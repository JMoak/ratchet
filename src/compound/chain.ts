import { randomUUID } from "node:crypto";
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
 * What `chainTags` adds after its three tags when the chain knows more about the attempt. Every
 * field is optional; each one present adds one tag, in this order.
 */
export interface ChainTagContext {
  /** `chain:run:<id>`: one `runChain` call. */
  readonly run?: string;
  /** `chain:instance:<step>@<key of the state before the step>`: stable across attempts. */
  readonly instance?: string;
  /** `chain:candidate:<key of the candidate>`: pairs verdicts on one candidate, finds repeats. */
  readonly candidate?: string;
  /** `chain:holds:<n>`: distinct candidates of this step instance held back before this one. */
  readonly holds?: number;
  /** `chain:tier:<tier>`: which verifier asked; absent for the primary, `second` for a second opinion. */
  readonly tier?: string;
}

/**
 * The tags a chain step's verification should carry into the ledger: `chain`, the step's name
 * and the attempt number (1-based), e.g. `["chain", "chain:step:migrate", "chain:attempt:2"]`.
 * A retry exists only because the attempt before it was held back, so attempts after the first
 * are a selected sample; learning reads these tags to keep them out of unselected evidence.
 * `runChain` passes them to `verify` as its fourth argument; give them to the gate's ask.
 *
 * With `ChainOptions.keyOf`, `runChain` passes a context too, and the tags gain, after those
 * three and never instead of them, the run, the step instance, the candidate and the holds
 * before it (`ChainTagContext`): the cluster and the distinct-candidate count every frailty
 * estimator needs (`frailtyCounts`). A second opinion's ask also carries `chain:tier:second`.
 */
export function chainTags(stepName: string, attempt: number, context?: ChainTagContext): string[] {
  const tags = ["chain", `chain:step:${stepName}`, `chain:attempt:${attempt}`];
  if (context === undefined) return tags;
  if (context.run !== undefined) tags.push(`chain:run:${context.run}`);
  if (context.instance !== undefined) tags.push(`chain:instance:${context.instance}`);
  if (context.candidate !== undefined) tags.push(`chain:candidate:${context.candidate}`);
  if (context.holds !== undefined) tags.push(`chain:holds:${context.holds}`);
  if (context.tier !== undefined) tags.push(`chain:tier:${context.tier}`);
  return tags;
}

/** What a row's chain tags say, as `readChainTags` parses them. */
export interface ChainTagInfo extends ChainTagContext {
  readonly step?: string;
  readonly attempt?: number;
}

/**
 * The chain fields a row's tags carry (`chainTags`), or undefined for a row outside a chain (no
 * `chain` tag). The first tag of each kind wins, as in `chainAttempt`.
 */
export function readChainTags(tags: unknown): ChainTagInfo | undefined {
  if (!Array.isArray(tags) || !tags.includes("chain")) return undefined;
  const out: Record<string, string | number> = {};
  const fields: readonly (readonly [keyof ChainTagInfo, string, "text" | "count"])[] = [
    ["step", "chain:step:", "text"],
    ["attempt", "chain:attempt:", "count"],
    ["run", "chain:run:", "text"],
    ["instance", "chain:instance:", "text"],
    ["candidate", "chain:candidate:", "text"],
    ["holds", "chain:holds:", "count"],
    ["tier", "chain:tier:", "text"],
  ];
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    for (const [field, prefix, kind] of fields) {
      if (field in out || !tag.startsWith(prefix)) continue;
      const rest = tag.slice(prefix.length);
      if (kind === "text") out[field] = rest;
      else if (/^\d+$/.test(rest)) out[field] = Number(rest);
    }
  }
  return out as ChainTagInfo;
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
  /**
   * A finite integer of at least 1. Default 3, or no cap of its own when the chain has an
   * `attemptPool`; set explicitly, it caps the step under a pool too.
   */
  readonly maxAttempts?: number;
  /**
   * A second verifier, best of another model family, asked about a candidate only after `verify`
   * held it back: never before the primary, never after its act or its refuse. Its answer is
   * ruled like any verification (the chain's policy and floor, a gate's floors and one-way
   * doors), its tags add `chain:tier:second`, and `ChainOptions.secondOpinion` says what its
   * pass does. By default ("order") nothing: the step resamples as today, and if it exhausts,
   * `ChainResult.held` lists its held candidates best first by this verifier's probability that
   * the candidate achieved the step, for a person to review. A refuse from it stops the chain.
   * Do not show it the primary's verdict or reasons: correlated verifiers are the problem.
   */
  readonly secondOpinion?: (
    before: S,
    after: S,
    attempt: number,
    tags: readonly string[],
  ) => Promise<Verification>;
}

/** A verification as the chain ruled it. */
export interface Verified {
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

/** One verified attempt: the primary verifier's ruling, and the second opinion's when asked. */
export interface Attempt extends Verified {
  readonly attempt: number;
  /** The candidate's key, with `keyOf`. */
  readonly key?: string;
  /** Distinct candidates of this step held back before this one, with `keyOf`. */
  readonly holdsBefore?: number;
  /** The second opinion on a candidate the primary held back, when the step has one. */
  readonly second?: Verified;
}

/** A proposal whose key repeated an earlier candidate of the same step: not verified again. */
export interface DuplicateProposal {
  readonly attempt: number;
  readonly key: string;
  /** The attempt whose candidate it repeats. */
  readonly repeats: number;
}

/** A candidate the chain held back, kept so a person can review it. */
export interface HeldCandidate<S> {
  readonly step: string;
  readonly attempt: number;
  readonly candidate: S;
  /** The candidate's key, with `keyOf`. */
  readonly key?: string;
  /** The primary verifier's ruling, which held it back. */
  readonly ruling: Ruling;
  /** The second opinion's ruling, when one was asked. */
  readonly second?: Ruling;
}

export interface StepTrace<S = unknown> {
  readonly name: string;
  /** Verified attempts, in order. Duplicates are not verified and are listed apart. */
  readonly attempts: readonly Attempt[];
  readonly committed: boolean;
  /** With `keyOf`: the step instance, `<step>@<key of the state before it>`. */
  readonly instance?: string;
  /** With `keyOf`: proposals skipped as repeats; each used an attempt. */
  readonly duplicates?: readonly DuplicateProposal[];
  /** With `keepHeld`: every candidate the step held back, in attempt order. */
  readonly held?: readonly HeldCandidate<S>[];
  /** When the step has a second opinion and committed: which verifier's act committed it. */
  readonly committedBy?: "primary" | "second";
  /** With `attemptPool`: the attempts this step could use, its cap and the pool's reservation. */
  readonly allowance?: number;
}

export interface ChainResult<S> {
  readonly ok: boolean;
  /** The last committed state. Never an unverified proposal. */
  readonly state: S;
  readonly checkpoints: readonly S[];
  readonly trace: readonly StepTrace<S>[];
  readonly cost: number;
  readonly stoppedAt?: string;
  /**
   * `refused`: a verifier refused; `exhausted`: a step used its attempts without a commit;
   * `review`: a second opinion passed a held candidate in "route" mode, which a person should
   * review (`pending`) before the application resumes from the last checkpoint.
   */
  readonly stopReason?: "refused" | "exhausted" | "review";
  /** With `keyOf`: the run id in every row's `chain:run:` tag. */
  readonly runId?: string;
  /** With `attemptPool`: its size and the attempts used, duplicates included. */
  readonly pool?: { readonly size: number; readonly used: number };
  /**
   * On a stop, when the stopped step has a second opinion or `keepHeld` is set: the candidates
   * that step held back, best first by the second opinion's probability that the candidate
   * achieved the step (candidates it gave no usable probability for, such as a failed-open
   * answer, after the rest), else in attempt order. Nothing here was committed. An application
   * that puts them before a person, and resumes from `state` with one the person passes, keeps
   * every commit verified: the person's approval is the verification.
   */
  readonly held?: readonly HeldCandidate<S>[];
  /** On a `review` stop: the candidate a person should review. It is not in `held`. */
  readonly pending?: HeldCandidate<S>;
}

/**
 * What a second opinion's pass does:
 * - "order" (default): nothing at once. The step resamples; if it exhausts, its held candidates
 *   come back best first (`ChainResult.held`) for a person. Simulated under the fitted frailty,
 *   a person reviewing that queue on exhaustion finished 93.9% of eight-step chains at 99.96%
 *   commit precision with 0.80 reviews per chain, against 93.5% and 1.00 reviews unordered and
 *   49.2% with no person.
 * - "route": stop the chain for review (`stopReason: "review"`, `pending`) as soon as the second
 *   opinion passes a held candidate. Second best: 87.2% at 99.96% and 1.07 reviews per chain.
 * - "commit": the second opinion's pass commits. This releases on the second verifier alone, an
 *   OR rule on the pass side, so commit precision falls to the second verifier's catch rate: in
 *   simulation wrong commits rose about forty times (0.03% to 1.2%) at every correlation between
 *   the two verifiers. Its ruling goes through the same path as the primary's, so the chain's
 *   floor and its own gate's floors and one-way doors bind; and it may release only a hold the
 *   primary's judgement made, never one the primary gate's floor or one-way door made, nor a
 *   shadow gate's baseline or a blind audit (its ruling is bound by those too). Never use it on a
 *   step a one-way door guards.
 */
export type SecondOpinionMode = "order" | "route" | "commit";

export interface ChainOptions<S = unknown> {
  /** Hard floor applied to every verification ruling, e.g. from floors.ts. */
  readonly floor?: Action;
  readonly onStep?: (trace: StepTrace, state: unknown) => void;
  /**
   * A short, stable key for a state (a hash or an id), given by the caller because the state type
   * is the caller's. With it, each verification is tagged with the run, the step instance (the
   * step name and the key of the state before it), the candidate's key and the holds before it
   * (`chainTags`), and a proposal whose key repeats an earlier candidate of the same step is not
   * verified again: a cached verdict must not pose as new evidence (the live six-attempt arm
   * replayed verdicts for repeated candidates and so tested three, not six). A repeat still uses
   * an attempt, so a proposer that keeps returning the same bytes ends the step instead of
   * looping, and it counts as neither a hold nor a pass; it is listed in `StepTrace.duplicates`.
   */
  readonly keyOf?: (state: S) => string;
  /** The run id for `chain:run:` tags (default a random UUID). Unique per run. Used with `keyOf`. */
  readonly runId?: string;
  /**
   * One attempt budget for the whole chain, replacing the per-step default of 3. A step may keep
   * trying while the pool lasts but must leave one attempt for each step still to come: step s
   * of n may use min(its `maxAttempts`, left - (n - s - 1)) attempts. That reservation is
   * lossless: a step that dipped into it would leave a later step with nothing, so the chain was
   * lost anyway; it only stops spending on lost chains. A finite integer of at least the number
   * of steps. Every proposal uses one, duplicates included; second opinions use none. Simulated
   * under the fitted frailty, 24 attempts pooled over eight steps finished 84.8% of chains
   * against 49.8% at three per step, the same worst-case spend.
   */
  readonly attemptPool?: number;
  /** What a second opinion's pass does (`SecondOpinionMode`). Default "order". */
  readonly secondOpinion?: SecondOpinionMode;
  /** Keep every held candidate on its step's trace (`StepTrace.held`). They can be large. */
  readonly keepHeld?: boolean;
}

const DEFAULT_ATTEMPTS = 3;

/**
 * A step's attempt cap, checked before anything runs: a finite integer of at least 1. Under a
 * pool a step without `maxAttempts` has no cap of its own.
 */
function capOf(step: Step<unknown>, pooled: boolean): number {
  if (step.secondOpinion !== undefined && typeof step.secondOpinion !== "function") {
    throw new Error(`step ${step.name}: secondOpinion must be a function`);
  }
  if (step.maxAttempts === undefined && pooled) return Number.POSITIVE_INFINITY;
  const max = step.maxAttempts ?? DEFAULT_ATTEMPTS;
  if (!(Number.isInteger(max) && max >= 1)) {
    throw new Error(
      `step ${step.name}: maxAttempts must be a finite integer of at least 1, not ${String(max)}`,
    );
  }
  return max;
}

/** The pool, checked before anything runs: a finite integer that gives every step an attempt. */
function poolOf(pool: unknown, steps: number): number | undefined {
  if (pool === undefined) return undefined;
  if (!(typeof pool === "number" && Number.isInteger(pool) && pool >= 1)) {
    throw new Error(`attemptPool must be a finite integer of at least 1, not ${String(pool)}`);
  }
  if (pool < steps) {
    throw new Error(`attemptPool ${pool} cannot give each of ${steps} steps an attempt`);
  }
  return pool;
}

function modeOf(mode: unknown): SecondOpinionMode {
  if (mode === undefined) return "order";
  if (mode === "order" || mode === "route" || mode === "commit") return mode;
  throw new Error(`secondOpinion must be "order", "route" or "commit", not ${show(mode)}`);
}

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
function rulingFor(v: Verification, policy: GatePolicy, floor: Action | undefined): Verified {
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
 * What a commit-mode second opinion may not release, read from the primary's answer: a gate's
 * floor in every mode (a review floor or a one-way door held the candidate whatever anyone
 * judged), and in shadow, an unreadable mode or on a blind audit the gate's action as well (a
 * shadow gate's baseline says what the application does anyway; an audited act is held for a
 * person). What remains releasable is a hold the primary's judgement made. A bare decision
 * carries no constraint beyond the chain's floor, which binds the second opinion anyway.
 */
function releaseCeiling(v: Verification): Action {
  if (!isGateVerification(v)) return "act";
  const floor = gateFloorOf(v);
  if (v.mode === "enforce" && v.audited !== true) return floor;
  return moreCautious(readAction(v.action), floor);
}

/** A cost that is not a non-negative number adds nothing rather than turning the total NaN. */
function spentOn(v: Verified): number {
  const spent: unknown = v.decision?.cost;
  return typeof spent === "number" && Number.isFinite(spent) && spent >= 0 ? spent : 0;
}

/**
 * The second opinion's probability that the candidate achieved the step, or undefined when it gave
 * none to rank by (failed open, or a go that is not a probability).
 */
function scoreOf(c: HeldCandidate<unknown>): number | undefined {
  const go = c.second?.go;
  return typeof go === "number" && go >= 0 && go <= 1 ? go : undefined;
}

/** Best first by the second opinion; unscored after scored; ties and the unscored by attempt. */
function bestFirst<S>(
  held: readonly HeldCandidate<S>[],
  failed: ReadonlySet<number>,
): HeldCandidate<S>[] {
  const score = (c: HeldCandidate<S>) => (failed.has(c.attempt) ? undefined : scoreOf(c));
  return [...held].sort((x, y) => {
    const sx = score(x);
    const sy = score(y);
    if (sx !== undefined && sy !== undefined && sx !== sy) return sy - sx;
    if (sx === undefined && sy !== undefined) return 1;
    if (sx !== undefined && sy === undefined) return -1;
    return x.attempt - y.attempt;
  });
}

/**
 * The ratchet. A chain of n steps that are each right with probability p succeeds p^n of the
 * time if nothing checks the work: at 0.8, ten steps succeed one time in nine. Verifying each
 * step and committing only verified progress changes what a committed step is worth: with
 * catch rate t and false-alarm rate f, a committed step is right with probability
 * q = p(1 - f) / (p(1 - f) + (1 - p)(1 - t)). That is the precision of commits, so a chain that
 * finishes is right about q^n of the time (live: 1,132 of 1,132 committed steps right).
 *
 * It does not say how often a chain finishes. With independent attempts a step would commit
 * within m attempts with probability 1 - (1 - a)^m, a = p(1 - f) + (1 - p)(1 - t), but that is
 * the optimistic end, not a prediction: a verifier that dislikes a step instance tends to
 * dislike every fresh correct answer to it (coincident failure). Live, after a correct candidate
 * was held back the next correct one for the same step was held back 55.9% of the time against a
 * 15.0% base rate, and chains finished 48% to 62% of the time where independence at that rate
 * said 76.6% to 97.3% (the evaluation's own 74% to 99.8% took the held-out 16.7% false-alarm
 * rate and counted replayed candidates as fresh ones). A beta frailty on each step instance's
 * false-alarm propensity, fitted from those two rates (`frailtyFromRates`, or `fitFrailty` on
 * counts from `frailtyCounts`), predicts 49.2% to 61.5% (`predictChain`). The two rates alone
 * bound completion to an interval (`completionInterval`); its optimistic end is the two-point
 * law the simulation used to show, and its pessimistic end certifies no more than about 52% at
 * those rates however many retries are allowed. Exhaustion falls as a power law in the
 * attempts, not geometrically, so open-ended retrying has unbounded expected cost: keep budgets
 * finite, and pool them (`attemptPool`).
 * Completion is a measured quantity with a model that predicts it: count it from run summaries
 * (`summarizeChain`), and fit the frailty from rows tagged with `keyOf`.
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
 * step retries. Pass the fourth argument to `verify`, `chainTags(step, attempt)`, as the ask's
 * tags, so each row says which step and attempt it verified.
 *
 * Options, each off by default: `keyOf` tags the run, step instance, candidate and holds and
 * skips repeated candidates; `attemptPool` shares one budget across the steps; a step's
 * `secondOpinion` asks a second verifier about held candidates, to order a person's queue
 * (default), route a candidate to a person, or, at a measured cost, commit; `keepHeld` keeps
 * held candidates on the trace. In every mode the committed state is a candidate some verifier
 * ruled act on. The chain never treats a person's verdict: that is the application's, resuming
 * from the last checkpoint. Nothing here writes to a ledger; a gate verifier's asks do.
 */
export async function runChain<S>(
  initial: S,
  steps: readonly Step<S>[],
  policy: GatePolicy,
  opts: ChainOptions<S> = {},
): Promise<ChainResult<S>> {
  const pooled = opts.attemptPool !== undefined;
  const caps = steps.map((step) => capOf(step as Step<unknown>, pooled));
  const pool = poolOf(opts.attemptPool, steps.length);
  const mode = modeOf(opts.secondOpinion);
  const keyOf = opts.keyOf;
  if (keyOf !== undefined && typeof keyOf !== "function") {
    throw new Error("keyOf must be a function from a state to a string");
  }
  if (opts.runId !== undefined && !(typeof opts.runId === "string" && opts.runId !== "")) {
    throw new Error(`runId must be a non-empty string, not ${show(opts.runId)}`);
  }
  const runId = keyOf === undefined ? undefined : (opts.runId ?? randomUUID());
  const keyFor = (s: S): string => {
    const k: unknown = (keyOf as (state: S) => string)(s);
    if (typeof k !== "string") throw new Error(`keyOf must return a string, not ${show(k)}`);
    return k;
  };
  let state = initial;
  const checkpoints: S[] = [initial];
  const trace: StepTrace<S>[] = [];
  let cost = 0;
  let left = pool;
  const extras = runId !== undefined ? { runId } : {};
  const poolNow = () =>
    pool === undefined ? {} : { pool: { size: pool, used: pool - (left as number) } };
  for (const [i, step] of steps.entries()) {
    const cap = caps[i] as number;
    const allowance = left === undefined ? cap : Math.min(cap, left - (steps.length - i - 1));
    const instance = keyOf === undefined ? undefined : `${step.name}@${keyFor(state)}`;
    const second = step.secondOpinion;
    const queue = opts.keepHeld === true || second !== undefined;
    const attempts: Attempt[] = [];
    const duplicates: DuplicateProposal[] = [];
    const held: HeldCandidate<S>[] = [];
    // Held candidates whose second opinion failed open: no probability to rank them by.
    const unscored = new Set<number>();
    const seen = new Map<string, number>();
    let holds = 0;
    let used = 0;
    let outcome: "committed" | "refused" | "exhausted" | "review" = "exhausted";
    let committedBy: "primary" | "second" = "primary";
    let pending: HeldCandidate<S> | undefined;
    for (let attempt = 1; used < allowance; attempt++) {
      used++;
      const after = await step.propose(state, attempt);
      let key: string | undefined;
      if (keyOf !== undefined) {
        key = keyFor(after);
        const repeats = seen.get(key);
        if (repeats !== undefined) {
          duplicates.push({ attempt, key, repeats });
          continue;
        }
        seen.set(key, attempt);
      }
      const context: ChainTagContext | undefined =
        key === undefined || runId === undefined || instance === undefined
          ? undefined
          : { run: runId, instance, candidate: key, holds };
      const answer = await step.verify(
        state,
        after,
        attempt,
        chainTags(step.name, attempt, context),
      );
      const ruled = rulingFor(answer, policy, opts.floor);
      cost += spentOn(ruled);
      const base: Attempt = {
        attempt,
        ...ruled,
        ...(key !== undefined ? { key, holdsBefore: holds } : {}),
      };
      if (ruled.ruling.action === "act") {
        attempts.push(base);
        outcome = "committed";
        state = after;
        checkpoints.push(after);
        break;
      }
      if (ruled.ruling.action === "refuse") {
        attempts.push(base);
        outcome = "refused";
        break;
      }
      // The primary held the candidate back: only now may a second opinion be asked. In commit
      // mode its ruling is also bound by what held the candidate besides the primary's judgement.
      let other: Verified | undefined;
      if (second !== undefined) {
        const ceiling = mode === "commit" ? releaseCeiling(answer) : "act";
        const bound =
          ceiling === "act" ? opts.floor : moreCautious(readAction(opts.floor ?? "act"), ceiling);
        other = rulingFor(
          await second(
            state,
            after,
            attempt,
            chainTags(step.name, attempt, { ...context, tier: "second" }),
          ),
          policy,
          bound,
        );
        cost += spentOn(other);
        if (other.decision?.failedOpen === true) unscored.add(attempt);
      }
      attempts.push(other === undefined ? base : { ...base, second: other });
      const candidate: HeldCandidate<S> = {
        step: step.name,
        attempt,
        candidate: after,
        ...(key !== undefined ? { key } : {}),
        ruling: ruled.ruling,
        ...(other !== undefined ? { second: other.ruling } : {}),
      };
      if (other?.ruling.action === "refuse") {
        outcome = "refused";
        break;
      }
      if (other?.ruling.action === "act" && mode === "commit") {
        outcome = "committed";
        committedBy = "second";
        state = after;
        checkpoints.push(after);
        break;
      }
      if (other?.ruling.action === "act" && mode === "route") {
        outcome = "review";
        pending = candidate;
        break;
      }
      holds++;
      if (queue) held.push(candidate);
    }
    if (left !== undefined) left -= used;
    const committed = outcome === "committed";
    const t: StepTrace<S> = {
      name: step.name,
      attempts,
      committed,
      ...(instance !== undefined ? { instance, duplicates } : {}),
      ...(opts.keepHeld === true ? { held } : {}),
      ...(committed && second !== undefined ? { committedBy } : {}),
      ...(pool !== undefined ? { allowance } : {}),
    };
    trace.push(t);
    opts.onStep?.(t, state);
    if (outcome !== "committed") {
      return {
        ok: false,
        state,
        checkpoints,
        trace,
        cost,
        stoppedAt: step.name,
        stopReason: outcome,
        ...extras,
        ...poolNow(),
        ...(queue ? { held: second !== undefined ? bestFirst(held, unscored) : held } : {}),
        ...(pending !== undefined ? { pending } : {}),
      };
    }
  }
  return { ok: true, state, checkpoints, trace, cost, ...extras, ...poolNow() };
}

/** One step of a run, as plain data. */
export interface StepSummary {
  readonly name: string;
  readonly instance?: string;
  /** Proposals: attempts used, duplicates included. */
  readonly proposals: number;
  /** Proposals the primary verifier judged. */
  readonly verified: number;
  /** Candidates the primary verifier held back. */
  readonly holds: number;
  readonly duplicates: number;
  readonly committed: boolean;
  readonly committedBy?: "primary" | "second";
  /** With a pool: the attempts this step could use. */
  readonly allowance?: number;
  /** With a second opinion: how often it was asked and what it ruled. */
  readonly secondOpinions?: {
    readonly asked: number;
    readonly act: number;
    readonly review: number;
    readonly refuse: number;
  };
}

/** A run as plain data, for an application to persist (`summarizeChain`). */
export interface ChainSummary {
  readonly outcome: "ok" | "refused" | "exhausted" | "review";
  readonly stoppedAt?: string;
  readonly runId?: string;
  readonly steps: readonly StepSummary[];
  /** Steps committed. */
  readonly committed: number;
  readonly proposals: number;
  readonly cost: number;
  readonly pool?: { readonly size: number; readonly used: number };
  /** Candidates held for a person on the stop (`ChainResult.held`). */
  readonly held?: number;
  /** On a `review` stop: the step and attempt of the candidate a person should review. */
  readonly pending?: { readonly step: string; readonly attempt: number; readonly key?: string };
}

/**
 * A run as plain data (strings and numbers, no states): the outcome, where it stopped, attempts,
 * holds and duplicates per step, and the second opinions asked and what they said. Completion
 * and per-step exhaustion are counted from these, with intervals, rather than computed; this
 * writes nothing anywhere, so persisting it is the application's.
 */
export function summarizeChain(result: ChainResult<unknown>): ChainSummary {
  const steps = result.trace.map((t): StepSummary => {
    const duplicates = t.duplicates?.length ?? 0;
    const asked = t.attempts.filter((a) => a.second !== undefined);
    const said = (action: Action) => asked.filter((a) => a.second?.ruling.action === action).length;
    return {
      name: t.name,
      ...(t.instance !== undefined ? { instance: t.instance } : {}),
      proposals: t.attempts.length + duplicates,
      verified: t.attempts.length,
      holds: t.attempts.filter((a) => a.ruling.action === "review").length,
      duplicates,
      committed: t.committed,
      ...(t.committedBy !== undefined ? { committedBy: t.committedBy } : {}),
      ...(t.allowance !== undefined ? { allowance: t.allowance } : {}),
      ...(asked.length > 0
        ? {
            secondOpinions: {
              asked: asked.length,
              act: said("act"),
              review: said("review"),
              refuse: said("refuse"),
            },
          }
        : {}),
    };
  });
  return {
    outcome: result.ok ? "ok" : (result.stopReason ?? "exhausted"),
    ...(result.stoppedAt !== undefined ? { stoppedAt: result.stoppedAt } : {}),
    ...(result.runId !== undefined ? { runId: result.runId } : {}),
    steps,
    committed: steps.filter((s) => s.committed).length,
    proposals: steps.reduce((n, s) => n + s.proposals, 0),
    cost: result.cost,
    ...(result.pool !== undefined ? { pool: result.pool } : {}),
    ...(result.held !== undefined ? { held: result.held.length } : {}),
    ...(result.pending !== undefined
      ? {
          pending: {
            step: result.pending.step,
            attempt: result.pending.attempt,
            ...(result.pending.key !== undefined ? { key: result.pending.key } : {}),
          },
        }
      : {}),
  };
}
