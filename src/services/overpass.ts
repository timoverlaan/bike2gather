import { fetchJson, limiter } from './http';
import { log, warn } from '../log';

/**
 * Overpass API (OpenStreetMap data). The main instance is run by FOSSGIS e.V.;
 * the private.coffee community instance is used as a fallback when it is busy.
 */
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

const throttle = limiter(1, 500, 'overpass');

/**
 * Run a query with a hard time budget. The fallback endpoint is only tried when the
 * first one fails quickly (e.g. 429 "too busy"); after a slow failure we give up so the
 * user isn't kept waiting for two full timeouts.
 */
export async function overpass<T>(query: string, timeoutMs = 25000): Promise<T> {
  let lastErr: unknown;
  log('overpass', `query (${query.length} chars)`, query.length > 400 ? `${query.slice(0, 400)}…` : query);
  for (const url of ENDPOINTS) {
    let started = 0;
    try {
      return await throttle(() => {
        started = performance.now();
        return fetchJson<T>(url, {
          method: 'POST',
          body: new URLSearchParams({ data: query }),
          timeoutMs,
          retries: 0,
        });
      });
    } catch (e) {
      lastErr = e;
      const took = started ? performance.now() - started : 0;
      if (took > 8000) {
        warn('overpass', `${new URL(url).host} failed after ${(took / 1000).toFixed(0)}s; giving up`, e);
        break;
      }
      warn('overpass', `${new URL(url).host} failed quickly, trying next endpoint`, e);
    }
  }
  throw lastErr;
}
