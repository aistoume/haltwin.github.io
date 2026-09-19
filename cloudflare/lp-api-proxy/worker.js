// api.sterlingai.net/lp/*  ->  Sterling LP rewards backend (sterling-asp lp-rewards/backend on Render).
// Only this path prefix is routed here (see wrangler.jsonc); everything else on api.sterlingai.net
// (notably /mcp, the production A2MCP endpoint served through the Cloudflare Tunnel) never reaches this Worker.
// Kept as its own tiny Worker on purpose: deploys of the website Worker cannot take the LP API down.
const BACKEND = 'https://sterling-lp-backend.onrender.com';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/lp/')) return new Response('not found', { status: 404 });
    const upstream = new URL(url.pathname + url.search, BACKEND);
    const headers = new Headers(request.headers);
    headers.delete('host');                                  // Render routes by Host; it comes from the upstream URL
    headers.set('x-forwarded-host', url.hostname);
    headers.set('x-forwarded-proto', 'https');
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const resp = await fetch(upstream.toString(), {
      method: request.method, headers, body: hasBody ? request.body : undefined, redirect: 'manual',
    });
    return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
  },
};
