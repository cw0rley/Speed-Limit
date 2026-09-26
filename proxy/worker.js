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
//   3b. ACCESS (TOMTOM_ACCESS):
//        "test"        — only requests with X-Client-Token = TEST_CLIENT_TOKEN
//                        (TestFlight builds from the `testflight` EAS profile).
//        "subscribers" — only requests whose X-App-User-Id has an active
//                        RevenueCat entitlement (checked against RevenueCat's
//                        REST API with the REVENUECAT_SECRET_KEY secret, then
//                        remembered in D1 for ENTITLEMENT_TTL_MS).
//        "both"        — either of the above.
//        anything else — everything is denied.
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

// Hard ceiling. The DAILY_CAP var can lower it (e.g. 5 for a cap drill) but
// never raise it: 600 × 31 = 18,600 < TomTom's 20,000 free requests/month.
const MAX_DAILY_CAP = 600;
const PER_IP_HOURLY_CAP = 60;

function dailyCap(env) {
  const n = Number(env.DAILY_CAP);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), MAX_DAILY_CAP) : MAX_DAILY_CAP;
}

// Constant-time string comparison.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const ENTITLEMENT_TTL_MS = 10 * 60 * 1000; // re-check a subscriber this often
const ENTITLEMENT_ID = 'pro';

function testTokenOk(request, env) {
  return (
    !!env.TEST_CLIENT_TOKEN &&
    safeEqual(request.headers.get('X-Client-Token') || '', env.TEST_CLIENT_TOKEN)
  );
}

// Does a RevenueCat /subscribers response grant the entitlement right now?
export function isEntitled(body, nowMs, entitlementId = ENTITLEMENT_ID) {
  const ent =
    body && body.subscriber && body.subscriber.entitlements && body.subscriber.entitlements[entitlementId];
  if (!ent) return false;
  // No expiry = lifetime/promotional grant.
  if (!ent.expires_date) return true;
  const expires = Date.parse(ent.expires_date);
  return Number.isFinite(expires) && expires > nowMs;
}

// App user ids come from RevenueCat; keep them to a safe shape before use.
export function validAppUserId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9:_$.+-]{6,128}$/.test(id);
}

async function subscriberAllowed(request, env, db) {
  const id = request.headers.get('X-App-User-Id') || '';
  if (!validAppUserId(id) || !env.REVENUECAT_SECRET_KEY) return false;

  const nowMs = Date.now();
  try {
    const row = await db
      .prepare('SELECT entitled, checked_at FROM subscriber_cache WHERE app_user_id = ?1')
      .bind(id)
      .first();
    if (row && nowMs - Number(row.checked_at) < ENTITLEMENT_TTL_MS) return Number(row.entitled) === 1;
  } catch (_) {
    return false; // fail closed
  }

  let entitled = false;
  try {
    const res = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}`, Accept: 'application/json' },
    });
    if (!res.ok) return false;
    entitled = isEntitled(await res.json(), nowMs);
  } catch (_) {
    return false;
  }

  try {
    await db
      .prepare(
        'INSERT INTO subscriber_cache (app_user_id, entitled, checked_at) VALUES (?1, ?2, ?3) ' +
          'ON CONFLICT(app_user_id) DO UPDATE SET entitled = excluded.entitled, checked_at = excluded.checked_at'
      )
      .bind(id, entitled ? 1 : 0, nowMs)
      .run();
  } catch (_) {
    // best effort
  }
  return entitled;
}

async function clientAllowed(request, env, db) {
  const mode = env.TOMTOM_ACCESS;
  if (mode === 'test') return testTokenOk(request, env);
  if (mode === 'subscribers') return subscriberAllowed(request, env, db);
  if (mode === 'both') return testTokenOk(request, env) || subscriberAllowed(request, env, db);
  return false;
}
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

// OSM highway class (sent by the app for the road it matched) -> TomTom
// roadUse filter. Without it, reverse geocoding returns the nearest street
// with addresses — on a motorway that is often a 25 mph side street.
const ROAD_USE = {
  motorway: 'LimitedAccess',
  trunk: 'LimitedAccess,Arterial',
  motorway_link: 'Ramp',
  trunk_link: 'Ramp',
  primary_link: 'Ramp',
  secondary_link: 'Ramp',
  tertiary_link: 'Ramp',
  primary: 'Arterial',
  secondary: 'Arterial',
  tertiary: 'Arterial,LocalStreet',
  unclassified: 'LocalStreet,Arterial',
  residential: 'LocalStreet',
  living_street: 'LocalStreet',
};

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
  const roadUse = ROAD_USE[url.searchParams.get('road')] || null;
  return {
    lat: Number(lat.toFixed(CELL_PRECISION)),
    lon: Number(lon.toFixed(CELL_PRECISION)),
    sector,
    roadUse,
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
    db.prepare(
      'CREATE TABLE IF NOT EXISTS subscriber_cache (app_user_id TEXT PRIMARY KEY, ' +
        'entitled INTEGER NOT NULL, checked_at INTEGER NOT NULL)'
    ),
  ]);
  schemaReady = true;
}

// Per-IP rows older than this are deleted (the privacy policy promises ~48 h).
const IP_RETENTION_MS = 48 * 3600 * 1000;
const ipCutoff = () => new Date(Date.now() - IP_RETENTION_MS).toISOString().slice(0, 13);

// Reserve one TomTom call, atomically (a D1 batch is one transaction): the
// daily and per-IP counters are incremented only if BOTH are under their caps,
// so the counters equal the calls actually made. Reserved BEFORE the call.
// Expired per-IP rows are deleted in the same batch.
// Returns { granted, dayCalls, ipCalls }.
async function reserveCall(db, ip, cap) {
  const day = today();
  const hour = new Date().toISOString().slice(0, 13);
  const results = await db.batch([
    db.prepare('DELETE FROM ip_usage WHERE hour < ?1').bind(ipCutoff()),
    db.prepare('INSERT OR IGNORE INTO tomtom_usage (day, calls) VALUES (?1, 0)').bind(day),
    db.prepare('INSERT OR IGNORE INTO ip_usage (ip, hour, calls) VALUES (?1, ?2, 0)').bind(ip, hour),
    db
      .prepare(
        'UPDATE tomtom_usage SET calls = calls + 1 WHERE day = ?1 AND calls < ?2 ' +
          'AND (SELECT calls FROM ip_usage WHERE ip = ?3 AND hour = ?4) < ?5'
      )
      .bind(day, cap, ip, hour, PER_IP_HOURLY_CAP),
    // changes() = rows touched by the previous UPDATE (same connection).
    db
      .prepare('UPDATE ip_usage SET calls = calls + 1 WHERE ip = ?1 AND hour = ?2 AND changes() = 1')
      .bind(ip, hour),
    db
      .prepare(
        'SELECT (SELECT calls FROM tomtom_usage WHERE day = ?1) AS day_calls, ' +
          '(SELECT calls FROM ip_usage WHERE ip = ?2 AND hour = ?3) AS ip_calls'
      )
      .bind(day, ip, hour),
  ]);
  const granted = results[3].meta && results[3].meta.changes === 1;
  const row = results[5].results[0] || {};
  return { granted, dayCalls: Number(row.day_calls), ipCalls: Number(row.ip_calls) };
}

async function readCalls(db) {
  const row = await db.prepare('SELECT calls FROM tomtom_usage WHERE day = ?1').bind(today()).first();
  return row ? Number(row.calls) : 0;
}

// Daily cron (wrangler.toml [triggers]) — deletes expired per-IP rows even on
// days with no TomTom calls.
async function prune(db) {
  await ensureSchema(db);
  await db.batch([
    db.prepare('DELETE FROM ip_usage WHERE hour < ?1').bind(ipCutoff()),
    db
      .prepare('DELETE FROM subscriber_cache WHERE checked_at < ?1')
      .bind(Date.now() - 7 * 24 * 3600 * 1000),
  ]);
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

  if (!(await clientAllowed(request, env, db))) {
    return json({ value: null, reason: 'not allowed' }, 403);
  }

  // Stops 2 + 4: daily and per-IP caps, reserved atomically before the call.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const cap = dailyCap(env);
  let usage;
  try {
    usage = cap > 0 ? await reserveCall(db, ip, cap) : { granted: false, dayCalls: 0, ipCalls: 0 };
  } catch (_) {
    return json({ value: null, reason: 'usage store unavailable' }, 503);
  }
  if (!usage.granted) {
    const reason = usage.ipCalls >= PER_IP_HOURLY_CAP ? 'rate limited' : 'daily cap reached';
    return json({ value: null, reason }, 429);
  }

  const upstream = new URL(
    `https://api.tomtom.com/search/2/reverseGeocode/${q.lat},${q.lon}.json`
  );
  upstream.searchParams.set('key', env.TOMTOM_API_KEY);
  upstream.searchParams.set('returnSpeedLimit', 'true');
  upstream.searchParams.set('radius', String(SEARCH_RADIUS_M));
  if (q.sector != null) upstream.searchParams.set('heading', String(q.sector * 45));
  if (q.roadUse) {
    upstream.searchParams.set(
      'roadUse',
      JSON.stringify(q.roadUse.split(','))
    );
  }

  let res;
  try {
    res = await fetch(upstream.toString(), { headers: { Accept: 'application/json' } });
  } catch (_) {
    return json({ value: null, reason: 'upstream unreachable' }, 502);
  }

  if (res.status === 401 || res.status === 403 || res.status === 429) {
    // TomTom's own limit (free allowance used up) or a bad/blocked key. Not
    // cached; the app backs off for several minutes on this 429.
    return json({ value: null, reason: `provider ${res.status}` }, 429);
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
    tomtomCalls: calls,
    dailyCap: dailyCap(env),
    enabled: env.TOMTOM_ENABLED === 'true',
    access: env.TOMTOM_ACCESS || 'none',
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
