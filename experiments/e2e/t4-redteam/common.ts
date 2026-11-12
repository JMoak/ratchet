/**
 * Shared plumbing for the T4 red-team track: result rows, tables, intervals, scratch dirs.
 * Every attack records an `Outcome` row: what was tried, what the engine did, what the
 * documented contract says it should do, and whether that held.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { wilsonInterval } from "../../../src/ledger/calibration.ts";
import { E2E_OUT } from "../lib.ts";

export const TRACK = "t4-redteam";
export const TRACK_OUT = join(E2E_OUT, TRACK);

/** One attack and what came of it. `held` is false when the engine broke its own contract. */
export interface Finding {
  readonly area: string;
  readonly attack: string;
  readonly observed: string;
  readonly expected: string;
  readonly held: boolean;
  /** Finding id in the report, when this row is evidence for one. */
  readonly ref?: string;
}

export class Findings {
  readonly rows: Finding[] = [];
  add(f: Finding): void {
    this.rows.push(f);
  }
  check(
    area: string,
    attack: string,
    held: boolean,
    observed: string,
    expected: string,
    ref?: string,
  ): void {
    this.rows.push({ area, attack, observed, expected, held, ...(ref ? { ref } : {}) });
  }
  get broken(): readonly Finding[] {
    return this.rows.filter((r) => !r.held);
  }
}

/** A fresh scratch directory under the track's gitignored output. */
export function scratch(label: string): string {
  mkdirSync(TRACK_OUT, { recursive: true });
  return mkdtempSync(join(TRACK_OUT, `${label}-`));
}

export const pct = (x: number, places = 1): string =>
  Number.isFinite(x) ? `${(100 * x).toFixed(places)}%` : "n/a";

/** "k/n = p% [lo, hi]" with a 95% Wilson interval. */
export function rate(k: number, n: number): string {
  if (n === 0) return "0/0";
  const p = k / n;
  const { lower, upper } = wilsonInterval(p, n, 0.95);
  return `${k}/${n} = ${pct(p)} [${pct(lower)}, ${pct(upper)}]`;
}

export function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${head.map(esc).join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
  ].join("\n");
}

export function findingsTable(rows: readonly Finding[]): string {
  return table(
    ["area", "attack", "observed", "expected", "held", "ref"],
    rows.map((r) => [r.area, r.attack, r.observed, r.expected, r.held ? "yes" : "NO", r.ref ?? ""]),
  );
}

/** Run a promise, capturing a thrown error as text instead of letting it escape. */
export async function attempt<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Exact two-sided McNemar p-value from the discordant counts (b, c). */
export function mcnemar(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  let coef = 1;
  for (let i = 0; i <= n; i++) {
    if (i > 0) coef = (coef * (n - i + 1)) / i;
    if (i <= k) tail += coef;
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}
