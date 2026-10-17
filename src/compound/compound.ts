import { maxLatency, nowIso, totalCost } from "../oracles/oracle.ts";
import type { Decision, Oracle, Question, Verdict } from "../types.ts";
import { agreement } from "./aggregate.ts";

/**
 * How a decision was produced. "battery" is several judge questions about one state, asked in
 * one request and combined into one verdict by a gate's combiner; "bypass" and "floored"
 * bought no answer at all.
 */
export type Strategy =
  | "single"
  | "ensemble"
  | "cascade"
  | "sequential"
  | "battery"
  | "bypass"
  | "floored";

/**
 * A decision produced by combining several oracle decisions. It is itself a Decision, so a
 * compound can be pooled again, ruled on, or recorded like any single call.
 */
export interface CompoundDecision<V extends Verdict = Verdict> extends Decision<V> {
  readonly strategy: Strategy;
  /** Every underlying decision, in the order it was made. */
  readonly members: readonly Decision[];
  /** Fraction of members agreeing with the final answer; 1 for a single call. */
  readonly agreement: number;
  /** Strategy-specific facts kept for audit. */
  readonly detail: Readonly<Record<string, unknown>>;
}

/** Lift a plain decision into the compound shape so callers handle one type. */
export function single(d: Decision): CompoundDecision {
  if (isCompound(d)) return d;
  return { ...d, strategy: "single", members: [d], agreement: 1, detail: {} };
}

export function isCompound(d: Decision): d is CompoundDecision {
  return "strategy" in d && "members" in d;
}

export function compoundOf(
  strategy: Strategy,
  verdict: Verdict,
  members: readonly Decision[],
  opts: {
    readonly parallel: boolean;
    readonly oracle: string;
    readonly detail?: Record<string, unknown>;
  },
): CompoundDecision {
  const latencyMs = opts.parallel
    ? maxLatency(members)
    : members.reduce((s, d) => s + d.latencyMs, 0);
  const failedOpen = members.length > 0 && members.every((d) => d.failedOpen === true);
  return {
    verdict,
    oracle: opts.oracle,
    latencyMs,
    cost: totalCost(members),
    at: nowIso(),
    strategy,
    members,
    agreement: agreement(members.map((d) => d.verdict)),
    detail: opts.detail ?? {},
    ...(failedOpen ? { failedOpen: true } : {}),
  };
}

/** Ask one oracle one question and return the single decision. */
export async function askOne(oracle: Oracle, state: string, q: Question): Promise<Decision> {
  const [d] = await oracle.decide(state, [q]);
  if (!d) throw new Error(`oracle ${oracle.id} returned no decision`);
  return d;
}
