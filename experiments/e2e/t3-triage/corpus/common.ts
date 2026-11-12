/**
 * Shared corpus plumbing for track T3: seeded draws, slot filling and the label shape. Corpora
 * are generated once by `build.ts` into JSON files that fix every label before any live call;
 * the runner reads the JSON, never these generators, so a generator edit cannot move a label
 * that a run already used without changing the corpus hash in its manifest.
 */
import { type Rand, rng } from "../../../../src/math.ts";
import type { DeciderLabel } from "../../lib.ts";

export type { DeciderLabel };

/** A label for one question: the decider's answer, why, and whether a reasonable decider could differ. */
export interface Label {
  readonly truth: boolean | string;
  readonly why: string;
  readonly ambiguous?: boolean;
}

export const label = (truth: boolean | string, why: string, ambiguous = false): Label =>
  ambiguous ? { truth, why, ambiguous: true } : { truth, why };

/** A seeded source of draws, so a corpus is a pure function of its seed. */
export class Draw {
  readonly rand: Rand;
  constructor(seed: number) {
    this.rand = rng(seed);
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.rand() * (hi - lo + 1));
  }
  pick<T>(xs: readonly T[]): T {
    const x = xs[Math.floor(this.rand() * xs.length)];
    if (x === undefined) throw new Error("pick from an empty list");
    return x;
  }
  chance(p: number): boolean {
    return this.rand() < p;
  }
  /** A money amount with cents, in [lo, hi]. */
  money(lo: number, hi: number): number {
    return Math.round((lo + this.rand() * (hi - lo)) * 100) / 100;
  }
  shuffle<T>(xs: readonly T[]): T[] {
    const a = xs.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [a[i], a[j]] = [a[j] as T, a[i] as T];
    }
    return a;
  }
}

/** Fill `{slot}` placeholders; throws on a slot with no value so a template typo cannot ship. */
export function fill(template: string, slots: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = slots[k];
    if (v === undefined) throw new Error(`no value for slot {${k}} in: ${template}`);
    return v;
  });
}

const DAY = 86_400_000;

/** A UTC calendar date, YYYY-MM-DD. */
export const ymd = (t: number): string => new Date(t).toISOString().slice(0, 10);

export const addDays = (date: string, days: number): string =>
  ymd(Date.parse(`${date}T00:00:00Z`) + days * DAY);

/** A date between two others, inclusive. */
export function dateBetween(d: Draw, from: string, to: string): string {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return ymd(a + d.int(0, Math.round((b - a) / DAY)) * DAY);
}

export const usd = (x: number): string =>
  `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A short opaque id, so every state renders uniquely without carrying a hint. */
export const opaqueId = (d: Draw, prefix: string): string => `${prefix}-${d.int(10000, 99999)}`;
