# Speed Limit — HERE API Proxy (Cloudflare Worker)

A minimal Cloudflare Worker that proxies requests to the HERE Routing v8 API, keeping the API key server-side.

## Setup

1. Install Wrangler (Cloudflare's CLI):

   ```bash
   npm install -g wrangler
   ```

2. Authenticate with Cloudflare:

   ```bash
   npx wrangler login
   ```

3. Set the HERE API key as a secret:

   ```bash
   cd proxy
   npx wrangler secret put HERE_API_KEY
   ```

   Paste your HERE API key when prompted.

4. Deploy:

   ```bash
   npx wrangler deploy
   ```

   This will print the worker URL, e.g. `https://speed-limit-proxy.<your-subdomain>.workers.dev`.

5. Update the app — set `PROXY_URL` in `App.js` to your worker URL:

   ```js
   const PROXY_URL = 'https://speed-limit-proxy.<your-subdomain>.workers.dev';
   ```

## How it works

The worker exposes a single endpoint:

```
GET /here-route?transportMode=car&origin=LAT,LON&destination=LAT,LON&return=polyline&spans=speedLimit
```

It forwards only the allowed query parameters (`transportMode`, `origin`, `destination`, `return`, `spans`) to `https://router.hereapi.com/v8/routes`, appends the API key from the secret store, and returns the response.

## Local development

```bash
cd proxy
npx wrangler dev
```

This starts a local dev server (default `http://localhost:8787`). You can set the secret locally via a `.dev.vars` file:

```
HERE_API_KEY=your_key_here
```

Do NOT commit `.dev.vars` — it is listed in `.gitignore`.

## Security notes

- The worker only allows specific query parameters to prevent misuse.
- CORS headers are set to `*` for simplicity. For production, restrict `Access-Control-Allow-Origin` to your app's origin or remove it entirely (mobile apps don't enforce CORS).
- Rate limiting can be added via Cloudflare's built-in rate limiting rules if needed.
