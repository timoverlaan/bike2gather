import type { Candidate, Leg, Person, Settings } from './types';
import { simplify } from './solver/geo';

/**
 * Share links: `#plan=<data>` (also accepted as `?plan=<data>`). The part after `#`
 * never reaches the web server, which keeps home locations out of server logs.
 *
 * <data> is a one-letter format tag followed by base64url:
 *   z = deflate-raw compressed JSON (CompressionStream), j = plain JSON.
 * Links from the first version (plain base64 JSON of the inputs, no tag) still open.
 */

/** [distance in m, green fraction or null, encoded polyline] */
export type SharedLeg = [number, number | null, string];

export interface SharedResult {
  /** Direct home ↔ destination distance per person (m). */
  direct: number[];
  selected: string | null;
  options: { c: Candidate; p: SharedLeg[]; s: SharedLeg }[];
}

export interface SharedPayload {
  v: 2;
  state: { people: Person[]; settings: Settings };
  result?: SharedResult;
}

// ------------------------------------------------------------------ polylines

/** Google encoded-polyline format (precision 5 ≈ 1 m) for [lat, lon] pairs. */
export function encodePolyline(coords: [number, number][]): string {
  let out = '';
  let pLat = 0;
  let pLon = 0;
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    out += String.fromCharCode(n + 63);
  };
  for (const [lat, lon] of coords) {
    const a = Math.round(lat * 1e5);
    const b = Math.round(lon * 1e5);
    enc(a - pLat);
    enc(b - pLon);
    pLat = a;
    pLon = b;
  }
  return out;
}

export function decodePolyline(s: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const dec = () => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = s.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < s.length) {
    lat += dec();
    lon += dec();
    out.push([lat / 1e5, lon / 1e5]);
  }
  return out;
}

export function packLeg(l: Leg): SharedLeg {
  return [Math.round(l.distance), l.green == null ? null : Math.round(l.green * 1000) / 1000, encodePolyline(simplify(l.coords, 5))];
}

export function unpackLeg([distance, green, poly]: SharedLeg): Leg {
  return { distance, green, coords: decodePolyline(poly) };
}

// ------------------------------------------------------------------ encoding

function toB64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function encodePayload(p: SharedPayload): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(p));
  if (typeof CompressionStream !== 'undefined') {
    try {
      return `z${toB64url(await pipe(json, new CompressionStream('deflate-raw')))}`;
    } catch {
      /* fall through to uncompressed */
    }
  }
  return `j${toB64url(json)}`;
}

export async function decodePayload(data: string): Promise<SharedPayload | null> {
  try {
    const tag = data[0];
    const body = data.slice(1);
    let json: string;
    if (tag === 'z') json = new TextDecoder().decode(await pipe(fromB64url(body), new DecompressionStream('deflate-raw')));
    else if (tag === 'j') json = new TextDecoder().decode(fromB64url(body));
    else {
      // First-version link: untagged base64 JSON of { lang, people, settings }.
      const old = JSON.parse(new TextDecoder().decode(fromB64url(data)));
      return { v: 2, state: { people: old.people, settings: old.settings } };
    }
    const p = JSON.parse(json);
    return p && p.v === 2 && p.state ? (p as SharedPayload) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ URLs

export async function buildShareUrl(p: SharedPayload): Promise<string> {
  const url = new URL(location.href);
  url.search = '';
  url.hash = `plan=${await encodePayload(p)}`;
  return url.toString();
}

/** The `plan=` data from the current URL (hash or query), if any. */
export function sharedFromUrl(): string | null {
  const m = /[#?&]plan=([A-Za-z0-9_-]+)/.exec(`${location.hash}${location.search}`);
  return m ? m[1] : null;
}

/** Remove the plan from the address bar (once the user starts changing things). */
export function clearSharedFromUrl() {
  if (sharedFromUrl()) history.replaceState(null, '', location.pathname);
}
