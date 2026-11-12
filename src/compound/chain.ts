import { type GatePolicy, isAction, type Ruling, readAction, rule } from "../policy.ts";
import { show } from "../questions.ts";
import { type Action, type Decision, moreCautious } from "../types.ts";

/**
 * What a gate's `ask` returns, as far as a chain reads it; an `AskResult` is one. `action` is
 * what the gate says to do now: in enforce its ruling with its floors, one-way doors and blind
 * audits applied, in shadow its baseline (review unless the ask passed one). Structural, so this
 * module needs nothing from the engine.
 */
export interface GateVerification {
  readonly decision: Decision;
  readonly ruling: Ruling;
  readonly action: Action;
  readonly mode?: string;
  readonly recordId?: string;
  readonly audited?: boolean;
}

/** What a step's verifier returns: a bare decision, or a gate's whole answer. */
export type Verification = Decision | GateVerification;

/** True when a verifier returned a gate's answer rather than a bare decision. */
export function isGateVerification(v: Verification): v is GateVerification {
  return typeof v === "object" && v !== null && "decision" in v && "action" in v && "ruling" in v;
}

/**
 * The tags a chain step's verification should carry into the ledger: `chain`, the step's name
 * and the attempt number (1-based), e.g. `["chain", "chain:step:migrate", "chain:attempt:2"]`.
 * A retry exists only because the attempt before it was held back, so attempts after the first
 * are a selected sample; learning reads these tags to keep them out of unselected evidence.
 * `runChain` passes them to `verify` as its fourth argument; give them to the gate's ask.
 */
export function chainTags(stepName: string, attempt: number): string[] {
  return ["chain", `chain:step:${stepName}`, `chain:attempt:${attempt}`];
}

/**
 * One step of a multi-step task. `propose` produces a candidate next state; `verify` judges
 * whether the candidate achieved the step (a judge verdict where yes means success).
 * Attempts must be independent: a fresh proposal, not a retry of the same bytes. When the
 * verifier is a gate, return its whole `AskResult`, not `result.decision` (see `runChain`).
 */
export interface Step<S> {
  readonly name: string;
  readonly propose: (state: S, attempt: number) => Promise<S>;
  readonly verify: (
    before: S,
    after: S,
    attempt: number,
    tags: readonly string[],
  ) => Promise<Verification>;
  /** A finite integer of at least 1. Default 3. */
  readonly maxAttempts?: number;
}

export interface Attempt {
  readonly attempt: number;
  readonly decision: Decision;
  /**
   * The ruling the chain acted on: `policy` and the chain's floor over the decision, made at
   * least as cautious as the gate's action when the verifier was a gate.
   */
  readonly ruling: Ruling;
  /** What the gate said, when the verifier was a gate. */
  readonly gate?: {
    readonly action: Action;
    readonly ruling: Ruling;
    readonly mode?: string;
    readonly recordId?: string;
    readonly audited?: boolean;
  };
}

export interface StepTrace {
  readonly name: string;
  readonly attempts: readonly Attempt[];
  readonly committed: boolean;
}

export interface ChainResult<S> {
  readonly ok: boolean;
  /** The last committed state. Never an unverified proposal. */
  readonly state: S;
  readonly checkpoints: readonly S[];
  readonly trace: readonly StepTrace[];
  readonly cost: number;
  readonly stoppedAt?: string;
  readonly stopReason?: "refused" | "exhausted";
}

export interface ChainOptions {
  /** Hard floor applied to every verification ruling, e.g. from floors.ts. */
  readonly floor?: Action;
  readonly onStep?: (trace: StepTrace, state: unknown) => void;
}

const DEFAULT_ATTEMPTS = 3;

/** A step's attempt budget, checked before anything runs: a finite integer of at least 1. */
function attemptsOf(step: Step<unknown>): number {
  const max = step.maxAttempts ?? DEFAULT_ATTEMPTS;
  if (!(Number.isInteger(max) && max >= 1)) {
    throw new Error(
      `step ${step.name}: maxAttempts must be a finite integer of at least 1, not ${String(max)}`,
    );
  }
  return max;
}

/** The chain's own ruling, made at least as cautious as a gate verifier's action. */
/**
 * The floor a gate's ruling applied: "act" when it applied none, review when the ruling cannot
 * be read (a gate verification without a ruling says nothing about the gate's hard rules).
 */
function gateFloorOf(v: GateVerification): Action {
  const ruling: unknown = v.ruling;
  if (typeof ruling !== "object" || ruling === null) return "review";
  const floor = (ruling as { readonly floor?: unknown }).floor;
  return floor === undefined ? "act" : readAction(floor);
}

/**
 * The chain's own ruling, made at least as cautious as a gate verifier's action, under the
 * chain's floor and the gate's floor together. The gate's floor binds in every mode: a shadow
 * gate's action is its baseline, which can be act, but a refuse floor or a one-way door on the
 * gate is a hard rule, and a floored ask carries only a neutral placeholder (p(yes) 0.5) that a
 * permissive chain policy would otherwise act on.
 */
function rulingFor(
  v: Verification,
  policy: GatePolicy,
  floor: Action | undefined,
): Pick<Attempt, "decision" | "ruling" | "gate"> {
  if (!isGateVerification(v)) return { decision: v, ruling: rule(v, policy, floor) };
  const gateFloor = gateFloorOf(v);
  const bound =
    floor === undefined && gateFloor === "act"
      ? undefined
      : moreCautious(readAction(floor ?? "act"), gateFloor);
  const own = rule(v.decision, policy, bound);
  const gateAction = readAction(v.action);
  const action = moreCautious(gateAction, own.action);
  const mode = typeof v.mode === "string" ? v.mode : undefined;
  const unread = isAction(v.action) ? "" : ` (${show(v.action)} is not an action)`;
  const said = `gate${mode !== undefined ? ` (${mode})` : ""} says ${gateAction}${unread}`;
  const ruling: Ruling =
    action === own.action ? own : { ...own, action, reason: `${own.reason}; ${said}` };
  return {
    decision: v.decision,
    ruling,
    gate: {
      action: gateAction,
      ruling: v.ruling,
      ...(mode !== undefined ? { mode } : {}),
      ...(typeof v.recordId === "string" ? { recordId: v.recordId } : {}),
      ...(typeof v.audited === "boolean" ? { audited: v.audited } : {}),
    },
  };
}

/**
 * The ratchet. A chain of n steps that are each right with probability p succeeds p^n of the
 * time if nothing checks the work: at 0.8, ten steps succeed one time in nine. Verifying each
 * step and committing only verified progress changes what a committed step is worth: with
 * catch rate t and false-alarm rate f, a committed step is right with probability
 * q = p(1 - f) / (p(1 - f) + (1 - p)(1 - t)). That is the precision of commits, so a chain that
 * finishes is right about q^n of the time. It does not say how often a chain finishes. One
 * attempt is accepted with probability a = p(1 - f) + (1 - p)(1 - t), and (1 - (1 - a)^m)^n is
 * the completion rate for m attempts per step only if attempts are independent, which they
 * usually are not: a verifier that dislikes an instance tends to dislike every fresh
 * correct answer to it. Live, a held-back correct attempt was held back again 56% of the time
 * (base rate 15%), and chains finished 48% to 62% of the time where that formula said 74% to
 * 99.8%. Completion is set by the false-alarm rate per item, its correlation across retries and
 * the retry budget; measure them from the ledger (`chainTags`).
 *
 * Each attempt is ruled by `policy` and `opts.floor`. A refusal stops the whole chain, not just
 * the step: a verifier policy with `refuseBelow` (as `policyWithBand(..., { refuse: true })`
 * builds) ends the chain on the first confidently wrong proposal, where a retry would usually
 * have succeeded (live: 6.7% of chains completed against 43.3% without it). Leave `refuseBelow`
 * off a step verifier's policy and put stop conditions in `opts.floor` or in a gate's floors.
 *
 * A verifier that is a gate returns the gate's `AskResult` (a `GateVerification`), not its
 * decision. The chain then commits only when the gate's action is act and its own ruling is act
 * (the more cautious of the two), and it rules its own policy under the gate's floor as well as
 * its own, so the gate's floors, one-way doors, mode and blind audits hold, and a gate that
 * refuses stops the chain. An action outside the vocabulary ("REFUSE", undefined) is read
 * cautiously (`readAction`), never as act. Returning `result.decision` instead drops all of
 * that: a bare decision is ruled by `policy` alone. A gate in shadow acts on its baseline,
 * review unless the ask passes `baseline`, so a chain verified by a shadow gate commits nothing
 * until the caller says what it does anyway. `baseline: "act"` lets the chain's own policy
 * decide while the gate records, except that the gate's floors still bind: a step its refuse
 * floor matches stops the chain, and one its review floor or one-way door matches is never
 * committed, whatever the chain's bar. An audited act is held back like any review, and the
 * step retries. Pass the
 * fourth argument to `verify`, `chainTags(step, attempt)`, as the ask's tags, so each row says
 * which step and attempt it verified.
 */
export async function runChain<S>(
  initial: S,
  steps: readonly Step<S>[],
  policy: GatePolicy,
  opts: ChainOptions = {},
): Promise<ChainResult<S>> {
  const budgets = steps.map((step) => attemptsOf(step as Step<unknown>));
  let state = initial;
  const checkpoints: S[] = [initial];
  const trace: StepTrace[] = [];
  let cost = 0;
  for (const [i, step] of steps.entries()) {
    const max = budgets[i] as number;
    const attempts: Attempt[] = [];
    let committed = false;
    let refused = false;
    for (let attempt = 1; attempt <= max; attempt++) {
      const after = await step.propose(state, attempt);
      const verified = await step.verify(state, after, attempt, chainTags(step.name, attempt));
      const ruled = rulingFor(verified, policy, opts.floor);
      // A cost that is not a non-negative number adds nothing rather than turning the total NaN.
      const spent: unknown = ruled.decision?.cost;
      if (typeof spent === "number" && Number.isFinite(spent) && spent >= 0) cost += spent;
      attempts.push({ attempt, ...ruled });
      if (ruled.ruling.action === "act") {
        state = after;
        checkpoints.push(after);
        committed = true;
        break;
      }
      if (ruled.ruling.action === "refuse") {
        refused = true;
        break;
      }
    }
    const t: StepTrace = { name: step.name, attempts, committed };
    trace.push(t);
    opts.onStep?.(t, state);
    if (!committed) {
      return {
        ok: false,
        state,
        checkpoints,
        trace,
        cost,
        stoppedAt: step.name,
        stopReason: refused ? "refused" : "exhausted",
      };
    }
  }
  return { ok: true, state, checkpoints, trace, cost };
}
