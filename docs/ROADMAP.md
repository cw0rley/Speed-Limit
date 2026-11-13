# Speed Limit — plan (v2)

_Last updated 2026-11-13. Decisions and research notes are at the bottom._

## What we're building

The app shows your current speed and the posted limit for the road you're on, on the phone and —
on iPhone — as a live tile on the **CarPlay Dashboard** and Lock Screen. It is **free, with no
ads and no subscription** (decided 2026-11-13; see Decisions).

The whole project exists because two things broke: **HERE billed ~$1,000** unexpectedly (so it was
switched off, leaving the store app barely able to find limits), and **Apple refused** the CarPlay
Navigation entitlement (so the full-screen CarPlay sign is impossible).

## How a speed limit is found (today)

1. **OpenStreetMap, downloaded by area.** All drivable roads in ~1 mile ahead come down in one
   request; every GPS fix is matched to a road on the device using distance, heading and one-way
   direction. Downloaded areas are **kept on the phone for 14 days**, so a commute re-downloads
   nothing.
2. **Inherited within a road.** OSM splits roads into many pieces and tags only some. An untagged
   piece uses the limit from another piece of the same road when they all agree. Free.
3. **TomTom, only if OSM can't answer**, through our Cloudflare Worker:
   - **highways / ramps → Snap to Roads** (reverse geocoding returns a nearby side street there),
   - **everything else → Reverse Geocode**,
   - once per road per drive, at most one call per 30 s, with hard daily caps.
4. **Nothing known → `--`.** The previous road's limit is never shown.

## Money

**There is none, and that is the decision.** Free, no ads, no subscription.

Why, in short:

- **Ads cannot fund the paid data source.** A banner in a driving app is worth roughly
  $0.50–0.80/user/month at best, against ~$1.75/user/month for TomTom at the measured call rate.
  They would buy a worse product, not a better one.
- **Ads have nowhere safe to go** in an app you look at while driving — not the main screen, not
  CarPlay, not the Live Activity — and Apple reviews driver distraction closely.
- **Free deletes the whole blocked list**: the TomTom licensing answer, the Paid Apps Agreement,
  RevenueCat, App Review's subscription scrutiny, and taking access away from existing users.
- **OSM turned out to be good enough to try.** 73 % of road length around Clayton NC carries a
  maxspeed tag — not the ~11 % this project had assumed from a mis-counted NJ sample.

**What a free release costs to run: nothing per user.** A production build never calls TomTom
(`lookup/tomtom.js` refuses without a token or subscriber id), so the store app is OSM-only.

**The one real cost is Overpass.** The app reads the public, donated Overpass servers. That is
fine at today's scale and is *not* fine at a few thousand users — their usage policy does not
cover it, and you would be throttled (you already see 502s). Before any real growth that means
self-hosting an OSM extract or switching to a vector-tile source. **That cost exists whether or
not the app charges**, and it is the only argument left for ever having revenue.

**Subscription code stays in the tree, switched off** (`subscription.mode = "off"`). It is built
and unit-tested; parking it costs nothing and deleting it would throw away work that a future
"Pro unlock for TomTom coverage" would want.

## Never-billed-again rules

1. TomTom account stays on the **free plan with no card**. Over the allowance it returns 429.
2. The key lives **only** in the Cloudflare Worker; the app can't call TomTom directly.
3. Worker caps: **600/day ceiling** (set to 200), **80/day snap ceiling** (set to 40), 60/hour per
   device, counted in a database *before* each call, and it refuses if anything fails.
4. **Kill switch**: one config change switches TomTom off.
5. Old app versions can't reach HERE: the old route returns "gone".
6. All of this was drilled live on 2026-09-17 and matched TomTom's own dashboard.

## Status

**Done**
- OSM area download + on-device road matching, inheritance within a road, 14-day map reuse
- TomTom behind the Worker with the caps, kill switch and test-only access
- Snap to Roads for highways (verified: correct 55 mph where reverse geocoding gave nothing)
- CarPlay Live Activity (Dashboard + Lock Screen + Dynamic Island), drive mode with idle stop
- CarPlay text screen (Driving Task entitlement, which Apple did grant)
- Fixes for the "stuck on 55" and frozen-screen bugs, with regression tests
- Paywall, "becoming a subscription" banner, Settings subscription section — **parked, off**
- Worker can serve only active subscribers (RevenueCat), fails closed — **parked, unused**
- Android Auto manifest entry removed (the Play policy pull of 2026-08-20)
- OSM coverage levers: inherit from nearest piece, statutory-default tags, nearby-zone defaults
- `tools/osm-coverage.mjs`, which measures all of the above on a real area
- Privacy policy rewritten; unused background mode removed; README rewritten
- 36 automated tests

**Waiting on you**
- Drive **build 32** and send Lookup stats — it still went blank for a long stretch on 2026-11-05
- Build the Android bundle and upload it to **every** Play track (the listing is still rolled back)
- Verify `US-NC:urban` (35) / `US-NC:rural` (55) in `lookup/zoneLimits.js` against statute
- Old HERE account: delete the key, remove the card

**No longer blocking** (free release)
- Apple Paid Apps Agreement, subscription products, RevenueCat — not needed
- TomTom licensing: store builds never call TomTom, so the sales answer only governs **your own
  test builds**, which are evaluation use. Worth having, no longer on the critical path.

## Plan from here

### Step 1 — Make the limit stay on screen (blocking)
Build 32 still went blank for a long stretch. Read the Lookup stats, in particular **Map
downloads / failed / timed out** — the `areaStore` fix made the device cache stricter, so the
engine leans harder on Overpass, and Overpass is flaky. Likely next fix: hold the stale box in
memory while a download retries, instead of showing nothing.

### Step 2 — Un-pull the Play listing
Build the Android bundle and upload to every track. Independent of everything else, and it is the
only thing currently broken for real users.

### Step 3 — Ship the free release
Phone + CarPlay Live Activity, OSM-only. No store agreements needed, no provider answer needed.

### Step 4 — Watch Overpass
If installs grow, the public servers will throttle. Plan a self-hosted extract or a vector-tile
source before that bites.

### Step 5 — After launch
Expo SDK upgrade, Android drive mode, trip history, speed smoothing, splitting `App.js` further.
Revisit paid only if there is real usage, and then as a one-off "Pro" unlock for TomTom coverage
rather than ads or a mandatory subscription.

## Decisions (2026-09-16 → 09-28)

- **Evolve the existing app** (same bundle id, same store listings); SDK upgrade deferred to after launch.
- ~~**Subscription only**, $2.99 / $24.99 / 7-day trial, existing free users lose free access.~~
  **Superseded 2026-11-13: free, no ads, no subscription.** See Money above. The code stays, off.
- **OSM first, TomTom fallback.** HERE **ruled out** (no card-free hard stop; even contacting them needs a card).
- **CarPlay via Live Activity** — Apple refused the Navigation entitlement; Driving Task was granted.
- **Google Play can't convert a free app to paid**, hence in-app subscription.
- **No shared server cache of TomTom answers** (their terms forbid serving one result to many users).

## Open questions

1. Why does the limit still drop out for long stretches on build 32?
2. Is OSM-only coverage good enough to be worth shipping? (73 % of road length by the map; the
   drive will say what that feels like.)
3. At what install count does Overpass throttle us, and what replaces it?
4. Android: any equivalent of the CarPlay tile (an ongoing notification)?
