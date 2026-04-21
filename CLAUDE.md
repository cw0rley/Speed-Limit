# Speed Limit

A cross-platform (iOS + Android) React Native + Expo app that shows the driver's current GPS speed and the posted speed limit for the road they're on.

## Stack

- **Expo SDK 51** (`package.json`) — picked for fastest iteration and one-codebase cross-platform
- **React Native 0.74.5**, React 18.2
- Single-file app: all UI and logic live in `App.js`. Not using expo-router.

## Key modules

- `expo-location` — GPS stream via `Location.watchPositionAsync` at BestForNavigation accuracy
- `expo-keep-awake` — manual activate/deactivate via a "Keep screen on" toggle (not the `useKeepAwake` hook)
- `expo-haptics` — single warning vibration on the rising edge of "went over the limit"
- `expo-status-bar`

## Speed-limit lookup

`fetchSpeedLimit(lat, lon, signal)` in `App.js` tries two providers in order:

1. **HERE Routing v8** (`fetchSpeedLimitHere`) — `https://router.hereapi.com/v8/routes` with a synthetic ~10 m route and `spans=speedLimit`. Response unit is **m/s**; code converts to km/h. Returns `{ value, unit: 'kmh', source: 'here' }` or `null`.
2. **Overpass / OpenStreetMap** (`fetchSpeedLimitOverpass`) — queries `way(around:25,lat,lon)[highway][maxspeed]` across two public endpoints. Picks the closest `way` by haversine distance to the center, parses the `maxspeed` tag via `parseMaxspeed()`, and returns `{ value, unit, source: 'osm' }`.

`parseMaxspeed` handles `"50"` (defaults to km/h — OSM convention), `"50 mph"`, `"30mph"`, `"50 km/h"`, `"50 kmh"`, `"50 kph"`. Ignores implicit values like `"RU:urban"`, `"walk"`, `"none"`, `"signals"` — returns `null` and the display shows `--`.

### HERE API key

Stored as a top-level constant in `App.js`:

```js
const HERE_API_KEY = '6jTbJVWZkUP4tAtJ-mVBeS24nhj-vs_UD0XVkOK44y4';
```

Free tier: 1,000 transactions/day. Billing card is on file for the account but never charged unless the tier is exceeded. For production, move this behind a small backend proxy (e.g. Cloudflare Worker) — keys embedded in mobile apps can be extracted.

### Throttling

The location callback calls `maybeFetchLimit` which is gated: skip if we're within 40 m of the last query **and** less than 15 s since the last query. In practice this keeps a 30-minute drive under ~120 provider calls.

## UI

- Large current-speed readout (220pt, centered)
- Speed-limit circle (red border on white, US-style)
- MPH/KM/H toggle in the top-left (tap to switch; both values are displayed in the selected unit — `convertLimit()` handles mph↔kmh conversion of the raw result)
- Keep-screen-on toggle in the top-right
- Over-limit state: background turns red (`#8a0f10`) and a warning haptic fires once on the rising edge (tracked via `lastOverRef`). Tolerance is `displayLimit + 1` to avoid flickering at the boundary.
- Footer shows GPS accuracy (`±Nm`) and the data source of the currently displayed limit (`HERE`, `OpenStreetMap`, or the fallback-chain note before the first successful fetch)

## Permissions

Configured in `app.json`:
- iOS: `NSLocationWhenInUseUsageDescription`, `NSLocationAlwaysAndWhenInUseUsageDescription`, `UIBackgroundModes: ["location"]`
- Android: `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`
- Expo location plugin configured with `locationAlwaysAndWhenInUsePermission`

Note: background location isn't actually wired up in `App.js` yet — the manifest entries are there for future use. Current "background/heads-up mode" is just the keep-awake toggle.

## Known gaps / next work

- **No app icon or splash screen art.** `app.json` references `./assets/icon.png`, `./assets/splash.png`, `./assets/adaptive-icon.png`, `./assets/favicon.png` — none of these files exist. Expo will fall back to defaults but `eas build` will complain.
- **No background/driving mode.** The user wanted "background/heads-up mode" in v1. Current implementation is keep-awake only. True background would need `expo-task-manager` + `Location.startLocationUpdatesAsync` + a foreground service on Android.
- **HERE key is client-embedded.** Fine for local testing, needs a proxy before any kind of distribution.
- **No trip history / max speed recorder.** Easy add: useReducer with a ring buffer of (t, speed, lat, lon) samples.
- **No speed smoothing.** The raw OS speed value can jitter near zero; a 1-sec EMA would feel nicer.

## Running

```bash
npm install
npx expo start
```

Scan the QR with Expo Go on iPhone/Android. The phone needs to be on the same network as the dev machine. Grant location permission on first launch.

Test the parser logic with `node test-parse.js` (the file lives in the session outputs folder if it was copied back; otherwise the tests are inline in the function and easy to recreate).

## Files

```
Speed Limit/
  App.js              # main component + all logic (~445 lines)
  app.json            # Expo config, permissions, bundle IDs
  package.json        # deps
  babel.config.js
  .gitignore
  README.md           # user-facing setup docs
  CLAUDE.md           # this file — orient yourself here first
```
