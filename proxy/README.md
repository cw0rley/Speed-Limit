# Speed Limit — proxy Worker (Cloudflare)

Keeps the TomTom API key off the phone and hard-limits how often TomTom is called.

## Endpoints

| Route | What it does |
|---|---|
| `GET /limit?lat=&lon=[&heading=]` | Speed limit from TomTom Reverse Geocode (`returnSpeedLimit=true`). Returns `{"value":45,"unit":"mph","source":"tomtom"}` or `{"value":null}`. `429` = capped / rate limited, `503` = switched off or not configured. |
| `GET /usage` | Today's TomTom call count vs. the daily cap. |
| `GET /here-route` | Always `410`. HERE is permanently off (it billed ~$1,000); old app builds still call this. |

## No-billing safeguards

1. **TomTom free plan, no card, no top-up — ever.** Over the free allowance TomTom returns `429`; it doesn't charge.
2. **Daily cap** (`DAILY_CAP = 600` → ≤18,600/month, under TomTom's 20,000 free), counted atomically in D1 *before* each call.
3. **Per-IP cap** (`PER_IP_HOURLY_CAP = 60`).
4. **Kill switch**: set `TOMTOM_ENABLED = "false"` in `wrangler.toml`, then `npx wrangler deploy`.
5. **No shared server cache** — TomTom T&Cs §11.4 forbid caching results to serve multiple users. The app caches answers for itself only.
6. Any database error **denies** the call.
7. Everything runs on Cloudflare's free tier (Workers + D1). On the Workers **Free** plan, exceeding a limit makes requests fail — it doesn't bill. Check your plan: Cloudflare dashboard → Workers & Pages → Plans.

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
