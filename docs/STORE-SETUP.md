# Store + subscription setup (things only the account owner can do)

Everything in the app is already built; it stays switched off until the steps below are done.
Decided: **$2.99/month, $24.99/year, 7-day free trial, subscription only** (existing free users
do not keep free access).

---

## 1. App Store Connect (Apple)

1. **Paid Apps Agreement** — appstoreconnect.apple.com → **Business** → accept the agreement, then
   fill in **tax forms** and **bank details**. Subscriptions cannot be sold until this says Active.
2. **Small Business Program** — developer.apple.com/app-store/small-business-program → apply.
   Apple's commission drops from 30% to 15% (proceeds under $1M/year).
3. **Subscription group** — App Store Connect → the app → **Subscriptions** → create a group named
   `Speed Limit`. (A group lets people switch between monthly and yearly.)
4. **Two products in that group:**

   | Reference name | Product ID | Duration | Price |
   |---|---|---|---|
   | Speed Limit Monthly | `speedlimit_monthly` | 1 month | $2.99 |
   | Speed Limit Yearly | `speedlimit_annual` | 1 year | $24.99 |

   For each: add a **localized display name** and **description**, then
   **Introductory Offer → Free → 1 week → New subscribers**.
5. **Review information** — a screenshot of the paywall is required before submission. Take one
   from a TestFlight build once the paywall is switched on.

## 2. RevenueCat (free)

1. Create a project at app.revenuecat.com, add an **App Store** app with bundle id
   `com.claytonrugby.speedlimit`.
2. Upload the **In-App Purchase Key** RevenueCat asks for (App Store Connect → **Users and Access**
   → **Integrations** → In-App Purchase → generate a key, download the `.p8`).
3. **Entitlement** → create one with id **`pro`**.
4. **Products** → import `speedlimit_monthly` and `speedlimit_annual`, attach both to `pro`.
5. **Offering** → create `default`, add a **Monthly** package (monthly product) and an **Annual**
   package (yearly product).
6. **Keys** (Project settings → API keys):
   - **Public SDK key** (`appl_…`) → paste into `app.json` at `expo.extra.subscription.iosApiKey`.
     This one ships inside the app and is safe there.
   - **Secret key** (`sk_…`) → **do not put it in the app**. Store it on the Worker:
     ```powershell
     cd proxy
     ```
     ```powershell
     npx wrangler secret put REVENUECAT_SECRET_KEY
     ```

## 3. Privacy policy

- Host the rewritten `privacy-policy.html` and put its URL in
  `app.json` → `expo.extra.subscription.privacyUrl` (the paywall links to it) **and** in App Store
  Connect. Publish it only when the release that uses TomTom/RevenueCat ships.

## 4. Switching the app on (me, after the above)

`app.json` → `expo.extra.subscription`:

```jsonc
{
  "mode": "notice",          // "notice" release first, then "required"
  "startDate": "2026-11-01", // shown in the banner; ~2 weeks after the notice release
  "iosApiKey": "appl_…",
  "androidApiKey": "",
  "privacyUrl": "https://…"
}
```

Worker (`proxy/wrangler.toml`), once subscribers should be served instead of test builds:

```toml
TOMTOM_ACCESS = "subscribers"   # or "both" while testing
```
then `npx wrangler deploy`. The Worker checks the app user id against RevenueCat, remembers the
answer for 10 minutes, and **fails closed** if RevenueCat can't be reached.

## 5. Release order

1. **Notice release** — `mode: "notice"`, subscription products live, paywall reachable from the
   banner and Settings. Release notes explain the change and the date.
2. **~2 weeks later, paywall release** — `mode: "required"`, Worker `TOMTOM_ACCESS = "subscribers"`.
3. Watch `https://speed-limit-proxy.prcunningham.workers.dev/usage` and the TomTom dashboard daily
   for the first weeks; raise `DAILY_CAP` only within the free allowance.

## Not done / blocked

- **TomTom licensing** (case CS0014609) must be answered before a **store** build uses TomTom:
  commercial use on the free/prepaid plan, CarPlay ("Automotive Usage"), and on-device caching.
- Google Play: same subscription products would need creating in Play Console; Android has no
  drive mode yet.
