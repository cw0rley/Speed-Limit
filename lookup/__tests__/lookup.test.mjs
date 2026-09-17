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
    fetchTomTom: async () => {
      calls.tomtom += 1;
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
  for (let i = 0; i < 20; i++) await h.drive(0, i * 15, 90, 15); // 20 s of driving
  assert.equal(h.calls.tomtom, 1, 'at most one call per 30 s');
  h.tick(TOMTOM_MIN_INTERVAL_MS);
  await h.drive(0, 400, 90, 15);
  assert.equal(h.calls.tomtom, 2);
  const s = h.engine.getStats();
  assert.ok(s.areaFailures >= 1);
  assert.equal(s.tomtomCalls, 2);
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
