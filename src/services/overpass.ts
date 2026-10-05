import { fetchJson, HttpError, limiter } from './http';
import { log, warn } from '../log';

/**
 * Overpass API (OpenStreetMap data). The main instance is run by FOSSGIS e.V.; when it
 * is busy we fall back to Kumi Systems (Austria) and the private.coffee community instance.
 */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const throttle = limiter(1, 500, 'overpass');

/**
 * Run a query, moving on to the next endpoint when one is busy or broken. A server that
 * answers "busy" (429/5xx) or fails quickly is skipped; when our own time limit runs out
 * we give up, so the user isn't kept waiting for several full timeouts.
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
      const busy = e instanceof HttpError && (e.status === 429 || e.status >= 500);
      if (!busy && took > 8000) {
        warn('overpass', `${new URL(url).host} failed after ${(took / 1000).toFixed(0)}s; giving up`, e);
        break;
      }
      warn('overpass', `${new URL(url).host} ${busy ? 'is busy' : 'failed quickly'}, trying the next server`, e);
    }
  }
  throw lastErr;
}
