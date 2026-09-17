// Parsing of OpenStreetMap maxspeed tags into { value, unit }.

// "50" | "50 mph" | "30mph" | "50 km/h" | "50 kmh" | "50 kph" -> { value, unit }.
// Implicit values ("US:urban", "walk", "none", "signals"), conditional or
// multi-value tags ("35 mph;25 mph") and blanks return null.
export function parseMaxspeed(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  const mph = s.match(/^(\d+(?:\.\d+)?)\s*mph$/);
  if (mph) return positive(parseFloat(mph[1]), 'mph');
  const kmh = s.match(/^(\d+(?:\.\d+)?)\s*(km\/h|kmh|kph)$/);
  if (kmh) return positive(parseFloat(kmh[1]), 'kmh');
  const bare = s.match(/^(\d+(?:\.\d+)?)$/);
  if (bare) return positive(parseFloat(bare[1]), 'kmh'); // OSM default unit
  return null;
}

function positive(value, unit) {
  return value > 0 ? { value, unit } : null;
}

// Limit for travel along a way. `forward` = travelling in the way's drawing
// direction (null if unknown). Direction-specific tags win when they apply.
export function wayLimit(tags, forward) {
  if (!tags) return null;
  if (forward === true) {
    const f = parseMaxspeed(tags.mf);
    if (f) return f;
  } else if (forward === false) {
    const b = parseMaxspeed(tags.mb);
    if (b) return b;
  }
  const both = parseMaxspeed(tags.maxspeed);
  if (both) return both;
  // Direction unknown but only one directional value exists: use it only if
  // both directions agree (otherwise we can't tell which one applies).
  if (forward == null) {
    const f = parseMaxspeed(tags.mf);
    const b = parseMaxspeed(tags.mb);
    if (f && b && f.value === b.value && f.unit === b.unit) return f;
  }
  return null;
}

// Convert a limit to the display unit, rounded.
export function convertLimit(limit, displayUnit) {
  if (!limit) return null;
  if (limit.unit === displayUnit) return Math.round(limit.value);
  if (limit.unit === 'mph' && displayUnit === 'kmh') return Math.round(limit.value * 1.609344);
  if (limit.unit === 'kmh' && displayUnit === 'mph') return Math.round(limit.value / 1.609344);
  return Math.round(limit.value);
}
