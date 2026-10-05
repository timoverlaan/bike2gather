import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../src/solver/engine';
import { clearRouteCache } from '../src/services/osrm';
import { haversine } from '../src/solver/geo';
import { defaultState } from '../src/store';
import type { LatLon, Person } from '../src/types';

/**
 * End-to-end solver run against a fake network: OSRM distances are crow-fly × 1.25,
 * routes are straight lines, Overpass returns one café and one park.
 */
const parsePts = (s: string): LatLon[] =>
  s.split(';').map((p) => {
    const [lon, lat] = p.split(',').map(Number);
    return { lat, lon };
  });

function fakeFetch(calls: string[]) {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url.split('?')[0]);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

    if (url.includes('/table/v1/')) {
      const m = /driving\/([^?]+)\?sources=([^&]+)&destinations=([^&]+)/.exec(url)!;
      const pts = parsePts(m[1]);
      const src = m[2].split(';').map(Number);
      const dst = m[3].split(';').map(Number);
      return json({
        code: 'Ok',
        distances: src.map((i) => dst.map((j) => haversine(pts[i], pts[j]) * 1.25)),
        sources: src.map((i) => ({ location: [pts[i].lon, pts[i].lat] })),
        destinations: dst.map((j) => ({ location: [pts[j].lon, pts[j].lat] })),
      });
    }
    if (url.includes('/route/v1/')) {
      const [a, b] = parsePts(/driving\/([^?]+)/.exec(url)![1]);
      return json({
        code: 'Ok',
        routes: [
          {
            distance: haversine(a, b) * 1.25,
            duration: 0,
            geometry: { coordinates: [[a.lon, a.lat], [(a.lon + b.lon) / 2, (a.lat + b.lat) / 2], [b.lon, b.lat]] },
          },
        ],
      });
    }
    if (url.includes('interpreter')) {
      const q = String((init?.body as URLSearchParams).get('data'));
      if (q.includes('out center')) {
        return json({
          elements: [
            { type: 'node', id: 1, lat: 52.075, lon: 5.08, tags: { amenity: 'cafe', name: 'Koffie Halfweg' } },
            { type: 'way', id: 2, center: { lat: 52.09, lon: 5.2 }, tags: { leisure: 'park', name: 'Ver Weg Park' } },
          ],
        });
      }
      return json({ elements: [] });
    }
    if (url.includes('locatieserver')) return json({ response: { docs: [{ weergavenaam: 'Teststraat, Utrecht' }] } });
    return new Response('not found', { status: 404 });
  });
}

const people: Person[] = [
  { id: 'a', name: 'A', home: { lat: 52.06, lon: 5.06, label: 'a' }, fitness: 3, speed: 18, maxDetourKm: null },
  { id: 'b', name: 'B', home: { lat: 52.06, lon: 5.1, label: 'b' }, fitness: 3, speed: 18, maxDetourKm: null },
];

describe('Engine', () => {
  let calls: string[];
  beforeEach(() => {
    calls = [];
    clearRouteCache();
    vi.stubGlobal('fetch', fakeFetch(calls));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('finds a sensible meetup spot and caches network work for re-weighting', async () => {
    const state = defaultState('en');
    state.settings.destination = { lat: 52.1, lon: 5.08, label: 'Work' };
    state.settings.weights = { fairness: 0.5, together: 0.4, spot: 1, green: 0.2, fitness: 0.5 };
    const engine = new Engine();
    const stages: string[] = [];
    const r = await engine.solve(people, state.settings, (s) => stages.push(s));

    expect(r.warnings).toEqual([]);
    expect(r.options.length).toBeGreaterThan(0);
    expect(r.options.length).toBeLessThanOrEqual(state.settings.options);
    // With a strong spot preference the café right on the way should win.
    expect(r.options[0].candidate.name).toBe('Koffie Halfweg');
    // Every option has detailed legs and greenery.
    for (const o of r.options) {
      expect(r.legs.get(o.candidate.id)).toBeDefined();
      expect(o.green).not.toBeNull();
    }
    expect(stages).toContain('matrix');
    expect(stages.at(-1)).toBe('done');
    expect(calls.filter((c) => c.includes('/table/')).length).toBe(2);

    // Re-weighting is local: no new network calls.
    const before = calls.length;
    state.settings.weights.spot = 0;
    const r2 = engine.rescore(state.settings);
    expect(calls.length).toBe(before);
    expect(r2.all.length).toBe(r.all.length);
  });

  it('falls back to estimates when the distance matrix fails', async () => {
    const base = fakeFetch(calls);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) =>
        String(input).includes('/table/') ? new Response('busy', { status: 503 }) : base(input, init),
      ),
    );
    const state = defaultState('en');
    state.settings.destination = { lat: 52.1, lon: 5.08, label: 'Work' };
    const r = await new Engine().solve(people, state.settings, () => {});
    expect(r.warnings).toContain('warnMatrix');
    expect(r.options.length).toBeGreaterThan(0);
    // Options are detailed with real routes, so they are no longer estimates.
    expect(r.options.every((o) => !o.estimated)).toBe(true);
  }, 20000);

  it('evening mode routes destination → split point → homes', async () => {
    const state = defaultState('en');
    state.settings.mode = 'evening';
    state.settings.time = '17:30';
    state.settings.destination = { lat: 52.1, lon: 5.08, label: 'Work' };
    const r = await new Engine().solve(people, state.settings, () => {});
    const best = r.options[0];
    expect(best.meetTime).toBeGreaterThan(17 * 60 + 30);
    expect(best.people.every((p) => p.homeTime > best.meetTime)).toBe(true);
  });

  it('does not wait for a slow greenery query', async () => {
    const base = fakeFetch(calls);
    let releaseGreen: (() => void) | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const q = init?.body instanceof URLSearchParams ? String(init.body.get('data')) : '';
        if (q.includes('out geom')) await new Promise<void>((r) => (releaseGreen = r)); // hangs until released
        return base(input, init);
      }),
    );
    const state = defaultState('en');
    state.settings.destination = { lat: 52.1, lon: 5.08, label: 'Work' };
    const engine = new Engine();
    engine.greenWaitMs = 100;
    let updated = false;
    engine.onBackgroundUpdate = () => (updated = true);

    const r = await engine.solve(people, state.settings, () => {});
    expect(r.options.length).toBeGreaterThan(0);
    expect(r.options.every((o) => o.green == null)).toBe(true);
    expect(engine.greenPending).toBe(true);

    // The Overpass client spaces requests out, so wait until the greenery request is really in flight.
    await vi.waitFor(() => expect(releaseGreen).not.toBeNull());
    releaseGreen!();
    await vi.waitFor(() => expect(updated).toBe(true));
    expect(engine.greenPending).toBe(false);
    expect(engine.rescore(state.settings).options.every((o) => o.green != null)).toBe(true);
  });

  it('adds a "meet where the routes join" variant when routes already overlap', async () => {
    // Routes that run via a common junction J before reaching any meetup point.
    const J = { lat: 52.07, lon: 5.08 };
    const base = fakeFetch(calls);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (!url.includes('/route/v1/')) return base(input, init);
        const [a, b] = parsePts(/driving\/([^?]+)/.exec(url)![1]);
        const isHome = people.some((p) => Math.abs(p.home!.lat - a.lat) < 1e-6 && Math.abs(p.home!.lon - a.lon) < 1e-6);
        const coords = isHome ? [[a.lon, a.lat], [J.lon, J.lat], [b.lon, b.lat]] : [[a.lon, a.lat], [b.lon, b.lat]];
        let d = 0;
        for (let i = 1; i < coords.length; i++)
          d += haversine({ lat: coords[i - 1][1], lon: coords[i - 1][0] }, { lat: coords[i][1], lon: coords[i][0] });
        return new Response(JSON.stringify({ code: 'Ok', routes: [{ distance: d, duration: 0, geometry: { coordinates: coords } }] }));
      }),
    );
    const state = defaultState('en');
    state.settings.destination = { lat: 52.1, lon: 5.08, label: 'Work' };
    state.settings.weights = { fairness: 0.5, together: 1, spot: 0, green: 0, fitness: 0 };
    const r = await new Engine().solve(people, state.settings, () => {});
    const join = r.all.filter((e) => e.candidate.id.endsWith('~join'));
    expect(join.length).toBeGreaterThan(0);
    // The best option should be (close to) the junction, where both routes come together.
    expect(haversine(r.options[0].candidate, J)).toBeLessThan(60);
  }, 30000);

  it('evaluates a custom spot', async () => {
    const state = defaultState('en');
    state.settings.destination = { lat: 52.1, lon: 5.08, label: 'Work' };
    const engine = new Engine();
    await engine.solve(people, state.settings, () => {});
    const r = await engine.addCustom({ lat: 52.08, lon: 5.07 }, state.settings, () => {});
    const custom = r.options.find((o) => o.candidate.custom);
    expect(custom).toBeDefined();
    expect(custom!.candidate.name).toBe('Teststraat, Utrecht');
  });
});
