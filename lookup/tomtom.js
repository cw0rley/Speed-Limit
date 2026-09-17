// TomTom speed limits via our Cloudflare Worker (the key never ships in the app).
// Returns { status: 'hit', limit } | { status: 'miss' } | { status: 'backoff' }
// | { status: 'error' }. 'backoff' = the Worker is capped, rate limited, off, or
// this build isn't allowed; the caller should stop asking for a while.
//
// While TomTom is limited to test builds, only builds made with the
// `testflight` EAS profile carry EXPO_PUBLIC_TEST_CLIENT_TOKEN (an EAS
// environment variable, never committed). Builds without it never call TomTom.

import { fetchWithTimeout } from './net.js';

export const PROXY_URL = 'https://speed-limit-proxy.prcunningham.workers.dev';
const TIMEOUT_MS = 5000;

// Must be referenced literally so Metro inlines it at build time.
const BUILD_CLIENT_TOKEN = process.env.EXPO_PUBLIC_TEST_CLIENT_TOKEN || '';
export const TOMTOM_TEST_BUILD = BUILD_CLIENT_TOKEN.length > 0;

export async function fetchTomTomLimit(
  lat,
  lon,
  heading,
  { signal, fetchImpl, proxyUrl = PROXY_URL, clientToken = BUILD_CLIENT_TOKEN } = {}
) {
  if (!clientToken) return { status: 'backoff' }; // this build isn't allowed to use TomTom

  // 4 decimals (~11 m): all the precision a speed-limit lookup needs, and what
  // the privacy policy promises.
  let url = `${proxyUrl}/limit?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
  if (heading != null && heading >= 0) url += `&heading=${Math.round(heading)}`;
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { 'X-Client-Token': clientToken } },
      TIMEOUT_MS,
      signal,
      fetchImpl
    );
    if (res.status === 403 || res.status === 429 || res.status === 503) return { status: 'backoff' };
    if (!res.ok) return { status: 'error' };
    const data = await res.json();
    const valid =
      typeof data.value === 'number' &&
      data.value > 0 &&
      (data.unit === 'mph' || data.unit === 'kmh');
    return valid
      ? { status: 'hit', limit: { value: data.value, unit: data.unit, source: 'tomtom' } }
      : { status: 'miss' };
  } catch (e) {
    if (signal && signal.aborted) throw e;
    return { status: 'error' };
  }
}
