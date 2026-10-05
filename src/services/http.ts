/** Minimal concurrency limiter so we stay polite to free public services. */
export function limiter(concurrency: number, minGapMs = 0) {
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
      queue.push(() => {
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
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...rest, signal: ctrl.signal });
      if (!res.ok) {
        // 429/5xx are worth one more try after a short pause; 4xx otherwise is final.
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        throw new HttpError(`${res.status} ${res.statusText}`, res.status);
      }
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpError) throw e;
      if (attempt < retries) await sleep(1000 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Round coordinates for cache keys (~1 m). */
export const key = (lat: number, lon: number) => `${lat.toFixed(5)},${lon.toFixed(5)}`;
