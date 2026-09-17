// Cloudflare Worker: speed-limit proxy for the Speed Limit app.
//
// GET /limit?lat=..&lon=..[&heading=..]
//   Returns {"value":45,"unit":"mph","source":"tomtom"} or {"value":null}.
//   Backed by TomTom Reverse Geocode (returnSpeedLimit=true). The TomTom key
//   lives only here, as the TOMTOM_API_KEY secret.
//
// ── NO-BILLING DESIGN ─────────────────────────────────────────────────────────
// HERE cost ~$1,000 because nothing ever hard-stopped usage. This Worker stacks
// independent stops, any one of which prevents runaway use:
//   1. TomTom account stays on the FREE plan with NO card and NO top-up. Over
//      the free allowance (20k reverse-geocode requests/month) TomTom returns
//      429 instead of charging.
//   2. DAILY_CAP: this Worker refuses to call TomTom more than DAILY_CAP times a
//      UTC day (600 × 31 = 18,600 < 20,000/month). Counted atomically in D1
//      (KV reads can be stale for ~60 s, which would undercount).
//   3. KILL SWITCH: set the TOMTOM_ENABLED var to "false" (wrangler.toml) and
//      redeploy — TomTom is never called.
//   4. PER_IP_HOURLY_CAP: one device/IP can't burn the day's budget.
//   5. NO shared cache of TomTom answers: TomTom T&Cs §11.4 forbid caching
//      "for the purpose of scaling results to serve multiple clients or users".
//      Each call serves only the device that asked; the app caches for itself.
// Everything uses Cloudflare's free tier (Workers + D1). On the Workers Free
// plan, going over a Cloudflare limit makes requests fail — it never bills.
// Any failure in the safety machinery (database error, etc.) DENIES the call.
// ──────────────────────────────────────────────────────────────────────────────
//
// GET /here-route is permanently disabled (410). Old app builds still in the
// wild call it; returning 410 here means re-enabling the HERE key can never
// silently resume HERE billing.

const DAILY_CAP = 600;
const PER_IP_HOURLY_CAP = 60;
const CELL_PRECISION = 4; // ~11 m
const SEARCH_RADIUS_M = 30; // don't take a limit from a road that isn't this one

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

// "25.00MPH" | "50.00KPH" | "50.00KMPH" -> { value, unit }
export function parseTomTomSpeedLimit(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(MPH|KPH|KMPH|KMH)$/i);
  if (!m) return null;
  const value = Math.round(Number(m[1]));
  if (!Number.isFinite(value) || value <= 0) return null;
  return { value, unit: m[2].toUpperCase() === 'MPH' ? 'mph' : 'kmh' };
}

function parseQuery(url) {
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const rawHeading = url.searchParams.get('heading');
  const heading = rawHeading == null || rawHeading === '' ? null : Number(rawHeading);
  // Bucket heading into 8 sectors (45°) — enough for TomTom to tell the two
  // sides of a divided road apart.
  const sector =
    heading != null && Number.isFinite(heading) && heading >= 0
      ? Math.round((((heading % 360) + 360) % 360) / 45) % 8
      : null;
  return {
    lat: Number(lat.toFixed(CELL_PRECISION)),
    lon: Number(lon.toFixed(CELL_PRECISION)),
    sector,
  };
}

const today = () => new Date().toISOString().slice(0, 10);

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(
      'CREATE TABLE IF NOT EXISTS tomtom_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL)'
    ),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS ip_usage (ip TEXT NOT NULL, hour TEXT NOT NULL, ' +
        'calls INTEGER NOT NULL, PRIMARY KEY (ip, hour))'
    ),
  ]);
  schemaReady = true;
}

// Per-IP rows older than this are deleted (the privacy policy promises ~48 h).
const IP_RETENTION_MS = 48 * 3600 * 1000;
const ipCutoff = () => new Date(Date.now() - IP_RETENTION_MS).toISOString().slice(0, 13);

// Atomically count one TomTom call against this IP's hour and the global day,
// returning both new totals. Counted BEFORE the call is made. Expired per-IP
// rows are deleted in the same batch.
async function countCall(db, ip) {
  const hour = new Date().toISOString().slice(0, 13);
  const [, ipRes, dayRes] = await db.batch([
    db.prepare('DELETE FROM ip_usage WHERE hour < ?1').bind(ipCutoff()),
    db
      .prepare(
        'INSERT INTO ip_usage (ip, hour, calls) VALUES (?1, ?2, 1) ' +
          'ON CONFLICT(ip, hour) DO UPDATE SET calls = calls + 1 RETURNING calls'
      )
      .bind(ip, hour),
    db
      .prepare(
        'INSERT INTO tomtom_usage (day, calls) VALUES (?1, 1) ' +
          'ON CONFLICT(day) DO UPDATE SET calls = calls + 1 RETURNING calls'
      )
      .bind(today()),
  ]);
  return {
    ipCalls: Number(ipRes.results[0]?.calls),
    dayCalls: Number(dayRes.results[0]?.calls),
  };
}

async function readCalls(db) {
  const row = await db.prepare('SELECT calls FROM tomtom_usage WHERE day = ?1').bind(today()).first();
  return row ? Number(row.calls) : 0;
}

// Daily cron (wrangler.toml [triggers]) — deletes expired per-IP rows even on
// days with no TomTom calls.
async function prune(db) {
  await ensureSchema(db);
  await db.prepare('DELETE FROM ip_usage WHERE hour < ?1').bind(ipCutoff()).run();
}

async function handleLimit(request, env, ctx, url) {
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  const q = parseQuery(url);
  if (!q) return json({ error: 'bad lat/lon' }, 400);

  // Stop 3: kill switch / config. (Checked first so a disabled Worker does no
  // database work at all.)
  if (env.TOMTOM_ENABLED !== 'true') return json({ value: null, reason: 'disabled' }, 503);
  if (!env.TOMTOM_API_KEY) return json({ value: null, reason: 'not configured' }, 503);
  if (!env.USAGE_DB) return json({ value: null, reason: 'usage store missing' }, 503);
  const db = env.USAGE_DB;

  try {
    await ensureSchema(db);
  } catch (_) {
    return json({ value: null, reason: 'usage store unavailable' }, 503);
  }

  // Stops 2 + 4: daily and per-IP caps, counted atomically before the call.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  let usage;
  try {
    usage = await countCall(db, ip);
  } catch (_) {
    return json({ value: null, reason: 'usage store unavailable' }, 503);
  }
  if (!Number.isFinite(usage.dayCalls) || usage.dayCalls > DAILY_CAP) {
    return json({ value: null, reason: 'daily cap reached' }, 429);
  }
  if (!Number.isFinite(usage.ipCalls) || usage.ipCalls > PER_IP_HOURLY_CAP) {
    return json({ value: null, reason: 'rate limited' }, 429);
  }

  const upstream = new URL(
    `https://api.tomtom.com/search/2/reverseGeocode/${q.lat},${q.lon}.json`
  );
  upstream.searchParams.set('key', env.TOMTOM_API_KEY);
  upstream.searchParams.set('returnSpeedLimit', 'true');
  upstream.searchParams.set('radius', String(SEARCH_RADIUS_M));
  if (q.sector != null) upstream.searchParams.set('heading', String(q.sector * 45));

  let res;
  try {
    res = await fetch(upstream.toString(), { headers: { Accept: 'application/json' } });
  } catch (_) {
    return json({ value: null, reason: 'upstream unreachable' }, 502);
  }

  if (res.status === 401 || res.status === 403 || res.status === 429) {
    // TomTom's own limit (free allowance used up) or a bad/blocked key. Not
    // cached; the app backs off for several minutes on this 429.
    return json({ value: null, reason: 'provider limit' }, 429);
  }
  if (!res.ok) return json({ value: null, reason: `upstream ${res.status}` }, 502);

  let data;
  try {
    data = await res.json();
  } catch (_) {
    return json({ value: null, reason: 'bad upstream body' }, 502);
  }

  const address = data && data.addresses && data.addresses[0] && data.addresses[0].address;
  const parsed = parseTomTomSpeedLimit(address && address.speedLimit);
  const body = JSON.stringify(
    parsed ? { ...parsed, source: 'tomtom' } : { value: null }
  );


  return new Response(body, { headers: JSON_HEADERS });
}

// GET /usage — today's TomTom call count vs. the cap (no secrets exposed).
async function handleUsage(env) {
  if (!env.USAGE_DB) return json({ error: 'usage store missing' }, 503);
  await ensureSchema(env.USAGE_DB);
  const calls = await readCalls(env.USAGE_DB);
  return json({
    date: today(),
    tomtomCalls: Math.min(calls, DAILY_CAP),
    deniedOverCap: Math.max(0, calls - DAILY_CAP),
    dailyCap: DAILY_CAP,
    enabled: env.TOMTOM_ENABLED === 'true',
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/limit':
        return handleLimit(request, env, ctx, url);
      case '/usage':
        return handleUsage(env);
      case '/here-route':
        return json({ error: 'HERE lookups are permanently disabled' }, 410);
      default:
        return new Response('Not found', { status: 404 });
    }
  },

  async scheduled(event, env, ctx) {
    if (env.USAGE_DB) ctx.waitUntil(prune(env.USAGE_DB));
  },
};
