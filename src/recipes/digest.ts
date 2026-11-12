/**
 * State digestion: do the arithmetic in code and hand the model the comparison.
 *
 * Decision models read numbers and dates as text. Banding a value, stating a comparison in
 * words, and turning timestamps into relative phrases took one NPC benchmark from 74.3% to
 * 100% while cutting tokens 43%, and label-defining fields move accuracy far more than any
 * wording of the question. These helpers build the lines of a state from records.
 *
 * A relative date is for recency; a policy window is a comparison and belongs in `compare`
 * (with `daysBetween`). Live, relative dates alone left 27% of a 30-day window's
 * auto-approvals wrong where the digested comparison left none (e2e T3).
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

export interface CompareOptions {
  readonly actual?: string;
  readonly limit?: string;
  readonly unit?: string;
  /**
   * Decimal places of the printed difference. Default: as many as the inputs are written with,
   * at most 2 for a currency unit (a three-letter code such as USD, or a currency sign). A
   * difference that would round to zero is printed at the inputs' own precision instead.
   */
  readonly digits?: number;
}

/** Decimal places a number is written with, read from its shortest round-trip form. */
function decimals(x: number): number {
  const [mantissa = "", exponent = "0"] = String(x).toLowerCase().split("e");
  const places = mantissa.split(".")[1]?.length ?? 0;
  return Math.max(0, places - Number(exponent));
}

const CURRENCY = /^(?:[A-Z]{3}|[$€£¥₹₩₽¢])$/u;

const at = (x: number, digits: number): number => Number(x.toFixed(Math.min(digits, 100)));

/**
 * State a numeric comparison in words, with the difference, so the model never subtracts. The
 * inputs are printed as given; the difference is rounded to the precision they are written
 * with (or `digits`), so cents stay cents and the noise of binary subtraction never reaches the
 * model ("by 4.2 USD", not "by 4.200000000000003 USD"; "by 0.004 USD", not "by
 * 0.00400000000000489 USD"). "Equals" means the two numbers are the same number; two different
 * numbers are never said to be equal, nor to differ "by 0".
 *
 * A missing value is not a number to compare: NaN or an infinity throws (a `daysBetween` of a
 * missing date would otherwise read as inside the window).
 */
export function compare(actual: number, limit: number, opts: CompareOptions = {}): string {
  const a = opts.actual ?? "actual";
  const l = opts.limit ?? "limit";
  const u = opts.unit ? ` ${opts.unit}` : "";
  if (!Number.isFinite(actual) || !Number.isFinite(limit)) {
    throw new RangeError(
      `compare: ${a} (${actual}) and ${l} (${limit}) must both be finite numbers`,
    );
  }
  if (
    opts.digits !== undefined &&
    !(Number.isInteger(opts.digits) && opts.digits >= 0 && opts.digits <= 20)
  ) {
    throw new RangeError(`compare: digits must be an integer from 0 to 20, got ${opts.digits}`);
  }
  if (actual === limit) return `${a} equals ${l} (${limit}${u})`;
  const places = Math.max(decimals(actual), decimals(limit));
  const digits =
    opts.digits ??
    (opts.unit !== undefined && CURRENCY.test(opts.unit) ? Math.min(places, 2) : places);
  const raw = Math.abs(actual - limit);
  let diff = at(raw, digits);
  if (diff === 0) diff = at(raw, places);
  if (diff === 0) diff = Number(raw.toPrecision(3));
  if (actual > limit) return `${a} (${actual}${u}) exceeds ${l} (${limit}${u}) by ${diff}${u}`;
  return `${a} (${actual}${u}) is below ${l} (${limit}${u}) by ${diff}${u}`;
}

/** The instant a date input names; an invalid or missing date throws rather than reading as NaN. */
function instant(value: Date | string | number, what: string): number {
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) throw new RangeError(`${what}: ${String(value)} is not a valid date`);
  return t;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "17 days ago", "in 5 hours", "just now": recency for a model to read. Never rounded up, so
 * it never states something as older (or further off) than it is: minutes below an hour,
 * hours below two days, whole days below 120 days, then whole 30-day months below a year,
 * then whole years.
 *
 * Day precision covers the usual policy windows (7, 14, 30, 60 and 90 days): rounding to the
 * nearest unit read 31 to 44 days as "1 month ago" and turned refunds outside a 30-day window
 * into confident approvals (e2e T3-05). It is still a phrase, not a comparison: for a window,
 * state the comparison in code with `compare(daysBetween(at, now), window, { actual: "days
 * since delivery", limit: "return window", unit: "days" })`. An invalid date throws.
 */
export function relativeTime(at: Date | string | number, now: Date | number = Date.now()): string {
  const t = instant(at, "relativeTime");
  const n = instant(now, "relativeTime");
  const diff = t - n;
  const abs = Math.abs(diff);
  const [k, name] =
    abs < MINUTE
      ? [0, "now"]
      : abs < HOUR
        ? [Math.floor(abs / MINUTE), "minute"]
        : abs < 2 * DAY
          ? [Math.floor(abs / HOUR), "hour"]
          : abs < 120 * DAY
            ? [Math.floor(abs / DAY), "day"]
            : abs < 365 * DAY
              ? [Math.floor(abs / (30 * DAY)), "month"]
              : [Math.floor(abs / (365 * DAY)), "year"];
  if (name === "now") return "just now";
  const word = `${k} ${name}${k === 1 ? "" : "s"}`;
  return diff < 0 ? `${word} ago` : `in ${word}`;
}

/**
 * Whole days between two instants, signed (positive when `later` is after `earlier`), rounded
 * to the nearest day. With `compare` it is how a policy window is stated:
 * `compare(daysBetween(delivered, requested), 30, { unit: "days" })`. An invalid or missing
 * date throws: NaN days would compare as neither above nor below a window.
 */
export function daysBetween(
  earlier: Date | string | number,
  later: Date | string | number,
): number {
  return Math.round((instant(later, "daysBetween") - instant(earlier, "daysBetween")) / 86_400_000);
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
