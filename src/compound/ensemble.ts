import { rng, shuffled } from "../math.ts";
import { neutralVerdict } from "../questions.ts";
import type { Decision, Oracle, PickQuestion, Question, Verdict } from "../types.ts";
import { type PoolOptions, pool } from "./aggregate.ts";
import { type CompoundDecision, compoundOf, memberKey } from "./compound.ts";

/** Rewrites the (state, question) pair a member sees. Used to manufacture independence. */
export type Transform = (
  state: string,
  question: Question,
) => { state: string; question: Question };

export interface Member {
  readonly oracle: Oracle;
  /** Names the member in the ledger (its key) and the trail. Give each member a distinct one. */
  readonly label?: string;
  readonly transform?: Transform;
  /**
   * The member is asked the negated question and its judge answer is flipped back before
   * pooling (both-polarity asking). Only meaningful for judge questions.
   */
  readonly negated?: boolean;
}

export interface EnsembleOptions extends PoolOptions {
  readonly members: readonly Member[];
  /**
   * Answers needed to pool, an integer from 1 to the member count. Default: every member, as a
   * battery. With fewer answers the ensemble fails open (see `ensemble`).
   */
  readonly minMembers?: number;
}

export const identity: Transform = (state, question) => ({ state, question });

export function compose(...ts: readonly Transform[]): Transform {
  return (state, question) =>
    ts.reduce((acc, t) => t(acc.state, acc.question), { state, question });
}

/**
 * Reorder pick options deterministically from a seed. Decision models favour the first
 * option; asking the same question in several orders and pooling by option name cancels
 * most of that bias. Rate rubrics are ordered and are left alone.
 */
export function shuffleOptions(seed: number): Transform {
  return (state, question) => {
    if (question.kind !== "pick") return { state, question };
    const options = shuffled(question.options, rng(seed));
    return { state, question: { ...question, options } };
  };
}

/** Rewrite the prompt, e.g. a paraphrase. Keep the meaning identical; avoid negations. */
export function reframe(fn: (prompt: string) => string): Transform {
  return (state, question) => ({ state, question: { ...question, prompt: fn(question.prompt) } });
}

/** Prepend framing text to the state. */
export function prefixState(text: string): Transform {
  return (state, question) => ({ state: `${text}\n\n${state}`, question });
}

/**
 * k members on one oracle, each with a different option order and, optionally, a different
 * phrasing. Members share the model, so their errors are correlated: measure the correlation
 * from labelled outcomes and pass it in PoolOptions rather than assuming independence.
 * For a decision model that repeats itself closely (jev-1.13: median shift 0.01 over 414
 * repeated requests, e2e T1; jev-1.14 moves more), shuffling alone
 * mostly cancels option-order bias; real independence needs different frames, decompositions
 * or oracles, so prefer explicit `Member`s over bare replication when the gain matters.
 */
export function replicate(
  oracle: Oracle,
  k: number,
  opts: {
    readonly shuffle?: boolean;
    readonly frames?: readonly ((prompt: string) => string)[];
  } = {},
): Member[] {
  const members: Member[] = [];
  for (let i = 0; i < k; i++) {
    const ts: Transform[] = [];
    if (opts.shuffle ?? true) ts.push(shuffleOptions(1000 + i));
    const frame = opts.frames?.[i % (opts.frames.length || 1)];
    if (frame) ts.push(reframe(frame));
    members.push({ oracle, label: `${oracle.id}#${i + 1}`, transform: compose(...ts) });
  }
  return members;
}

/**
 * Map a verdict given to a transformed question back onto the original question's terms: the
 * original id, a pick distribution keyed by the original options, and, for a member asked the
 * negated question (`Member.negated`), its judge answer flipped back (p(yes) becomes 1 - p).
 * Every strategy that takes `Member`s reads their answers through this, so one member list
 * means the same thing to `ensemble` and `sequential`.
 */
export function untransform(original: Question, v: Verdict, negated = false): Verdict {
  if (v.kind === "judge" && negated) {
    return { ...v, questionId: original.id, pYes: 1 - v.pYes };
  }
  if (v.kind === "pick" && original.kind === "pick") {
    const o = original as PickQuestion;
    const probabilities = Object.fromEntries(
      o.options.map((opt) => [opt, v.probabilities[opt] ?? 0]),
    ) as Record<string, number>;
    return { ...v, questionId: original.id, probabilities };
  }
  return { ...v, questionId: original.id };
}

/** The members an ensemble needs answers from, checked: an integer from 1 to the member count. */
function minimumOf(opts: EnsembleOptions): number {
  const n = opts.members.length;
  const min = opts.minMembers ?? n;
  if (!(Number.isInteger(min) && min >= 1 && min <= n)) {
    throw new Error(`minMembers must be an integer from 1 to ${n} (the member count), not ${min}`);
  }
  return min;
}

/**
 * Ask every member in parallel, map the answers back to the original question, and pool.
 * Members that failed open carry no evidence and are dropped from the pool, but an ensemble
 * pools only when at least `minMembers` answered (default: all of them); with fewer, the
 * result is neutral and flagged failedOpen, so the policy reviews it. That matches a battery,
 * which fails open when any member fails: an ensemble whose bar was fitted on k voices is not
 * the ensemble of the voices that happened to answer, and the member that failed may be the
 * cautious one (a 0.30 and a 0.97 pool to review; the 0.97 alone acts). Lower `minMembers` to
 * keep answering through a member's outage, at the price of acting on fewer, possibly less
 * cautious, voices.
 */
export async function ensemble(
  state: string,
  question: Question,
  opts: EnsembleOptions,
): Promise<CompoundDecision> {
  if (opts.members.length === 0) throw new Error("ensemble needs at least one member");
  const minMembers = minimumOf(opts);
  const answers = await Promise.all(
    opts.members.map(async (m): Promise<Decision> => {
      const t = m.transform ?? identity;
      const seen = t(state, question);
      const [d] = await m.oracle.decide(seen.state, [seen.question]);
      if (!d) throw new Error(`member ${m.label ?? m.oracle.id} returned nothing`);
      return { ...d, verdict: untransform(question, d.verdict, m.negated === true) };
    }),
  );
  const live = answers.filter((d) => !d.failedOpen);
  const enough = live.length >= minMembers;
  const weights =
    opts.weights && live.length !== answers.length
      ? answers.flatMap((d, i) => (d.failedOpen ? [] : [opts.weights?.[i] ?? 1]))
      : opts.weights;
  const keys = opts.members.map((m, i) => memberKey(m.oracle.id, i, m.label));
  // The keys of the members actually pooled, so a per-pair correlation matrix
  // (`PoolOptions.correlations`) weighs each answer by the member that gave it.
  const memberKeys = keys.filter((_, i) => answers[i]?.failedOpen !== true);
  const verdict = !enough
    ? neutralVerdict(question)
    : pool(
        question,
        live.map((d) => d.verdict),
        { ...opts, ...(weights ? { weights } : {}), memberKeys },
      );
  const oracle = `ensemble(${opts.members.map((m) => m.label ?? m.oracle.id).join(",")})`;
  const result = compoundOf("ensemble", verdict, answers, {
    parallel: true,
    oracle,
    memberKeys: keys,
    detail: {
      pooled: enough ? live.length : 0,
      dropped: answers.length - live.length,
      correlation: opts.correlation ?? 0,
      ...(opts.minMembers !== undefined || !enough ? { minMembers } : {}),
    },
  });
  if (enough) return result;
  const cause = answers.find((d) => d.failedOpen && d.error !== undefined)?.error;
  const error = `${live.length} of ${answers.length} members answered; minMembers is ${minMembers}${cause !== undefined ? `: ${cause}` : ""}`;
  return { ...result, failedOpen: true, error: error.slice(0, 160) };
}
