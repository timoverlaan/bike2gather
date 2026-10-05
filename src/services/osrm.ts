import type { LatLon } from '../types';
import { fetchJson, key, limiter } from './http';

/**
 * OSRM bicycle routing hosted by FOSSGIS e.V. (routing.openstreetmap.de) –
 * free, no key, GDPR-governed. Meant for light use, so requests are throttled.
 */
const BASE = 'https://routing.openstreetmap.de/routed-bike';
/** Max coordinates per table request on the public server. */
export const TABLE_LIMIT = 100;

const throttle = limiter(2, 250, 'osrm');

const fmt = (pts: LatLon[]) => pts.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');

interface TableResponse {
  code: string;
  distances?: (number | null)[][];
  destinations?: { location: [number, number] }[];
  sources?: { location: [number, number] }[];
}

/** Bicycle distance matrix (metres) from each source to each destination. */
export async function table(
  sources: LatLon[],
  destinations: LatLon[],
): Promise<{ distances: (number | null)[][]; srcSnapped: LatLon[]; dstSnapped: LatLon[] }> {
  const coords = [...sources, ...destinations];
  if (coords.length > TABLE_LIMIT) throw new Error('Too many coordinates for one table request');
  const src = sources.map((_, i) => i).join(';');
  const dst = destinations.map((_, i) => i + sources.length).join(';');
  const url = `${BASE}/table/v1/driving/${fmt(coords)}?sources=${src}&destinations=${dst}&annotations=distance`;
  const data = await throttle(() => fetchJson<TableResponse>(url, { timeoutMs: 30000 }));
  if (data.code !== 'Ok' || !data.distances) throw new Error(`OSRM table: ${data.code}`);
  const toLL = (l: { location: [number, number] }) => ({ lat: l.location[1], lon: l.location[0] });
  return {
    distances: data.distances,
    srcSnapped: (data.sources ?? []).map(toLL),
    dstSnapped: (data.destinations ?? []).map(toLL),
  };
}

interface RouteResponse {
  code: string;
  routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[];
}

export interface Route {
  distance: number;
  coords: [number, number][]; // [lat, lon]
}

const routeCache = new Map<string, Promise<Route>>();

export function route(from: LatLon, to: LatLon): Promise<Route> {
  const k = `${key(from.lat, from.lon)}>${key(to.lat, to.lon)}`;
  let p = routeCache.get(k);
  if (!p) {
    const url = `${BASE}/route/v1/driving/${fmt([from, to])}?overview=full&geometries=geojson`;
    p = throttle(() => fetchJson<RouteResponse>(url, { timeoutMs: 25000 })).then((d) => {
      const r = d.routes?.[0];
      if (d.code !== 'Ok' || !r) throw new Error(`OSRM route: ${d.code}`);
      return { distance: r.distance, coords: r.geometry.coordinates.map(([lo, la]) => [la, lo]) };
    });
    p.catch(() => routeCache.delete(k));
    routeCache.set(k, p);
  }
  return p;
}

/** For tests: forget cached routes. */
export function clearRouteCache() {
  routeCache.clear();
}
