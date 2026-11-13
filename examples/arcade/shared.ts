import { decisionRows, judgeVerdictFrom, type Ledger, type Oracle } from "../../src/index.ts";
import { randNormal, rng } from "../../src/math.ts";

/** Small input boundary for the local teaching examples, not a public engine API. */
export function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Expected a JSON object.");
  }
  return input as Record<string, unknown>;
}

export function numeric(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
  integer = false,
): number {
  const value = input[key] ?? fallback;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    throw new Error(`${key} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}.`);
  }
  return value;
}

export function sandboxMode(input: Record<string, unknown>): "shadow" | "enforce" {
  if (input.automate !== undefined && typeof input.automate !== "boolean") {
    throw new Error("automate must be a boolean.");
  }
  return input.automate === true ? "enforce" : "shadow";
}

/** Decision rows keep member votes out of the action count; member rows are downloadable too. */
export async function ledgerView(ledger: Ledger) {
  const rows = await ledger.all();
  return {
    rows,
    decisions: decisionRows(rows).map((row) => ({
      id: row.id,
      gate: row.gateId,
      probability: row.go,
      suggested: row.soft,
      actual: row.action,
      mode: row.mode,
      floor: row.floor ?? null,
      answered: !row.failedOpen && row.strategy !== "floored" && row.strategy !== "bypass",
      failedOpen: row.failedOpen ?? false,
      correct:
        row.failedOpen || row.strategy === "floored" || row.strategy === "bypass"
          ? null
          : (row.outcome?.correct ?? null),
      truth: row.outcome?.truth ?? null,
    })),
  };
}

/** Worlds in a batch: enough for a rate to settle within about two points, and under a second. */
export const WORLDS = 500;
/** Worlds per point of a trade-off sweep. */
export const SWEEP_WORLDS = 200;

export function choice<T extends string>(
  input: Record<string, unknown>,
  key: string,
  options: readonly T[],
  fallback: T,
): T {
  const value = input[key] ?? fallback;
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
    throw new Error(`${key} must be one of ${options.join(", ")}.`);
  }
  return value as T;
}

export function flag(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = input[key] ?? fallback;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean.`);
  return value;
}

/** Worlds a request may ask for: its game's default, or fewer for a quicker, rougher batch. */
export const worldsOf = (input: Record<string, unknown>, most: number): number =>
  numeric(input, "worlds", most, 10, most, true);

/** A seed for world `index` of a batch: fixed, so only the levers move a batch's figures. */
export const batchSeed = (index: number): number => (index * 104_729 + 17) % 1_000_003;

/** A generator for one named stream of a world, so each draw is independent of call order. */
export const stream = (seed: number, ...keys: readonly number[]): (() => number) =>
  rng(keys.reduce((a, k) => avalanche(a ^ avalanche(k + 0x9e3779b9)), avalanche(seed)));

/** A 32-bit finalizer, so worlds with neighbouring seeds share nothing. */
function avalanche(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A standard normal draw. */
export const normal = (rand: () => number): number => randNormal(rand);

/**
 * The probability a judge states after one noisy look. The look is `strength` standard
 * deviations toward the truth plus `noise` (a standard normal), so the log-likelihood ratio is
 * 2 * strength * look and the stated probability is calibrated by construction at
 * temperature 1; a temperature below 1 overstates it, as an overconfident model does.
 */
export function reading(
  truth: boolean,
  strength: number,
  noise: number,
  prior = 0.5,
  temperature = 1,
): number {
  const look = (truth ? strength : -strength) + noise;
  const logit = (2 * strength * look + Math.log(prior / (1 - prior))) / temperature;
  return Math.max(0.001, Math.min(0.999, 1 / (1 + Math.exp(-logit))));
}

/** A seeded toy judge that answers each state with the probability the simulation drew for it. */
export function tableOracle(id: string, model: string, table: ReadonlyMap<string, number>): Oracle {
  return {
    id,
    decide: async (state, questions) =>
      questions.map((q) => {
        const p = table.get(state);
        if (q.kind !== "judge" || p === undefined) throw new Error(`${id} has no reading here.`);
        return {
          verdict: judgeVerdictFrom(q, p),
          oracle: id,
          model,
          at: "2026-01-01T00:00:00.000Z",
          latencyMs: 0,
          cost: 0,
        };
      }),
  };
}

export const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

export const share = (n: number, of: number): number => (of === 0 ? 0 : n / of);

/** One square of a world strip: a style class, an optional glyph, and what happened there. */
export interface Cell {
  readonly kind: string;
  readonly text?: string;
  readonly note: string;
}

/** One way of running the same seeded world. */
export interface Arm {
  readonly id: "baseline" | "engine";
  readonly label: string;
  readonly verdict: "good" | "safe" | "bad";
  readonly summary: string;
  readonly cells: readonly Cell[];
}

/** One figure of the batch, for both arms. */
export interface BatchRow {
  readonly label: string;
  readonly baseline: number;
  readonly engine: number;
  readonly unit: "pct" | "num";
  readonly better: "high" | "low" | "none";
}

/** One condition of the target, read from the engine arm's batch. */
export interface Check {
  readonly label: string;
  readonly value: number;
  readonly goal: number;
  readonly sense: "min" | "max";
  readonly unit: "pct" | "num";
  readonly met: boolean;
}

export function check(
  label: string,
  value: number,
  sense: "min" | "max",
  goal: number,
  unit: "pct" | "num" = "pct",
): Check {
  return { label, value, goal, sense, unit, met: sense === "min" ? value >= goal : value <= goal };
}

/** One lever swept across its range with the others held: each series is a rate per value. */
export interface Sweep {
  readonly lever: string;
  readonly values: readonly number[];
  readonly current: number;
  readonly series: readonly { readonly label: string; readonly values: readonly number[] }[];
}
