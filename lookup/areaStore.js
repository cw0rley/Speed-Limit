// Keeps downloaded OpenStreetMap road data on the device so a repeated route
// (a commute) needs no download at all. Only OSM data is stored — OSM's licence
// allows it. TomTom answers are NEVER stored here (their terms limit caching,
// and the question is still open with them).
//
// Records are bucketed by a ~1.1 km grid cell of the fix, so the same route
// hits the same buckets. Storage is injected (AsyncStorage in the app, a plain
// Map in tests) and only needs getItem / setItem / removeItem.

import { areaContains, parseArea } from './osmArea.js';

const PREFIX = '@speed_limit_area:';
const INDEX_KEY = '@speed_limit_area_index';
const BUCKET_DECIMALS = 2; // ~1.1 km
const MAX_RECORDS = 15;
const MAX_RECORD_BYTES = 400 * 1024;
export const AREA_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // speed limits change rarely

export function bucketKey(lat, lon) {
  return `${lat.toFixed(BUCKET_DECIMALS)},${lon.toFixed(BUCKET_DECIMALS)}`;
}

export function createAreaStore(storage, { maxAgeMs = AREA_MAX_AGE_MS, now = () => Date.now() } = {}) {
  if (!storage) return null;

  async function readIndex() {
    try {
      const raw = await storage.getItem(INDEX_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  async function writeIndex(list) {
    try {
      await storage.setItem(INDEX_KEY, JSON.stringify(list));
    } catch (_) {
      // out of space / unavailable: caching is best-effort
    }
  }

  return {
    // A stored area covering this fix (with the usual edge margin), or null.
    async get(lat, lon) {
      try {
        const raw = await storage.getItem(PREFIX + bucketKey(lat, lon));
        if (!raw) return null;
        const rec = JSON.parse(raw);
        if (!rec || !rec.box || !rec.elements) return null;
        if (now() - rec.fetchedAt > maxAgeMs) return null;
        const area = parseArea({ elements: rec.elements }, rec.box);
        area.fetchedAt = rec.fetchedAt;
        area.fromStore = true;
        return areaContains(area, lat, lon) ? area : null;
      } catch (_) {
        return null;
      }
    },

    // Store the raw Overpass elements for the bucket the fix is in.
    async put(lat, lon, elements, box) {
      const key = PREFIX + bucketKey(lat, lon);
      const body = JSON.stringify({ box, elements, fetchedAt: now() });
      if (body.length > MAX_RECORD_BYTES) return;
      try {
        await storage.setItem(key, body);
      } catch (_) {
        return;
      }
      const index = (await readIndex()).filter((k) => k !== key);
      index.push(key);
      while (index.length > MAX_RECORDS) {
        const oldest = index.shift();
        try {
          await storage.removeItem(oldest);
        } catch (_) {
          // ignore
        }
      }
      await writeIndex(index);
    },

    async clear() {
      const index = await readIndex();
      for (const key of index) {
        try {
          await storage.removeItem(key);
        } catch (_) {
          // ignore
        }
      }
      await writeIndex([]);
    },
  };
}
