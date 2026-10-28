// Statutory-default limits implied by OSM's `maxspeed:type`, `zone:maxspeed`
// and `source:maxspeed` tags.
//
// These tags say "there is no sign here; the limit is whatever the law says
// for this kind of road". That IS the legal limit, so showing it is honest —
// but only if the number is right, and a wrong number in a speed-limit app is
// worse than a blank sign. So:
//
//   * A value that states the number outright (`US-NC:35`, `DE:30`) is used as
//     given. No statute knowledge is involved, so there is nothing to get
//     wrong.
//   * A value that names a statutory class (`GB:nsl_single`) is only used if
//     it is in the small table below. Anything else returns null and the app
//     falls through to a paid lookup or shows `--`, exactly as before.
//
// **The table needs checking before a public release.** Statutory defaults get
// amended, and only the values that actually occur on the roads in question
// matter — `tools/osm-coverage.mjs` lists which ones appear in a real area, so
// verify those rather than trying to be complete.
//
// Deliberately NOT included: bare `US:urban` / `US:rural`. The US default
// varies by state (NC is 35 inside municipal limits where many states are 25),
// so an unqualified value cannot be resolved to a number honestly. If the
// coverage tool shows those dominating an area, the answer is to decide a
// number per state, not to guess one here.

const NAMED = new Map([
  // United Kingdom national speed limits (Highway Code). Confident.
  ['gb:nsl_single', { value: 60, unit: 'mph' }],
  ['gb:nsl_dual', { value: 70, unit: 'mph' }],
  ['gb:motorway', { value: 70, unit: 'mph' }],
  // Germany, StVO. Confident. `de:motorway` is deliberately absent: the
  // autobahn default is an advisory speed, not a limit.
  ['de:urban', { value: 50, unit: 'kmh' }],
  ['de:rural', { value: 100, unit: 'kmh' }],
  // North Carolina, GS 20-141(b): 35 mph inside municipal corporate limits,
  // 55 mph outside, unless posted otherwise. VERIFY.
  ['us-nc:urban', { value: 35, unit: 'mph' }],
  ['us-nc:rural', { value: 55, unit: 'mph' }],
]);

// Countries that post in mph, for values that state a bare number.
const MPH_COUNTRIES = new Set(['us', 'gb', 'uk', 'pr', 'vi', 'gu', 'as', 'mp', 'lr', 'mm']);

// One tag value -> { value, unit }, or null when we cannot say.
export function parseZoneLimit(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;

  // "US-NC:35", "DE:30" — the number is stated, so no statute is involved.
  const explicit = s.match(/^([a-z]{2})(?:-[a-z0-9]{1,3})?:(\d+(?:\.\d+)?)$/);
  if (explicit) {
    const value = parseFloat(explicit[2]);
    if (!(value > 0)) return null;
    return { value, unit: MPH_COUNTRIES.has(explicit[1]) ? 'mph' : 'kmh' };
  }

  // Otherwise it has to be a class we have a number for. `sign`, `survey` and
  // anything unlisted fall through to null.
  return NAMED.get(s) || null;
}

// The statutory default implied by a way's tags, if any. `maxspeed:type` is
// the current tag and wins; `zone:maxspeed` and `source:maxspeed` are the
// older spellings of the same idea.
export function zoneLimit(tags) {
  if (!tags) return null;
  return parseZoneLimit(tags.mt) || parseZoneLimit(tags.zm) || parseZoneLimit(tags.sm) || null;
}
