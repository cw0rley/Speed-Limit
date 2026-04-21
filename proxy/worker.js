// Cloudflare Worker proxy for HERE Routing API
// Keeps the HERE API key server-side so it doesn't need to be embedded in the app.

const ALLOWED_PARAMS = new Set([
  'transportMode',
  'origin',
  'destination',
  'return',
  'spans',
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Only handle /here-route
    if (url.pathname !== '/here-route') {
      return new Response('Not found', { status: 404 });
    }

    // Only allow GET requests
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    const apiKey = env.HERE_API_KEY;
    if (!apiKey) {
      return new Response('Server misconfigured: missing HERE_API_KEY', { status: 500 });
    }

    // Build the upstream URL with only allowed params
    const upstream = new URL('https://router.hereapi.com/v8/routes');
    for (const [key, value] of url.searchParams) {
      if (ALLOWED_PARAMS.has(key)) {
        upstream.searchParams.set(key, value);
      }
    }
    upstream.searchParams.set('apikey', apiKey);

    // Forward the request to HERE
    try {
      const response = await fetch(upstream.toString(), {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      // Return the response with CORS headers so the mobile app can call this
      const body = await response.arrayBuffer();
      return new Response(body, {
        status: response.status,
        headers: {
          'Content-Type': response.headers.get('Content-Type') || 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Upstream request failed' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
