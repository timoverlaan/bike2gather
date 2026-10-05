import { describe, expect, it } from 'vitest';
import { haversine, samplePolyline, simplify, lineLength } from '../src/solver/geo';
import { evaluate, fitnessMultiplier, formatTime, parseTime, pickDiverse } from '../src/solver/scoring';
import { classify, gridCandidates, poisToCandidates, prefilter, searchArea } from '../src/solver/candidates';
import { greenFraction, greenQuery, parseGreen } from '../src/solver/greenery';
import { defaultState, normalize } from '../src/store';
import { _dictsForTest } from '../src/i18n';
import type { Candidate, Person, Settings } from '../src/types';

const utrechtCS = { lat: 52.0894, lon: 5.1101 };
const domtoren = { lat: 52.0907, lon: 5.1214 };

function person(id: string, lat: number, lon: number, extra: Partial<Person> = {}): Person {
  return { id, name: id, home: { lat, lon, label: id }, fitness: 3, speed: 18, maxDetourKm: null, ...extra };
}

function settings(over: Partial<Settings> = {}): Settings {
  const s = defaultState('en').settings;
  return { ...s, destination: { ...domtoren, label: 'work' }, ...over, weights: { ...s.weights, ...(over.weights ?? {}) } };
}

describe('geo', () => {
  it('haversine matches known distance (Utrecht CS → Dom ≈ 790 m)', () => {
    const d = haversine(utrechtCS, domtoren);
    expect(d).toBeGreaterThan(740);
    expect(d).toBeLessThan(830);
  });

  it('samples a polyline at a fixed step', () => {
    const line: [number, number][] = [
      [52, 5],
      [52, 5.01],
    ];
    const len = lineLength(line);
    const pts = samplePolyline(line, 100);
    expect(pts.length).toBe(Math.floor(len / 100) + 1);
  });

  it('simplify keeps endpoints and drops collinear points', () => {
    const line: [number, number][] = Array.from({ length: 50 }, (_, i) => [52, 5 + i * 0.001]);
    const s = simplify(line, 5);
    expect(s).toEqual([line[0], line[49]]);
  });
});

describe('scoring', () => {
  const people = [person('a', 52.1, 5.0), person('b', 52.1, 5.2)];
  const cand: Candidate = { id: 'c', lat: 52.1, lon: 5.1, type: 'cafe', name: 'Café' };

  it('fitness multiplier is neutral at 3 and smaller for fitter riders', () => {
    expect(fitnessMultiplier(3, 1)).toBe(1);
    expect(fitnessMultiplier(5, 1)).toBeLessThan(1);
    expect(fitnessMultiplier(1, 1)).toBeGreaterThan(1);
    expect(fitnessMultiplier(5, 0)).toBe(1);
  });

  it('computes detours, times and the fairness blend', () => {
    const s = settings({ time: '09:00', weights: { fairness: 1, together: 0, spot: 0, green: 0, fitness: 0 } });
    const e = evaluate({
      candidate: cand,
      dist: { personLeg: [3000, 1000], shared: 5000, estimated: false },
      direct: [7000, 5500],
      people,
      settings: s,
    });
    expect(e.people[0].detourKm).toBeCloseTo(1);
    expect(e.people[1].detourKm).toBeCloseTo(0.5);
    // fairness = 1 → effort is the worst detour
    expect(e.score.effort).toBeCloseTo(1);
    // 5 km at 18 km/h ≈ 16.7 min + 2 min buffer before 09:00
    expect(formatTime(e.meetTime)).toBe('08:41');
    expect(formatTime(e.people[0].homeTime)).toBe('08:31');
  });

  it('evening mode counts forward from leaving time', () => {
    const s = settings({ mode: 'evening', time: '17:30' });
    const e = evaluate({
      candidate: cand,
      dist: { personLeg: [1800, 1800], shared: 3000, estimated: false },
      direct: [4800, 4800],
      people,
      settings: s,
    });
    expect(formatTime(e.meetTime)).toBe('17:40');
    expect(formatTime(e.people[0].homeTime)).toBe('17:46');
  });

  it('penalises exceeding a personal max detour', () => {
    const limited = [person('a', 52.1, 5.0, { maxDetourKm: 0.5 }), people[1]];
    const e = evaluate({
      candidate: cand,
      dist: { personLeg: [3000, 1000], shared: 5000, estimated: false },
      direct: [7000, 5500],
      people: limited,
      settings: settings(),
    });
    expect(e.people[0].overLimit).toBe(true);
    expect(e.score.limitPenalty).toBeGreaterThan(0);
  });

  it('spot and green weights reward nice spots', () => {
    const base = { dist: { personLeg: [2000, 2000], shared: 4000, estimated: false }, direct: [5500, 5500], people };
    const s = settings({ weights: { fairness: 0.5, together: 0, spot: 1, green: 1, fitness: 0 } });
    const cafe = evaluate({ ...base, candidate: cand, settings: s, green: { perPerson: [0.5, 0.5], overall: 0.5 } });
    const corner = evaluate({ ...base, candidate: { ...cand, type: 'generic' }, settings: s, green: { perPerson: [0, 0], overall: 0 } });
    expect(cafe.score.total).toBeLessThan(corner.score.total);
  });

  it('pickDiverse respects spacing', () => {
    const mk = (id: string, lat: number, total: number) =>
      ({ candidate: { id, lat, lon: 5, type: 'generic', name: null }, score: { total } }) as never;
    const picked = pickDiverse([mk('a', 52, 1), mk('b', 52.0001, 2), mk('c', 52.01, 3)], 2, 250, haversine);
    expect(picked.map((p: { candidate: Candidate }) => p.candidate.id)).toEqual(['a', 'c']);
  });

  it('parses and formats times', () => {
    expect(parseTime('7:05')).toBe(425);
    expect(formatTime(-10)).toBe('23:50');
  });
});

describe('candidates', () => {
  it('classifies OSM tags', () => {
    expect(classify({ amenity: 'cafe' })).toBe('cafe');
    expect(classify({ man_made: 'windmill' })).toBe('landmark');
    expect(classify({ shop: 'bicycle' })).toBe('bikeshop');
    expect(classify({ amenity: 'bank' })).toBeNull();
  });

  it('converts elements with centers', () => {
    const c = poisToCandidates([
      { type: 'way', id: 1, center: { lat: 52, lon: 5 }, tags: { leisure: 'park', name: 'Wilhelminapark' } },
      { type: 'node', id: 2, lat: 52.1, lon: 5.1, tags: { amenity: 'bank' } },
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ id: 'w1', type: 'park', name: 'Wilhelminapark' });
  });

  it('prefilter prefers points between the riders and the destination', () => {
    const people = [person('a', 52.06, 5.06), person('b', 52.06, 5.1)];
    const dest = { lat: 52.1, lon: 5.08 };
    const area = searchArea(people.map((p) => p.home!), dest);
    const grid = gridCandidates(area, 10);
    const s = settings({ destination: { ...dest, label: 'w' } });
    const kept = prefilter(grid, people, dest, s, 10);
    expect(kept.length).toBe(10);
    // The best one should be roughly between both homes and the destination.
    expect(kept[0].lat).toBeGreaterThan(52.055);
    expect(kept[0].lat).toBeLessThan(52.1);
  });

  it('prefilter drops disallowed spot types', () => {
    const people = [person('a', 52.06, 5.06), person('b', 52.06, 5.1)];
    const dest = { lat: 52.1, lon: 5.08 };
    const s = settings({ destination: { ...dest, label: 'w' } });
    s.spotTypes.cafe = false;
    const kept = prefilter([{ id: 'x', lat: 52.07, lon: 5.08, type: 'cafe', name: null }], people, dest, s, 5);
    expect(kept).toHaveLength(0);
  });
});

describe('greenery', () => {
  // A square park of ~700 m around (52.0, 5.0).
  const park = {
    type: 'way' as const,
    tags: { leisure: 'park' },
    geometry: [
      { lat: 51.997, lon: 4.995 },
      { lat: 51.997, lon: 5.005 },
      { lat: 52.003, lon: 5.005 },
      { lat: 52.003, lon: 4.995 },
      { lat: 51.997, lon: 4.995 },
    ],
  };
  const features = parseGreen([park], 52);

  it('route through a park is mostly green', () => {
    const through: [number, number][] = [
      [52.0, 4.996],
      [52.0, 5.004],
    ];
    expect(greenFraction(through, features)).toBe(1);
  });

  it('route far away is not green', () => {
    const away: [number, number][] = [
      [52.05, 5.0],
      [52.05, 5.01],
    ];
    expect(greenFraction(away, features)).toBe(0);
  });

  it('half in, half out ≈ 0.5', () => {
    const half: [number, number][] = [
      [52.0, 4.999],
      [52.0, 5.011],
    ];
    const f = greenFraction(half, features);
    expect(f).toBeGreaterThan(0.4);
    expect(f).toBeLessThan(0.65);
  });

  it('builds an around-polyline Overpass query', () => {
    const q = greenQuery([
      [
        [52, 5],
        [52.01, 5.01],
      ],
    ]);
    expect(q).toContain('around:20,52.00000,5.00000,52.01000,5.01000');
    expect(q).toContain('out geom');
  });
});

describe('store & i18n', () => {
  it('normalize fills in missing fields', () => {
    const s = normalize({ people: [{ name: 'X' }], settings: { weights: { green: 1 } } }, 'nl');
    expect(s.people[0].fitness).toBe(3);
    expect(s.people[0].id).toBeTruthy();
    expect(s.settings.weights.green).toBe(1);
    expect(s.settings.weights.fairness).toBe(0.5);
    expect(s.lang).toBe('nl');
  });

  it('Dutch and English dictionaries have the same keys and placeholders', () => {
    const { en, nl } = _dictsForTest;
    expect(Object.keys(nl).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
      expect(ph(nl[k]), k).toEqual(ph(en[k]));
    }
  });
});
