# Speed Limit

A cross-platform (iOS + Android) React Native app built with Expo that shows your current GPS
speed alongside the posted speed limit of the road you're on. On iPhone it can also show a live
speed + speed-limit tile on the **CarPlay Dashboard** and the Lock Screen.

> Developer notes and the current plan live in [`CLAUDE.md`](CLAUDE.md) and
> [`docs/ROADMAP.md`](docs/ROADMAP.md) — those are the source of truth. This file is the short
> user-facing version.

## Features

- Large, glanceable current-speed readout (portrait and landscape layouts)
- Posted speed limit for the road you're on, matched on the device from **OpenStreetMap** road
  data, with **TomTom** as a fallback where OSM has no limit (test builds only for now)
- MPH / KM/H unit toggle
- **Speed-alert thresholds** — the speed turns yellow / orange / red as you go further over the
  limit (defaults: +3 / +8 / +10), with one vibration when you cross it
- Screen stays awake automatically for heads-up / dashboard use
- **Drive mode** ("Show on CarPlay", iPhone): keeps the speed and sign updating on the CarPlay
  Dashboard, Lock Screen and Dynamic Island while the phone is locked; switches itself off after
  10 minutes parked
- **Lookup stats** in Settings: how often a limit was found, and what it cost
- Works on both iPhone and Android from a single codebase (drive mode is iPhone-only)

## How the speed limit is found

1. All drivable roads in roughly a square mile ahead are downloaded once from **OpenStreetMap**
   and matched to your position on the device (direction of travel included, so parallel roads
   and one-way pairs resolve correctly). Downloaded areas are reused on later drives.
2. If the matched road has no speed limit, another piece of the **same road** supplies it when
   they agree.
3. Only if that fails does the app ask **TomTom**, through a Cloudflare Worker that holds the API
   key and enforces hard daily caps (see [`proxy/README.md`](proxy/README.md)). Highways use
   TomTom's Snap to Roads; other roads use reverse geocoding.
4. If nothing is known, the sign shows `--`. The app never shows the previous road's limit.

**Always obey the actual posted signs** — map data can be wrong, missing or out of date.

## Prerequisites

- Node.js 18 or newer
- An iPhone or Android phone for testing
- Expo Go is fine for the basic phone UI, but **CarPlay, drive mode and subscriptions need an EAS
  build** on a real device — they don't work in Expo Go

## Quick start (development)

```bash
npm install
npx expo start
```

Scan the QR code with Expo Go (Android) or the iPhone camera (iOS), and grant the location
permission. Go outside or near a window for a GPS fix.

Run the tests (no extra tooling needed):

```bash
npm test
```

## Building

```bash
npm install -g eas-cli
eas login
eas build -p ios --profile testflight      # test build (uses TomTom; TestFlight only)
eas build -p ios --profile production      # App Store build
eas build -p android --profile preview     # APK you can sideload
eas submit -p ios --latest
```

`testflight` builds carry a private token that lets them use TomTom — **never submit one for App
Store review**. Build and submit settings live in `eas.json`.

## Project layout

| Path | What's in it |
|---|---|
| `App.js` | UI, drive mode, CarPlay screen, Live Activity updates |
| `lookup/` | Speed-limit engine: OSM area download + road matching, TomTom fallback, stats (+ tests) |
| `subscription/` | RevenueCat paywall, notice banner, subscription state (+ tests) |
| `targets/live-activity/` | The SwiftUI tile shown on CarPlay / Lock Screen |
| `modules/speed-limit-activity/` | Small native module that drives that tile |
| `proxy/` | Cloudflare Worker holding the TomTom key, with the spending caps |
| `docs/` | Roadmap and store-setup steps |

## Privacy

Location is used to show your speed and look up limits, and is never stored as history. See
[`privacy-policy.html`](privacy-policy.html).
