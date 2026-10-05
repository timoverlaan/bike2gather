import type { Candidate, LatLon, Person, Settings, SpotType } from '../types';
import { bboxOf, haversine, type BBox } from './geo';
import { evaluate } from './scoring';

/** Typical ratio between cycling network distance and crow-fly distance in NL. */
export const DETOUR_FACTOR = 1.3;

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export function classify(tags: Record<string, string>): SpotType | null {
  const { amenity, shop, leisure, place, railway, tourism, historic, man_made } = tags;
  if (amenity === 'cafe' || amenity === 'ice_cream' || shop === 'bakery' || shop === 'coffee') return 'cafe';
  if (leisure === 'park') return 'park';
  if (place === 'square') return 'square';
  if (railway === 'station' || railway === 'halt') return 'station';
  if (shop === 'bicycle') return 'bikeshop';
  if (
    tourism === 'viewpoint' ||
    tourism === 'artwork' ||
    tourism === 'attraction' ||
    historic === 'windmill' ||
    historic === 'monument' ||
    man_made === 'windmill' ||
    amenity === 'fountain'
  )
    return 'landmark';
  return null;
}

export function poiQuery(b: BBox): string {
  const bb = `${b.south.toFixed(5)},${b.west.toFixed(5)},${b.north.toFixed(5)},${b.east.toFixed(5)}`;
  return `[out:json][timeout:40];
(
  node["amenity"~"^(cafe|ice_cream|fountain)$"](${bb});
  node["shop"~"^(bakery|coffee|bicycle)$"](${bb});
  nwr["leisure"="park"]["name"](${bb});
  nwr["place"="square"](${bb});
  node["railway"~"^(station|halt)$"](${bb});
  nwr["tourism"~"^(viewpoint|artwork|attraction)$"]["name"](${bb});
  nwr["man_made"="windmill"](${bb});
  nwr["historic"~"^(windmill|monument)$"](${bb});
);
out center tags;`;
}

export function poisToCandidates(elements: OsmElement[]): Candidate[] {
  const out: Candidate[] = [];
  for (const el of elements) {
    const pos = el.center ?? (el.lat != null && el.lon != null ? { lat: el.lat, lon: el.lon } : null);
    if (!pos || !el.tags) continue;
    const type = classify(el.tags);
    if (!type) continue;
    out.push({ id: `${el.type[0]}${el.id}`, lat: pos.lat, lon: pos.lon, type, name: el.tags.name ?? null });
  }
  return out;
}

/** Regular grid of generic meeting points covering the bounding box. */
export function gridCandidates(b: BBox, cells = 16): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i <= cells; i++) {
    for (let j = 0; j <= cells; j++) {
      const lat = b.south + ((b.north - b.south) * i) / cells;
      const lon = b.west + ((b.east - b.west) * j) / cells;
      out.push({ id: `g${i}_${j}`, lat, lon, type: 'generic', name: null });
    }
  }
  return out;
}

/** Bounding box that can contain a sensible meetup point for everyone. */
export function searchArea(homes: LatLon[], dest: LatLon): BBox {
  const pts = [...homes, dest];
  const span = Math.max(...pts.map((p) => haversine(p, dest)));
  return bboxOf(pts, Math.min(3000, Math.max(500, span * 0.15)));
}

/**
 * Rank candidates with crow-fly estimates (× DETOUR_FACTOR) using the real
 * scoring function, and keep the `limit` most promising ones, de-duplicated.
 */
export function prefilter(
  candidates: Candidate[],
  people: Person[],
  dest: LatLon,
  settings: Settings,
  limit: number,
): Candidate[] {
  const homes = people.map((p) => p.home!) as LatLon[];
  const direct = homes.map((h) => haversine(h, dest) * DETOUR_FACTOR);
  const allowed = candidates.filter((c) => c.custom || settings.spotTypes[c.type]);

  // Skip spots that are hopeless for any single person: way off everyone's route.
  const maxDirect = Math.max(...direct, 1000);
  const scored = allowed
    .map((c) => {
      const personLeg = homes.map((h) => haversine(h, c) * DETOUR_FACTOR);
      const shared = haversine(c, dest) * DETOUR_FACTOR;
      const ev = evaluate({
        candidate: c,
        dist: { personLeg, shared, estimated: true },
        direct,
        people,
        settings,
      });
      return { c, total: ev.score.total, far: Math.max(...personLeg) + shared > maxDirect * 2.2 };
    })
    .filter((s) => !s.far)
    .sort((a, b) => a.total - b.total);

  // De-duplicate: within 120 m, keep the best one (POIs cluster heavily in city centres).
  // Crow-fly estimates can be badly wrong near water without bridges, so reserve a third
  // of the slots for candidates that are spread out more widely.
  const kept: Candidate[] = [];
  const fill = (cap: number, spacing: number) => {
    for (const s of scored) {
      if (kept.length >= cap) break;
      if (kept.every((k) => haversine(k, s.c) > spacing)) kept.push(s.c);
    }
  };
  fill(Math.ceil((limit * 2) / 3), 120);
  fill(limit, 700);
  fill(limit, 120);
  return kept;
}
