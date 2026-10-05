import type { LatLon } from '../types';

const R = 6371008.8;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversine(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Local equirectangular projection to metres around a reference latitude.
 * Accurate enough at city/region scale (the Netherlands is ~300 km across).
 */
export function projector(refLat: number) {
  const kx = Math.cos(toRad(refLat)) * (Math.PI / 180) * R;
  const ky = (Math.PI / 180) * R;
  return {
    toXY: (lat: number, lon: number): [number, number] => [lon * kx, lat * ky],
    toLatLon: (x: number, y: number): [number, number] => [y / ky, x / kx],
  };
}

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export function bboxOf(points: LatLon[], padMeters = 0): BBox {
  let south = Infinity,
    west = Infinity,
    north = -Infinity,
    east = -Infinity;
  for (const p of points) {
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
    west = Math.min(west, p.lon);
    east = Math.max(east, p.lon);
  }
  const dLat = padMeters / 111_320;
  const dLon = padMeters / (111_320 * Math.cos(toRad((south + north) / 2)));
  return { south: south - dLat, north: north + dLat, west: west - dLon, east: east + dLon };
}

export function lineLength(coords: [number, number][]): number {
  let d = 0;
  for (let i = 1; i < coords.length; i++) {
    d += haversine(
      { lat: coords[i - 1][0], lon: coords[i - 1][1] },
      { lat: coords[i][0], lon: coords[i][1] },
    );
  }
  return d;
}

/** Points every `step` metres along a [lat, lon] polyline (including the start). */
export function samplePolyline(coords: [number, number][], step: number): [number, number][] {
  if (coords.length === 0) return [];
  const out: [number, number][] = [coords[0]];
  let carry = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const seg = haversine({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] });
    if (seg === 0) continue;
    let pos = step - carry;
    while (pos <= seg) {
      const t = pos / seg;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      pos += step;
    }
    carry = seg - (pos - step);
  }
  return out;
}

/** Douglas–Peucker simplification with a tolerance in metres. */
export function simplify(coords: [number, number][], tolerance: number): [number, number][] {
  if (coords.length <= 2) return coords.slice();
  const proj = projector(coords[0][0]);
  const pts = coords.map(([lat, lon]) => proj.toXY(lat, lon));
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack: [number, number][] = [[0, coords.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0,
      idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = pointSegDist(pts[i], pts[s], pts[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tolerance) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

/** Distance from point p to segment ab in projected metres. */
export function pointSegDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0];
  const y = a[1] + t * dy - p[1];
  return Math.sqrt(x * x + y * y);
}

/** Ray-casting point-in-polygon on projected coordinates. */
export function pointInRing(p: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
