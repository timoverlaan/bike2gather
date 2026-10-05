import type { Place } from '../types';
import { fetchJson } from './http';

/**
 * PDOK Locatieserver (Kadaster, Dutch government) – free, no key, no tracking.
 * https://www.pdok.nl/introductie/-/article/pdok-locatieserver
 */
const BASE = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1';

interface PdokDoc {
  weergavenaam: string;
  centroide_ll?: string;
  type?: string;
}
interface PdokResponse {
  response: { docs: PdokDoc[] };
}

function parsePoint(wkt?: string): { lat: number; lon: number } | null {
  const m = wkt && /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(wkt);
  return m ? { lon: Number(m[1]), lat: Number(m[2]) } : null;
}

export async function searchAddress(q: string, signal?: AbortSignal): Promise<Place[]> {
  const params = new URLSearchParams({
    q,
    rows: '6',
    fl: 'weergavenaam,centroide_ll,type',
    fq: 'type:(adres OR postcode OR weg OR woonplaats OR buurt OR wijk)',
  });
  const data = await fetchJson<PdokResponse>(`${BASE}/free?${params}`, { signal, retries: 0, timeoutMs: 10000 });
  return data.response.docs
    .map((d) => {
      const p = parsePoint(d.centroide_ll);
      return p ? { ...p, label: d.weergavenaam } : null;
    })
    .filter((x): x is Place => x !== null);
}

const reverseCache = new Map<string, string | null>();

export async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  const k = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (reverseCache.has(k)) return reverseCache.get(k)!;
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    rows: '1',
    type: 'weg',
    fl: 'weergavenaam',
  });
  try {
    const data = await fetchJson<PdokResponse>(`${BASE}/reverse?${params}`, { retries: 0, timeoutMs: 8000 });
    const name = data.response.docs[0]?.weergavenaam ?? null;
    reverseCache.set(k, name);
    return name;
  } catch {
    return null;
  }
}
