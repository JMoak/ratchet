import type { Decision, Oracle, Question } from "../types.ts";
import { type PoolOptions, pool } from "./aggregate.ts";
import { type CompoundDecision, compoundOf } from "./compound.ts";

export interface Tier {
  readonly oracle: Oracle;
  /** Settle at this tier when the verdict's confidence reaches this; otherwise escalate. */
  readonly settleAbove: number;
  readonly label?: string;
}

export interface CascadeOptions {
  /** Cheapest first. The last tier always settles, however unsure it is. */
  readonly tiers: readonly Tier[];
  /**
   * Pool every tier's evidence instead of letting the settling tier's answer replace the
   * earlier ones. Only sound when the tiers are calibrated and reasonably independent.
   */
  readonly pool?: PoolOptions | false;
}

export interface CascadeDecision extends CompoundDecision {
  readonly detail: {
    readonly tier: number;
    readonly tierLabel: string;
    readonly escalations: number;
    readonly pooled: boolean;
  };
}

/**
 * Ask the cheap oracle first and escalate only when it is unsure. With a calibrated first
 * tier, the fraction of traffic that escalates is roughly the fraction of items whose
 * confidence falls below the bar, so cost and accuracy are both predictable from the ledger.
 */
export async function cascade(
  state: string,
  question: Question,
  opts: CascadeOptions,
): Promise<CascadeDecision> {
  if (opts.tiers.length === 0) throw new Error("cascade needs at least one tier");
  const members: Decision[] = [];
  let settled: Decision | undefined;
  let tierIndex = 0;
  for (let i = 0; i < opts.tiers.length; i++) {
    const tier = opts.tiers[i] as Tier;
    const [d] = await tier.oracle.decide(state, [question]);
    if (!d) throw new Error(`tier ${tier.label ?? tier.oracle.id} returned nothing`);
    members.push(d);
    tierIndex = i;
    const last = i === opts.tiers.length - 1;
    if (last || (!d.failedOpen && d.verdict.confidence >= tier.settleAbove)) {
      settled = d;
      break;
    }
  }
  const final = settled as Decision;
  const live = members.filter((d) => !d.failedOpen);
  const usePool = opts.pool !== false && opts.pool !== undefined && live.length > 1;
  const verdict = usePool
    ? pool(
        question,
        live.map((d) => d.verdict),
        opts.pool as PoolOptions,
      )
    : final.verdict;
  const tier = opts.tiers[tierIndex] as Tier;
  const base = compoundOf("cascade", verdict, members, {
    parallel: false,
    oracle: `cascade(${opts.tiers.map((t) => t.label ?? t.oracle.id).join(">")})`,
  });
  const result: CascadeDecision = {
    ...base,
    detail: {
      tier: tierIndex,
      tierLabel: tier.label ?? tier.oracle.id,
      escalations: tierIndex,
      pooled: usePool,
    },
    ...(final.failedOpen ? { failedOpen: true } : {}),
  };
  return result;
}
