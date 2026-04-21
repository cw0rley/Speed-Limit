# Speed Limit

A cross-platform (iOS + Android) React Native app built with Expo that shows your current GPS speed alongside the posted speed limit of the road you're on.

## Features

- Large, glanceable current-speed readout
- Posted speed limit pulled from OpenStreetMap via the Overpass API (no API key required)
- MPH / KM/H unit toggle
- Over-limit warning: background turns red and the phone vibrates when you exceed the limit
- "Keep screen on" toggle for heads-up / dashboard use
- Works on both iPhone and Android from a single codebase

## Prerequisites

- Node.js 18 or newer
- An iPhone or Android phone for testing, with the free **Expo Go** app installed
  - iOS: https://apps.apple.com/app/expo-go/id982107779
  - Android: https://play.google.com/store/apps/details?id=host.exp.exponent

## Quick start (development)

From the project folder:

```bash
npm install
npx expo start
```

Scan the QR code with Expo Go (Android) or the iPhone camera (iOS). The app will load on your phone over the local network.

On the phone, grant the location permission when prompted. Go outside or near a window for a GPS fix, then walk/drive — the speed display updates in real time. When you pass near a road that has a `maxspeed` tag in OpenStreetMap, the limit will appear in the red circle below.

## Building a standalone app

For a production build you don't need to publish — you can build an `.ipa` / `.apk` with EAS:

```bash
npm install -g eas-cli
eas login
eas build -p android --profile preview   # APK you can sideload
eas build -p ios     --profile preview   # requires an Apple Developer account
```

See https://docs.expo.dev/build/introduction/ for details.

## How the speed limit lookup works

On each GPS update (throttled — every 40 m or 15 s, whichever comes first) the app queries **HERE's Routing v8 API** first, using a tiny ~10 m route from the current point and reading `spans[].speedLimit` off the response. If HERE has no data for that road — or the request fails — the app falls back to the **Overpass API** (OpenStreetMap), which looks for OSM `way` elements within 25 m that have both `highway=*` and `maxspeed=*` tags and parses the closest one.

The data source that actually produced the displayed limit is shown in the small footer text ("Limit data: HERE" or "Limit data: OpenStreetMap").

### Managing the HERE API key

The key lives as a constant at the top of `App.js`:

```js
const HERE_API_KEY = '...';
```

To rotate it: log in at https://platform.here.com → Access Manager → delete the old key → create a new one → paste it in and reload the app.

**Production note.** Keys embedded in a mobile app can be extracted by anyone who installs the app. The free tier's 1,000 requests/day cap limits the damage, but if you ever publish this you should put a small proxy server in front of HERE (e.g. a Cloudflare Worker or a tiny Node service) that holds the key server-side and only forwards whitelisted requests from your app. That's a future step, not needed for local testing.

Recognised formats:
- `50` — interpreted as km/h (OSM default)
- `50 mph` — miles per hour
- `50 km/h`, `50 kmh`, `50 kph` — kilometres per hour

Non-numeric values like `RU:urban`, `walk`, `none`, or `signals` are ignored and the limit is shown as `—`.

## Limitations

- **HERE coverage is much better than OSM** on residential and rural roads, which is why it's the primary source. But it's not perfect — the fallback to OSM catches cases where HERE returns no data. If both fail, the limit shows as `—`.
- **GPS speed is smoothed by the OS.** It's accurate while moving but jittery near zero. This is normal.
- **Not for enforcement.** Don't rely on this app to avoid a ticket — always follow posted signs.
- **Background mode** is currently "keep the screen on while foregrounded." True background tracking requires extra work (background location entitlements on iOS, a foreground service on Android) that this first version doesn't include.

## Project layout

```
Speed Limit/
  App.js              # main component: UI + GPS + Overpass lookup
  app.json            # Expo config (permissions, bundle IDs)
  package.json        # dependencies
  babel.config.js     # Babel preset
  README.md           # this file
```

## Troubleshooting

- **Permission denied** — open iOS Settings → Privacy → Location Services → Expo Go (or Speed Limit), or Android Settings → Apps → Expo Go → Permissions → Location, and allow access.
- **Speed stays at 0** — you probably don't have a GPS fix yet, or you're indoors. Try stepping outside.
- **Limit always shows `—`** — the road you're on likely has no `maxspeed` tag in OpenStreetMap. You can check at https://www.openstreetmap.org and even contribute tags back.
- **"Network request failed"** — the Overpass public endpoints are occasionally rate-limited or down. The app falls back between two endpoints and retries on the next GPS update.
