export type LatLon = { lat: number; lon: number };

/** morning: everyone rides home → meetup → destination. evening: destination → split point → home. */
export type Mode = 'morning' | 'evening';

export type Lang = 'en' | 'nl';

export interface Place extends LatLon {
  label: string;
}

export interface Person {
  id: string;
  name: string;
  home: Place | null;
  /** 1 (take it easy) … 5 (very fit). Fitter riders accept more of the detour. */
  fitness: number;
  /** Cruising speed in km/h, used for departure / arrival times. */
  speed: number;
  /** Optional hard limit on extra kilometres for this person. */
  maxDetourKm: number | null;
}

export type SpotType = 'cafe' | 'park' | 'square' | 'landmark' | 'station' | 'bikeshop' | 'generic';

export const SPOT_TYPES: SpotType[] = ['cafe', 'park', 'square', 'landmark', 'station', 'bikeshop', 'generic'];

/** How pleasant a spot type is to wait at (0–1). Generic = just a point on the street network. */
export const SPOT_QUALITY: Record<SpotType, number> = {
  cafe: 1,
  park: 0.9,
  landmark: 0.8,
  square: 0.75,
  station: 0.6,
  bikeshop: 0.55,
  generic: 0,
};

export interface Weights {
  /** 0 = minimise the group's total detour, 1 = minimise the worst individual detour. */
  fairness: number;
  /** Reward for kilometres ridden together. */
  together: number;
  /** Reward for meeting at a pleasant spot. */
  spot: number;
  /** Reward for green / scenic routes. */
  green: number;
  /** How strongly fitness shifts the detour burden toward fitter riders. */
  fitness: number;
}

export interface Settings {
  mode: Mode;
  destination: Place | null;
  /** HH:MM — morning: arrive at destination by; evening: leave destination at. */
  time: string;
  /** Group rides together at the slowest rider's pace or the average. */
  groupPace: 'slowest' | 'average';
  weights: Weights;
  spotTypes: Record<SpotType, boolean>;
  /** Number of options to work out in detail. */
  options: number;
  /** Minutes of slack at the meetup point. */
  waitBuffer: number;
}

export interface Candidate extends LatLon {
  id: string;
  type: SpotType;
  name: string | null;
  custom?: boolean;
  /** Raw OSM opening_hours value, if known. */
  hours?: string;
}

/** Network distances (metres) for one candidate. */
export interface CandidateDistances {
  /** Per person, the leg between their home and the meetup point (direction depends on mode). */
  personLeg: number[];
  /** Shared leg between meetup point and destination. */
  shared: number;
  /** True if distances are crow-fly estimates rather than routed. */
  estimated: boolean;
}

export interface Leg {
  distance: number; // metres
  coords: [number, number][]; // [lat, lon]
  /** Fraction (0–1) of this leg that is green / scenic; null until computed. */
  green: number | null;
}

export interface PersonResult {
  personId: string;
  legKm: number;
  totalKm: number;
  directKm: number;
  detourKm: number;
  weightedDetourKm: number;
  /** morning: departure from home; evening: arrival at home (minutes since midnight). */
  homeTime: number;
  green: number | null;
  overLimit: boolean;
}

export interface ScoreBreakdown {
  effort: number;
  togetherBonus: number;
  spotBonus: number;
  greenBonus: number;
  limitPenalty: number;
  total: number;
}

export interface Evaluation {
  candidate: Candidate;
  people: PersonResult[];
  sharedKm: number;
  /** morning: time at meetup; evening: time arriving at split point (minutes since midnight). */
  meetTime: number;
  green: number | null;
  score: ScoreBreakdown;
  estimated: boolean;
  /** Open at the meetup time on Mon–Fri, for places with opening hours; null = unknown / n.a. */
  openWorkdays: boolean[] | null;
}
