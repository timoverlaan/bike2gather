/**
 * Small parser for the common subset of OpenStreetMap `opening_hours` values, e.g.
 *   "Mo-Fr 07:30-18:00; Sa 09:00-17:00; Su off", "24/7", "Mo,We 08:00-12:00,13:00-17:00",
 *   "Fr-Sa 18:00-02:00", "Mo-Su 08:00+".
 * Anything outside that subset (months, weeks, sunrise, comments, …) yields `null` = unknown,
 * and the raw text is shown instead.
 */

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

/** Per weekday (0 = Monday) a list of [from, to) minute ranges; to may exceed 1440. */
export type Week = [number, number][][];

const cache = new Map<string, Week | null>();

function parseDays(sel: string): number[] | null {
  const out = new Set<number>();
  for (const part of sel.split(',')) {
    const m = /^([A-Z][a-z])(?:-([A-Z][a-z]))?$/.exec(part.trim());
    if (!m) return null;
    const a = DAYS.indexOf(m[1]);
    const b = m[2] ? DAYS.indexOf(m[2]) : a;
    if (a < 0 || b < 0) return null;
    for (let d = a; ; d = (d + 1) % 7) {
      out.add(d);
      if (d === b) break;
    }
  }
  return [...out];
}

function parseTimes(spec: string): [number, number][] | null {
  const out: [number, number][] = [];
  for (const part of spec.split(',')) {
    const m = /^(\d{1,2}):(\d{2})(?:-(\d{1,2}):(\d{2})|(\+))$/.exec(part.trim());
    if (!m) return null;
    const from = Number(m[1]) * 60 + Number(m[2]);
    let to = m[5] ? 24 * 60 : Number(m[3]) * 60 + Number(m[4]);
    if (to <= from) to += 24 * 60; // past midnight
    out.push([from, to]);
  }
  return out;
}

export function parseOpeningHours(raw: string): Week | null {
  const key = raw.trim();
  if (cache.has(key)) return cache.get(key)!;
  const week = parse(key);
  cache.set(key, week);
  return week;
}

function parse(s: string): Week | null {
  if (!s) return null;
  if (s === '24/7') return DAYS.map(() => [[0, 24 * 60]]);
  const week: Week = DAYS.map(() => []);
  // ';' starts a rule that overrides earlier ones for its days; a comma after a time
  // followed by a day ("…17:00, Sa 10:00-14:00") adds a rule.
  const rules = s.split(';').flatMap((r, i) =>
    r.split(/(?<=\d|\+|off|closed)\s*,\s*(?=[A-Z][a-z])/).map((part, j) => ({ text: part.trim(), override: i > 0 && j === 0 })),
  );
  for (const { text, override } of rules) {
    if (!text) continue;
    // Public/school holidays: we don't know the calendar, so ignore those rules.
    if (/^(PH|SH)\b/.test(text)) continue;
    const m = /^(?:([A-Z][a-z](?:[-,][A-Z][a-z])*)\s*)?(.*)$/.exec(text);
    if (!m) return null;
    const days = m[1] ? parseDays(m[1]) : DAYS.map((_, i) => i);
    if (!days) return null;
    const rest = m[2].trim();
    let ranges: [number, number][];
    if (rest === '') ranges = [[0, 24 * 60]];
    else if (/^(off|closed)$/i.test(rest)) ranges = [];
    else {
      const t = parseTimes(rest.replace(/\s+/g, ''));
      if (!t) return null;
      ranges = t;
    }
    for (const d of days) week[d] = override ? [...ranges] : [...week[d], ...ranges];
  }
  return week;
}

/** Is the place open at `minute` (since midnight) on weekday `day` (0 = Monday)? */
export function isOpen(week: Week, day: number, minute: number): boolean {
  const m = ((minute % 1440) + 1440) % 1440;
  if (week[day].some(([a, b]) => m >= a && m < b)) return true;
  // Ranges from the previous day that run past midnight.
  const prev = (day + 6) % 7;
  return week[prev].some(([a, b]) => b > 1440 && m + 1440 >= a && m + 1440 < b);
}

/** Open at `minute` on each workday Monday–Friday, or null when the hours can't be read. */
export function openOnWorkdays(raw: string | null | undefined, minute: number): boolean[] | null {
  if (!raw) return null;
  const week = parseOpeningHours(raw);
  if (!week) return null;
  return [0, 1, 2, 3, 4].map((d) => isOpen(week, d, minute));
}
