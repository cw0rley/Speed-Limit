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
  REFRESH_MARGIN_M,
} from './osmArea.js';
import { fetchTomTomLimit as defaultFetchTomTom } from './tomtom.js';
import { haversine } from './geo.js';

// Spacing between paid lookups. 30 s starved the display: in town a road
// changes every 20-40 s, so most roads never got asked and showed "--"
// (real drive 2026-10: only 12-21 calls/day against a 200/day cap, 20% of
// moving time blank). A new road may jump the queue after NEW_ROAD_MIN_MS.
export const TOMTOM_MIN_INTERVAL_MS = 8 * 1000;
const NEW_ROAD_MIN_MS = 3 * 1000;
// A road TomTom had no answer for is re-asked after this long, rather than
// being written off for the whole session.
const WAY_MISS_TTL_MS = 20 * 60 * 1000;
export const TOMTOM_BACKOFF_MS = 10 * 60 * 1000;
const TOMTOM_CELL_MISS_TTL_MS = 10 * 60 * 1000;
// A per-cell answer describes the point it was asked about. Cells are ~10 m, so
// at road speed the car has left the cell before the answer arrives and it was
// never read again (2026-10-27: 90 of 91 calls answered, 8 % of display time).
// Keep the last one and go on using it while the car is still near that point.
const POINT_VALID_MS = 30 * 1000;
const POINT_VALID_M = 300; // ~one TomTom spacing interval at highway speed
const AREA_RETRY_BASE_MS = 15 * 1000;
const AREA_RETRY_MAX_MS = 2 * 60 * 1000;
// How long to wait for an in-flight area download before paying TomTom for a
// spot the downloaded box no longer covers.
const AREA_GRACE_MS = 6 * 1000;
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
    impliedSeconds: 0, // …from the statutory default its tags name
    assumedSeconds: 0, // …from what roads of its class obey near by
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
  getAppUserId = () => null, // RevenueCat id, sent so the Worker can check the subscription
} = {}) {
  let area = null;
  let areaLoading = false;
  let areaFailures = 0;
  let areaRetryAt = 0;

  const wayTomTom = new Map(); // `${wayId}:${dir}` -> limit | null
  const cellTomTom = new Map(); // cell -> { limit, until }
  let lastPoint = null; // { lat, lon, limit, at } — most recent per-point answer
  let tomtomBusy = false;
  let tomtomNextAt = 0;

  let current = { key: null, limit: null };
  let pending = { key: null, count: 0 };
  let lastConfirmedAt = 0;
  let lastFixAt = null;
  let prevFix = null; // previous position, sent so the Worker can snap to the road
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
        // Same margin the refresh test uses, so a store hit always means "no
        // refresh needed" — otherwise the store keeps handing back the box we
        // are trying to replace and the next one is never downloaded.
        const stored = await areaStore
          .get(fix.lat, fix.lon, REFRESH_MARGIN_M)
          .catch(() => null);
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
  function tomtomAllowed(fix, { movingOnly = false, newRoad = false } = {}) {
    if (tomtomBusy) return false;
    // Moving onto a road we haven't asked about is the case that matters for
    // the display, so it waits only the short floor.
    const until = newRoad ? tomtomNextAt - (TOMTOM_MIN_INTERVAL_MS - NEW_ROAD_MIN_MS) : tomtomNextAt;
    if (now() < until) return false;
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
    fetchTomTom(fix.lat, fix.lon, fix.heading, {
      signal: req.signal,
      road,
      appUserId: getAppUserId(),
      prev: prevFix,
    })
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

  // A point answer still applies if we have not gone far from where it was
  // asked about, and it has not gone stale.
  function pointApplies(fix) {
    return (
      lastPoint != null &&
      now() - lastPoint.at < POINT_VALID_MS &&
      haversine(fix.lat, fix.lon, lastPoint.lat, lastPoint.lon) < POINT_VALID_M
    );
  }

  // Keyed by the value, not the cell: successive point answers are independent
  // readings of the same thing, so the same value keeps the display steady
  // while a changed one still has to agree on two fixes. The old `c:${cell}`
  // key changed every ~10 m, so a point answer could only ever be shown when it
  // happened to match what was already up — and once the stale rule blanked the
  // display, nothing on this path could bring it back.
  const pointKey = (limit) => `cell:${limit ? `${limit.value}${limit.unit}` : 'none'}`;

  // No OSM road for this fix: per-cell TomTom (device cache only).
  function resolveByCell(fix) {
    const cell = cellKey(fix);
    const cached = cellTomTom.get(cell);
    if (cached && (cached.limit || now() < cached.until)) {
      lastPoint = { lat: fix.lat, lon: fix.lon, limit: cached.limit, at: now() };
      propose(pointKey(cached.limit), cached.limit);
      return;
    }
    // Show the most recent point answer while it still applies. A refresh may
    // still go out below when the spacing allows one — this keeps the display
    // populated between calls without changing how often we pay for them.
    if (pointApplies(fix)) propose(pointKey(lastPoint.limit), lastPoint.limit);
    if (tomtomAllowed(fix, { movingOnly: true })) {
      askTomTom(fix, (limit) => {
        boundedSet(cellTomTom, cell, { limit, until: now() + TOMTOM_CELL_MISS_TTL_MS });
        // Filed against where the call was made, which is where the answer is
        // true — the next fix picks it up from here.
        lastPoint = { lat: fix.lat, lon: fix.lon, limit, at: now() };
      });
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
    if (src === 'osm' && current.limit.assumed) stats.assumedSeconds += dt;
    else if (src === 'osm' && current.limit.implied) stats.impliedSeconds += dt;
    else if (src === 'osm' && current.limit.inferred) stats.inferredSeconds += dt;
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
          implied: !!m.implied,
          assumed: !!m.assumed,
        });
      } else if (m) {
        // Road known, OSM has no limit for it: TomTom once per road+direction.
        const dir = m.forward == null ? 'x' : m.forward ? 'f' : 'b';
        const key = `${m.wayId}:${dir}`;
        const known = wayTomTom.get(key);
        if (known && (known.limit || now() < known.until)) {
          propose(`t:${key}`, known.limit && { ...known.limit, road: m.name });
        } else if (tomtomAllowed(f, { newRoad: true })) {
          askTomTom(
            f,
            (limit) =>
              boundedSet(wayTomTom, key, { limit, until: now() + WAY_MISS_TTL_MS }),
            m.highway
          );
        } else if (!tomtomBusy) {
          // TomTom unavailable (spacing / capped / off): don't carry the
          // previous road's limit onto this one.
          propose(`n:${m.wayId}`, null);
        }
      } else if (
        (area && areaContains(area, f.lat, f.lon)) ||
        areaFailures > 0 ||
        (areaLoading && now() - areaStartedAt > AREA_GRACE_MS)
      ) {
        // OSM has no road here, OSM is down, or we have driven out of the
        // downloaded box and the next one is taking too long: fall back to
        // TomTom by cell. A download that answers within AREA_GRACE_MS costs
        // nothing, so only a slow one (Overpass 504s are common) pays for a
        // lookup. Without the third clause nothing at all was asked between
        // leaving one box and the next arriving — the display just held the
        // last road's limit until the 60 s stale rule blanked it.
        resolveByCell(f);
      }
    }

    if (f.speed > MOVING_MPS && current.limit && now() - lastConfirmedAt > STALE_AFTER_MS) {
      show('stale', null);
    }

    recordStats(f);
    // Kept at least ~50 m back so a snap trace has a usable length.
    if (!prevFix || Math.hypot((f.lat - prevFix.lat) * 111320, (f.lon - prevFix.lon) * 85000) > 50) {
      prevFix = { lat: f.lat, lon: f.lon };
    }
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
