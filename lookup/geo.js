// Small geometry helpers. Distances in meters, angles in degrees.
// Uses a local equirectangular projection — accurate to well under 1% over the
// couple of kilometres we ever compare, and cheap enough to run every GPS fix.

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Meters per degree at a latitude.
export function metersPerDegree(lat) {
  return { lat: 111320, lon: 111320 * Math.cos(toRad(lat)) };
}

// Project (lat, lon) to local x/y meters around an origin latitude/longitude.
export function project(lat, lon, originLat, originLon, mpd = metersPerDegree(originLat)) {
  return { x: (lon - originLon) * mpd.lon, y: (lat - originLat) * mpd.lat };
}

// Distance from point p to segment a-b (all in local meters), and where along
// the segment the closest point is (t in [0, 1]).
export function pointToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return { dist: Math.hypot(p.x - cx, p.y - cy), t };
}

// Compass bearing (0 = north, 90 = east) of the vector a -> b in local meters.
export function bearing(a, b) {
  const deg = (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
  return (deg + 360) % 360;
}

// Smallest absolute difference between two bearings, 0..180.
export function angleDiff(a, b) {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}
