import { fetchJson, limiter } from './http';

/**
 * Overpass API (OpenStreetMap data). The main instance is run by FOSSGIS e.V.;
 * the private.coffee community instance is used as a fallback when it is busy.
 */
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

const throttle = limiter(1, 500);

export async function overpass<T>(query: string): Promise<T> {
  let lastErr: unknown;
  for (const url of ENDPOINTS) {
    try {
      return await throttle(() =>
        fetchJson<T>(url, {
          method: 'POST',
          body: new URLSearchParams({ data: query }),
          timeoutMs: 60000,
          retries: 1,
        }),
      );
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
