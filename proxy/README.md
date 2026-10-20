# Speed Limit — proxy Worker (Cloudflare)

Keeps the TomTom API key off the phone and hard-limits how often TomTom is called.

## Endpoints

| Route | What it does |
|---|---|
| `GET /limit?lat=&lon=[&heading=]` | Speed limit from TomTom Reverse Geocode (`returnSpeedLimit=true`). Returns `{"value":45,"unit":"mph","source":"tomtom"}` or `{"value":null}`. `429` = capped / rate limited, `503` = switched off or not configured. |
| `GET /usage` | Today's TomTom + Snap to Roads call counts vs. their caps. |
| `GET /snap?points=lon,lat;lon,lat` | Diagnostic: raw Snap to Roads answer for a trace (test token, same caps). |
| `GET /here-route` | Always `410`. HERE is permanently off (it billed ~$1,000); old app builds still call this. |

## No-billing safeguards

1. **TomTom free plan, no card, no top-up — ever.** Over the free allowance TomTom returns `429`; it doesn't charge.
2. **Daily cap**: hard ceiling `MAX_DAILY_CAP = 600` (≤18,600/month, under TomTom's 20,000 free). The `DAILY_CAP` var can only lower it. A call is *reserved* in D1 before it is made, and only if both caps have room, so the counter equals the calls actually made.
3. **Per-IP cap** (`PER_IP_HOURLY_CAP = 60`). Per-IP rows are deleted after ~48 h (every call + a daily cron).
3b. **Access**: `TOMTOM_ACCESS = "test"` serves only requests with `X-Client-Token` = the `TEST_CLIENT_TOKEN` secret. Only app builds from the EAS `testflight` profile carry it (EAS env var `EXPO_PUBLIC_TEST_CLIENT_TOKEN`, `preview` environment). Everything else gets 403.
4. **Kill switch**: set `TOMTOM_ENABLED = "false"` in `wrangler.toml`, then `npx wrangler deploy`.
5. **No shared server cache** — TomTom T&Cs §11.4 forbid caching results to serve multiple users. The app caches answers for itself only.
6. Any database error **denies** the call.
7. Everything runs on Cloudflare's free tier (Workers + D1). On the Workers **Free** plan, exceeding a limit makes requests fail — it doesn't bill. Check your plan: Cloudflare dashboard → Workers & Pages → Plans.

**Which TomTom product:** `motorway` / `trunk` / `*_link` → **Snap to Roads** (needs `prev=`),
everything else → **Reverse Geocode**, and if that comes back empty (it only knows *addressed*
streets) the Worker falls back to Snap to Roads when `prev=` is present. Snap's free allowance is 2,500/month (vs 20,000), so it has
its own daily ceiling (`MAX_SNAP_DAILY_CAP = 80`, `SNAP_DAILY_CAP` var).

The app adds its own spacing (at most one TomTom call per 30 s per device, 10-minute back-off after a `429`/`503`) and only asks TomTom when OpenStreetMap has no answer.

## One-time setup

```bash
cd proxy
npx wrangler d1 create speed-limit-usage     # paste the database_id into wrangler.toml
npx wrangler secret put TOMTOM_API_KEY       # paste the TomTom key when prompted
npx wrangler secret delete HERE_API_KEY      # optional cleanup; HERE is unused
npx wrangler deploy
```

Tables are created by the Worker on first use.

## Cap drill (run 2026-09-17)

1. Deploy with a tiny cap: `npx wrangler deploy --var TOMTOM_ENABLED:true --var DAILY_CAP:5`
2. No token / wrong token → `403 not allowed`.
3. 10 calls with the token → 5 reach TomTom, 5 get `daily cap reached`; `/usage` shows 5.
4. Compare with the TomTom dashboard (should show the same number of requests).
5. `npx wrangler deploy` (committed config, TomTom off) → token calls get `503 disabled`, nothing counted.

Result: all steps passed. The first run hit a rotated key (TomTom 401 — not counted by TomTom); after the key was re-set, a real lookup returned a limit and the TomTom dashboard showed exactly the 2 successful calls.

## Checking usage

```bash
curl https://speed-limit-proxy.prcunningham.workers.dev/usage
```

Also watch the TomTom dashboard (developer.tomtom.com → Dashboard → Analytics).

## Local testing

```bash
cd proxy
echo TOMTOM_API_KEY=your_key > .dev.vars   # .dev.vars is gitignored
npx wrangler dev --local
```

`--local` uses a local D1 database. Inspect or seed it with
`npx wrangler d1 execute speed-limit-usage --local --command "SELECT * FROM tomtom_usage"`.
