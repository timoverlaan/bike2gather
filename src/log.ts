/**
 * Debug logging. Always goes to the browser console; in dev mode (`pixi run dev`)
 * each line is also sent to the Vite dev server, which prints it in the terminal
 * (see the `browser-log` plugin in vite.config.ts).
 */
const t0 = performance.now();
const toTerminal = import.meta.env?.DEV && typeof window !== 'undefined';

const elapsed = () => `${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}s`;

function safe(data: unknown): string {
  if (data === undefined) return '';
  if (data instanceof Error) return `${data.name}: ${data.message}`;
  try {
    const s = JSON.stringify(data);
    return s.length > 600 ? `${s.slice(0, 600)}…(${s.length} chars)` : s;
  } catch {
    return String(data);
  }
}

export function log(scope: string, msg: string, data?: unknown, level: 'info' | 'warn' | 'error' = 'info') {
  const line = `[${elapsed()}] [${scope}] ${msg}${data === undefined ? '' : ` ${safe(data)}`}`;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  if (toTerminal) {
    fetch('/__log', { method: 'POST', body: `${level.toUpperCase().padEnd(5)} ${line}`, keepalive: true }).catch(
      () => {},
    );
  }
}

export const warn = (scope: string, msg: string, data?: unknown) => log(scope, msg, data, 'warn');
export const error = (scope: string, msg: string, data?: unknown) => log(scope, msg, data, 'error');

/** Requests currently in flight, for the heartbeat. */
export const pending = new Map<number, { label: string; start: number }>();

export function pendingSummary(): string[] {
  const now = performance.now();
  return [...pending.values()].map((p) => `${p.label} (${((now - p.start) / 1000).toFixed(0)}s)`);
}
