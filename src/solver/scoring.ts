import type {
  Candidate,
  CandidateDistances,
  Evaluation,
  Person,
  PersonResult,
  Settings,
  Weights,
} from '../types';
import { SPOT_QUALITY } from '../types';

/**
 * All score terms are expressed in "kilometres of detour" so the sliders trade off
 * against something tangible. Lower total = better.
 *
 *   effort   = (1 - fairness) · mean(wᵢ·detourᵢ) + fairness · max(wᵢ·detourᵢ)
 *   together = TOGETHER_KM · together · sharedKm / meanDirectKm   (bonus)
 *   spot     = SPOT_KM · spot · quality(type)                      (bonus)
 *   green    = GREEN_KM · green · greenFraction                    (bonus)
 *
 * wᵢ is a per-person multiplier: fitter riders get a smaller weight, so the
 * optimiser is happier to give them the longer detour.
 */
export const TOGETHER_KM = 8;
export const SPOT_KM = 1.5;
export const GREEN_KM = 3;
/** Penalty per km above someone's personal maximum detour. */
export const LIMIT_PENALTY_KM = 10;

/** Fitness 1…5 → effort multiplier. Fitness 3 is neutral. */
export function fitnessMultiplier(fitness: number, strength: number): number {
  return Math.pow(2, (strength * (3 - fitness)) / 2);
}

export function groupSpeed(people: Person[], pace: Settings['groupPace']): number {
  const speeds = people.map((p) => p.speed).filter((s) => s > 0);
  if (!speeds.length) return 15;
  return pace === 'slowest' ? Math.min(...speeds) : speeds.reduce((a, b) => a + b, 0) / speeds.length;
}

export function parseTime(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return 8 * 60 + 30;
  return (Number(m[1]) * 60 + Number(m[2])) % (24 * 60);
}

export function formatTime(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export interface ScoreInput {
  candidate: Candidate;
  dist: CandidateDistances;
  /** Direct home ↔ destination distance per person (metres). */
  direct: number[];
  people: Person[];
  settings: Settings;
  /** Green fraction per person for their whole ride, and for the shared leg, if known. */
  green?: { perPerson: number[]; overall: number } | null;
}

export function evaluate(input: ScoreInput): Evaluation {
  const { candidate, dist, direct, people, settings } = input;
  const w: Weights = settings.weights;
  const sharedKm = dist.shared / 1000;
  const vGroup = groupSpeed(people, settings.groupPace);
  const sharedMin = (sharedKm / vGroup) * 60;
  const t0 = parseTime(settings.time);

  // morning: meet so that the group arrives on time; evening: split point reached after the shared ride.
  const meetTime =
    settings.mode === 'morning' ? t0 - sharedMin - settings.waitBuffer : t0 + sharedMin;

  let limitPenalty = 0;
  const results: PersonResult[] = people.map((p, i) => {
    const legKm = dist.personLeg[i] / 1000;
    const totalKm = legKm + sharedKm;
    const directKm = direct[i] / 1000;
    const detourKm = Math.max(0, totalKm - directKm);
    const mult = fitnessMultiplier(p.fitness, w.fitness);
    const legMin = (legKm / (p.speed > 0 ? p.speed : 15)) * 60;
    const homeTime = settings.mode === 'morning' ? meetTime - legMin : meetTime + legMin;
    const over = p.maxDetourKm != null && detourKm > p.maxDetourKm;
    if (over) limitPenalty += (detourKm - (p.maxDetourKm ?? 0)) * LIMIT_PENALTY_KM;
    return {
      personId: p.id,
      legKm,
      totalKm,
      directKm,
      detourKm,
      weightedDetourKm: detourKm * mult,
      homeTime,
      green: input.green ? input.green.perPerson[i] : null,
      overLimit: over,
    };
  });

  const wd = results.map((r) => r.weightedDetourKm);
  const mean = wd.reduce((a, b) => a + b, 0) / Math.max(1, wd.length);
  const max = wd.length ? Math.max(...wd) : 0;
  const effort = (1 - w.fairness) * mean + w.fairness * max;

  const meanDirectKm = Math.max(0.5, results.reduce((a, r) => a + r.directKm, 0) / Math.max(1, results.length));
  const togetherBonus = TOGETHER_KM * w.together * Math.min(1, sharedKm / meanDirectKm);
  const spotBonus = SPOT_KM * w.spot * SPOT_QUALITY[candidate.type];
  const greenFrac = input.green ? input.green.overall : null;
  const greenBonus = greenFrac == null ? 0 : GREEN_KM * w.green * greenFrac;

  return {
    candidate,
    people: results,
    sharedKm,
    meetTime,
    green: greenFrac,
    estimated: dist.estimated,
    score: {
      effort,
      togetherBonus,
      spotBonus,
      greenBonus,
      limitPenalty,
      total: effort - togetherBonus - spotBonus - greenBonus + limitPenalty,
    },
  };
}

/**
 * Optimistic green bonus a candidate could still earn; used to decide how many
 * candidates deserve detailed routing (routing is the expensive step).
 */
export function maxGreenBonus(w: Weights): number {
  return GREEN_KM * w.green;
}

/** Pick the best `n` evaluations while keeping options at least `minSpacing` metres apart. */
export function pickDiverse(
  evals: Evaluation[],
  n: number,
  minSpacing: number,
  distance: (a: Candidate, b: Candidate) => number,
): Evaluation[] {
  const sorted = [...evals].sort((a, b) => a.score.total - b.score.total);
  const out: Evaluation[] = [];
  for (const e of sorted) {
    if (out.length >= n) break;
    if (out.every((o) => distance(o.candidate, e.candidate) >= minSpacing)) out.push(e);
  }
  return out;
}
