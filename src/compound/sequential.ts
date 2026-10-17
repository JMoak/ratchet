import { neutralVerdict } from "../questions.ts";
import type { Decision, Question, Verdict } from "../types.ts";
import { type PoolOptions, pool } from "./aggregate.ts";
import { type CompoundDecision, compoundOf } from "./compound.ts";
import { identity, type Member } from "./ensemble.ts";

export interface SequentialOptions extends PoolOptions {
  /** Members are sampled in order and cycled if more samples are needed than members. */
  readonly members: readonly Member[];
  /** Stop once the pooled verdict's confidence reaches this. */
  readonly settleAbove: number;
  /**
   * Alternatively stop once the leading answer is ahead of the runner-up by this many votes
   * (first-to-ahead-by-k, the rule MAKER used to run a million steps without an error).
   * Either condition settles.
   */
  readonly settleLead?: number;
  readonly minSamples?: number;
  readonly maxSamples: number;
}

export interface SequentialDecision extends CompoundDecision {
  readonly detail: {
    readonly samples: number;
    readonly settled: boolean;
    readonly trajectory: readonly number[];
  };
}

/**
 * Keep buying cheap independent-ish samples until the pooled evidence is strong enough,
 * then stop. With calibrated members pooled in log-odds this is Wald's sequential
 * probability ratio test with symmetric bounds at +/- logit(settleAbove): easy items settle
 * in one sample, hard items get more, and the expected sample count is far below the fixed
 * ensemble size that would reach the same accuracy.
 */
/** Votes for the leading answer minus votes for the runner-up. */
export function voteLead(vs: readonly Verdict[]): number {
  const counts = new Map<string, number>();
  for (const v of vs) {
    const label =
      v.kind === "judge" ? (v.pYes >= 0.5 ? "yes" : "no") : v.kind === "pick" ? v.choice : v.level;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const sorted = [...counts.values()].sort((a, b) => b - a);
  return (sorted[0] ?? 0) - (sorted[1] ?? 0);
}

export async function sequential(
  state: string,
  question: Question,
  opts: SequentialOptions,
): Promise<SequentialDecision> {
  if (opts.members.length === 0) throw new Error("sequential needs at least one member");
  const minSamples = Math.max(1, opts.minSamples ?? 1);
  const members: Decision[] = [];
  const trajectory: number[] = [];
  let verdict: Verdict = neutralVerdict(question);
  let settled = false;
  for (let i = 0; i < opts.maxSamples; i++) {
    const m = opts.members[i % opts.members.length] as Member;
    const seen = (m.transform ?? identity)(state, question);
    const [d] = await m.oracle.decide(seen.state, [seen.question]);
    if (!d) throw new Error(`member ${m.label ?? m.oracle.id} returned nothing`);
    members.push({ ...d, verdict: { ...d.verdict, questionId: question.id } as Verdict });
    const live = members.filter((x) => !x.failedOpen);
    if (live.length > 0) {
      verdict = pool(
        question,
        live.map((x) => x.verdict),
        opts,
      );
    }
    trajectory.push(verdict.confidence);
    const lead = opts.settleLead !== undefined ? voteLead(live.map((x) => x.verdict)) : 0;
    if (
      live.length >= minSamples &&
      (verdict.confidence >= opts.settleAbove ||
        (opts.settleLead !== undefined && lead >= opts.settleLead))
    ) {
      settled = true;
      break;
    }
  }
  const base = compoundOf("sequential", verdict, members, {
    parallel: false,
    oracle: `sequential(${opts.members.map((m) => m.label ?? m.oracle.id).join(",")})`,
  });
  const allFailed = members.every((d) => d.failedOpen);
  return {
    ...base,
    detail: { samples: members.length, settled, trajectory },
    ...(allFailed ? { failedOpen: true } : {}),
  };
}
