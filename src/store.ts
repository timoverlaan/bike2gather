import type { Lang, Person, Settings, SpotType, Weights } from './types';
import { SPOT_TYPES } from './types';

export interface AppState {
  lang: Lang;
  people: Person[];
  settings: Settings;
}

export const PRESETS: Record<string, Weights> = {
  presetBalanced: { fairness: 0.5, together: 0.4, spot: 0.5, green: 0.4, fitness: 0.5 },
  presetFair: { fairness: 1, together: 0.2, spot: 0.3, green: 0.2, fitness: 0.3 },
  presetEfficient: { fairness: 0, together: 0.1, spot: 0.2, green: 0, fitness: 0.5 },
  presetSocial: { fairness: 0.4, together: 1, spot: 0.4, green: 0.3, fitness: 0.8 },
  presetScenic: { fairness: 0.4, together: 0.4, spot: 0.5, green: 1, fitness: 0.5 },
  presetCoffee: { fairness: 0.5, together: 0.3, spot: 1, green: 0.3, fitness: 0.5 },
};

let idCounter = 0;
export const newId = () => `p${Date.now().toString(36)}${(idCounter++).toString(36)}`;

export function newPerson(): Person {
  return { id: newId(), name: '', home: null, fitness: 3, speed: 17, maxDetourKm: null };
}

export function defaultState(lang: Lang): AppState {
  return {
    lang,
    people: [newPerson(), newPerson()],
    settings: {
      mode: 'morning',
      destination: null,
      time: '08:45',
      groupPace: 'slowest',
      weights: { ...PRESETS.presetBalanced },
      spotTypes: Object.fromEntries(SPOT_TYPES.map((s) => [s, true])) as Record<SpotType, boolean>,
      options: 4,
      waitBuffer: 2,
    },
  };
}

const STORAGE_KEY = 'bike2gather:v1';

/** Merge possibly old / partial data onto defaults so new fields never break loading. */
export function normalize(raw: unknown, lang: Lang): AppState {
  const d = defaultState(lang);
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<AppState>;
  const s = (r.settings ?? {}) as Partial<Settings>;
  return {
    lang: r.lang === 'nl' || r.lang === 'en' ? r.lang : lang,
    people: Array.isArray(r.people) && r.people.length
      ? r.people.map((p) => ({ ...newPerson(), ...p, id: p.id || newId() }))
      : d.people,
    settings: {
      ...d.settings,
      ...s,
      weights: { ...d.settings.weights, ...(s.weights ?? {}) },
      spotTypes: { ...d.settings.spotTypes, ...(s.spotTypes ?? {}) },
    },
  };
}

/** State saved on this device (share links are applied separately, see share.ts). */
export function load(lang: Lang): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalize(raw ? JSON.parse(raw) : null, lang);
  } catch {
    return defaultState(lang);
  }
}

export function save(state: AppState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable (private mode) – app still works */
  }
}
