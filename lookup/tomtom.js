// TomTom speed limits via our Cloudflare Worker (the key never ships in the app).
// Returns { status: 'hit', limit } | { status: 'miss' } | { status: 'backoff' }
// | { status: 'error' }. 'backoff' = the Worker is capped, rate limited or
// switched off; the caller should stop asking for a while.

import { fetchWithTimeout } from './net.js';

export const PROXY_URL = 'https://speed-limit-proxy.prcunningham.workers.dev';
const TIMEOUT_MS = 5000;

export async function fetchTomTomLimit(lat, lon, heading, { signal, fetchImpl, proxyUrl = PROXY_URL } = {}) {
  let url = `${proxyUrl}/limit?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`;
  if (heading != null && heading >= 0) url += `&heading=${Math.round(heading)}`;
  try {
    const res = await fetchWithTimeout(url, {}, TIMEOUT_MS, signal, fetchImpl);
    if (res.status === 429 || res.status === 503) return { status: 'backoff' };
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
