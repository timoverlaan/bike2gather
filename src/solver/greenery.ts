import { pointInRing, pointSegDist, projector, samplePolyline, simplify } from './geo';

/**
 * Greenery is measured by sampling a route every SAMPLE_STEP metres and checking
 * whether the sample lies inside (or right next to) parks, woods, grass, farmland,
 * water, or tree rows from OpenStreetMap.
 */
export const SAMPLE_STEP = 40;
export const EDGE_DIST = 20;

const AREA_VALUES =
  'forest|wood|grass|meadow|park|scrub|heath|nature_reserve|garden|recreation_ground|village_green|farmland|orchard|wetland|water|allotments|cemetery|common';

/** Overpass query for green features near the given polylines ([lat, lon]). */
export function greenQuery(lines: [number, number][][]): string {
  const parts: string[] = [];
  for (const line of lines) {
    const simple = simplify(line, 25);
    // Overpass `around` with a coordinate list treats it as a polyline.
    const coords = simple.map(([la, lo]) => `${la.toFixed(5)},${lo.toFixed(5)}`).join(',');
    const around = `(around:${EDGE_DIST},${coords})`;
    parts.push(
      `way${around}[~"^(landuse|leisure|natural)$"~"^(${AREA_VALUES})$"];`,
      `rel${around}[~"^(landuse|leisure|natural)$"~"^(${AREA_VALUES})$"];`,
      `way${around}["natural"="tree_row"];`,
      `way${around}["waterway"~"^(river|canal)$"];`,
    );
  }
  return `[out:json][timeout:60];\n(\n${parts.join('\n')}\n);\nout geom;`;
}

interface OverpassGeomEl {
  type: 'way' | 'relation' | 'node';
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
  tags?: Record<string, string>;
}

export interface GreenFeatures {
  /** Closed rings (projected) – a sample inside counts as green. */
  rings: { ring: [number, number][]; box: [number, number, number, number] }[];
  /** Open lines (projected) – a sample within EDGE_DIST counts as green. */
  lines: { line: [number, number][]; box: [number, number, number, number] }[];
  refLat: number;
}

function boxOf(pts: [number, number][], pad = 0): [number, number, number, number] {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

export function parseGreen(elements: OverpassGeomEl[], refLat: number): GreenFeatures {
  const proj = projector(refLat);
  const rings: GreenFeatures['rings'] = [];
  const lines: GreenFeatures['lines'] = [];
  const add = (geom: { lat: number; lon: number }[] | undefined, asArea: boolean) => {
    if (!geom || geom.length < 2) return;
    const pts = geom.map((g) => proj.toXY(g.lat, g.lon));
    const first = geom[0];
    const last = geom[geom.length - 1];
    const closed = geom.length >= 4 && first.lat === last.lat && first.lon === last.lon;
    // Edges always count (riding along a park or canal is scenic too).
    lines.push({ line: pts, box: boxOf(pts, EDGE_DIST) });
    if (asArea && closed) rings.push({ ring: pts, box: boxOf(pts) });
  };
  for (const el of elements) {
    const isLinear = el.tags?.natural === 'tree_row' || el.tags?.waterway != null;
    if (el.type === 'way') add(el.geometry, !isLinear);
    else if (el.type === 'relation') {
      for (const m of el.members ?? []) if (m.type === 'way' && m.role !== 'inner') add(m.geometry, true);
    }
  }
  return { rings, lines, refLat };
}

const inBox = (p: [number, number], b: [number, number, number, number]) =>
  p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

/** Fraction (0–1) of a polyline that runs through or along green features. */
export function greenFraction(coords: [number, number][], f: GreenFeatures): number {
  const samples = samplePolyline(coords, SAMPLE_STEP);
  if (samples.length === 0) return 0;
  const proj = projector(f.refLat);
  let green = 0;
  for (const [lat, lon] of samples) {
    const p = proj.toXY(lat, lon);
    if (isGreen(p, f)) green++;
  }
  return green / samples.length;
}

function isGreen(p: [number, number], f: GreenFeatures): boolean {
  for (const r of f.rings) if (inBox(p, r.box) && pointInRing(p, r.ring)) return true;
  for (const l of f.lines) {
    if (!inBox(p, l.box)) continue;
    for (let i = 1; i < l.line.length; i++) {
      if (pointSegDist(p, l.line[i - 1], l.line[i]) <= EDGE_DIST) return true;
    }
  }
  return false;
}
