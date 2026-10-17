/**
 * Core vocabulary. Three typed questions, three typed verdicts, one oracle interface.
 *
 * The names are deliberately oracle-agnostic. TypeSafe's Jev calls these Choice, Score and
 * Noul; Cloudflare's and Amazon's decision models use their own words. The engine speaks
 * pick / rate / judge and adapters translate.
 */

export type QuestionKind = "pick" | "rate" | "judge";

/** Pick exactly one option from a closed set (Jev: Choice). */
export interface PickQuestion<O extends string = string> {
  readonly kind: "pick";
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly O[];
  /** Optional one-line criteria per option; routers use this heavily. */
  readonly criteria?: Readonly<Partial<Record<O, string>>>;
}

/** Place the state on an ordered rubric of 2 to 10 levels (Jev: Score). */
export interface RateQuestion {
  readonly kind: "rate";
  readonly id: string;
  readonly prompt: string;
  /** Ordered from lowest to highest. */
  readonly levels: readonly string[];
}

/** A yes / no question answered with a calibrated probability of yes (Jev: Noul). */
export interface JudgeQuestion {
  readonly kind: "judge";
  readonly id: string;
  readonly prompt: string;
  /** Optional descriptions of what a yes and a no mean. */
  readonly criteria?: { readonly yes?: string; readonly no?: string };
}

export type Question = PickQuestion | RateQuestion | JudgeQuestion;

export interface PickVerdict<O extends string = string> {
  readonly kind: "pick";
  readonly questionId: string;
  readonly choice: O;
  /** Full distribution over options; sums to 1. */
  readonly probabilities: Readonly<Record<O, number>>;
  /** Probability mass on `choice`. */
  readonly confidence: number;
}

export interface RateVerdict {
  readonly kind: "rate";
  readonly questionId: string;
  /** Probability-weighted position on the rubric, 0 .. levels.length - 1 (may be fractional). */
  readonly score: number;
  /** The most probable level. */
  readonly level: string;
  /** One probability per level, in rubric order; sums to 1. */
  readonly probabilities: readonly number[];
  /** Probability mass on `level`. */
  readonly confidence: number;
}

export interface JudgeVerdict {
  readonly kind: "judge";
  readonly questionId: string;
  /** Calibrated probability that the answer is yes. */
  readonly pYes: number;
  /** max(pYes, 1 - pYes): how sure the oracle is of whichever side it leans to. */
  readonly confidence: number;
}

export type Verdict = PickVerdict | RateVerdict | JudgeVerdict;

export type VerdictFor<Q extends Question> =
  Q extends PickQuestion<infer O>
    ? PickVerdict<O>
    : Q extends RateQuestion
      ? RateVerdict
      : JudgeVerdict;

/** One oracle call's answer to one question, with the operational facts the ledger needs. */
export interface Decision<V extends Verdict = Verdict> {
  readonly verdict: V;
  /** Oracle id, e.g. "jev", "sim", "rules", "openrouter:anthropic/claude-haiku-5-5". */
  readonly oracle: string;
  /** Model version the oracle reported, when it reports one. Pin and log it. */
  readonly model?: string;
  readonly latencyMs: number;
  /** Estimated cost in USD for this question's share of the call. */
  readonly cost: number;
  /** ISO timestamp. */
  readonly at: string;
  /**
   * True when the oracle errored or timed out and the verdict is the neutral placeholder.
   * Soft judgments fail open: a failure changes nothing. Hard rules fail closed.
   */
  readonly failedOpen?: boolean;
  /** Why it failed open (HTTP status, timeout, malformed answer), kept short. */
  readonly error?: string;
  /** Small vendor-specific extras worth keeping for audit, e.g. the vendor's own confidence figure. */
  readonly vendor?: Readonly<Record<string, unknown>>;
}

export interface DecideOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Anything that answers typed questions about a state. The state is plain text: whatever
 * evidence the caller wants judged, already serialized. Oracles must answer every question,
 * in order, and may answer them all from one underlying call (Jev batches per state).
 */
export interface Oracle {
  readonly id: string;
  decide(state: string, questions: readonly Question[], opts?: DecideOptions): Promise<Decision[]>;
}

/**
 * The minimum the engine needs from a built state: the text the oracle sees, a hash of that
 * whole rendering (the ledger's `stateHash`), a hash of the trusted fields alone (for grouping
 * and replay, so that the same command with different tool output groups together), and the
 * names of the untrusted spans, which the ledger records so an auditor can see what evidence
 * the harness did not vouch for. The `State` builder satisfies it; a plain string is wrapped
 * as one trusted field, so existing callers change nothing.
 */
export interface StateLike {
  readonly text: string;
  readonly hash: string;
  readonly trustedHash: string;
  readonly untrusted: readonly string[];
}

/** What the engine, gates and recipes accept as a state. */
export type StateInput = string | StateLike;

/** What the application should do with a verdict. Caution is a total order: refuse > review > act. */
export type Action = "act" | "review" | "refuse";

export const CAUTION: Readonly<Record<Action, number>> = { act: 0, review: 1, refuse: 2 };

/** The more cautious of two actions. A soft judgment can raise caution but never lower a hard floor. */
export function moreCautious(a: Action, b: Action): Action {
  return CAUTION[a] >= CAUTION[b] ? a : b;
}
