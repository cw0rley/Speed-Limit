# Speed Limit

A cross-platform (iOS + Android) React Native app built with Expo that shows your current GPS
speed alongside the posted speed limit of the road you're on. On iPhone it also drives a
full-screen **CarPlay** display.

## Features

- Large, glanceable current-speed readout (portrait and landscape layouts)
- Posted speed limit looked up from **OpenStreetMap** (Overpass). (A HERE fallback exists in the
  code but is **currently disabled** — see the note below.)
- MPH / KM/H unit toggle
- Configurable **speed-alert thresholds** — the speed turns yellow / orange / red as you go
  further over the limit (defaults: +3 / +8 / +10), and the phone vibrates once when you cross
  the limit
- Screen stays awake automatically for heads-up / dashboard use
- **CarPlay**: a full-screen sign mirroring the phone (current speed + speed-limit sign, red
  when you're over)
- Works on both iPhone and Android from a single codebase

## Prerequisites

- Node.js 18 or newer
- An iPhone or Android phone for testing, with the free **Expo Go** app installed
  - iOS: https://apps.apple.com/app/expo-go/id982107779
  - Android: https://play.google.com/store/apps/details?id=host.exp.exponent

> **Note:** Expo Go is fine for the phone-only UI. **CarPlay** and the custom native config
> require an EAS **development build** on a real device — it does not run in Expo Go.

## Quick start (development)

From the project folder:

```bash
npm install
npx expo start
```

Scan the QR code with Expo Go (Android) or the iPhone camera (iOS). The app will load on your
phone over the local network.

On the phone, grant the location permission when prompted. Go outside or near a window for a GPS
fix, then walk/drive — the speed display updates in real time. When you pass near a road that has
a `maxspeed` tag in OpenStreetMap (or that HERE has data for), the limit appears in the sign.

## Building a standalone app

This app uses config plugins and CarPlay, so you build it with EAS:

```bash
npm install -g eas-cli
eas login
eas build -p android --profile preview        # APK you can sideload
eas build -p ios     --profile development     # dev client on a real device (needed for CarPlay)
eas build -p ios     --profile production      # App Store build
```

Submit config lives in `eas.json` (App Store Connect app id, Play track). See
https://docs.expo.dev/build/introduction/ for details.

## How the speed-limit lookup works

On each GPS update (throttled — skipped unless you've moved > 40 m **or** > 15 s have passed) the
app queries the **Overpass API** (OpenStreetMap): it looks for OSM `way` elements within 25 m that
have both `highway=*` and `maxspeed=*` tags and parses the closest one. Results are cached per
~11 m grid cell for the session, so repeat/looping routes hit no provider at all.

The code also has a **HERE Routing v8** fallback for roads OSM doesn't cover, but **HERE is
currently disabled** (see below), so the app effectively runs OSM-only today.

> **⚠️ HERE billing warning.** Despite HERE's "1,000 free transactions/day" tier, the account was
> hit with real overage charges (~$1,000 total) and the HERE service was **disabled** in response.
> Do **not** re-enable HERE without first putting a hard spend cap / usage alarm on the account —
> the free tier is not a safe assumption. See `CLAUDE.md` for details.

The data source that actually produced the displayed limit is shown in the small footer text
("Limit Data: HERE" or "Limit Data: OpenStreetMap").

### The HERE API key and proxy (inert — HERE is disabled)

HERE requests do **not** go directly from the app. They're routed through a small **Cloudflare
Worker** (`proxy/`) that holds the HERE API key server-side (as a Worker secret) and caches
responses in Workers KV by grid cell for 30 days. This was meant to keep the key out of the
shipped app and keep HERE cost near zero for repeat drives.

**The HERE service is currently disabled after ~$1,000 of unexpected overage charges**, so this
path is inert — the proxy will get errors from HERE and the app falls back to nothing (limit
shows `--` where OSM has no data). The proxy code and `PROXY_URL` in `App.js` are left in place
for reference.

The app points at the proxy via `PROXY_URL` in `App.js`. The `HERE_API_KEY` constant in `App.js`
is only a fallback for local development when no proxy is configured (and is tied to the billed
account — rotate it before any reuse).

If HERE is ever re-enabled (**only with a hard spend cap in place**), deploy / manage the proxy:

```bash
cd proxy
npx wrangler secret put HERE_API_KEY            # paste your key (one time)
npx wrangler kv namespace create SPEED_CACHE    # one time; put the id in wrangler.toml
npx wrangler deploy
```

HERE keys come from https://platform.here.com. The "free Base plan: 1,000 transactions/day" is
**not** a safe assumption — it is what generated the overage.

### Recognised `maxspeed` formats

- `50` — interpreted as km/h (OSM default)
- `50 mph` / `50mph` — miles per hour
- `50 km/h`, `50 kmh`, `50 kph` — kilometres per hour

Non-numeric values like `RU:urban`, `walk`, `none`, or `signals` are ignored and the limit shows
as `--`.

## CarPlay

On iPhone, when connected to CarPlay the app shows a full-screen custom sign that mirrors the
phone: current speed on one side, a US-style speed-limit sign on the other, with a red background
when you're over the limit.

CarPlay requires Apple's **CarPlay Maps entitlement**, which must be granted by Apple before a
build can be signed with it. Until then, CarPlay-enabled iOS builds will fail to sign — see
`CLAUDE.md` for the current status.

## Limitations

- **GPS speed is smoothed by the OS.** It's accurate while moving but jittery near zero. This is
  normal.
- **Coverage gaps.** If neither OSM nor HERE has data for the road, the limit shows as `--`.
- **Not for enforcement.** Don't rely on this app to avoid a ticket — always follow posted signs.
- **Foreground only.** The screen is kept awake while the app is open, but there is no true
  background tracking (that would need extra iOS/Android entitlements not included here).

## Project layout

```
speed-limit/
  App.js                 # main component: UI + GPS + speed-limit lookup + CarPlay screen
  app.json               # Expo config (permissions, plugins, bundle ids)
  eas.json               # EAS build/submit profiles
  package.json           # dependencies
  babel.config.js
  plugins/withCarPlay.js # CarPlay config plugin (entitlement, scenes, AppDelegate hook)
  proxy/                 # Cloudflare Worker proxy for HERE (+ KV cache)
  assets/                # icon/splash/favicon + store screenshots
  README.md              # this file
  CLAUDE.md              # architecture / source-of-truth notes for contributors
```

## Troubleshooting

- **Permission denied** — open iOS Settings → Privacy → Location Services → (Expo Go or Speed
  Limit), or Android Settings → Apps → Permissions → Location, and allow access. The app also
  shows an "Open Settings" button on the denied screen.
- **Speed stays at 0** — you probably don't have a GPS fix yet, or you're indoors. Try stepping
  outside.
- **Limit always shows `--`** — the road likely has no `maxspeed` tag in OpenStreetMap and HERE
  has no data for it either. You can check / contribute tags at https://www.openstreetmap.org.
- **"Network request failed"** — the Overpass public endpoints are occasionally rate-limited or
  down. The app falls back between two endpoints and retries on the next GPS update.
```
