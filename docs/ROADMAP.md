# Speed Limit — Roadmap (v2: paid app, new data provider, CarPlay Live Activity)

_Decided 2026-09-16. Research notes (with sources) are summarized at the bottom._

## Decisions

| Area | Decision |
|---|---|
| Scope | **Evolve the existing app** (same bundle id `com.claytonrugby.speedlimit`, same store listings). Upgrade Expo to **SDK 56+**. Split `App.js` into modules as we touch it. |
| Business model | **Subscription only** — free download, free trial via introductory offer, then auto-renewing subscription. No free tier. |
| Speed-limit data | **OSM first, TomTom fallback.** HERE ruled out 2026-09-21 (no card-free hard stop). TomTom Reverse Geocode (`returnSpeedLimit=true`) is called only when OSM has no `maxspeed`, and only through the Cloudflare Worker. HERE stays off. |
| CarPlay | **Live Activity** (small family) on the CarPlay dashboard — no entitlement needed. The full-screen `MapTemplate` branch is dead — **Apple refused the Navigation entitlement** (Case-ID 21844634, 2026-09-16). |

## Why these choices

- **Google Play cannot turn an existing free app into a paid-upfront app**, and a one-time price doesn't cover a per-user recurring API cost → in-app subscription.
- **TomTom Freemium returns HTTP 429 instead of billing** when the free allowance (20k req/month, account-wide) runs out — the hard stop HERE never had. Pay-as-you-grow is ~US$0.50 / 1k (third-party figure, unverified).
- **A CarPlay widget can't show live speed** (WidgetKit refreshes every ~15–60 min). A **Live Activity** can be updated by the app while it runs in the background, and appears in CarPlay on iOS 26+ without any CarPlay entitlement.

## Phase 0 — Foundations

- [ ] Upgrade Expo SDK 54 → 56+ (one SDK at a time, `npx expo install --fix`), check `@iternio/react-native-auto-play`, `react-native-nitro-modules`, `babel-preset-expo` (currently pinned to ^55 on SDK 54 — mismatch).
- [ ] Split `App.js` into modules — `lookup/` done (2026-09-17); `carplay/`, `settings/`, UI components still to do.
- [x] **Remove the embedded `HERE_API_KEY`** from `App.js` (done). Still to do: revoke it on the HERE account.
- [x] Delete dead HERE code; Worker `/here-route` now returns 410 (deployed 2026-09-17).

## Phase 1 — Lookup rework (do first: no provider is safe without it)

- [x] **Fix the throttle** (replaced by the area-match engine in `lookup/`, 2026-09-17). Today: fetch if moved ≥40 m **or** ≥15 s elapsed → ~1 call per 40 m at speed (~2,400/hr). New gate: require a minimum interval (e.g. ≥10 s) **and** movement to a new grid cell / new road; back off further when the limit hasn't changed.
- [x] Cache **negative** results (OSM miss) per cell for a short TTL so unmapped roads don't hammer the paid fallback.
- [x] Provider layer: `osm` → `tomtom`, each returning `{ value, unit, source }`.
- [x] Worker route `GET /limit?lat&lon` → TomTom Reverse Geocode with `returnSpeedLimit=true`; key as Worker secret `TOMTOM_API_KEY`.
- [x] Worker safety: D1 daily cap + per-IP cap, fail closed, kill switch (OFF), `/usage`. Shared cache dropped — TomTom T&Cs §11.4 forbid it.
- [ ] **Cap drill** before enabling TomTom: cap 5 → 10 calls → 6–10 refused, TomTom dashboard shows 5, kill switch stops all; ~10-call billing-category check.
- [ ] Stay on TomTom **Freemium** until usage is understood; set up alerts before moving to pay-as-you-grow.
- [x] Read TomTom T&Cs (shared caching forbidden; free licence "Evaluation Use"; "Automotive Usage" excluded) — written questions sent to TomTom and HERE 2026-09-17; awaiting replies.

## Phase 2 — Subscription

- [ ] Accept Apple **Paid Apps Agreement**, tax + banking; apply to **App Store Small Business Program** (15%). Set up Google Play payments profile.
- [ ] Create subscription products (monthly + annual, with free-trial intro offer) in App Store Connect and Play Console.
- [x] Integrate **RevenueCat** (`react-native-purchases`) with a custom paywall + notice banner (`subscription/`, 2026-09-17). Off by config until products and keys exist.
- [x] Paywall shows price, period, trial, auto-renew + cancel info, **Restore Purchases**, Terms of Use and Privacy Policy links (App Review 3.1.1 / 3.1.2). Needs the hosted privacy URL in config.
- [ ] Worker gates `/limit` on an active entitlement (RevenueCat REST `GET /subscribers/{id}`, cached in KV a few minutes; RevenueCat webhooks to invalidate).
- [ ] Update `privacy-policy.html` (location sent to TomTom via our Worker; purchase data via RevenueCat) and store privacy labels.
- [ ] Pricing: set price above worst-case monthly API cost per heavy user after the 15% store fee.
- [ ] **Existing free users** — decided: no free access. Soften it: an in-app notice in the release *before* the paywall ships, clear release notes, and the trial so current users can keep using it for a week before paying.

## Phase 3 — CarPlay Live Activity

_Prototype built on `feat/carplay-live-activity` (2026-09-16) with `@bacons/apple-targets` on SDK 54 — awaiting first EAS build + in-car test._

- [ ] **Prototype first**: can the app update a Live Activity ~1 Hz in the background, and how often does CarPlay actually redraw it? Test in CarPlay Simulator + a real car. If it's heavily coalesced, show the **limit** (changes rarely) prominently and speed as best-effort.
- [ ] Background location: `UIBackgroundModes: location`, `Location.startLocationUpdatesAsync` + `expo-task-manager` (already a dependency), Android foreground service if we want parity. Justify in App Review notes (2.5.4); watch battery (2.4.2); frame as compliance aid (1.4.4).
- [ ] Build the Live Activity with `supplementalActivityFamilies([.small])` via official **`expo-widgets`** (SDK 56+). Fallback: SwiftUI via `@bacons/apple-targets` + a small ActivityKit native module.
- [ ] Start activity when a drive starts (app in foreground), end on stop / after 8 h limit. Payload ≤ 4 KB.
- [ ] App Group data must not use data-protection class A/B (widget/activity must work with phone locked).
- [ ] Park `feat/carplay-grid-display` (`MapTemplate`, `carplay-maps` entitlement). Note: the **Driving Task** entitlement was granted 2026-08-25 — useful because a CarPlay widget/Live Activity can only open the app from CarPlay if the app is also a CarPlay app.

## Phase 4 — Release

- [ ] Remove `withCarPlay` `carplay-maps` changes from the release branch (builds won't sign with it).
- [ ] Store listing copy + screenshots for subscription and CarPlay.
- [ ] TestFlight / internal track with real drives; watch Worker call counts and TomTom usage daily for the first weeks.

## Decisions (2026-09-17)

- **Existing free users do NOT keep free access** — everyone hits the paywall after the update.
- **Price: $2.99/month and $24.99/year.**
- **Trial: 7-day free trial** (Apple introductory offer / Google free trial) on both plans — recommended; confirm before creating the products.

## Open questions

1. Android: Android Auto was stripped after a Play rejection — any Android equivalent of the Live Activity (ongoing notification) wanted?
2. Is OSM + TomTom coverage good enough in the areas you drive? Test before committing to launch.

## Research summary (2026-09-16)

**Providers** — TomTom Reverse Geocode `returnSpeedLimit=true` (20k/mo free, 429 when exceeded; ~$0.50/1k paid, third-party figure). Google Roads speed limits need an Asset Tracking licence ($20/1k). Mapbox Map Matching `maxspeed` is beta and its terms forbid caching ($2/1k after 100k). Esri SnapToRoads $4/1k points, no free tier. HERE: `departureTime=any` avoids the Time Aware Routing bucket; reverse-geocode speed limits are premium/contact sales. Self-hosted Valhalla / on-device OSM extract: no per-call cost, same OSM coverage gaps.
Docs: https://docs.tomtom.com/reverse-geocoding-api/documentation/reverse-geocode · https://docs.tomtom.com/pricing · https://developers.google.com/maps/documentation/roads/speed-limits · https://www.mapbox.com/legal/product-terms

**Paid app** — Play: free apps "can't be changed to paid" (https://support.google.com/googleplay/android-developer/answer/6334373). RevenueCat free to $2.5K MTR then 1%. `react-native-iap` / `expo-iap` repos moved to hyodotdev/openiap (Aug 2026). Apple Small Business Program 15%; Play subscriptions 15%.

**CarPlay** — "Your app does not need to be a CarPlay app to support widgets and Live Activities in CarPlay" (CarPlay Developer Guide, June 2026). Widgets: `.systemSmall`. Live Activities: `supplementalActivityFamilies([.small])`, updatable from the app while running in the background, can't fetch network/location themselves, 4 KB, 8 h. Navigation category requires turn-by-turn guidance. `expo-widgets` stable since SDK 56; `expo-live-activity` is deprecated.
Docs: https://developer.apple.com/download/files/CarPlay-Developer-Guide.pdf · https://developer.apple.com/videos/play/wwdc2025/216/ · https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities
