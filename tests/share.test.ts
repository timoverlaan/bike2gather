import { describe, expect, it } from 'vitest';
import { decodePayload, decodePolyline, encodePayload, encodePolyline, packLeg, unpackLeg, type SharedPayload } from '../src/share';
import { Engine } from '../src/solver/engine';
import { defaultState } from '../src/store';
import type { Leg, Person } from '../src/types';

const route: [number, number][] = Array.from({ length: 200 }, (_, i) => [
  52.06 + i * 0.0002 + Math.sin(i / 7) * 0.0003,
  5.06 + i * 0.0001,
]);

describe('share links', () => {
  it('polyline round-trips at ~1 m precision', () => {
    const back = decodePolyline(encodePolyline(route));
    expect(back).toHaveLength(route.length);
    back.forEach(([la, lo], i) => {
      expect(Math.abs(la - route[i][0])).toBeLessThan(1e-5);
      expect(Math.abs(lo - route[i][1])).toBeLessThan(1e-5);
    });
    expect(decodePolyline(encodePolyline([[-33.5, -70.25]]))).toEqual([[-33.5, -70.25]]);
  });

  it('packs legs compactly', () => {
    const leg: Leg = { distance: 1234.56, green: 0.4567, coords: route };
    const back = unpackLeg(packLeg(leg));
    expect(back.distance).toBe(1235);
    expect(back.green).toBe(0.457);
    expect(back.coords[0]).toEqual([52.06, 5.06]);
  });

  it('payload round-trips through the compressed encoding', async () => {
    const s = defaultState('en');
    const p: SharedPayload = { v: 2, state: { people: s.people, settings: s.settings } };
    const enc = await encodePayload(p);
    expect(enc[0]).toBe('z');
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await decodePayload(enc)).toEqual(p);
  });

  it('still opens first-version links (untagged base64 JSON)', async () => {
    const s = defaultState('nl');
    const old = btoa(JSON.stringify(s)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const p = await decodePayload(old);
    expect(p?.state.settings.mode).toBe('morning');
    expect(p?.result).toBeUndefined();
  });

  it('rejects garbage', async () => {
    expect(await decodePayload('zNotReallyDeflate')).toBeNull();
  });

  it('a hydrated engine reproduces the shared ranking without network', async () => {
    const people: Person[] = [
      { id: 'a', name: 'A', home: { lat: 52.06, lon: 5.06, label: 'a' }, fitness: 3, speed: 18, maxDetourKm: null },
      { id: 'b', name: 'B', home: { lat: 52.06, lon: 5.1, label: 'b' }, fitness: 5, speed: 22, maxDetourKm: null },
    ];
    const s = defaultState('en').settings;
    s.destination = { lat: 52.1, lon: 5.08, label: 'Work' };
    const mk = (id: string, lat: number, km: number[], shared: number, green: number) => ({
      candidate: { id, lat, lon: 5.08, type: 'generic' as const, name: id },
      legs: {
        person: km.map((d) => ({ distance: d * 1000, green, coords: route.slice(0, 20) })),
        shared: { distance: shared * 1000, green, coords: route.slice(20, 40) },
      },
    });
    const opts = [mk('x', 52.07, [2, 2.5], 4, 0.5), mk('y', 52.08, [3, 3], 3, 0.1)];

    const fetchCalls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (u: string) => {
      fetchCalls.push(String(u));
      throw new Error('no network');
    }) as typeof fetch;
    try {
      const e = new Engine();
      e.hydrate(people, s, [5500, 5800], opts);
      const r = e.rescore(s);
      expect(r.options.map((o) => o.candidate.id).sort()).toEqual(['x', 'y']);
      expect(r.options.every((o) => o.green != null)).toBe(true);
      expect(e.isStale(people, s)).toBe(false);
      // Re-weighting after hydrating still works and needs no network.
      const r2 = await e.refine({ ...s, weights: { ...s.weights, green: 1 } }, () => {});
      expect(r2.options[0].candidate.id).toBe('x');
      expect(fetchCalls).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
