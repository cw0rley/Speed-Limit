#!/usr/bin/env node
// How much of a real area's road length can the app label WITHOUT a paid
// lookup, and how much would each remaining OSM lever add?
//
//   node --no-warnings tools/osm-coverage.mjs <lat> <lon> [radiusMetres]
//   node --no-warnings tools/osm-coverage.mjs 35.6506 -78.4564 4000
//
// (--no-warnings only silences Node's note about lookup/*.js being ESM without
// a "type" field in package.json; adding that field could disturb Metro.)
//
// Needs network (Overpass). Nothing here runs in the app — it exists so the
// decision about which lever to build is made on data from the roads you
// actually drive. Coverage varies wildly between regions, so run it on your
// own commute before trusting any number.
//
// Everything is **length-weighted**: a 3 km untagged road costs you far more
// blank time than a 40 m one, so counting ways would flatter the result.
//
// The baseline calls the app's real matching code (parseArea / inheritedLimit),
// so "today" is what the app actually achieves, not an optimistic model of it.

import { parseMaxspeed, wayLimit } from '../lookup/maxspeed.js';
import { parseArea, areaBoxFor, inheritedLimit } from '../lookup/osmArea.js';
import { zoneLimit, parseZoneLimit } from '../lookup/zoneLimits.js';
import { haversine } from '../lookup/geo.js';

const DRIVABLE =
  'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|' +
  'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

// Tags that say "the limit here is the statutory default for this kind of
// road", which is a real legal limit even where nothing is posted. The app
// does not currently download these at all (see buildAreaQuery).
const ZONE_TAGS = ['maxspeed:type', 'source:maxspeed', 'zone:maxspeed'];

const [latArg, lonArg, radiusArg] = process.argv.slice(2);
const lat = Number(latArg);
const lon = Number(lonArg);
const radius = Number(radiusArg || 4000);
if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
  console.error('usage: node --no-warnings tools/osm-coverage.mjs <lat> <lon> [radiusMetres]');
  process.exit(1);
}

const dLat = radius / 111320;
const dLon = radius / (111320 * Math.cos((lat * Math.PI) / 180));
const bbox = [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map((n) => n.toFixed(5)).join(',');

console.log(`Querying Overpass for a ${(radius * 2) / 1000} km box around ${lat}, ${lon}…`);

const res = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'speed-limit-coverage-check (github.com/cw0rley/Speed-Limit)',
  },
  body: new URLSearchParams({
    data: `[out:json][timeout:90];\nway["highway"~"^(${DRIVABLE})$"](${bbox});\nout geom;`,
  }),
});
if (!res.ok) {
  console.error(`Overpass returned ${res.status}. Public servers are often busy — try again.`);
  process.exit(1);
}
const json = await res.json();

// Re-shape the raw response the way the app's own Overpass `convert` does, so
// parseArea sees exactly what it sees in the app.
const elements = [];
const extra = new Map(); // way id -> { metres, zone, cls }
for (const el of json.elements || []) {
  const g = el.geometry;
  if (el.type !== 'way' || !Array.isArray(g) || g.length < 2) continue;
  const raw = el.tags || {};
  elements.push({
    type: 'way',
    id: el.id,
    geometry: { coordinates: g.map((n) => [n.lon, n.lat]) },
    tags: {
      highway: raw.highway,
      maxspeed: raw.maxspeed,
      mf: raw['maxspeed:forward'],
      mb: raw['maxspeed:backward'],
      oneway: raw.oneway,
      name: raw.name,
      ref: raw.ref,
      mt: raw['maxspeed:type'],
      zm: raw['zone:maxspeed'],
      sm: raw['source:maxspeed'],
    },
  });
  let metres = 0;
  for (let i = 1; i < g.length; i++) {
    metres += haversine(g[i - 1].lat, g[i - 1].lon, g[i].lat, g[i].lon);
  }
  extra.set(Number(el.id), {
    metres,
    zone: ZONE_TAGS.map((t) => raw[t]).find(Boolean) || null,
    cls: raw.highway,
  });
}

const area = parseArea({ elements }, areaBoxFor(lat, lon, null, 0));
const total = [...extra.values()].reduce((s, e) => s + e.metres, 0);
if (total === 0) {
  console.error('No drivable ways in that box — check the coordinates.');
  process.exit(1);
}

let direct = 0;
let inherited = 0;
let implied = 0;
let unresolvedZone = 0;
let unknown = 0;
const unknownByClass = new Map();
const unmappedZoneValues = new Map();

for (const way of area.ways) {
  const e = extra.get(way.id);
  if (!e) continue;
  if (wayLimit(way.tags, null)) {
    direct += e.metres;
    continue;
  }
  const zone = zoneLimit(way.tags);
  // A zone tag we cannot turn into a number is the actionable case: it is
  // coverage sitting right there, waiting on one table entry.
  const unmapped = !zone && e.zone && !parseZoneLimit(e.zone) ? e.zone : null;
  // Walk the way rather than testing its midpoint: inheritance depends on
  // where the car is, so a long way can be in reach of a tagged piece at one
  // end and out of reach at the other. OSM segments are short, so stepping
  // segment by segment is already fine-grained.
  for (let i = 0; i < way.pts.length - 1; i++) {
    const a = way.pts[i];
    const b = way.pts[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (inheritedLimit(area, way, mid)) {
      inherited += segLen;
    } else if (zone) {
      implied += segLen;
    } else if (unmapped) {
      unresolvedZone += segLen;
      unmappedZoneValues.set(unmapped, (unmappedZoneValues.get(unmapped) || 0) + segLen);
    } else {
      unknown += segLen;
      unknownByClass.set(e.cls, (unknownByClass.get(e.cls) || 0) + segLen);
    }
  }
}

const pct = (m) => ((m / total) * 100).toFixed(1).padStart(6);
const km = (m) => (m / 1000).toFixed(1);

console.log(`\n${area.ways.length} drivable ways, ${(total / 1000).toFixed(1)} km of road\n`);
console.log('Share of road LENGTH the app can label with no paid lookup:');
console.log(`  maxspeed on the way itself          ${pct(direct)}%  (${km(direct)} km)`);
console.log(`  + inherited from the nearest piece   ${pct(inherited)}%  (${km(inherited)} km)`);
console.log(`  + statutory default from its tags   ${pct(implied)}%  (${km(implied)} km)`);
console.log(`  ----------------------------------------------`);
console.log(`  = today                             ${pct(direct + inherited + implied)}%`);
console.log('\nWhat is left:');
console.log(`  zone tag we cannot resolve          ${pct(unresolvedZone)}%  (${km(unresolvedZone)} km)`);
console.log(`  nothing to go on                    ${pct(unknown)}%  (${km(unknown)} km)`);

// Where the remaining blank road is — this decides whether lever C (per-class
// statutory defaults) is worth its accuracy risk, and for which classes.
console.log('\nRoad classes still unlabelled (length-weighted):');
for (const [cls, m] of [...unknownByClass].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(cls).padEnd(20)} ${pct(m)}%  (${km(m)} km)`);
}

// The actionable list: each of these is road that would light up for one
// verified entry in lookup/zoneLimits.js.
if (unmappedZoneValues.size) {
  console.log('\nZone-tag values present but not in zoneLimits.js:');
  for (const [v, m] of [...unmappedZoneValues].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${String(v).padEnd(28)} ${pct(m)}%`);
  }
}

// Values parseMaxspeed throws away. Something common here is a parser fix,
// which is cheaper and safer than any lever.
const rejected = new Map();
for (const way of area.ways) {
  for (const v of [way.tags.maxspeed, way.tags.mf, way.tags.mb]) {
    if (v && !parseMaxspeed(v)) rejected.set(v, (rejected.get(v) || 0) + 1);
  }
}
if (rejected.size) {
  console.log('\nmaxspeed values the parser rejects (ways):');
  for (const [v, n] of [...rejected].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${String(v).padEnd(28)} ${n}`);
  }
}
