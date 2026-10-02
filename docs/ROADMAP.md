# Speed Limit — plan (v2)

_Last updated 2026-10-02. Decisions and research notes are at the bottom._

## What we're building

The app shows your current speed and the posted limit for the road you're on, on the phone and —
on iPhone — as a live tile on the **CarPlay Dashboard** and Lock Screen. It is becoming a **paid
subscription** ($2.99/month, $24.99/year, 7-day free trial, no free tier).

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

| | |
|---|---|
| Price | $2.99/month, $24.99/year, 7-day free trial |
| Store fee | 15% (Small Business Program / Play) |
| Data cost | TomTom free: 20,000 reverse-geocode + 2,500 snap per month, account-wide |
| Measured | One real drive (2026-09-22, before the savings work) used **116 lookups** |
| Risk | At that rate, ~3,500/user/month ≈ **$1.75/user/month** if paid — too close to the price |

The savings work (steps 1–2 above) is meant to cut that a lot; **the next drive's numbers decide
whether the price works.**

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
- Paywall, "becoming a subscription" banner, Settings subscription section — **switched off**
- Worker can serve only active subscribers (RevenueCat), fails closed
- Privacy policy rewritten; unused background mode removed; README rewritten
- 36 automated tests

**Waiting on you**
- Submit + drive **build 30**, then send Lookup stats
- Store setup: Apple agreements, 2 subscription products, RevenueCat account ([STORE-SETUP.md](STORE-SETUP.md))
- Decisions: keep the Live Activity? privacy policy URL? subscription start date? confirm 7-day trial
- Old HERE account: delete the key, remove the card

**Waiting on TomTom** (sales form, 2026-09-28)
- Commercial use on the free/prepaid plan
- **CarPlay** ("Automotive Usage" exclusion) — the one that matters
- On-device caching duration
- Prepaid hard cap confirmation

## Plan from here

### Step 1 — Prove the accuracy and the cost (needs a drive)
Drive build 30; read Lookup stats. Expect far fewer TomTom calls and limits on highways.
If a road type is still blank, that's the next fix.

### Step 2 — Store setup (parallel, needs you)
Apple agreements, products, RevenueCat. Nothing here depends on TomTom.

### Step 3 — Decide the CarPlay question
- TomTom says CarPlay is fine → ship everything.
- TomTom says no → ship **phone-only** (no CarPlay tile), or keep CarPlay on OSM-only data.
- No answer in ~2 weeks → treat as "no" and pick one of the above.

### Step 4 — Notice release
`subscription.mode = "notice"`: app still free, a banner announces the date, the trial can be
started early. Release notes explain it. ~2 weeks before the switch.

### Step 5 — Paywall release
`mode = "required"`, Worker switched to subscribers-only. Watch usage and cost daily for the
first weeks.

### Step 6 — After launch
Expo SDK upgrade, Android drive mode, trip history, speed smoothing, splitting `App.js` further.

## Decisions (2026-09-16 → 09-28)

- **Evolve the existing app** (same bundle id, same store listings); SDK upgrade deferred to after launch.
- **Subscription only**; existing free users do **not** keep free access (softened by the notice release + trial).
- **$2.99 / $24.99 / 7-day trial.**
- **OSM first, TomTom fallback.** HERE **ruled out** (no card-free hard stop; even contacting them needs a card).
- **CarPlay via Live Activity** — Apple refused the Navigation entitlement; Driving Task was granted.
- **Google Play can't convert a free app to paid**, hence in-app subscription.
- **No shared server cache of TomTom answers** (their terms forbid serving one result to many users).

## Open questions

1. Android: any equivalent of the CarPlay tile (an ongoing notification)?
2. Is OSM + TomTom coverage good enough on the roads you actually drive?
3. Does the price clear the data cost once the savings work is measured?
