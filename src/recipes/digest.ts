/**
 * State digestion: do the arithmetic in code and hand the model the comparison.
 *
 * Decision models read numbers and dates as text. Banding a value, stating a comparison in
 * words, and turning timestamps into relative phrases took one NPC benchmark from 74.3% to
 * 100% while cutting tokens 43%, and label-defining fields move accuracy far more than any
 * wording of the question. These helpers build the lines of a state from records.
 */

export interface Band {
  /** Values at or below this belong to the band. */
  readonly upTo: number;
  readonly label: string;
}

/** Map a number onto an ordered set of labelled bands; values above the last band get `above`. */
export function band(value: number, bands: readonly Band[], above: string): string {
  for (const b of bands) if (value <= b.upTo) return b.label;
  return above;
}

/** State a numeric comparison in words, with the difference, so the model never subtracts. */
export function compare(
  actual: number,
  limit: number,
  opts: { readonly actual?: string; readonly limit?: string; readonly unit?: string } = {},
): string {
  const a = opts.actual ?? "actual";
  const l = opts.limit ?? "limit";
  const u = opts.unit ? ` ${opts.unit}` : "";
  const diff = Math.abs(actual - limit);
  if (actual > limit) return `${a} (${actual}${u}) exceeds ${l} (${limit}${u}) by ${diff}${u}`;
  if (actual < limit) return `${a} (${actual}${u}) is below ${l} (${limit}${u}) by ${diff}${u}`;
  return `${a} equals ${l} (${limit}${u})`;
}

/** "3 days ago", "in 2 hours", "just now". Rounds to the largest whole unit. */
export function relativeTime(at: Date | string | number, now: Date | number = Date.now()): string {
  const t = new Date(at).getTime();
  const n = typeof now === "number" ? now : now.getTime();
  const diff = t - n;
  const abs = Math.abs(diff);
  const units: readonly [number, string][] = [
    [365 * 86_400_000, "year"],
    [30 * 86_400_000, "month"],
    [7 * 86_400_000, "week"],
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [ms, name] of units) {
    if (abs >= ms) {
      const k = Math.round(abs / ms);
      const word = `${k} ${name}${k === 1 ? "" : "s"}`;
      return diff < 0 ? `${word} ago` : `in ${word}`;
    }
  }
  return "just now";
}

/** Whole days between two instants, signed (positive when `later` is after `earlier`). */
export function daysBetween(
  earlier: Date | string | number,
  later: Date | string | number,
): number {
  return Math.round((new Date(later).getTime() - new Date(earlier).getTime()) / 86_400_000);
}

/** "no open tickets", "1 open ticket", "3 open tickets". */
export function count(n: number, noun: string, plural = `${noun}s`): string {
  if (n === 0) return `no ${plural}`;
  return `${n} ${n === 1 ? noun : plural}`;
}

/** Keep only the named fields of a record, in that order. */
export function pruneFields<T extends Record<string, unknown>>(
  record: T,
  keep: readonly (keyof T & string)[],
): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keep) if (k in record) out[k] = record[k];
  return out;
}

/** Render a record as `key: value` lines, the compact state shape decision models read best. */
export function lines(record: Readonly<Record<string, unknown>>): string {
  return Object.entries(record)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
}
