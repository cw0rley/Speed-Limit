// Speed-limit engine: turns a stream of GPS fixes into "the limit for the road
// I'm on", using as few network calls as possible.
//
//   1. OpenStreetMap area (lookup/osmArea.js): one download per ~1.6 km box,
//      then every fix is matched to a road on the device.
//   2. TomTom (lookup/tomtom.js, through our capped Worker) only for a matched
//      road that has no OSM maxspeed — asked ONCE per road (and direction) per
//      session — or, if OSM is unavailable, per ~11 m cell. Calls are spaced at
//      least TOMTOM_MIN_INTERVAL_MS apart and stop for TOMTOM_BACKOFF_MS when
//      the Worker says it's capped or switched off. Only asked while moving.
//
// Display rules:
//   - A new road's limit must be seen on 2 consecutive fixes before it replaces
//     the current one (avoids flicker at intersections).
//   - A matched road with no known limit shows "--" — never the previous road's
//     limit.
//   - If nothing can be confirmed for STALE_AFTER_MS while moving, show "--".
//
// Everything that touches the network or the clock is injected, so the engine
// runs under node tests (lookup/__tests__).

import {
  fetchArea as defaultFetchArea,
  areaBoxFor,
  areaContains,
  areaNeedsRefresh,
  matchRoad,
} from './osmArea.js';
import { fetchTomTomLimit as defaultFetchTomTom } from './tomtom.js';

export const TOMTOM_MIN_INTERVAL_MS = 30 * 1000;
export const TOMTOM_BACKOFF_MS = 10 * 60 * 1000;
const TOMTOM_CELL_MISS_TTL_MS = 10 * 60 * 1000;
const AREA_RETRY_BASE_MS = 15 * 1000;
const AREA_RETRY_MAX_MS = 2 * 60 * 1000;
const STALE_AFTER_MS = 60 * 1000;
const MOVING_MPS = 2; // ~4.5 mph
const MAX_ACCURACY_M = 50; // ignore worse fixes for matching
const CONFIRM_FIXES = 2;
// Watchdogs, checked on every fix (not timers: with the phone locked, JS
// timers — including fetch timeouts — may not fire, and a hung request would
// otherwise block new map downloads for the rest of the drive).
const AREA_WATCHDOG_MS = 25 * 1000;
const TOMTOM_WATCHDOG_MS = 12 * 1000;
const MAP_MAX = 2000;
const CELL_PRECISION = 4;

export function emptyStats() {
  return {
    since: Date.now(),
    movingSeconds: 0,
    osmSeconds: 0, // moving with a limit from OSM (tagged on this road)
    inferredSeconds: 0, // …from another piece of the same road
    tomtomSeconds: 0, // moving with a limit from TomTom
    unknownSeconds: 0, // moving with no limit shown
    areaFetches: 0,
    areaFailures: 0,
    tomtomCalls: 0,
    tomtomHits: 0,
    tomtomMisses: 0,
    tomtomBackoffs: 0,
    tomtomErrors: 0,
    areaFromStore: 0, // areas served from the device's own store (no download)
    areaTimeouts: 0, // downloads abandoned by the watchdog
    limitChanges: 0, // how often the shown limit changed
  };
}

function boundedSet(map, key, value) {
  if (map.size >= MAP_MAX) map.delete(map.keys().next().value);
  map.set(key, value);
}

export function createLimitEngine({
  fetchArea = defaultFetchArea,
  fetchTomTom = defaultFetchTomTom,
  now = () => Date.now(),
  onLimit = () => {},
  onStats = () => {},
  initialStats = null,
  areaStore = null, // lookup/areaStore.js — OSM data reused across drives
} = {}) {
  let area = null;
  let areaLoading = false;
  let areaFailures = 0;
  let areaRetryAt = 0;

  const wayTomTom = new Map(); // `${wayId}:${dir}` -> limit | null
  const cellTomTom = new Map(); // cell -> { limit, until }
  let tomtomBusy = false;
  let tomtomNextAt = 0;

  let current = { key: null, limit: null };
  let pending = { key: null, count: 0 };
  let lastConfirmedAt = 0;
  let lastFixAt = null;
  let disposed = false;
  const inflight = new Set(); // AbortControllers of running requests

  let areaGen = 0; // bumps when a download is abandoned; stale results are ignored
  let areaStartedAt = 0;
  let areaAbort = null;
  let tomtomGen = 0;
  let tomtomStartedAt = 0;
  let tomtomAbort = null;

  function newRequest() {
    const c = new AbortController();
    inflight.add(c);
    return c;
  }
  function endRequest(c) {
    inflight.delete(c);
  }

  let stats = { ...emptyStats(), ...(initialStats || {}) };

  function show(key, limit) {
    const changed =
      (current.limit == null) !== (limit == null) ||
      (limit && current.limit &&
        (limit.value !== current.limit.value ||
          limit.unit !== current.limit.unit ||
          limit.source !== current.limit.source));
    current = { key, limit };
    if (changed) {
      stats.limitChanges += 1;
      onLimit(limit);
    }
  }

  const sameLimit = (a, b) =>
    (a == null && b == null) ||
    (a != null && b != null && a.value === b.value && a.unit === b.unit && a.source === b.source);

  // Area downloads can come from the device's own store (free) or the network.

  // Apply a candidate { key, limit } with the 2-fix confirmation rule. Only an
  // ACCEPTED candidate counts as "confirmed" for the stale rule — otherwise a
  // stream of changing candidates (ramps, parallel roads) would keep an old
  // limit on screen forever (bug seen 2026-09-18: stuck on 55).
  function propose(key, limit) {
    if (key === current.key || current.key == null || sameLimit(limit, current.limit)) {
      // Same road, first answer, or a different road with the same limit
      // (switching can't flicker the display): accept now.
      pending = { key: null, count: 0 };
      lastConfirmedAt = now();
      show(key, limit);
      return;
    }
    pending = pending.key === key ? { key, count: pending.count + 1 } : { key, count: 1 };
    if (pending.count >= CONFIRM_FIXES) {
      pending = { key: null, count: 0 };
      lastConfirmedAt = now();
      show(key, limit);
    }
  }

  function areaFailed() {
    stats.areaFailures += 1;
    areaFailures += 1;
    areaRetryAt =
      now() + Math.min(AREA_RETRY_MAX_MS, AREA_RETRY_BASE_MS * 2 ** (areaFailures - 1));
  }

  async function loadArea(fix) {
    if (areaLoading || now() < areaRetryAt) return;
    areaLoading = true;
    areaStartedAt = now();
    const gen = ++areaGen;
    const req = newRequest();
    areaAbort = req;
    const box = areaBoxFor(fix.lat, fix.lon, fix.heading, fix.speed);
    try {
      // Free first: OSM data this device already downloaded (a commute needs
      // no download at all after the first drive).
      if (areaStore) {
        const stored = await areaStore.get(fix.lat, fix.lon).catch(() => null);
        if (disposed || gen !== areaGen) return;
        if (stored) {
          area = stored;
          areaFailures = 0;
          areaRetryAt = 0;
          stats.areaFromStore += 1;
          return;
        }
      }
      stats.areaFetches += 1;
      const a = await fetchArea(box, { signal: req.signal });
      if (disposed || gen !== areaGen) return;
      area = a;
      areaFailures = 0;
      areaRetryAt = 0;
      if (areaStore && a.raw) areaStore.put(fix.lat, fix.lon, a.raw, box).catch(() => {});
    } catch (_) {
      if (disposed || gen !== areaGen) return;
      areaFailed();
    } finally {
      endRequest(req);
      if (gen === areaGen) areaLoading = false;
    }
  }

  // Called on every fix: abandon requests that have hung.
  function checkWatchdogs() {
    const t = now();
    if (areaLoading && t - areaStartedAt > AREA_WATCHDOG_MS) {
      areaGen += 1; // ignore whatever the hung request eventually returns
      if (areaAbort) areaAbort.abort();
      areaLoading = false;
      stats.areaTimeouts += 1;
      areaFailed();
    }
    if (tomtomBusy && t - tomtomStartedAt > TOMTOM_WATCHDOG_MS) {
      tomtomGen += 1;
      if (tomtomAbort) tomtomAbort.abort();
      tomtomBusy = false;
      stats.tomtomErrors += 1;
    }
  }

  // Can we spend a TomTom call right now? Per-road lookups may also run while
  // stopped if nothing is shown yet (one call per road, cached); per-cell
  // lookups only while moving (GPS drift in a parking lot would otherwise
  // wander through new cells).
  function tomtomAllowed(fix, { movingOnly = false } = {}) {
    if (tomtomBusy || now() < tomtomNextAt) return false;
    if (fix.speed > MOVING_MPS) return true;
    return !movingOnly && current.limit == null;
  }

  function askTomTom(fix, store, road = null) {
    tomtomBusy = true;
    tomtomStartedAt = now();
    tomtomNextAt = now() + TOMTOM_MIN_INTERVAL_MS;
    stats.tomtomCalls += 1;
    const gen = ++tomtomGen;
    const req = newRequest();
    tomtomAbort = req;
    fetchTomTom(fix.lat, fix.lon, fix.heading, { signal: req.signal, road })
      .then((r) => {
        if (disposed || gen !== tomtomGen) return;
        if (r.status === 'hit') {
          stats.tomtomHits += 1;
          store(r.limit);
        } else if (r.status === 'miss') {
          stats.tomtomMisses += 1;
          store(null);
        } else if (r.status === 'backoff') {
          stats.tomtomBackoffs += 1;
          tomtomNextAt = now() + TOMTOM_BACKOFF_MS;
        } else {
          stats.tomtomErrors += 1;
        }
      })
      .catch(() => {
        if (gen === tomtomGen) stats.tomtomErrors += 1;
      })
      .finally(() => {
        endRequest(req);
        if (gen === tomtomGen) tomtomBusy = false;
      });
  }

  function cellKey(fix) {
    return `${fix.lat.toFixed(CELL_PRECISION)},${fix.lon.toFixed(CELL_PRECISION)}`;
  }

  // No OSM road for this fix: per-cell TomTom (device cache only).
  function resolveByCell(fix) {
    const cell = cellKey(fix);
    const cached = cellTomTom.get(cell);
    if (cached && (cached.limit || now() < cached.until)) {
      propose(`c:${cell}`, cached.limit);
      return;
    }
    if (tomtomAllowed(fix, { movingOnly: true })) {
      askTomTom(fix, (limit) =>
        boundedSet(cellTomTom, cell, { limit, until: now() + TOMTOM_CELL_MISS_TTL_MS })
      );
    }
    // Unknown for now: keep what's shown (stale rule clears it eventually).
  }

  function recordStats(fix) {
    const t = now();
    const dt = lastFixAt == null ? 0 : Math.min(5, Math.max(0, (t - lastFixAt) / 1000));
    lastFixAt = t;
    if (fix.speed <= MOVING_MPS || dt === 0) return;
    stats.movingSeconds += dt;
    const src = current.limit && current.limit.source;
    if (src === 'osm' && current.limit.inferred) stats.inferredSeconds += dt;
    else if (src === 'osm') stats.osmSeconds += dt;
    else if (src === 'tomtom') stats.tomtomSeconds += dt;
    else stats.unknownSeconds += dt;
  }

  function update(fix) {
    if (disposed || !fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return;
    const speed = Number.isFinite(fix.speed) && fix.speed > 0 ? fix.speed : 0;
    const heading = Number.isFinite(fix.heading) && fix.heading >= 0 ? fix.heading : null;
    const f = { ...fix, speed, heading };

    checkWatchdogs();
    if (areaNeedsRefresh(area, f.lat, f.lon)) loadArea(f).catch(() => {});

    if (f.accuracy == null || f.accuracy <= MAX_ACCURACY_M) {
      const m = area ? matchRoad(area, f.lat, f.lon, f.heading, f.speed, f.accuracy) : null;
      if (m && m.limit) {
        propose(`w:${m.wayId}`, {
          ...m.limit,
          source: 'osm',
          road: m.name,
          inferred: !!m.inferred,
        });
      } else if (m) {
        // Road known, OSM has no limit for it: TomTom once per road+direction.
        const dir = m.forward == null ? 'x' : m.forward ? 'f' : 'b';
        const key = `${m.wayId}:${dir}`;
        if (wayTomTom.has(key)) {
          const limit = wayTomTom.get(key);
          propose(`t:${key}`, limit && { ...limit, road: m.name });
        } else if (tomtomAllowed(f)) {
          askTomTom(f, (limit) => boundedSet(wayTomTom, key, limit), m.highway);
        } else if (!tomtomBusy) {
          // TomTom unavailable (spacing / capped / off): don't carry the
          // previous road's limit onto this one.
          propose(`n:${m.wayId}`, null);
        }
      } else if ((area && areaContains(area, f.lat, f.lon)) || areaFailures > 0) {
        // OSM has no road here, or OSM is down: fall back to TomTom by cell.
        // (While the first area is still downloading, just wait.)
        resolveByCell(f);
      }
    }

    if (f.speed > MOVING_MPS && current.limit && now() - lastConfirmedAt > STALE_AFTER_MS) {
      show('stale', null);
    }

    recordStats(f);
    onStats(stats);
  }

  return {
    update,
    getStats: () => ({ ...stats }),
    resetStats: () => {
      stats = emptyStats();
      onStats(stats);
    },
    // Merge counters saved by a previous session (loaded asynchronously, so
    // this session may already have counted some fixes).
    restoreStats: (saved) => {
      if (!saved || typeof saved !== 'object') return;
      const merged = { ...stats };
      for (const [k, v] of Object.entries(saved)) {
        if (k === 'since') merged.since = Math.min(stats.since, Number(v) || stats.since);
        else if (typeof v === 'number' && typeof merged[k] === 'number') merged[k] += v;
      }
      stats = merged;
    },
    getCurrent: () => current.limit,
    dispose: () => {
      disposed = true;
      inflight.forEach((c) => c.abort());
      inflight.clear();
    },
  };
}
