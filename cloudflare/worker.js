// sterlingai.net Worker: static site (Workers assets) + canonical-host redirects + API proxy. No secrets.
//  - www.sterlingai.net -> sterlingai.net (hostname check).
//  - http -> https, decided from Cloudflare's `cf-visitor` header (the edge always sets it in
//    production). `wrangler dev` presents the request as http://sterlingai.net without that header,
//    so local runs serve the assets instead of bouncing to https.
//  - /mcp, /health and /v1/* are proxied to the Sterling ASP backend (HalTwin/sterling-asp on Render).
//    The upstream body is streamed through untouched, so MCP's Streamable HTTP / SSE
//    (text/event-stream) is never buffered. Everything else is served from the static assets.
//  - /treasury/portfolio.json is the treasury page's live data feed. The treasury bot PUTs it here every ~10 min
//    (Authorization: Bearer <TREASURY_PUBLISH_TOKEN secret>); it is kept in KV and served same-origin, so the
//    page no longer depends on a public GitHub raw URL (the site repo is private).
const CANONICAL = 'sterlingai.net';
const API_ORIGIN = 'https://sterling-asp.onrender.com';
const API_PATH = /^\/(mcp|health)$|^\/v1(\/|$)/;
const API_ORIGIN_RE = /^https?:\/\/sterling-asp\.onrender\.com/;

const DATA_PATH = '/treasury/portfolio.json';
const DATA_MAX_BYTES = 262144;
const jsonResp = (body, status = 200, extra = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
});

async function sameToken(given, expected) {
  if (!given || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, expected].map((t) => crypto.subtle.digest('SHA-256', enc.encode(t))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];              // constant-time compare of the digests
  return diff === 0;
}

// Treasury data feed: public GET, token-protected PUT. JSON only — nothing uploaded here can run as code.
async function treasuryData(request, env) {
  if (request.method === 'GET' || request.method === 'HEAD') {
    const { value, metadata } = await env.TREASURY.getWithMetadata('portfolio.json');
    if (value === null) return jsonResp({ error: 'no treasury data published yet' }, 404);
    return jsonResp(request.method === 'HEAD' ? '' : value, 200, { 'x-received-at': (metadata && metadata.received_at) || '' });
  }
  if (request.method !== 'PUT' && request.method !== 'POST') return jsonResp({ error: 'method not allowed' }, 405, { allow: 'GET, HEAD, PUT' });
  const auth = request.headers.get('authorization') || '';
  if (!(await sameToken(auth.startsWith('Bearer ') ? auth.slice(7) : '', env.TREASURY_PUBLISH_TOKEN))) return jsonResp({ error: 'forbidden' }, 403);
  const text = await request.text();
  if (new TextEncoder().encode(text).length > DATA_MAX_BYTES) return jsonResp({ error: 'payload too large' }, 413);
  let d;
  try { d = JSON.parse(text); } catch { return jsonResp({ error: 'body is not JSON' }, 400); }
  const ok = d && typeof d === 'object' && !Array.isArray(d) && Number.isInteger(d.v) && typeof d.as_of === 'string'
    && Array.isArray(d.rows) && Array.isArray(d.buckets) && (d.total_usd === null || typeof d.total_usd === 'number')
    && (d.generated_at === undefined || d.generated_at === null || typeof d.generated_at === 'number');
  if (!ok) return jsonResp({ error: 'not a treasury payload (need v, as_of, rows, buckets, total_usd)' }, 400);
  // never go backwards: a delayed or replayed upload must not overwrite newer data
  const prev = await env.TREASURY.get('portfolio.json', 'json');
  if (prev && typeof prev.generated_at === 'number' && typeof d.generated_at === 'number' && d.generated_at < prev.generated_at) {
    return jsonResp({ error: 'older than the published snapshot', published_as_of: prev.as_of }, 409);
  }
  const received_at = new Date().toISOString();
  await env.TREASURY.put('portfolio.json', text, { metadata: { received_at, as_of: d.as_of } });
  return jsonResp({ ok: true, as_of: d.as_of, bytes: text.length, received_at });
}

function visitorScheme(request) {
  try { return JSON.parse(request.headers.get('cf-visitor') || '{}').scheme || null; } catch { return null; }
}

async function proxyApi(request, url) {
  const upstream = new URL(url.pathname + url.search, API_ORIGIN);
  const headers = new Headers(request.headers);
  headers.delete('host');                       // the subrequest's Host comes from the upstream URL
  headers.set('accept-encoding', 'identity');   // no gzip/br from Render: a compressed SSE stream gets
                                                // buffered by the encoder and the MCP handshake stalls
  headers.set('x-forwarded-host', url.hostname);
  headers.set('x-forwarded-proto', 'https');
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const resp = await fetch(upstream.toString(), {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual',                         // pass 3xx through instead of following them here
  });
  const out = new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
  const loc = out.headers.get('location');      // an upstream redirect must not leak the Render hostname
  if (loc && API_ORIGIN_RE.test(loc)) out.headers.set('location', loc.replace(API_ORIGIN_RE, 'https://' + CANONICAL));
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const wrongHost = url.hostname === 'www.' + CANONICAL;
    const insecure = visitorScheme(request) === 'http';
    if (wrongHost || insecure) {
      url.protocol = 'https:';
      url.hostname = CANONICAL;
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === DATA_PATH) return treasuryData(request, env);
    if (API_PATH.test(url.pathname)) return proxyApi(request, url);
    return env.ASSETS.fetch(request);
  },
};
