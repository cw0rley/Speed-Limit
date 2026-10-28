#!/usr/bin/env node
// How much of a real area's road length can the app label WITHOUT a paid
// lookup, and how much would each proposed OSM lever add?
//
//   node --no-warnings tools/osm-coverage.mjs <lat> <lon> [radiusMetres]
//   node --no-warnings tools/osm-coverage.mjs 35.6506 -78.4564 4000
//
// (--no-warnings only silences Node's note about lookup/*.js being ESM without
// a "type" field in package.json; adding that field could disturb Metro.)
//
// Needs network (Overpass). Nothing here runs in the app — it exists so the
// decision about which lever to build is made on data from the roads you
// actually drive, not on a sample from somewhere else. Coverage varies wildly
// between regions, so run it on your own commute before trusting any number.
//
// Everything is **length-weighted**: a 3 km untagged road costs you far more
// blank time than a 40 m one, so counting ways would flatter the result.

import { parseMaxspeed, wayLimit } from '../lookup/maxspeed.js';
import { roadKey, inferRoadLimits } from '../lookup/osmArea.js';
import { haversine } from '../lookup/geo.js';

const DRIVABLE =
  'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|' +
  'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

// Tags that say "the limit here is the statutory default for this kind of
// road", which is a real legal limit even where nothing is posted. The app
// does not currently download these at all.
const ZONE_TAGS = ['maxspeed:type', 'source:maxspeed', 'zone:maxspeed'];

// How far an untagged piece may look along its own road for a tagged one.
const NEAREST_MAX_M = 2000;

const [latArg, lonArg, radiusArg] = process.argv.slice(2);
const lat = Number(latArg);
const lon = Number(lonArg);
const radius = Number(radiusArg || 4000);
if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
  console.error('usage: node tools/osm-coverage.mjs <lat> <lon> [radiusMetres]');
  process.exit(1);
}

const dLat = radius / 111320;
const dLon = radius / (111320 * Math.cos((lat * Math.PI) / 180));
const bbox = [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map((n) => n.toFixed(5)).join(',');

const query = `[out:json][timeout:90];
way["highway"~"^(${DRIVABLE})$"](${bbox});
out geom;`;

console.log(`Querying Overpass for a ${(radius * 2) / 1000} km box around ${lat}, ${lon}…`);

const res = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'speed-limit-coverage-check (github.com/cw0rley/Speed-Limit)',
  },
  body: new URLSearchParams({ data: query }),
});
if (!res.ok) {
  console.error(`Overpass returned ${res.status}. Public servers are often busy — try again.`);
  process.exit(1);
}
const json = await res.json();

// Shape the tags the way the app's parseArea does, so the "today" number is
// exactly what the app gets rather than an optimistic version of it.
const ways = [];
for (const el of json.elements || []) {
  const g = el.geometry;
  if (el.type !== 'way' || !Array.isArray(g) || g.length < 2) continue;
  const raw = el.tags || {};
  const tags = {
    highway: raw.highway || undefined,
    maxspeed: raw.maxspeed || undefined,
    mf: raw['maxspeed:forward'] || undefined,
    mb: raw['maxspeed:backward'] || undefined,
    oneway: raw.oneway || undefined,
    name: raw.name || undefined,
    ref: raw.ref || undefined,
  };
  let metres = 0;
  for (let i = 1; i < g.length; i++) {
    metres += haversine(g[i - 1].lat, g[i - 1].lon, g[i].lat, g[i].lon);
  }
  const mid = g[Math.floor(g.length / 2)];
  const zone = ZONE_TAGS.map((t) => raw[t]).find(Boolean) || null;
  ways.push({ id: el.id, tags, metres, mid, zone, cls: raw.highway });
}

const total = ways.reduce((s, w) => s + w.metres, 0);
if (total === 0) {
  console.error('No drivable ways in that box — check the coordinates.');
  process.exit(1);
}

// --- today ---------------------------------------------------------------
const direct = ways.filter((w) => wayLimit(w.tags, null));
const needHelp = ways.filter((w) => !wayLimit(w.tags, null));

// Lever 0: the inheritance rule as it stands (every tagged piece must agree).
const currentMap = inferRoadLimits(ways);
const currentInherit = needHelp.filter((w) => {
  const k = roadKey(w.tags);
  return k && currentMap.has(k);
});

// Lever A: inherit from the NEAREST tagged piece of the same road instead of
// demanding that every piece agree. A long road whose limit genuinely steps
// from 45 to 55 currently teaches the app nothing anywhere along its length.
const taggedByKey = new Map();
for (const w of direct) {
  const k = roadKey(w.tags);
  if (!k) continue;
  if (!taggedByKey.has(k)) taggedByKey.set(k, []);
  taggedByKey.get(k).push(w);
}
const nearestInherit = needHelp.filter((w) => {
  const k = roadKey(w.tags);
  const pieces = k && taggedByKey.get(k);
  if (!pieces) return false;
  return pieces.some((p) => haversine(w.mid.lat, w.mid.lon, p.mid.lat, p.mid.lon) <= NEAREST_MAX_M);
});
const nearestOnly = nearestInherit.filter((w) => !currentInherit.includes(w));

// Lever B: a statutory-default tag the app does not even download today.
const covered = new Set([...currentInherit, ...nearestInherit].map((w) => w.id));
const zoneOnly = needHelp.filter((w) => w.zone && !covered.has(w.id));

const unknown = needHelp.filter((w) => !covered.has(w.id) && !w.zone);

const pct = (list) => ((list.reduce((s, w) => s + w.metres, 0) / total) * 100).toFixed(1);
const km = (list) => (list.reduce((s, w) => s + w.metres, 0) / 1000).toFixed(1);

console.log(`\n${ways.length} drivable ways, ${(total / 1000).toFixed(1)} km of road\n`);
console.log('Share of road LENGTH the app can label with no paid lookup:');
console.log(`  maxspeed tag on the way itself      ${pct(direct).padStart(6)}%  (${km(direct)} km)`);
console.log(`  + inheritance as it works today     ${pct(currentInherit).padStart(6)}%  (${km(currentInherit)} km)`);
console.log(`  ------------------------------------------`);
console.log(`  = today                             ${pct([...direct, ...currentInherit]).padStart(6)}%`);
console.log('\nWhat each proposed lever would add on top:');
console.log(`  A: inherit from the nearest piece   ${pct(nearestOnly).padStart(6)}%  (${km(nearestOnly)} km)`);
console.log(`  B: statutory-default zone tags      ${pct(zoneOnly).padStart(6)}%  (${km(zoneOnly)} km)`);
console.log(`  still unknown after A and B         ${pct(unknown).padStart(6)}%  (${km(unknown)} km)`);

// Where the remaining blank road actually is — this decides whether lever C
// (per-class statutory defaults) is worth its accuracy risk, and for which
// classes.
const byClass = new Map();
for (const w of unknown) byClass.set(w.cls, (byClass.get(w.cls) || 0) + w.metres);
console.log('\nRoad classes still unlabelled (length-weighted):');
for (const [cls, m] of [...byClass].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(cls).padEnd(20)} ${((m / total) * 100).toFixed(1).padStart(6)}%  (${(m / 1000).toFixed(1)} km)`);
}

// Which zone-tag values show up, so the lookup table only has to cover the
// ones that actually occur here.
const zoneValues = new Map();
for (const w of needHelp) if (w.zone) zoneValues.set(w.zone, (zoneValues.get(w.zone) || 0) + 1);
if (zoneValues.size) {
  console.log('\nZone-tag values present (ways):');
  for (const [v, n] of [...zoneValues].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${String(v).padEnd(28)} ${n}`);
  }
}

// Values parseMaxspeed throws away. If something common is in here it is a
// parser fix, which is cheaper and safer than any of the levers above.
const rejected = new Map();
for (const w of ways) {
  for (const v of [w.tags.maxspeed, w.tags.mf, w.tags.mb]) {
    if (v && !parseMaxspeed(v)) rejected.set(v, (rejected.get(v) || 0) + 1);
  }
}
if (rejected.size) {
  console.log('\nmaxspeed values the parser rejects (ways):');
  for (const [v, n] of [...rejected].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${String(v).padEnd(28)} ${n}`);
  }
}
