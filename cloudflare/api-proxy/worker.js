// api.sterlingai.net  ->  the Sterling backends on Render. No tunnel involved: Render services already have public
// URLs, so this Worker simply fronts them on our own hostname (a Cloudflare Tunnel needs a cloudflared connector
// running next to the origin; on 2026-09-19 that connector was gone and the whole hostname answered 530/1033).
//   /lp/*      -> LP rewards backend   (sterling-asp lp-rewards/backend)
//   everything else (/mcp, /health, /v1/*, /docs, ...) -> main ASP backend (sterling-asp Dockerfile)
// Bodies are streamed through untouched and the upstream is asked for identity encoding, so MCP's
// Streamable HTTP / SSE (text/event-stream) is never buffered by a compressor.
const MAIN_BACKEND = 'https://sterling-asp.onrender.com';
const LP_BACKEND = 'https://sterling-lp-backend.onrender.com';
const UPSTREAM_HOST_RE = /^https?:\/\/(sterling-asp|sterling-lp-backend)\.onrender\.com/;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const base = url.pathname === '/lp' || url.pathname.startsWith('/lp/') ? LP_BACKEND : MAIN_BACKEND;
    const upstream = new URL(url.pathname + url.search, base);
    const headers = new Headers(request.headers);
    headers.delete('host');                                   // Render routes by Host; it comes from the upstream URL
    headers.set('accept-encoding', 'identity');
    headers.set('x-forwarded-host', url.hostname);
    headers.set('x-forwarded-proto', 'https');
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    let resp;
    try {
      resp = await fetch(upstream.toString(), { method: request.method, headers, body: hasBody ? request.body : undefined, redirect: 'manual' });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'upstream unreachable' }), { status: 502, headers: { 'content-type': 'application/json' } });
    }
    const out = new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
    const loc = out.headers.get('location');                  // never leak the Render hostname in redirects
    if (loc && UPSTREAM_HOST_RE.test(loc)) out.headers.set('location', loc.replace(UPSTREAM_HOST_RE, 'https://' + url.hostname));
    return out;
  },
};
