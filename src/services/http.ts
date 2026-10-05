import { log, pending, warn } from '../log';

let reqId = 0;

/** Short, readable label for a URL (host + path start, no long coordinate lists). */
function label(url: string, method = 'GET') {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 60 ? `${u.pathname.slice(0, 60)}…` : u.pathname;
    return `${method} ${u.host}${path}`;
  } catch {
    return url.slice(0, 80);
  }
}

/** Minimal concurrency limiter so we stay polite to free public services. */
export function limiter(concurrency: number, minGapMs = 0, name = 'limiter') {
  let active = 0;
  let last = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= concurrency || !queue.length) return;
    const wait = Math.max(0, last + minGapMs - Date.now());
    if (wait > 0) {
      setTimeout(next, wait);
      return;
    }
    active++;
    last = Date.now();
    queue.shift()!();
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const queuedAt = performance.now();
      if (active >= concurrency) log('queue', `${name}: queued (active ${active}, waiting ${queue.length + 1})`);
      queue.push(() => {
        const waited = performance.now() - queuedAt;
        if (waited > 1000) log('queue', `${name}: started after waiting ${(waited / 1000).toFixed(1)}s`);
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}

export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number; retries?: number } = {},
): Promise<T> {
  const { timeoutMs = 20000, retries = 1, ...rest } = init;
  const lbl = label(url, rest.method);
  const bodyLen = typeof rest.body === 'string' ? rest.body.length : rest.body ? String(rest.body).length : 0;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const id = ++reqId;
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    const start = performance.now();
    pending.set(id, { label: `#${id} ${lbl}`, start });
    log('http', `#${id} → ${lbl}`, { attempt: attempt + 1, of: retries + 1, timeoutMs, urlLength: url.length, bodyLength: bodyLen || undefined });
    const ms = () => `${Math.round(performance.now() - start)}ms`;
    try {
      const res = await fetch(url, { ...rest, signal: ctrl.signal });
      log('http', `#${id} ← ${res.status} ${res.statusText} after ${ms()}`);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        warn('http', `#${id} error body`, text.slice(0, 300));
        // 429/5xx are worth one more try after a short pause; 4xx otherwise is final.
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        throw new HttpError(`${res.status} ${res.statusText}`, res.status);
      }
      const text = await res.text();
      log('http', `#${id} body ${(text.length / 1024).toFixed(1)} kB, total ${ms()}`);
      return JSON.parse(text) as T;
    } catch (e) {
      lastErr = e;
      if (timedOut) warn('http', `#${id} TIMEOUT after ${ms()} (limit ${timeoutMs}ms)`);
      else if (!(e instanceof HttpError)) warn('http', `#${id} failed after ${ms()} (network/CORS?)`, e);
      if (e instanceof HttpError) throw e;
      if (attempt < retries) await sleep(1000 * (attempt + 1));
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }
  throw lastErr;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Round coordinates for cache keys (~1 m). */
export const key = (lat: number, lon: number) => `${lat.toFixed(5)},${lon.toFixed(5)}`;
