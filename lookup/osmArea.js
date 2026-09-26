// OpenStreetMap "area" lookups: download every drivable road in a ~1.6 km box
// once, then match each GPS fix to a road on the device. One Overpass request
// covers minutes of driving instead of one request every few seconds, and a
// matched road without a maxspeed can be looked up once (by way id) elsewhere.

import { angleDiff, bearing, metersPerDegree, pointToSegment, project } from './geo.js';
import { wayLimit } from './maxspeed.js';
import { fetchWithTimeout, USER_AGENT } from './net.js';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const AREA_HALF_SIZE_M = 800;
const AREA_LOOKAHEAD_S = 20; // shift the box ahead by speed × this…
const AREA_MAX_LOOKAHEAD_M = 400; // …capped here
const REFRESH_MARGIN_M = 250; // refetch when this close to the box edge
const FETCH_TIMEOUT_MS = 15000; // area queries are heavier than point queries

const DRIVABLE =
  'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|' +
  'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

// `convert` trims the response to the handful of tags we use (~75 KB for a
// suburban 1.6 km box instead of several hundred with all tags).
export function buildAreaQuery(box) {
  const bbox = `${box.south.toFixed(5)},${box.west.toFixed(5)},${box.north.toFixed(5)},${box.east.toFixed(5)}`;
  return `[out:json][timeout:12];
way["highway"~"^(${DRIVABLE})$"](${bbox});
convert way ::id=id(),::geom=geom(),highway=t["highway"],maxspeed=t["maxspeed"],mf=t["maxspeed:forward"],mb=t["maxspeed:backward"],oneway=t["oneway"],name=t["name"],ref=t["ref"];
out geom;`;
}

// Box around a position, shifted ahead in the direction of travel.
export function areaBoxFor(lat, lon, heading, speedMps) {
  let cLat = lat;
  let cLon = lon;
  const mpd = metersPerDegree(lat);
  if (heading != null && speedMps > 2) {
    const shift = Math.min(speedMps * AREA_LOOKAHEAD_S, AREA_MAX_LOOKAHEAD_M);
    const rad = (heading * Math.PI) / 180;
    cLat += (shift * Math.cos(rad)) / mpd.lat;
    cLon += (shift * Math.sin(rad)) / mpd.lon;
  }
  const dLat = AREA_HALF_SIZE_M / mpd.lat;
  const dLon = AREA_HALF_SIZE_M / mpd.lon;
  return { south: cLat - dLat, north: cLat + dLat, west: cLon - dLon, east: cLon + dLon };
}

const blank = (v) => (v === '' || v == null ? undefined : v);

function onewayOf(tags) {
  const v = tags.oneway;
  if (v === 'yes' || v === 'true' || v === '1') return 1;
  if (v === '-1' || v === 'reverse') return -1;
  if (v === 'no') return 0;
  return tags.highway === 'motorway' || tags.highway === 'motorway_link' ? 1 : 0;
}

// Overpass JSON (from buildAreaQuery) -> area with pre-projected geometry.
export function parseArea(json, box) {
  const originLat = (box.south + box.north) / 2;
  const originLon = (box.west + box.east) / 2;
  const mpd = metersPerDegree(originLat);
  const ways = [];
  for (const el of (json && json.elements) || []) {
    const coords = el.geometry && el.geometry.coordinates;
    if (el.type !== 'way' || !Array.isArray(coords) || coords.length < 2) continue;
    const raw = el.tags || {};
    const tags = {
      highway: blank(raw.highway),
      maxspeed: blank(raw.maxspeed),
      mf: blank(raw.mf),
      mb: blank(raw.mb),
      oneway: blank(raw.oneway),
      name: blank(raw.name),
      ref: blank(raw.ref),
    };
    const pts = coords.map(([lon, lat]) => project(lat, lon, originLat, originLon, mpd));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    ways.push({ id: Number(el.id), tags, oneway: onewayOf(tags), pts, minX, minY, maxX, maxY });
  }
  return { box, originLat, originLon, mpd, ways, inferred: inferRoadLimits(ways), fetchedAt: Date.now() };
}

// OSM splits a road into many ways, and often only some of them carry a
// maxspeed. Build "road identity -> limit" from the tagged ways so the
// untagged pieces of the SAME road can reuse it instead of costing a paid
// lookup. Only used when every tagged piece of that road agrees.
export function inferRoadLimits(ways) {
  const seen = new Map(); // key -> { limit, conflict }
  for (const way of ways) {
    const key = roadKey(way.tags);
    if (!key) continue;
    const limit = wayLimit(way.tags, null);
    if (!limit) continue;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, { limit, conflict: false });
    } else if (prev.limit.value !== limit.value || prev.limit.unit !== limit.unit) {
      prev.conflict = true;
    }
  }
  const out = new Map();
  for (const [key, v] of seen) if (!v.conflict) out.set(key, v.limit);
  return out;
}

// Identity of a road for inference: its number (ref) if it has one, else its
// name — always combined with the highway class, so a service-road-like
// "Main Street" can't inherit from a trunk "Main Street".
export function roadKey(tags) {
  if (!tags || !tags.highway) return null;
  const cls = tags.highway.replace(/_link$/, '');
  const id = (tags.ref || tags.name || '').trim().toLowerCase();
  return id ? `${cls}|${id}` : null;
}

export function areaContains(area, lat, lon, marginM = 0) {
  if (!area) return false;
  const p = project(lat, lon, area.originLat, area.originLon, area.mpd);
  const half = {
    x: ((area.box.east - area.box.west) / 2) * area.mpd.lon,
    y: ((area.box.north - area.box.south) / 2) * area.mpd.lat,
  };
  return Math.abs(p.x) <= half.x - marginM && Math.abs(p.y) <= half.y - marginM;
}

export function areaNeedsRefresh(area, lat, lon) {
  return !areaContains(area, lat, lon, REFRESH_MARGIN_M);
}

// Best road for a fix, or null. Scores distance plus how badly the road's
// direction disagrees with the heading, so parallel roads and overpasses
// resolve to the one you're actually driving on.
export function matchRoad(area, lat, lon, heading, speedMps, accuracyM) {
  if (!areaContains(area, lat, lon)) return null;
  const p = project(lat, lon, area.originLat, area.originLon, area.mpd);
  const maxDist = Math.min(35, Math.max(15, (accuracyM || 10) + 10));
  const headingKnown = heading != null && heading >= 0 && speedMps > 2;

  let best = null;
  for (const way of area.ways) {
    if (
      p.x < way.minX - maxDist || p.x > way.maxX + maxDist ||
      p.y < way.minY - maxDist || p.y > way.maxY + maxDist
    ) {
      continue;
    }
    for (let i = 0; i < way.pts.length - 1; i++) {
      const a = way.pts[i];
      const b = way.pts[i + 1];
      const { dist } = pointToSegment(p, a, b);
      if (dist > maxDist) continue;

      let score = dist;
      let forward = null;
      if (headingKnown) {
        const diff = angleDiff(heading, bearing(a, b));
        forward = diff <= 90;
        const offAxis = forward ? diff : 180 - diff; // 0 = perfectly along the road
        score += (offAxis / 90) * 25;
        // Driving against a one-way road's direction: almost certainly the
        // other carriageway of a divided road.
        if ((way.oneway === 1 && !forward) || (way.oneway === -1 && forward)) score += 30;
      }
      if (!best || score < best.score) best = { way, score, dist, forward };
    }
  }
  if (!best) return null;
  const own = wayLimit(best.way.tags, best.forward);
  // Fall back to another piece of the same road before any paid lookup.
  const key = own ? null : roadKey(best.way.tags);
  const inherited = key && area.inferred ? area.inferred.get(key) || null : null;
  return {
    wayId: best.way.id,
    name: best.way.tags.name || best.way.tags.ref || null,
    highway: best.way.tags.highway,
    forward: best.forward,
    dist: best.dist,
    limit: own || inherited,
    inferred: !own && !!inherited,
  };
}

// Download + parse an area. Throws on failure (every endpoint down/slow).
export async function fetchArea(box, { signal, fetchImpl, endpoints = OVERPASS_ENDPOINTS } = {}) {
  const body = 'data=' + encodeURIComponent(buildAreaQuery(box));
  let lastError = new Error('no endpoints');
  for (const endpoint of endpoints) {
    try {
      const res = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
          },
          body,
        },
        FETCH_TIMEOUT_MS,
        signal,
        fetchImpl
      );
      if (!res.ok) {
        lastError = new Error(`overpass ${res.status}`);
        continue;
      }
      const json = await res.json();
      const area = parseArea(json, box);
      // Kept so the caller can store the raw data for reuse on later drives.
      area.raw = (json && json.elements) || [];
      return area;
    } catch (e) {
      if (signal && signal.aborted) throw e;
      lastError = e;
    }
  }
  throw lastError;
}
