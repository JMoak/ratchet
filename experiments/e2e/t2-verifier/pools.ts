/**
 * Seeded helpers and name pools for the scripted proposer. Everything here is deterministic
 * given the seed, so the corpus (and its hash in the manifest) is reproducible byte for byte.
 */
import type { Rand } from "../../../src/math.ts";

export const pickOne = <T>(r: Rand, xs: readonly T[]): T => {
  if (xs.length === 0) throw new Error("pickOne of nothing");
  return xs[Math.floor(r() * xs.length)] as T;
};

export const int = (r: Rand, lo: number, hi: number): number =>
  lo + Math.floor(r() * (hi - lo + 1));

/** k distinct elements, in random order. */
export function sample<T>(r: Rand, xs: readonly T[], k: number): T[] {
  const pool = xs.slice();
  const out: T[] = [];
  while (out.length < k && pool.length > 0) {
    const i = Math.floor(r() * pool.length);
    out.push(pool.splice(i, 1)[0] as T);
  }
  if (out.length < k) throw new Error(`sample: asked ${k} of ${xs.length}`);
  return out;
}

export const round2 = (x: number): number => Math.round(x * 100 + Number.EPSILON * 100) / 100;
export const round1 = (x: number): number => Math.round(x * 10 + Number.EPSILON * 10) / 10;

/** 1234.5 -> "1,234.50". Written by hand so the rendering never depends on ICU data. */
export function money(x: number, decimals = 2): string {
  const neg = x < 0;
  const [whole, frac] = Math.abs(x).toFixed(decimals).split(".") as [string, string | undefined];
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${frac !== undefined ? `.${frac}` : ""}`;
}

/** Integer with thousands separators. */
export const count = (n: number): string => money(n, 0);

/** Swap two adjacent distinct digits of a number's text, so the value changes but looks alike. */
export function transposeDigits(text: string, r: Rand): string {
  const idx: number[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    const a = text[i] as string;
    const b = text[i + 1] as string;
    if (/\d/.test(a) && /\d/.test(b) && a !== b) idx.push(i);
  }
  if (idx.length === 0) return text.replace(/\d(?=\D*$)/, (d) => String((Number(d) + 3) % 10));
  const i = pickOne(r, idx);
  return text.slice(0, i) + text[i + 1] + text[i] + text.slice(i + 2);
}

// ---------------------------------------------------------------------------
// Dates, always UTC so the rendering never depends on the machine's zone.
// ---------------------------------------------------------------------------

export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export const day = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d));
export const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86_400_000);
export const iso = (d: Date): string => d.toISOString().slice(0, 10);
export const longDate = (d: Date): string =>
  `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
export const usDate = (d: Date): string =>
  `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
export const slashDate = (d: Date): string =>
  `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
export const monthYear = (d: Date): string => `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
export const daysBetween = (a: Date, b: Date): number =>
  Math.round((b.getTime() - a.getTime()) / 86_400_000);

/** A date in the given year, avoiding month ends so off-by-one edits stay in the month. */
export const randomDate = (r: Rand, year: number): Date => day(year, int(r, 1, 12), int(r, 2, 26));

/** Shift a date by one day either way. */
export const offByOne = (d: Date, r: Rand): Date => addDays(d, r() < 0.5 ? -1 : 1);

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

export const FIRST = [
  "Dana",
  "Priya",
  "Tomas",
  "Wei",
  "Amara",
  "Lukas",
  "Sofia",
  "Kenji",
  "Fatima",
  "Mateo",
  "Ingrid",
  "Olu",
  "Hana",
  "Rafael",
  "Elif",
  "Noah",
  "Aisha",
  "Marek",
  "Leila",
  "Jonas",
] as const;

export const LAST = [
  "Okafor",
  "Raman",
  "Lindqvist",
  "Chen",
  "Nwosu",
  "Becker",
  "Moreau",
  "Tanaka",
  "Haddad",
  "Alvarez",
  "Halvorsen",
  "Adeyemi",
  "Kim",
  "Costa",
  "Yilmaz",
  "Novak",
  "Brennan",
  "Kowalski",
  "Farouk",
  "Ishikawa",
] as const;

export interface Person {
  readonly first: string;
  readonly last: string;
  readonly full: string;
}

export function people(r: Rand, k: number): Person[] {
  const firsts = sample(r, FIRST, k);
  const lasts = sample(r, LAST, k);
  return firsts.map((first, i) => {
    const last = lasts[i] as string;
    return { first, last, full: `${first} ${last}` };
  });
}

export const COMPANIES = [
  "Brightline Supplies Ltd",
  "Calder Robotics GmbH",
  "Norrland Logistics AB",
  "Pinecrest Foods Inc",
  "Aurora Textiles SpA",
  "Meridian Labs LLC",
  "Kestrel Marine Pty",
  "Juniper Office Co",
  "Halvorsen Tools AS",
  "Oakridge Dental Group",
  "Sable & Finch LLP",
  "Tessaract Systems Ltd",
  "Bluewater Ceramics BV",
  "Granite Peak Outfitters",
  "Lumen Analytics SAS",
  "Redfern Bakery Co",
] as const;

export const PRODUCTS = [
  "Servo motor SM-40",
  "Cable harness CH-2",
  "Torque sensor TS-9",
  "Mounting bracket MB-12",
  "Power supply PS-600",
  "Control board CB-3",
  "Linear rail LR-800",
  "Cooling fan CF-120",
  "Encoder disc ED-5",
  "Relay module RM-8",
] as const;

export const CARRIERS = [
  "Baltic Freight Lines",
  "Cascade Parcel",
  "Meridian Express",
  "Northstar Cargo",
  "Tasman Shipping",
] as const;

export const CITIES = [
  "Leeds",
  "Prato",
  "Toledo",
  "Gothenburg",
  "Lyon",
  "Porto",
  "Osaka",
  "Halifax",
  "Tampere",
  "Ghent",
] as const;

export const COUNTRIES = [
  "Canada",
  "Germany",
  "France",
  "Japan",
  "Brazil",
  "Kenya",
  "Spain",
  "Norway",
] as const;
