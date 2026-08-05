// Cloudflare Worker proxy for HERE Routing API
// Keeps the HERE API key server-side so it doesn't need to be embedded in the app.
//
// Cost control: responses are cached in Workers KV keyed by a rounded geo-grid
// cell. Speed limits almost never change, so a cached cell is reused for 30 days.
// Repeat drives on the same roads (commuters, etc.) cost zero HERE transactions
// after the first lookup. Negative/empty responses are cached too, so blank cells
// aren't re-queried on every pass.

const ALLOWED_PARAMS = new Set([
  'transportMode',
  'origin',
  'destination',
  'return',
  'spans',
]);

// ~11 m grid cell (4 decimal places). Small enough not to straddle a speed-limit
// change at an intersection, coarse enough that repeat GPS fixes on the same road
// land in the same cell.
const CACHE_PRECISION = 4;
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// Build a stable cache key from the origin coordinate. Destination is derived from
// origin by the app (~10 m north), so the origin alone identifies the cell.
function cacheKeyFromParams(searchParams) {
  const origin = searchParams.get('origin');
  if (!origin) return null;
  const parts = origin.split(',');
  if (parts.length !== 2) return null;
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return `here:${lat.toFixed(CACHE_PRECISION)},${lon.toFixed(CACHE_PRECISION)}`;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env, ctx) {
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

    // --- Cache lookup ---
    const cacheKey = cacheKeyFromParams(url.searchParams);
    if (env.SPEED_CACHE && cacheKey) {
      const cached = await env.SPEED_CACHE.get(cacheKey);
      if (cached !== null) {
        return new Response(cached, {
          headers: {
            'Content-Type': 'application/json',
            'X-Cache': 'HIT',
            ...CORS_HEADERS,
          },
        });
      }
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

      const body = await response.text();

      // Only cache successful responses. Errors (rate limit, 5xx) must not be
      // cached, or a transient failure would stick for 30 days.
      if (response.ok && env.SPEED_CACHE && cacheKey) {
        // Hand the KV write to waitUntil so it completes after the response is
        // returned. Without this the runtime cancels the un-awaited put and
        // nothing is ever cached.
        ctx.waitUntil(
          env.SPEED_CACHE.put(cacheKey, body, { expirationTtl: CACHE_TTL_SECONDS })
        );
      }

      return new Response(body, {
        status: response.status,
        headers: {
          'Content-Type': response.headers.get('Content-Type') || 'application/json',
          'X-Cache': 'MISS',
          ...CORS_HEADERS,
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
