import type { Candidate, CandidateDistances, Evaluation, LatLon, Leg, Person, Settings } from '../types';
import { route, table, TABLE_LIMIT } from '../services/osrm';
import { overpass } from '../services/overpass';
import { reverseGeocode } from '../services/pdok';
import { key, sleep } from '../services/http';
import {
  DETOUR_FACTOR,
  gridCandidates,
  poiQuery,
  poisToCandidates,
  prefilter,
  searchArea,
  type OsmElement,
} from './candidates';
import { commonPrefixLength, haversine, lineLength, splitLine } from './geo';
import { greenFraction, greenQuery, parseGreen } from './greenery';
import { evaluate, pickDiverse } from './scoring';
import { log, warn } from '../log';

const since = (t: number) => `${Math.round(performance.now() - t)}ms`;

export type Progress = (stage: 'pois' | 'matrix' | 'routes' | 'green' | 'done', detail?: string) => void;

export interface SolveResult {
  /** Top options, worked out in detail (routes + greenery). */
  options: Evaluation[];
  /** Every candidate that was scored, for the map overview. */
  all: Evaluation[];
  /** Detailed legs per candidate id, for drawing routes. */
  legs: Map<string, { person: Leg[]; shared: Leg }>;
  warnings: string[];
}

const OPTION_SPACING = 250;

/**
 * Keeps the expensive network results (POIs, distance matrix, routes, greenery)
 * between runs so that moving a slider only re-scores locally.
 */
export class Engine {
  private poiCache = new Map<string, Candidate[]>();
  private candidates: Candidate[] = [];
  private dist = new Map<string, CandidateDistances>();
  private direct: number[] = [];
  private directEstimated = false;
  private legs = new Map<string, Leg>();
  private detailed = new Map<string, { person: Leg[]; shared: Leg }>();
  private names = new Map<string, string | null>();
  private problemKey = '';
  private people: Person[] = [];
  private dest: LatLon | null = null;
  private mode: Settings['mode'] = 'morning';
  warnings: string[] = [];
  /** How long a search waits for greenery before showing results without it. */
  greenWaitMs = 10000;
  /** Called when greenery that arrived after the results were shown is ready (re-rank). */
  onBackgroundUpdate: (() => void) | null = null;
  private greenInFlight = new Set<Leg>();
  /** "Meet where the routes join" variants: derived id → parent candidate and shift. */
  private mergeOf = new Map<string, { parent: string; shiftM: number }>();

  /** True while greenery is still being fetched in the background. */
  get greenPending() {
    return this.greenInFlight.size > 0;
  }

  get hasProblem() {
    return this.candidates.length > 0;
  }

  /** Key of the inputs that require a new search (not the weights). */
  static problemKeyOf(people: Person[], settings: Settings): string {
    return JSON.stringify([
      settings.mode,
      settings.destination && key(settings.destination.lat, settings.destination.lon),
      people.map((p) => p.home && key(p.home.lat, p.home.lon)),
    ]);
  }

  isStale(people: Person[], settings: Settings) {
    return Engine.problemKeyOf(people, settings) !== this.problemKey;
  }

  /** Full search: candidate POIs → distance matrix → detailed top options. */
  async solve(people: Person[], settings: Settings, progress: Progress): Promise<SolveResult> {
    const dest = settings.destination!;
    const homes = people.map((p) => p.home!) as LatLon[];
    this.warnings = [];
    this.people = people;
    this.dest = dest;
    this.mode = settings.mode;
    const custom = this.candidates.filter((c) => c.custom);
    const newKey = Engine.problemKeyOf(people, settings);
    if (newKey !== this.problemKey) custom.length = 0;
    this.problemKey = newKey;
    this.dist.clear();
    this.detailed.clear();
    this.mergeOf.clear();

    log('engine', 'solve start', { mode: settings.mode, riders: people.length, options: settings.options, weights: settings.weights });

    // 1. Candidate spots: OSM POIs plus a grid of generic points.
    progress('pois');
    let t = performance.now();
    const area = searchArea(homes, dest);
    const areaKey = JSON.stringify(area);
    log('engine', 'search area (km)', {
      ns: +((haversine({ lat: area.south, lon: area.west }, { lat: area.north, lon: area.west }) / 1000).toFixed(1)),
      ew: +((haversine({ lat: area.south, lon: area.west }, { lat: area.south, lon: area.east }) / 1000).toFixed(1)),
    });
    let pois = this.poiCache.get(areaKey);
    if (!pois) {
      try {
        const data = await overpass<{ elements: OsmElement[] }>(poiQuery(area));
        pois = poisToCandidates(data.elements);
        this.poiCache.set(areaKey, pois);
        log('engine', `POIs: ${data.elements.length} elements → ${pois.length} spots in ${since(t)}`);
      } catch (e) {
        warn('engine', `POI query failed after ${since(t)}`, e);
        this.warnings.push('warnPois');
        pois = [];
      }
    } else log('engine', `POIs from cache: ${pois.length}`);
    t = performance.now();
    const pool = [...pois, ...gridCandidates(area)];
    const limit = Math.min(85, TABLE_LIMIT - 1 - people.length);
    this.candidates = [...custom, ...prefilter(pool, people, dest, settings, limit - custom.length)];
    log('engine', `prefilter: ${pool.length} → ${this.candidates.length} candidates in ${since(t)}`);

    // 2. Bicycle distance matrix for all candidates.
    progress('matrix');
    t = performance.now();
    try {
      await this.computeMatrix(homes, dest);
      log('engine', `matrix: ${this.dist.size}/${this.candidates.length} reachable in ${since(t)}`, {
        directKm: this.direct.map((d) => +(d / 1000).toFixed(1)),
      });
    } catch (e) {
      warn('engine', `matrix failed after ${since(t)}, using estimates`, e);
      this.warnings.push('warnMatrix');
      this.estimateMatrix(homes, dest);
    }

    return this.refine(settings, progress);
  }

  private async computeMatrix(homes: LatLon[], dest: LatLon) {
    const cands = this.candidates;
    const n = homes.length;
    this.directEstimated = false;
    if (this.mode === 'morning') {
      // A: homes → candidates (+ destination for direct distance); B: candidates → destination.
      const a = await table(homes, [...cands, dest]);
      const b = await table(cands, [dest]);
      this.direct = homes.map((_, i) => a.distances[i][cands.length] ?? haversine(homes[i], dest) * DETOUR_FACTOR);
      cands.forEach((c, j) => {
        const personLeg = homes.map((_, i) => a.distances[i][j]);
        const shared = b.distances[j][0];
        this.setDist(c, personLeg, shared, a.dstSnapped[j]);
      });
    } else {
      // A: destination → candidates (+ homes for direct); B: candidates → homes.
      const a = await table([dest], [...cands, ...homes]);
      const b = await table(cands, homes);
      this.direct = homes.map(
        (_, i) => a.distances[0][cands.length + i] ?? haversine(homes[i], dest) * DETOUR_FACTOR,
      );
      cands.forEach((c, j) => {
        const personLeg = Array.from({ length: n }, (_, i) => b.distances[j][i]);
        this.setDist(c, personLeg, a.distances[0][j], a.dstSnapped[j]);
      });
    }
  }

  private setDist(c: Candidate, personLeg: (number | null)[], shared: number | null, snapped?: LatLon) {
    if (shared == null || personLeg.some((d) => d == null)) return; // unreachable by bike
    // Generic grid points are moved onto the street network.
    if (c.type === 'generic' && !c.custom && snapped) {
      c.lat = snapped.lat;
      c.lon = snapped.lon;
    }
    this.dist.set(c.id, { personLeg: personLeg as number[], shared, estimated: false });
  }

  private estimateMatrix(homes: LatLon[], dest: LatLon) {
    this.direct = homes.map((h) => haversine(h, dest) * DETOUR_FACTOR);
    this.directEstimated = true;
    for (const c of this.candidates) {
      this.dist.set(c.id, {
        personLeg: homes.map((h) => haversine(h, c) * DETOUR_FACTOR),
        shared: haversine(c, dest) * DETOUR_FACTOR,
        estimated: true,
      });
    }
  }

  /** Score everything with the current weights; detail the top options as needed. */
  async refine(settings: Settings, progress: Progress): Promise<SolveResult> {
    let options: Evaluation[] = [];
    for (let round = 0; round < 3; round++) {
      const all = this.scoreAll(settings);
      options = pickDiverse(all, settings.options, OPTION_SPACING, haversine);
      // Custom spots are always shown, even when they don't make the top list.
      for (const e of all) if (e.candidate.custom && !options.includes(e)) options.push(e);
      const missing = options.filter((o) => !this.detailed.has(o.candidate.id));
      log('engine', `refine round ${round + 1}: ${all.length} scored, ${options.length} options, ${missing.length} need detail`);
      if (!missing.length) break;
      await this.detail(missing.map((m) => m.candidate), progress);
    }
    const all = this.scoreAll(settings);
    options = pickDiverse(all, settings.options, OPTION_SPACING, haversine).filter((o) =>
      this.detailed.has(o.candidate.id),
    );
    for (const e of all) if (e.candidate.custom && !options.includes(e)) options.push(e);
    let t = performance.now();
    await this.nameOptions(options);
    log('engine', `named options in ${since(t)}`);
    log('engine', 'done', options.map((o) => ({ name: o.candidate.name, type: o.candidate.type, score: +o.score.total.toFixed(2) })));
    progress('done');
    return { options, all, legs: this.detailed, warnings: [...this.warnings] };
  }

  /** Instant re-score from cached data (no network). */
  rescore(settings: Settings): SolveResult {
    const all = this.scoreAll(settings);
    const detailedOnly = all.filter((e) => this.detailed.has(e.candidate.id));
    const options = pickDiverse(detailedOnly, settings.options, OPTION_SPACING, haversine);
    for (const e of detailedOnly) if (e.candidate.custom && !options.includes(e)) options.push(e);
    return { options, all, legs: this.detailed, warnings: [...this.warnings] };
  }

  private scoreAll(settings: Settings): Evaluation[] {
    // Undetailed candidates get the average greenery seen so far as an estimate.
    const known = [...this.detailed.keys()].map((id) => this.greenOf(id)).filter((g) => g != null);
    const avgGreen = known.length ? known.reduce((a, g) => a + g!.overall, 0) / known.length : 0.3;
    const out: Evaluation[] = [];
    for (const c of this.candidates) {
      const d = this.dist.get(c.id);
      if (!d) continue;
      if (!c.custom && !settings.spotTypes[c.type]) continue;
      const measured = this.greenOf(c.id);
      const green = measured ?? { perPerson: this.people.map(() => avgGreen), overall: avgGreen };
      const e = evaluate({ candidate: c, dist: d, direct: this.direct, people: this.people, settings, green });
      if (!measured) {
        // The estimate only steers the ranking; don't present it as a measurement.
        e.green = null;
        e.people.forEach((p) => (p.green = null));
      }
      out.push(e);
    }
    return out;
  }

  private greenOf(id: string): { perPerson: number[]; overall: number } | null {
    if (this.mergeOf.has(id)) this.fillMergeGreen(id);
    const legs = this.detailed.get(id);
    if (!legs || legs.shared.green == null || legs.person.some((l) => l.green == null)) return null;
    const perPerson = legs.person.map((l) => {
      const total = l.distance + legs.shared.distance;
      return total > 0 ? (l.green! * l.distance + legs.shared.green! * legs.shared.distance) / total : 0;
    });
    return { perPerson, overall: perPerson.reduce((a, b) => a + b, 0) / Math.max(1, perPerson.length) };
  }

  /** Fetch real routes and greenery for the given candidates. */
  private async detail(cands: Candidate[], progress: Progress) {
    const homes = this.people.map((p) => p.home!) as LatLon[];
    const dest = this.dest!;
    const morning = this.mode === 'morning';
    progress('routes', `${cands.length}`);
    let t = performance.now();
    log('engine', `detail: routing ${cands.length} candidates × ${homes.length + 1} legs`);

    const legFor = async (from: LatLon, to: LatLon): Promise<Leg> => {
      const k = `${key(from.lat, from.lon)}>${key(to.lat, to.lon)}`;
      const cached = this.legs.get(k);
      if (cached) return cached;
      const r = await route(from, to);
      const leg: Leg = { distance: r.distance, coords: r.coords, green: null };
      this.legs.set(k, leg);
      return leg;
    };

    await Promise.all(
      cands.map(async (c) => {
        try {
          const person = await Promise.all(homes.map((h) => (morning ? legFor(h, c) : legFor(c, h))));
          const shared = await (morning ? legFor(c, dest) : legFor(dest, c));
          this.detailed.set(c.id, { person, shared });
          // Routed distances replace matrix values / estimates.
          this.dist.set(c.id, {
            personLeg: person.map((l) => l.distance),
            shared: shared.distance,
            estimated: false,
          });
          this.addMergeVariant(c, person, shared);
        } catch (e) {
          warn('engine', `routing failed for ${c.id}, dropping it`, e);
          this.dist.delete(c.id); // can't route there – drop it
          if (!this.warnings.includes('warnRoute')) this.warnings.push('warnRoute');
        }
      }),
    );
    log('engine', `routes done in ${since(t)}`);
    if (this.directEstimated) {
      // Matrix failed earlier: get real direct distances too.
      const estimates = this.direct;
      this.direct = await Promise.all(
        homes.map((h, i) =>
          (morning ? legFor(h, dest) : legFor(dest, h)).then((l) => l.distance).catch(() => estimates[i]),
        ),
      );
      this.directEstimated = false;
    }

    // Greenery for all legs we don't have yet, in one Overpass query. Results don't wait
    // for it longer than greenWaitMs; late greenery triggers onBackgroundUpdate.
    const pending = [...new Set(cands.flatMap((c) => {
      const d = this.detailed.get(c.id);
      return d ? [...d.person, d.shared] : [];
    }))].filter((l) => l.green == null && l.coords.length > 1 && !this.greenInFlight.has(l));
    if (!pending.length) return;
    progress('green');
    const task = this.computeGreen(pending, dest);
    const inTime = await Promise.race([task.then(() => true), sleep(this.greenWaitMs).then(() => false)]);
    if (!inTime) {
      warn('engine', `greenery not ready after ${this.greenWaitMs}ms; showing results now, will re-rank when it arrives`);
      void task.then(() => this.onBackgroundUpdate?.());
    }
  }

  /**
   * If all riders' routes already run together for a while before reaching candidate `c`,
   * add a variant that meets where the routes join: same distance for everyone, more
   * kilometres together. Derived from the routes we already have; no extra requests.
   */
  private addMergeVariant(c: Candidate, person: Leg[], shared: Leg) {
    if (c.custom || person.length < 2 || this.mergeOf.has(c.id)) return;
    const morning = this.mode === 'morning';
    // Orient every personal leg so it starts at the meetup point.
    const fromMeet = person.map((l) => (morning ? [...l.coords].reverse() : l.coords));
    const d = commonPrefixLength(fromMeet);
    if (d < 80) return;

    const parts = fromMeet.map((coords) => splitLine(coords, d)); // [meet → join, join → home]
    // Routed distance per metre of geometry (geometry is slightly shorter than the routed distance).
    const scale = person.map((l) => l.distance / Math.max(1, lineLength(l.coords)) || 1);
    const togetherPart = parts[0][0]; // meet → join, along rider 0's route
    const join = togetherPart[togetherPart.length - 1];
    const id = `${c.id}~join`;
    const newPerson: Leg[] = person.map((l, i) => ({
      distance: Math.max(0, l.distance - d * scale[i]),
      coords: morning ? [...parts[i][1]].reverse() : parts[i][1],
      green: null,
    }));
    const newShared: Leg = {
      distance: shared.distance + d * scale[0],
      coords: morning
        ? [...[...togetherPart].reverse(), ...shared.coords.slice(1)]
        : [...shared.coords, ...togetherPart.slice(1)],
      green: null,
    };
    this.candidates.push({ id, lat: join[0], lon: join[1], type: 'generic', name: null });
    this.detailed.set(id, { person: newPerson, shared: newShared });
    this.dist.set(id, { personLeg: newPerson.map((l) => l.distance), shared: newShared.distance, estimated: false });
    this.mergeOf.set(id, { parent: c.id, shiftM: d * scale[0] });
    log('engine', `routes to ${c.name ?? c.id} already join ${Math.round(d)} m earlier; added a variant there`);
  }

  /** Greenery of a join variant follows from its parent's measured legs. */
  private fillMergeGreen(id: string) {
    const m = this.mergeOf.get(id);
    const legs = this.detailed.get(id);
    const parent = m && this.detailed.get(m.parent);
    if (!m || !legs || !parent || parent.shared.green == null || parent.person.some((l) => l.green == null)) return;
    legs.person.forEach((l, i) => (l.green = parent.person[i].green));
    legs.shared.green =
      (parent.person[0].green! * m.shiftM + parent.shared.green * parent.shared.distance) /
      Math.max(1, m.shiftM + parent.shared.distance);
  }

  private async computeGreen(legs: Leg[], dest: LatLon) {
    legs.forEach((l) => this.greenInFlight.add(l));
    let t = performance.now();
    log('engine', `greenery: ${legs.length} legs, ${legs.reduce((a, l) => a + l.coords.length, 0)} route points`);
    try {
      const data = await overpass<{ elements: never[] }>(greenQuery(legs.map((l) => l.coords)));
      log('engine', `greenery: ${data.elements.length} OSM features in ${since(t)}`);
      t = performance.now();
      const features = parseGreen(data.elements, dest.lat);
      for (const l of legs) l.green = greenFraction(l.coords, features);
      log('engine', `greenery computed in ${since(t)}`, {
        rings: features.rings.length,
        lines: features.lines.length,
        green: legs.map((l) => +(l.green ?? 0).toFixed(2)),
      });
    } catch (e) {
      warn('engine', `greenery failed after ${since(t)}`, e);
      if (!this.warnings.includes('warnGreen')) this.warnings.push('warnGreen');
      for (const l of legs) l.green = 0;
    } finally {
      legs.forEach((l) => this.greenInFlight.delete(l));
    }
  }

  private async nameOptions(options: Evaluation[]) {
    await Promise.all(
      options.map(async (o) => {
        const c = o.candidate;
        if (c.name) return;
        if (!this.names.has(c.id)) this.names.set(c.id, await reverseGeocode(c.lat, c.lon));
        c.name = this.names.get(c.id) ?? null;
      }),
    );
  }

  /** Add a user-chosen spot to the problem and work it out in detail. */
  async addCustom(at: LatLon, settings: Settings, progress: Progress): Promise<SolveResult> {
    const c: Candidate = { id: `custom${Date.now()}`, lat: at.lat, lon: at.lon, type: 'generic', name: null, custom: true };
    this.candidates.unshift(c);
    this.dist.set(c.id, {
      personLeg: this.people.map((p) => haversine(p.home!, c) * DETOUR_FACTOR),
      shared: haversine(c, this.dest!) * DETOUR_FACTOR,
      estimated: true,
    });
    await this.detail([c], progress);
    return this.refine(settings, progress);
  }

  /** Direct home ↔ destination distances (m), for share links. */
  get directDistances(): number[] {
    return [...this.direct];
  }

  /**
   * Load a pre-computed result (from a share link) without any network calls.
   * Re-weighting, re-ranking and "try my own spot" keep working afterwards.
   */
  hydrate(
    people: Person[],
    settings: Settings,
    direct: number[],
    options: { candidate: Candidate; legs: { person: Leg[]; shared: Leg } }[],
  ) {
    this.people = people;
    this.dest = settings.destination;
    this.mode = settings.mode;
    this.problemKey = Engine.problemKeyOf(people, settings);
    this.direct = [...direct];
    this.directEstimated = false;
    this.warnings = [];
    this.candidates = options.map((o) => o.candidate);
    this.dist.clear();
    this.detailed.clear();
    this.mergeOf.clear();
    for (const { candidate: c, legs } of options) {
      this.detailed.set(c.id, legs);
      this.dist.set(c.id, { personLeg: legs.person.map((l) => l.distance), shared: legs.shared.distance, estimated: false });
      if (c.name) this.names.set(c.id, c.name);
    }
    log('engine', `hydrated ${options.length} shared options`);
  }

  removeCustom(id: string) {
    this.candidates = this.candidates.filter((c) => c.id !== id);
    this.dist.delete(id);
    this.detailed.delete(id);
  }
}
