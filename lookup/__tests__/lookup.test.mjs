// Run: npm test   (node's built-in test runner; no extra dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseMaxspeed, wayLimit, convertLimit } from '../maxspeed.js';
import { angleDiff, bearing, metersPerDegree } from '../geo.js';
import { areaBoxFor, areaContains, buildAreaQuery, matchRoad, parseArea } from '../osmArea.js';
import { createLimitEngine, TOMTOM_BACKOFF_MS, TOMTOM_MIN_INTERVAL_MS } from '../engine.js';

const flush = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// Synthetic map around (40.0, -75.0):
//   way 1 "Main St"  east-west two-way through the origin, 35 mph
//   way 2 "Side Rd"  north-south two-way through the origin, untagged
//   way 3 "Fwy WB"   east-west one-way WESTBOUND 20 m north, 65/55 mph by direction
// ---------------------------------------------------------------------------
const LAT = 40.0;
const LON = -75.0;
const mpd = metersPerDegree(LAT);
const dLat = (m) => m / mpd.lat;
const dLon = (m) => m / mpd.lon;

function syntheticJson() {
  const line = (pts) => ({ type: 'LineString', coordinates: pts.map(([n, e]) => [LON + dLon(e), LAT + dLat(n)]) });
  return {
    elements: [
      { type: 'way', id: 1, geometry: line([[0, -600], [0, 600]]),
        tags: { highway: 'primary', maxspeed: '35 mph', mf: '', mb: '', oneway: '', name: 'Main St' } },
      { type: 'way', id: 2, geometry: line([[-600, 0], [600, 0]]),
        tags: { highway: 'residential', maxspeed: '', mf: '', mb: '', oneway: '', name: 'Side Rd' } },
      // drawn east -> west, one-way in drawing direction
      { type: 'way', id: 3, geometry: line([[20, 600], [20, -600]]),
        tags: { highway: 'motorway', maxspeed: '', mf: '65 mph', mb: '55 mph', oneway: 'yes', name: 'Fwy WB' } },
    ],
  };
}
const syntheticBox = areaBoxFor(LAT, LON, null, 0);
const syntheticArea = () => parseArea(syntheticJson(), syntheticBox);
const at = (north, east) => ({ lat: LAT + dLat(north), lon: LON + dLon(east) });

// ---------------------------------------------------------------------------
test('parseMaxspeed handles units and rejects implicit values', () => {
  assert.deepEqual(parseMaxspeed('25 mph'), { value: 25, unit: 'mph' });
  assert.deepEqual(parseMaxspeed('30mph'), { value: 30, unit: 'mph' });
  assert.deepEqual(parseMaxspeed('50'), { value: 50, unit: 'kmh' });
  assert.deepEqual(parseMaxspeed('50 km/h'), { value: 50, unit: 'kmh' });
  for (const v of ['', null, undefined, 'US:urban', 'none', 'walk', 'signals', '35 mph;25 mph', '0']) {
    assert.equal(parseMaxspeed(v), null, `expected null for ${v}`);
  }
});

test('wayLimit prefers direction-specific tags', () => {
  const tags = { maxspeed: '45 mph', mf: '55 mph', mb: '' };
  assert.deepEqual(wayLimit(tags, true), { value: 55, unit: 'mph' });
  assert.deepEqual(wayLimit(tags, false), { value: 45, unit: 'mph' });
  assert.deepEqual(wayLimit({ mf: '30 mph', mb: '30 mph' }, null), { value: 30, unit: 'mph' });
  assert.equal(wayLimit({ mf: '30 mph', mb: '40 mph' }, null), null);
});

test('convertLimit', () => {
  assert.equal(convertLimit({ value: 50, unit: 'kmh' }, 'mph'), 31);
  assert.equal(convertLimit({ value: 30, unit: 'mph' }, 'kmh'), 48);
  assert.equal(convertLimit(null, 'mph'), null);
});

test('geo helpers', () => {
  assert.equal(angleDiff(350, 10), 20);
  assert.equal(angleDiff(90, 270), 180);
  assert.equal(Math.round(bearing({ x: 0, y: 0 }, { x: 1, y: 0 })), 90);
});

test('area query and box', () => {
  const q = buildAreaQuery(syntheticBox);
  assert.match(q, /convert way/);
  assert.match(q, /maxspeed:forward/);
  const ahead = areaBoxFor(LAT, LON, 0, 30); // heading north at 30 m/s
  assert.ok((ahead.north + ahead.south) / 2 > LAT, 'box shifts ahead');
  assert.ok(areaContains(syntheticArea(), LAT, LON));
});

test('parses the real Overpass sample (blank tags become undefined)', () => {
  const json = JSON.parse(
    readFileSync(new URL('./fixtures/overpass-area-sample.json', import.meta.url), 'utf8')
  );
  const box = { south: 40.5, west: -74.46, north: 40.515, east: -74.44 };
  const area = parseArea(json, box);
  assert.equal(area.ways.length, 8);
  const tagged = area.ways.find((w) => w.id === 11674280);
  assert.equal(tagged.tags.maxspeed, '25 mph');
  const untagged = area.ways.find((w) => w.id === 11648485);
  assert.equal(untagged.tags.maxspeed, undefined);
  assert.equal(area.ways.find((w) => w.id === 11650753).oneway, 1); // motorway_link implied

  // A point on the first segment of the 55 mph motorway, driving along it.
  const m = matchRoad(area, 40.5072034, -74.4568538, 290, 25, 5);
  assert.equal(m.wayId, 11676951);
  assert.deepEqual(m.limit, { value: 55, unit: 'mph' });
});

test('matchRoad uses heading to pick between crossing and parallel roads', () => {
  const area = syntheticArea();
  // At the intersection heading east -> Main St; heading north -> Side Rd.
  assert.equal(matchRoad(area, at(0, 0).lat, at(0, 0).lon, 90, 15, 5).wayId, 1);
  assert.equal(matchRoad(area, at(0, 0).lat, at(0, 0).lon, 0, 15, 5).wayId, 2);

  // 12 m north of Main St, 8 m from the westbound freeway:
  //  - heading WEST -> the freeway (forward, 65 mph)
  //  - heading EAST -> Main St (freeway would be wrong-way)
  const p = at(12, 300);
  const west = matchRoad(area, p.lat, p.lon, 270, 25, 5);
  assert.equal(west.wayId, 3);
  assert.equal(west.forward, true);
  assert.deepEqual(west.limit, { value: 65, unit: 'mph' });
  assert.equal(matchRoad(area, p.lat, p.lon, 90, 25, 5).wayId, 1);

  // Far from every road -> null.
  const far = at(300, 300);
  assert.equal(matchRoad(area, far.lat, far.lon, 90, 25, 5), null);
});

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
function harness({ areaOk = true, tomtom = () => ({ status: 'hit', limit: { value: 25, unit: 'mph', source: 'tomtom' } }) } = {}) {
  let clock = 1_000_000;
  const calls = { area: 0, tomtom: 0 };
  const shown = [];
  const engine = createLimitEngine({
    now: () => clock,
    fetchArea: async () => {
      calls.area += 1;
      if (!areaOk) throw new Error('down');
      return syntheticArea();
    },
    fetchTomTom: async (lat, lon, heading, opts) => {
      calls.tomtom += 1;
      calls.lastRoad = opts && opts.road;
      return tomtom();
    },
    onLimit: (l) => shown.push(l && `${l.value} ${l.unit} ${l.source}`),
  });
  const drive = async (north, east, heading, speed = 15, seconds = 1) => {
    clock += seconds * 1000;
    const p = at(north, east);
    engine.update({ ...p, heading, speed, accuracy: 5 });
    await flush();
  };
  return { engine, calls, shown, drive, tick: (ms) => { clock += ms; } };
}

test('engine: one area download serves a whole stretch of road', async () => {
  const h = harness();
  for (let e = -300; e <= 300; e += 15) await h.drive(0, e, 90);
  assert.equal(h.calls.area, 1);
  assert.equal(h.calls.tomtom, 0);
  assert.deepEqual(h.shown, ['35 mph osm']);
});

test('engine: untagged road -> TomTom once per road, then cached', async () => {
  const h = harness();
  await h.drive(0, -200, 90); // area loads
  for (let n = -300; n <= 300; n += 15) await h.drive(n, 0, 0); // up Side Rd
  assert.equal(h.calls.tomtom, 1, 'one TomTom call for the whole road');
  assert.equal(h.calls.lastRoad, 'residential', 'passes the matched road class');
  assert.equal(h.shown.at(-1), '25 mph tomtom');
});

test("engine: never carries the previous road's limit onto an unknown road", async () => {
  const h = harness({ tomtom: () => ({ status: 'backoff' }) });
  await h.drive(0, -200, 90);
  await h.drive(0, -150, 90);
  assert.equal(h.shown.at(-1), '35 mph osm');
  for (let n = 30; n <= 200; n += 15) await h.drive(n, 0, 0); // turn onto Side Rd
  assert.equal(h.shown.at(-1), null, 'shows -- on Side Rd');
  assert.equal(h.calls.tomtom, 1, 'backoff stops further calls');
  h.tick(TOMTOM_BACKOFF_MS);
  await h.drive(250, 0, 0);
  assert.equal(h.calls.tomtom, 2, 'retries after the backoff');
});

// Drive of 2026-10-26: 90 of 91 TomTom calls answered, but only 8% of moving
// time showed a TomTom limit. Per-cell answers were filed under the ~10 m cell
// the call was made in — at road speed the car is out of that cell before the
// answer arrives, so it was never read — and the proposal key changed every
// cell, so the 2-fix confirmation could never be met either.
test('engine: a per-point TomTom answer reaches the screen at road speed', async () => {
  let answer = { status: 'hit', limit: { value: 25, unit: 'mph', source: 'tomtom' } };
  const h = harness({ areaOk: false, tomtom: () => answer });

  // OSM is down, so every fix falls through to a point lookup. 15 m per fix
  // means a different ~10 m cell every time.
  for (let i = 0; i < 6; i++) await h.drive(0, i * 15, 90, 15);
  assert.equal(h.engine.getCurrent()?.value, 25, 'the answer is actually shown');
  assert.deepEqual(h.shown, ['25 mph tomtom'], 'shown once, no flicker');

  // A later answer with a different value takes over (two fixes to agree).
  answer = { status: 'hit', limit: { value: 45, unit: 'mph', source: 'tomtom' } };
  for (let i = 6; i < 26; i++) await h.drive(0, i * 15, 90, 15);
  assert.equal(h.engine.getCurrent()?.value, 45, 'a changed limit takes effect');
});

test('engine: needs 2 consecutive fixes before switching roads', async () => {
  const h = harness();
  await h.drive(0, -200, 90);
  await h.drive(0, -150, 90);
  const before = h.shown.length;
  // One stray fix that matches the freeway, then back on Main St.
  await h.drive(15, -100, 270);
  await h.drive(0, -85, 90);
  assert.equal(h.shown.length, before, 'no flicker');
});

test('engine: TomTom calls are spaced and nothing is asked before OSM loads', async () => {
  let resolveArea;
  const h = harness();
  // Replace area fetch with a slow one.
  const slow = createLimitEngine({
    now: () => Date.now(),
    fetchArea: () => new Promise((r) => { resolveArea = r; }),
    fetchTomTom: async () => { h.calls.tomtom += 1; return { status: 'miss' }; },
  });
  const p = at(300, 300);
  slow.update({ ...p, heading: 90, speed: 20, accuracy: 5 });
  slow.update({ ...p, heading: 90, speed: 20, accuracy: 5 });
  await flush();
  assert.equal(h.calls.tomtom, 0, 'waits for the first area');
  resolveArea(syntheticArea());
  slow.dispose();
});

test('engine: OSM down -> per-cell TomTom, only while moving, spaced', async () => {
  const h = harness({ areaOk: false });
  await h.drive(0, 0, 90, 0); // parked: area fails
  await h.drive(0, 0, 90, 0);
  assert.equal(h.calls.tomtom, 0, 'no per-cell calls while parked');
  // 20 s of driving: per-cell lookups are spaced by TOMTOM_MIN_INTERVAL_MS
  // (no "new road" exemption here — OSM is down, so no road is matched).
  for (let i = 0; i < 20; i++) await h.drive(0, i * 15, 90, 15);
  const expected = 1 + Math.floor(20000 / TOMTOM_MIN_INTERVAL_MS);
  assert.equal(h.calls.tomtom, expected, `one call per ${TOMTOM_MIN_INTERVAL_MS} ms`);
  h.tick(TOMTOM_MIN_INTERVAL_MS);
  await h.drive(0, 400, 90, 15);
  assert.equal(h.calls.tomtom, expected + 1);
  const s = h.engine.getStats();
  assert.ok(s.areaFailures >= 1);
  assert.equal(s.tomtomCalls, expected + 1);
});

test('engine: a new road is asked about promptly, not after the full spacing', async () => {
  // Side Rd has no OSM maxspeed; TomTom answers 25.
  const h = harness();
  await h.drive(0, -200, 90); // Main St (35 mph from OSM), area loads
  await h.drive(0, -150, 90);
  assert.equal(h.calls.tomtom, 0, 'tagged road costs nothing');
  // Turn onto Side Rd a few seconds later: the lookup should not wait 30 s.
  await h.drive(60, 0, 0);
  await h.drive(90, 0, 0);
  await h.drive(120, 0, 0);
  assert.equal(h.calls.tomtom, 1, 'asked within seconds of the turn');
  assert.equal(h.shown.at(-1), '25 mph tomtom');
});

test('engine: a road TomTom had no answer for is retried later', async () => {
  const h = harness({ tomtom: () => ({ status: 'miss' }) });
  await h.drive(0, -200, 90);
  for (let n = 60; n <= 180; n += 30) await h.drive(n, 0, 0); // up the untagged road
  assert.equal(h.calls.tomtom, 1, 'one call, then remembered as unknown');
  assert.equal(h.engine.getCurrent() ?? null, null, 'shows --');
  h.tick(21 * 60 * 1000); // past WAY_MISS_TTL_MS
  await h.drive(210, 0, 0);
  await h.drive(240, 0, 0);
  assert.equal(h.calls.tomtom, 2, 'asked again on a later pass');
});

test('engine: stats split moving time by source', async () => {
  const h = harness();
  for (let e = -300; e <= 0; e += 15) await h.drive(0, e, 90);
  const s = h.engine.getStats();
  assert.ok(s.movingSeconds > 15);
  assert.ok(s.osmSeconds > 10);
  h.engine.resetStats();
  assert.equal(h.engine.getStats().movingSeconds, 0);
});

test('engine: restoreStats adds saved counters', async () => {
  const h = harness();
  h.engine.restoreStats({ since: 1, movingSeconds: 100, tomtomCalls: 3, bogus: 'x' });
  const s = h.engine.getStats();
  assert.equal(s.movingSeconds, 100);
  assert.equal(s.tomtomCalls, 3);
  assert.equal(s.since, 1);
  assert.equal(s.bogus, undefined);
});

// ---------------------------------------------------------------------------
// TomTom client
// ---------------------------------------------------------------------------
import { fetchTomTomLimit } from '../tomtom.js';

const fakeResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('tomtom client: builds without a token never touch the network', async () => {
  let called = false;
  const r = await fetchTomTomLimit(40.1, -74.2, 90, {
    clientToken: '',
    fetchImpl: async () => { called = true; return fakeResponse(200, {}); },
  });
  assert.equal(r.status, 'backoff');
  assert.equal(called, false);
});

test('tomtom client: sends the token and rounded coordinates, maps statuses', async () => {
  let seen;
  const ok = await fetchTomTomLimit(40.123456, -74.987654, 91.6, {
    clientToken: 'tkn',
    proxyUrl: 'https://proxy.test',
    road: 'motorway',
    fetchImpl: async (url, opts) => { seen = { url, opts }; return fakeResponse(200, { value: 45, unit: 'mph', source: 'tomtom' }); },
  });
  assert.equal(seen.url, 'https://proxy.test/limit?lat=40.1235&lon=-74.9877&heading=92&road=motorway');
  assert.equal(seen.opts.headers['X-Client-Token'], 'tkn');
  assert.deepEqual(ok, { status: 'hit', limit: { value: 45, unit: 'mph', source: 'tomtom' } });

  const call = (status, body = {}) =>
    fetchTomTomLimit(1, 2, null, { clientToken: 't', fetchImpl: async () => fakeResponse(status, body) });
  assert.equal((await call(200, { value: null })).status, 'miss');
  for (const s of [403, 429, 503]) assert.equal((await call(s)).status, 'backoff');
  assert.equal((await call(502)).status, 'error');
});

// ---------------------------------------------------------------------------
// Regressions for "CarPlay limit stuck on 55" (2026-09-18)
// ---------------------------------------------------------------------------
function parallelRoadsArea() {
  // Three two-way east-west roads 40 m apart: A 35 mph (n=0), B 45 mph (n=40), C 55 mph (n=80).
  const line = (n) => ({
    type: 'LineString',
    coordinates: [[LON + dLon(-600), LAT + dLat(n)], [LON + dLon(600), LAT + dLat(n)]],
  });
  const way = (id, n, maxspeed) => ({
    type: 'way', id, geometry: line(n),
    tags: { highway: 'primary', maxspeed, mf: '', mb: '', oneway: '', name: `R${id}` },
  });
  return parseArea({ elements: [way(1, 0, '35 mph'), way(2, 40, '45 mph'), way(3, 80, '55 mph')] }, syntheticBox);
}

function engineWith(fetchArea) {
  let clock = 5_000_000;
  const shown = [];
  let areaCalls = 0;
  const engine = createLimitEngine({
    now: () => clock,
    fetchArea: (...args) => { areaCalls += 1; return fetchArea(...args); },
    fetchTomTom: async () => ({ status: 'backoff' }),
    onLimit: (l) => shown.push(l && `${l.value}`),
  });
  const fix = async (north, east, heading = 90, speed = 15) => {
    clock += 1000;
    const p = at(north, east);
    engine.update({ ...p, heading, speed, accuracy: 5 });
    await flush();
  };
  return { engine, shown, fix, areaCalls: () => areaCalls };
}

test('engine: an unconfirmed stream of different roads does not freeze the old limit', async () => {
  const h = engineWith(async () => parallelRoadsArea());
  await h.fix(0, -300);
  await h.fix(0, -285);
  assert.equal(h.shown.at(-1), '35');
  // Alternate between B and C every fix for 70 s: neither is ever confirmed.
  for (let i = 0; i < 70; i++) await h.fix(i % 2 ? 80 : 40, -270 + i * 15);
  assert.equal(h.shown.at(-1), null, 'falls back to -- instead of keeping 35');
});

test('engine: switching to a road with the same limit is immediate', async () => {
  const area = parallelRoadsArea();
  area.ways[1].tags.maxspeed = '35 mph'; // B now also 35
  const h = engineWith(async () => area);
  await h.fix(0, -300);
  await h.fix(0, -285);
  const changes = h.engine.getStats().limitChanges;
  await h.fix(40, -270); // single fix on B
  assert.equal(h.shown.at(-1), '35');
  assert.equal(h.engine.getStats().limitChanges, changes, 'no visible change');
});

test('engine: a hung map download is abandoned and retried (no timers needed)', async () => {
  let resolveFirst;
  let calls = 0;
  const h = engineWith(() => {
    calls += 1;
    if (calls === 1) return new Promise((r) => { resolveFirst = r; }); // never settles on its own
    return Promise.resolve(parallelRoadsArea());
  });
  for (let i = 0; i < 27; i++) await h.fix(0, -300 + i * 5); // > 25 s after the download started
  assert.equal(h.engine.getStats().areaTimeouts, 1);
  // Retry waits for the back-off (15 s), then a fresh download succeeds.
  for (let i = 0; i < 17; i++) await h.fix(0, -165 + i * 5);
  assert.equal(calls, 2, 'retried');
  assert.equal(h.shown.at(-1), '35');
  // The hung request finally answering must not overwrite anything.
  resolveFirst(parseArea({ elements: [] }, syntheticBox));
  await flush();
  await h.fix(0, -80);
  assert.equal(h.shown.at(-1), '35');
});

// ---------------------------------------------------------------------------
// Cost savings: inherit limits from the same road; reuse OSM data across drives
// ---------------------------------------------------------------------------
import { createAreaStore } from '../areaStore.js';
import { inferRoadLimits, roadKey, inheritedLimit, INHERIT_MAX_M } from '../osmArea.js';
import { parseZoneLimit } from '../zoneLimits.js';

function splitRoadJson() {
  // "Main St" in three pieces west->east: the middle one has no maxspeed.
  // "Other Rd" is two pieces that disagree, so nothing may be inherited.
  const seg = (id, fromE, toE, north, tags) => ({
    type: 'way', id,
    geometry: { type: 'LineString', coordinates: [[LON + dLon(fromE), LAT + dLat(north)], [LON + dLon(toE), LAT + dLat(north)]] },
    tags: { highway: 'secondary', maxspeed: '', mf: '', mb: '', oneway: '', ref: '', ...tags },
  });
  return {
    elements: [
      seg(10, -600, -200, 0, { name: 'Main St', maxspeed: '40 mph' }),
      seg(11, -200, 200, 0, { name: 'Main St' }),
      seg(12, 200, 600, 0, { name: 'Main St', maxspeed: '40 mph' }),
      seg(20, -600, 0, 200, { name: 'Other Rd', maxspeed: '30 mph' }),
      seg(21, 0, 600, 200, { name: 'Other Rd', maxspeed: '50 mph' }),
      seg(22, -600, 600, 400, { name: 'Other Rd' }),
    ],
  };
}

test('roadKey / inferRoadLimits: tagged pieces indexed per road, class-scoped', () => {
  assert.equal(roadKey({ highway: 'secondary', name: 'Main St' }), 'secondary|main st');
  assert.equal(roadKey({ highway: 'secondary_link', ref: 'NJ 18', name: 'x' }), 'secondary|nj 18');
  assert.equal(roadKey({ highway: 'residential' }), null);
  const inferred = inferRoadLimits(parseArea(splitRoadJson(), syntheticBox).ways);
  assert.deepEqual(inferred.get('secondary|main st').map((p) => p.limit.value), [40, 40]);
  // Pieces that disagree are kept, not discarded: the nearest one wins at
  // match time, which is how a road whose limit steps gets followed.
  assert.deepEqual(inferred.get('secondary|other rd').map((p) => p.limit.value), [30, 50]);
});

// "Other Rd" is tagged 30 mph west of centre and 50 mph east of it, with a
// third, untagged piece running the whole width 200 m to the north. The old
// rule called that a conflict and inherited nothing anywhere along the road —
// the common case on any road long enough to change limit, which is where most
// driving time goes.
test('a road whose limit steps inherits the nearest value, not nothing', () => {
  const area = parseArea(splitRoadJson(), syntheticBox);
  const west = at(400, -400);
  const east = at(400, 400);
  const mWest = matchRoad(area, west.lat, west.lon, 90, 20, 5);
  const mEast = matchRoad(area, east.lat, east.lon, 90, 20, 5);

  assert.equal(mWest.inferred, true, 'west end inherits');
  assert.equal(mWest.limit.value, 30, 'from the 30 mph piece beside it');
  assert.equal(mEast.inferred, true, 'east end inherits');
  assert.equal(mEast.limit.value, 50, 'from the 50 mph piece beside it');
});

test('parseZoneLimit: numbers are taken as given, classes must be known', () => {
  // Stated outright — no statute knowledge involved.
  assert.deepEqual(parseZoneLimit('US-NC:35'), { value: 35, unit: 'mph' });
  assert.deepEqual(parseZoneLimit('DE:30'), { value: 30, unit: 'kmh' });
  assert.deepEqual(parseZoneLimit('GB:20'), { value: 20, unit: 'mph' });
  // Named statutory classes we have a number for.
  assert.deepEqual(parseZoneLimit('GB:nsl_single'), { value: 60, unit: 'mph' });
  assert.deepEqual(parseZoneLimit('de:urban'), { value: 50, unit: 'kmh' });
  // Anything we cannot resolve honestly stays unknown.
  assert.equal(parseZoneLimit('sign'), null, 'says nothing about the number');
  assert.equal(parseZoneLimit('US:urban'), null, 'varies by state');
  assert.equal(parseZoneLimit('DE:motorway'), null, 'advisory, not a limit');
  assert.equal(parseZoneLimit(''), null);
  assert.equal(parseZoneLimit(null), null);
  assert.equal(parseZoneLimit('US-NC:0'), null);
});

test('a way with only a statutory-default tag gets a limit', () => {
  const zoneWay = (id, tags) => ({
    type: 'way', id,
    geometry: { type: 'LineString', coordinates: [[LON + dLon(-300), LAT + dLat(800)], [LON + dLon(300), LAT + dLat(800)]] },
    tags: { highway: 'residential', name: 'Zone Rd', ...tags },
  });

  const implied = parseArea({ elements: [zoneWay(90, { mt: 'US-NC:35' })] }, syntheticBox);
  const p = at(800, 0);
  const m = matchRoad(implied, p.lat, p.lon, 90, 20, 5);
  assert.equal(m.limit.value, 35, 'the statutory default is shown');
  assert.equal(m.implied, true, 'and marked as implied, not surveyed');
  assert.equal(m.inferred, false);

  // A posted maxspeed on the way itself still wins.
  const posted = parseArea(
    { elements: [zoneWay(91, { mt: 'US-NC:35', maxspeed: '45 mph' })] },
    syntheticBox
  );
  const mp = matchRoad(posted, p.lat, p.lon, 90, 20, 5);
  assert.equal(mp.limit.value, 45, 'a sign beats the statutory default');
  assert.equal(mp.implied, false);

  // An unresolvable value leaves the way unknown rather than guessing.
  const vague = parseArea({ elements: [zoneWay(92, { mt: 'US:urban' })] }, syntheticBox);
  assert.equal(matchRoad(vague, p.lat, p.lon, 90, 20, 5).limit, null);
});

test('inheritance does not reach across a distant road', () => {
  const area = parseArea(splitRoadJson(), syntheticBox);
  // Far enough from both tagged pieces of Other Rd to be a different stretch.
  const ways = area.ways.filter((w) => w.tags.name === 'Other Rd');
  const untagged = ways.find((w) => !w.tags.maxspeed);
  const far = { x: 0, y: INHERIT_MAX_M + 500 };
  assert.equal(inheritedLimit(area, untagged, far), null, 'beyond INHERIT_MAX_M');
});

test('engine: untagged piece of a known road costs no TomTom call', async () => {
  let clock = 9_000_000;
  const calls = { tomtom: 0 };
  const shown = [];
  const engine = createLimitEngine({
    now: () => clock,
    fetchArea: async () => parseArea(splitRoadJson(), syntheticBox),
    fetchTomTom: async () => { calls.tomtom += 1; return { status: 'hit', limit: { value: 99, unit: 'mph', source: 'tomtom' } }; },
    onLimit: (l) => shown.push(l && `${l.value}${l.inferred ? ' (inherited)' : ''}`),
  });
  for (let e = -500; e <= 500; e += 20) {
    clock += 1000;
    const p = at(0, e);
    engine.update({ ...p, heading: 90, speed: 20, accuracy: 5 });
    await flush();
  }
  assert.equal(calls.tomtom, 0, 'no paid lookup on the untagged middle piece');
  assert.deepEqual(shown, ['40'], 'one limit, never dropped');
  assert.ok(engine.getStats().inferredSeconds > 0, 'inherited time is tracked');
});

test('areaStore: a second drive needs no download', async () => {
  const mem = new Map();
  const storage = {
    getItem: async (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: async (k, v) => { mem.set(k, v); },
    removeItem: async (k) => { mem.delete(k); },
  };
  const store = createAreaStore(storage);
  const raw = splitRoadJson().elements;

  const drive = async () => {
    let clock = 10_000_000;
    let downloads = 0;
    const engine = createLimitEngine({
      now: () => clock,
      areaStore: store,
      fetchArea: async (box) => {
        downloads += 1;
        const a = parseArea({ elements: raw }, box);
        a.raw = raw;
        return a;
      },
      fetchTomTom: async () => ({ status: 'backoff' }),
    });
    for (let e = -400; e <= 400; e += 50) {
      clock += 1000;
      const p = at(0, e);
      engine.update({ ...p, heading: 90, speed: 20, accuracy: 5 });
      await flush();
    }
    return { downloads, stats: engine.getStats(), limit: engine.getCurrent() };
  };

  const first = await drive();
  assert.equal(first.downloads, 1);
  const second = await drive();
  assert.equal(second.downloads, 0, 'served from the device store');
  assert.equal(second.stats.areaFromStore, 1);
  assert.equal(second.limit.value, 40, 'and still shows the limit');
});

test('areaStore: stale records are ignored', async () => {
  const mem = new Map();
  const storage = {
    getItem: async (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: async (k, v) => { mem.set(k, v); },
    removeItem: async (k) => { mem.delete(k); },
  };
  let t = 1_000_000_000;
  const store = createAreaStore(storage, { maxAgeMs: 1000, now: () => t });
  const box = areaBoxFor(LAT, LON, null, 0);
  await store.put(LAT, LON, splitRoadJson().elements, box);
  assert.ok(await store.get(LAT, LON), 'fresh record is used');
  t += 5000;
  assert.equal(await store.get(LAT, LON), null, 'stale record is not');
});

// Real drive 2026-10-27: "Maps reused from device 81" in 29 minutes, and the
// whole way home showed nothing. Boxes are shifted ahead in the direction of
// travel, so driving back through them puts you near their trailing edge —
// inside the box, but within the refresh margin. The store answered with
// margin 0, so it kept handing back the very box the engine was trying to
// replace: every fix "reloaded" it, no new box was ever downloaded, and the
// car left the box with nothing to replace it.
test('areaStore: a box you are about to leave is not reused forever', async () => {
  const mem = new Map();
  const storage = {
    getItem: async (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: async (k, v) => { mem.set(k, v); },
    removeItem: async (k) => { mem.delete(k); },
  };
  const store = createAreaStore(storage);
  const raw = splitRoadJson().elements;

  // Stored while driving EAST: box spans x = -400 m … +1200 m.
  await store.put(LAT, LON, raw, areaBoxFor(LAT, LON, 90, 20));

  let clock = 10_000_000;
  let downloads = 0;
  const engine = createLimitEngine({
    now: () => clock,
    areaStore: store,
    fetchArea: async (box) => {
      downloads += 1;
      const a = parseArea({ elements: raw }, box);
      a.raw = raw;
      return a;
    },
    fetchTomTom: async () => ({ status: 'backoff' }),
  });

  // Now drive WEST back through it, towards the trailing edge at -400 m.
  for (let e = -100; e >= -500; e -= 50) {
    clock += 1000;
    engine.update({ ...at(0, e), heading: 270, speed: 20, accuracy: 5 });
    await flush();
  }

  const stats = engine.getStats();
  assert.ok(downloads >= 1, 'the next box is downloaded before the edge');
  assert.ok(
    stats.areaFromStore <= 1,
    `store answered once at most, not once per fix (got ${stats.areaFromStore})`
  );
});

// Leaving a box while its replacement is still downloading used to ask nothing
// at all — not OSM (the old box no longer covers us) and not TomTom (the cell
// fallback was gated on areaContains/areaFailures). The display just held the
// last road's limit until the 60 s stale rule blanked it.
test('a slow area download falls back to TomTom instead of asking nothing', async () => {
  let clock = 10_000_000;
  let fetches = 0;
  let secondFetchAt = 0;
  let tomtomAt = 0;

  const engine = createLimitEngine({
    now: () => clock,
    fetchArea: async (box) => {
      fetches += 1;
      if (fetches === 1) {
        const a = parseArea(syntheticJson(), box);
        a.raw = syntheticJson().elements;
        return a;
      }
      secondFetchAt = clock;
      return new Promise(() => {}); // Overpass hanging, as it often does
    },
    fetchTomTom: async () => {
      if (!tomtomAt) tomtomAt = clock;
      return { status: 'hit', limit: { value: 45, unit: 'mph' } };
    },
  });

  // First box loads around the origin, shifted east to x = -400 … +1200 m.
  engine.update({ ...at(0, 0), heading: 90, speed: 20, accuracy: 5 });
  await flush();

  // Now well past the box edge (1200 m), so nothing on the device covers us
  // and the replacement never arrives.
  for (let e = 1500; e <= 2500; e += 100) {
    clock += 2000;
    engine.update({ ...at(0, e), heading: 90, speed: 20, accuracy: 5 });
    await flush();
  }

  assert.ok(secondFetchAt > 0, 'a replacement box was requested');
  assert.ok(tomtomAt > 0, 'TomTom was asked while the download hung');
  const waited = tomtomAt - secondFetchAt;
  assert.ok(
    waited >= 6000 && waited < 25000,
    `asked after the grace period but before the watchdog (waited ${waited} ms)`
  );
});

// ---------------------------------------------------------------------------
// Worker entitlement rules (pure parts of proxy/worker.js)
// ---------------------------------------------------------------------------
import { isEntitled, validAppUserId } from '../../proxy/worker.js';

test('worker: entitlement is active only until it expires', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const body = (expires) => ({ subscriber: { entitlements: { pro: { expires_date: expires } } } });
  assert.equal(isEntitled(body('2026-09-26T12:00:01Z'), now), true);
  assert.equal(isEntitled(body('2026-09-26T11:59:59Z'), now), false);
  assert.equal(isEntitled(body(null), now), true, 'lifetime grant');
  assert.equal(isEntitled(body('nonsense'), now), false);
  assert.equal(isEntitled({ subscriber: { entitlements: {} } }, now), false);
  assert.equal(isEntitled({}, now), false);
  assert.equal(isEntitled(null, now), false);
});

test('worker: app user ids are validated before use', () => {
  assert.equal(validAppUserId('$RCAnonymousID:8f3b1c2d4e5f6a7b8c9d0e1f2a3b4c5d'), true);
  assert.equal(validAppUserId('short'), false);
  assert.equal(validAppUserId('bad/../id'), false);
  assert.equal(validAppUserId('x'.repeat(200)), false);
  assert.equal(validAppUserId(null), false);
});

test('tomtom client: sends the subscription id when there is no test token', async () => {
  let seen;
  await fetchTomTomLimit(1, 2, null, {
    clientToken: '',
    appUserId: 'user-123456',
    fetchImpl: async (url, opts) => { seen = opts; return { ok: true, status: 200, json: async () => ({ value: null }) }; },
  });
  assert.equal(seen.headers['X-App-User-Id'], 'user-123456');
  assert.equal(seen.headers['X-Client-Token'], undefined);
});

// ---------------------------------------------------------------------------
// Snap to Roads (highways) — Worker helpers
// ---------------------------------------------------------------------------
import { limitFromSnap, parsePoint, useSnapFor } from '../../proxy/worker.js';

test('worker: snap is used only for motorway-like classes', () => {
  for (const c of ['motorway', 'trunk', 'motorway_link', 'primary_link']) {
    assert.equal(useSnapFor(c), true, c);
  }
  for (const c of ['residential', 'primary', 'secondary', 'tertiary', '', null]) {
    assert.equal(useSnapFor(c), false, String(c));
  }
});

test('worker: point validation', () => {
  assert.equal(parsePoint('-74.4569,40.5072'), '-74.4569,40.5072');
  assert.equal(parsePoint('200,40'), null);
  assert.equal(parsePoint('-74.4569'), null);
  assert.equal(parsePoint('a,b'), null);
  assert.equal(parsePoint(null), null);
});

test('worker: snap response -> the limit where the driver now is', () => {
  const seg = (value, unit) => ({ properties: { speedLimits: { value, unit, type: 'Maximum' } } });
  assert.deepEqual(limitFromSnap({ route: [seg(45, 'mph'), seg(55, 'mph')] }), { value: 55, unit: 'mph' });
  assert.deepEqual(limitFromSnap({ route: [seg(80, 'kmph')] }), { value: 80, unit: 'kmh' });
  // Skips trailing segments that have no limit.
  assert.deepEqual(limitFromSnap({ route: [seg(55, 'mph'), { properties: {} }] }), { value: 55, unit: 'mph' });
  assert.equal(limitFromSnap({ route: [] }), null);
  assert.equal(limitFromSnap(null), null);
});

test('tomtom client: sends the previous point for snapping', async () => {
  let seen;
  await fetchTomTomLimit(40.5072, -74.4569, 290, {
    clientToken: 't',
    proxyUrl: 'https://proxy.test',
    road: 'motorway',
    prev: { lat: 40.5058, lon: -74.4551 },
    fetchImpl: async (url) => { seen = url; return { ok: true, status: 200, json: async () => ({ value: null }) }; },
  });
  assert.match(seen, /&road=motorway&prev=-74\.45510,40\.50580$/);
});
