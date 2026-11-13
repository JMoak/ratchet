import { type PoolOptions, pool as poolVerdicts } from "./compound/aggregate.ts";
import { type CascadeOptions, cascade } from "./compound/cascade.ts";
import {
  type CompoundDecision,
  compoundOf,
  isCompound,
  memberKey,
  single,
} from "./compound/compound.ts";
import { ensemble, type Member, replicate } from "./compound/ensemble.ts";
import { sequential } from "./compound/sequential.ts";
import { type BypassRule, bypassFor, evaluateFloors, type FloorRule } from "./floors.ts";
import {
  checkRuleScopes,
  type Gate,
  GateImpl,
  type GateQuestion,
  type GateSpec,
  type GateVerdict,
} from "./gate.ts";
import { type ActBar, type BatteryReadout, gateEvidence } from "./ledger/bars.ts";
import { parseProfile } from "./ledger/borrow.ts";
import {
  brier,
  ece,
  expectedAccuracy,
  modelFamily,
  type ReliabilityBin,
  reliability,
  scoredFromLedger,
  shadowAgreement,
} from "./ledger/calibration.ts";
import { currentConfiguration, type EvidenceGrade, type ReportLevers } from "./ledger/evidence.ts";
import {
  type CostBasis,
  type CostEstimate,
  type DecisionRecord,
  decisionRows,
  hashQuestion,
  hashState,
  inheritOutcome,
  isMemberOf,
  isValidCost,
  type Ledger,
  type MemberRecord,
  MemoryLedger,
  type Mode,
  newRecordId,
  newRequestId,
  type Outcome,
  settledWithoutAnswer,
} from "./ledger/ledger.ts";
import type { CalibrationProfile } from "./ledger/profile.ts";
import {
  COUNTED_SOURCES,
  type TrustClass,
  type TrustRegistry,
  trustRegistry,
} from "./ledger/sources.ts";
import { clamp, mean, type Rand, rng } from "./math.ts";
import { type FailOpenOptions, failOpen } from "./oracles/oracle.ts";
import { type GatePolicy, goProbability, hashPolicy, type Ruling, rule } from "./policy.ts";
import { isProbability, judgeVerdictFrom, neutralVerdict } from "./questions.ts";
import { DailySpend, type SpendSnapshot } from "./spend.ts";
import type {
  Action,
  Decision,
  JudgeQuestion,
  JudgeVerdict,
  Oracle,
  Question,
  StateInput,
  StateLike,
  Verdict,
  VerdictFor,
} from "./types.ts";

/**
 * How a question is asked. For `ensemble` and `sequential`, an unstated `correlation` defaults
 * by who the voters are, not by how they were spelled (e2e T5-01): two voters that share an
 * oracle id or a model pin (an oracle's `model`, or the model their answers recorded) are
 * replicas and count at 0.75, the error correlation paraphrases of one question showed on
 * BoolQ; two that share neither count at 0. The pool reads the mean over pairs, which is
 * exact for the design effect of an unweighted log-odds sum. The row's `detail.rhoSource` says
 * which applied: `caller`, `default-replica`, `default-mixed` or `default-independent`.
 * Measure it from the ledger (`memberCorrelation`) and state it once you have.
 */
export type StrategySpec =
  | "single"
  | {
      readonly ensemble: PoolOptions & {
        /** Replicate the engine's default oracle k times with shuffled options. */
        readonly k?: number;
        readonly frames?: readonly ((prompt: string) => string)[];
        /** Or supply explicit members (other oracles, other transforms). */
        readonly members?: readonly Member[];
        /** Answers needed to pool; with fewer the ensemble fails open. Default: every member. */
        readonly minMembers?: number;
      };
    }
  | { readonly cascade: CascadeOptions }
  | {
      readonly sequential: PoolOptions & {
        readonly k?: number;
        readonly members?: readonly Member[];
        readonly settleAbove: number;
        /** Or stop once the leading answer is this many independent votes ahead. */
        readonly settleLead?: number;
        readonly maxSamples: number;
        /**
         * Samples that may fail open before the run ends neutral and failed open. Default 0: a
         * failed cautious member never leaves a bold one to act alone (`sequential`).
         */
        readonly maxFailedSamples?: number;
        readonly minSamples?: number;
      };
    };

export interface EngineOptions {
  /**
   * Fraction of enforce-mode "act" rulings that are blind-audited: sent to review anyway,
   * chosen at random within acts, and tagged "audit". This monitors the acted population;
   * it cannot establish performance below the existing action bar. It also keeps reviewers
   * seeing easy cases, which the
   * human-factors literature says is what keeps them able to catch the hard ones.
   * Gates may set their own rate.
   */
  readonly auditRate?: number;
  readonly seed?: number;
  /**
   * Spend cutoff in USD for this engine instance, based on completed, recorded requests.
   * Once reached, new asks fail open into the policy's onFailOpen action (review by default).
   * Requests already in flight can exceed it; costs are known afterward. Within one request, a
   * sequential run or a cascade stops buying once the cap is spent partway through it; an
   * ensemble's members start together, so they can exceed it by up to their own cost.
   * It starts at zero with every process; `dailyBudgetUsd` is the cap a restart cannot reset.
   * A cost that is unknown (a timeout) or not a finite non-negative number is counted at the
   * larger of `reserveUsd` and the costliest request on record, never as free; with neither,
   * the instance stops buying until a priced request gives it a price (`costEstimate`).
   */
  readonly budgetUsd?: number;
  /**
   * Spend cutoff in USD per UTC day, read from the ledger, so restarting the process does not
   * reset it. Each request reserves `reserveUsd` while it is in flight, so concurrent asks
   * cannot all slip under the cap together. A recorded-spend cutoff, not a prepaid budget:
   * see `DailySpend` for what it cannot promise.
   */
  readonly dailyBudgetUsd?: number;
  /**
   * Reserved per request in flight against `dailyBudgetUsd`. Default: the costliest request the
   * ledger records. Also the least a request whose cost is unknown is charged, under either cap;
   * set it to price a timeout on a fresh ledger.
   */
  readonly reserveUsd?: number;
  /** The default oracle. Wrapped to fail open. */
  readonly oracle: Oracle;
  readonly ledger?: Ledger;
  /**
   * Start in shadow: decide, record, change nothing. Flip to enforce when the ledger says so.
   * This is the default for every gate that does not set its own mode.
   */
  readonly mode?: Mode;
  /** Hard rules that bound every ruling from below, for every gate. */
  readonly floors?: readonly FloorRule[];
  /** Allowlist rules: matching judge questions are answered yes at full confidence without a call. */
  readonly bypass?: readonly BypassRule[];
  /** Store the raw state in the ledger (default: only a hash). */
  readonly keepState?: boolean;
  readonly timeoutMs?: number;
  readonly tags?: readonly string[];
  /**
   * Trust classes for label sources, laid over `DEFAULT_TRUST` and keyed by `<channel>:<kind>`
   * or `<channel>:*`. Reports, fits and every gate's acceptance test read labels through it:
   * only blind, census and unsourced labels fit a bar or feed acceptance, and consequence
   * labels are counted on their own. Reclassifying a source changes a gate's evidence, so
   * bump its `evidenceVersion` when you do.
   */
  readonly labelTrust?: Readonly<Record<string, TrustClass>>;
  /**
   * Calibration profiles a report may borrow a bar from, shadow only (`borrowFor`). A gate whose
   * own labels do not yet grade it estimated or measured is graded borrowed from the first one
   * that matches its model pin
   * (its rollout's pinned model, else the model its newest answered row recorded), question
   * kind and rubric; a gate whose spec names a `barSource` reads only that profile, and reads it
   * as stale once the gate has moved off its key. Each is checked as `parseProfile` checks a
   * file. Without profiles nothing is borrowed.
   */
  readonly profiles?: readonly CalibrationProfile[];
}

export interface AskOptions {
  readonly policy: GatePolicy;
  /** Caller-owned configuration version required for rollout evidence. */
  readonly evidenceVersion?: string;
  readonly strategy?: StrategySpec;
  /** In shadow mode, what the application is doing anyway. Recorded for agreement. Default review. */
  readonly baseline?: Action;
  readonly tags?: readonly string[];
}

export interface AskResult<V extends Verdict = Verdict> {
  readonly recordId: string;
  /** Shared by every row this request produced; label by `recordId`, group by this. */
  readonly requestId: string;
  readonly gateId: string;
  readonly decision: CompoundDecision<V>;
  readonly ruling: Ruling;
  /** Do this now. In shadow mode it is the baseline; in enforce mode it is the ruling. */
  readonly action: Action;
  readonly mode: Mode;
  /** True when this act was diverted to review as a blind audit. */
  readonly audited: boolean;
}

/**
 * Anything that asks typed questions about one state through the engine's machinery, so
 * every answer is ledgered, budgeted, floored and auditable. `Engine` and `Gate` implement
 * it; the recipes take one instead of a raw oracle. The options are honoured as given: the
 * caller's policy and strategy rule each question, whoever the asker is.
 */
export interface Asker {
  askAll(
    state: StateInput,
    questions: readonly Question[],
    opts: AskOptions | ((q: Question) => AskOptions),
  ): Promise<AskResult[]>;
}

/** The levers a report reads a gate with; every default is `REPORT_DEFAULTS`, as in the CLI. */
export interface ReportOptions {
  /**
   * Accuracy acting above the fitted bar must deliver, and the promise a gate's planned sample
   * is read against for a measured grade (zero wrong acts, 95% confidence). Default 0.98.
   */
  readonly targetAccuracy?: number;
  /** Labelled rows the bar needs at or above it. Default 30. */
  readonly minSupport?: number;
  /** Labelled unselected rows of the current configuration an estimated grade needs. Default 30. */
  readonly minEstimated?: number;
}

/**
 * Calibration figures read only rows an answer was bought for. Rows a floor or a bypass
 * settled carry placeholder confidences (0 and 1) that no oracle stated, so they count in `n`
 * and nowhere else. Accuracy, Brier and ECE are of the leading answer, over every labelled
 * row; the act bar (`fitted`) and the grade read only the current configuration's rows (its
 * policy, rubric and evidence version).
 */
export interface QuestionReport extends ActBar {
  readonly n: number;
  /**
   * Of `n`, rows recorded under an older configuration (policy, rubric or evidence version;
   * `currentConfiguration`). No count or figure below reads them but `unregistered`.
   */
  readonly older: number;
  /**
   * Labelled answers of the current configuration, of every trust class but consequence;
   * accuracy, Brier and ECE read these.
   */
  readonly labelled: number;
  readonly accuracy?: number;
  readonly brier?: number;
  readonly ece?: number;
  /** Labelled shadow/audit rows of trusted sources; audits represent only the acted population. */
  readonly unselected: number;
  /** Labelled answers inferred from what happened next: counted here, read by nothing else. */
  readonly consequence: number;
  /**
   * Labelled answers whose source is present but malformed or unregistered: counted so a typo
   * in a source cannot make labels vanish silently, read by nothing else (e2e T4-09).
   */
  readonly unregistered: number;
  /** Label-free estimate: mean stated confidence. Its gap from `accuracy` is miscalibration. */
  readonly expectedAccuracy?: number;
  /*
   * From `ActBar`: `fitted` is the act bar, the one to put in a policy's `actAbove`. It is
   * fitted on the probability that acting is right (for a judge gate, p(yes) or 1 - p(yes) by
   * the side its policy acts on) against whether acting was right, and conservatively: the 95%
   * lower end of the 95% Wilson interval (a one-sided 97.5% bound) of acting right above it
   * reaches `targetAccuracy`. `pointFitted` is the
   * point estimate's bar, for reading only. `fittedFrom` and `fitRows` say which rows were
   * fitted; a fit source is not a guarantee of representative labels.
   */
  /**
   * What kind of evidence stands behind these figures (`gradeOf`). A gate's decision rows can
   * grade measured, against `targetAccuracy`; a battery member's rows are features of their
   * battery's decision, so they grade no better than estimated. Per gate, a matching profile
   * from `EngineOptions.profiles` grades it borrowed until its own labels grade it estimated.
   */
  readonly grade: EvidenceGrade;
  /** The levers the bar and the grade were read with, defaults filled. */
  readonly levers: ReportLevers;
  /** On a battery gate: how often its pooled verdicts saturate (`describeBattery`). */
  readonly battery?: BatteryReadout;
}

export interface Report {
  /** Every ledger row, battery members included. */
  readonly records: number;
  /**
   * The figures from here to `reliability` are over decision rows (battery members excluded);
   * `labelled`, `brier`, `ece` and `reliability` also skip rows a floor or bypass settled.
   */
  readonly labelled: number;
  /** Decision rows labelled from a consequence source, kept out of `labelled` and every figure. */
  readonly consequence: number;
  /** Decision rows labelled from a malformed or unregistered source, also kept out. */
  readonly unregistered: number;
  readonly failedOpen: number;
  /** Spend over every row. A battery's members carry its cost; its combined row carries 0. */
  readonly cost: number;
  readonly meanLatencyMs: number;
  readonly shadowAgreement: number;
  readonly brier?: number;
  readonly ece?: number;
  readonly reliability?: readonly ReliabilityBin[];
  /**
   * Per question id over every row, so each battery member is calibrated against its own truth
   * when the battery's label gave one (`Outcome.memberTruths`), else against the battery's.
   */
  readonly byQuestion: Readonly<Record<string, QuestionReport>>;
  /** Per gate id over its decision rows: a battery's combined rows, every other gate's rows. */
  readonly byGate: Readonly<Record<string, QuestionReport>>;
}

/**
 * What a gate contributes to one request: its id, mode, audit rate, floors, bypasses and tags.
 * The question and the policy travel separately, in a `Lane`. Internal to the engine and
 * `gate.ts`; not part of the public surface.
 */
export interface GateContext {
  readonly id: string;
  readonly mode: Mode;
  readonly auditRate: number;
  readonly floors: readonly FloorRule[];
  readonly bypass: readonly BypassRule[];
  readonly tags: readonly string[];
  /** The profile the gate's bar was borrowed from, written into every row's detail. */
  readonly barSource?: { readonly profileHash: string };
}

/** One question in a request, the gate it belongs to, and how to rule on it. Internal. */
export interface Lane {
  readonly gate: GateContext;
  readonly question: Question;
  readonly opts: AskOptions;
}

/** A battery as the engine runs it: members asked in one request, combined into one verdict. Internal. */
export interface BatteryPlan {
  /** The combined judge question, id = gate id. Floors and bypasses see this one. */
  readonly question: JudgeQuestion;
  readonly members: readonly JudgeQuestion[];
  readonly combine: (verdicts: readonly JudgeVerdict[]) => JudgeVerdict;
  /** Hash of the members and the combiner: the battery's rubric version. */
  readonly questionHash: string;
  /** "logodds", "max", "learned", "function", ... kept in the decision's detail. */
  readonly method: string;
}

/**
 * Wrap a plain string as a state of one trusted field: the text is the string, both hashes
 * are its hash, and nothing is untrusted. It carries no `fields`, so entry floors read it as
 * having no entries (and fail closed), and no `trustedText`, which means its trusted text is the
 * string itself, so bypasses read it as before. Built states pass through unchanged.
 */
export function asStateLike(input: StateInput): StateLike {
  if (typeof input !== "string") return input;
  const hash = hashState(input);
  return { text: input, hash, trustedHash: hash, untrusted: [] };
}

/**
 * True when the oracle (or a bypass rule) actually answered: not failed open, not settled by
 * a floor without a call. A recipe reads a choice only from an answered result.
 */
export function wasAnswered(r: AskResult): boolean {
  return r.decision.failedOpen !== true && r.decision.strategy !== "floored";
}

interface Settled {
  readonly mode: Mode;
  /** The ruling's action, floors applied: what the engine recommends. */
  readonly soft: Action;
  readonly action: Action;
  readonly tags: readonly string[];
  readonly audited: boolean;
  /** The floor the ruling was bounded by, when one applied. */
  readonly floor?: Action;
  /** On an enforce-mode act, drawn or not: the chance the audit draw sent it to review. */
  readonly auditProbability?: number;
}

/** What floors and bypasses settled before any answer is bought. */
interface Preempted {
  readonly floor: Action;
  readonly decision: CompoundDecision | undefined;
  /** Floors that threw or answered outside the vocabulary; kept on the row as its `error`. */
  readonly floorError?: string;
}

interface Planned {
  readonly lane: Lane;
  readonly floor: Action;
  readonly floorError?: string;
  decision: CompoundDecision | undefined;
}

/** Which cap refused a request: the instance's own, or the day's read from the ledger. */
type BudgetKind = "instance" | "daily";

/** A request's permission to buy answers, and the reservation it gives back afterwards. */
interface Admission {
  /** Set when the request may not call an oracle. */
  readonly refused: BudgetKind | undefined;
  readonly release: (requestCostUsd: number) => void;
}

const ADMITTED: Admission = { refused: undefined, release: () => {} };

/** Strategies whose rows need no member trail: one answer, no answer, or members that are rows. */
const UNTRAILED: ReadonlySet<string> = new Set(["single", "floored", "bypass", "battery"]);

const memberRecord = (d: Decision, key: string, settled: boolean): MemberRecord => ({
  key,
  oracle: d.oracle,
  ...(d.model !== undefined ? { model: d.model } : {}),
  verdict: d.verdict,
  cost: d.cost,
  latencyMs: d.latencyMs,
  ...(d.failedOpen === true ? { failedOpen: true as const } : {}),
  ...(d.error !== undefined ? { error: d.error } : {}),
  ...(settled ? { settled: true as const } : {}),
});

/** The member whose answer settled the run, by the strategy's own account of it. */
function settlingMember(d: CompoundDecision): number | undefined {
  if (d.strategy === "cascade" && typeof d.detail.tier === "number") return d.detail.tier;
  if (d.strategy === "sequential" && d.detail.settled === true) return d.members.length - 1;
  return undefined;
}

/**
 * The part of a compound decision that is otherwise lost at the row: each member's answer
 * and the strategy's account of how it settled. Kept so the path to a verdict can be read
 * back from the ledger alone and member error correlation measured from it.
 */
function trailOf(d: CompoundDecision): Pick<DecisionRecord, "members" | "detail"> {
  const at = settlingMember(d);
  const members = UNTRAILED.has(d.strategy)
    ? {}
    : {
        members: d.members.map((m, i) =>
          memberRecord(m, d.memberKeys?.[i] ?? memberKey(m.oracle, i), i === at),
        ),
      };
  // A floor's or a bypass's detail only repeats its strategy; a battery's names its combiner
  // and an exhausted budget's says which budget, so those are worth the bytes.
  const skipDetail =
    d.strategy === "floored" || d.strategy === "bypass" || Object.keys(d.detail).length === 0;
  return { ...members, ...(skipDetail ? {} : { detail: d.detail }) };
}

/**
 * A gate whose bar was borrowed from a profile says so on every row it writes, so replay and
 * reports can tell borrowed traffic from fitted and notice when the gate outlives the profile.
 * A single, floored or bypass row carries no detail otherwise and gains one only for this.
 */
function sourced(
  trail: Pick<DecisionRecord, "members" | "detail">,
  barSource: { readonly profileHash: string } | undefined,
): Pick<DecisionRecord, "members" | "detail"> {
  if (barSource === undefined) return trail;
  const detail = { ...trail.detail, barSource: { profileHash: barSource.profileHash } };
  return { ...trail, detail };
}

const refused = (budget: BudgetKind): Admission => ({ refused: budget, release: () => {} });

/**
 * Set `key` as an own, enumerable property, whatever it is. A plain assignment of `__proto__`
 * sets the object's prototype instead, so a gate or question with that id vanished from a
 * report keyed by id (e2e T4-18).
 */
function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Why a decision's reported cost cannot be counted as given, or undefined when it can: the call
 * timed out and may still be billed (`costUnknown`), or the cost reported, by the decision or by
 * one of its members, is not a finite non-negative number (e2e T4-05, T4-06).
 */
function costProblem(d: Decision): string | undefined {
  if (d.costUnknown === true) {
    return d.error !== undefined ? `cost unknown: ${d.error}` : "cost unknown";
  }
  if (!isValidCost(d.cost)) {
    return `reported cost ${String(d.cost)} is not a finite non-negative number`;
  }
  if (isCompound(d)) {
    for (const m of d.members) {
      const p = m === d ? undefined : costProblem(m);
      if (p !== undefined) return p;
    }
  }
  return undefined;
}

/** The part of a decision's cost that was reported validly; members are summed when any is not. */
function knownCost(d: Decision): number {
  if (costProblem(d) === undefined) return d.cost;
  if (!isCompound(d)) return 0;
  return d.members.reduce((sum, m) => sum + (m === d ? 0 : knownCost(m)), 0);
}

/** What one row of a request is charged. */
interface Priced {
  readonly cost: number;
  readonly costEstimate?: CostEstimate;
}

/** How one request's rows are charged, and what it teaches the default reservation. */
interface Pricing {
  readonly rows: readonly Priced[];
  /** The request's validly reported cost: what `largest` and a daily release learn from. */
  readonly known: number;
  /** True when part of its cost is unknown and nothing could price it. */
  readonly unpriced: boolean;
}

const isCount = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 1;

/**
 * Refuse a strategy that no ask could run: an empty member list, a replica count or sample
 * budget that is not a positive integer, a `minMembers` outside 1 to the member count, a
 * `maxFailedSamples` that is not a whole number (e2e V1), or, when the question's kind is
 * given, a `priorYes` on a pick or rate question. Each of those used to throw on every ask,
 * leaving no ledger row behind.
 */
export function checkStrategy(
  spec: StrategySpec | undefined,
  where: string,
  kind?: Question["kind"],
): void {
  if (spec === undefined || spec === "single") return;
  // A base rate of yes means nothing to a pick or rate question: `pool` throws there, on every
  // ask, so a strategy that carries one is refused where it is declared.
  const pooled =
    "cascade" in spec ? spec.cascade.pool : "ensemble" in spec ? spec.ensemble : spec.sequential;
  if (kind !== undefined && kind !== "judge" && pooled && pooled.priorYes !== undefined) {
    throw new Error(`${where}: priorYes pools judge verdicts only, and this is a ${kind} question`);
  }
  if ("cascade" in spec) return;
  const plan = "ensemble" in spec ? spec.ensemble : spec.sequential;
  const name = "ensemble" in spec ? "ensemble" : "sequential";
  if (plan.members !== undefined && plan.members.length === 0) {
    throw new Error(`${where}: ${name} needs at least one member`);
  }
  if (plan.members === undefined && plan.k !== undefined && !isCount(plan.k)) {
    throw new Error(`${where}: ${name} k must be a positive integer, not ${plan.k}`);
  }
  if ("ensemble" in spec) {
    const n = spec.ensemble.members?.length ?? spec.ensemble.k ?? 3;
    const min = spec.ensemble.minMembers;
    if (min !== undefined && !(isCount(min) && min <= n)) {
      throw new Error(
        `${where}: minMembers must be an integer from 1 to ${n} (the member count), not ${min}`,
      );
    }
    return;
  }
  if (!isCount(spec.sequential.maxSamples)) {
    throw new Error(
      `${where}: sequential maxSamples must be a positive integer, not ${spec.sequential.maxSamples}`,
    );
  }
  const failures = spec.sequential.maxFailedSamples;
  if (failures !== undefined && !(Number.isSafeInteger(failures) && failures >= 0)) {
    throw new Error(`${where}: maxFailedSamples must be an integer of at least 0, not ${failures}`);
  }
}

/** The error correlation two replicas of one oracle or one model default to. */
const REPLICA_RHO = 0.75;

/** Where a pool's correlation came from, recorded on the row as `detail.rhoSource`. */
type RhoSource = "caller" | "default-replica" | "default-mixed" | "default-independent";

interface Rho {
  readonly value: number;
  readonly source: RhoSource;
  /** Set when two different model names were counted as one model family. */
  readonly family?: true;
}

/** One member's identity for the default correlation, and how many pooled draws it makes. */
interface Voter {
  readonly id: string;
  /** The model the oracle says it asks (`model`, as SystemOne's), when it says. */
  readonly pin?: string;
  /** The model its answers recorded, once there are answers. */
  readonly recorded?: string;
  readonly draws: number;
}

/** The pinned model an oracle advertises; not part of `Oracle`, so read defensively. */
function advertisedModel(o: Oracle): string | undefined {
  const m = (o as { readonly model?: unknown }).model;
  return typeof m === "string" && m.trim() !== "" ? m : undefined;
}

const pairsOf = (n: number): number => (n * (n - 1)) / 2;

type VoterKey = (v: Voter) => string | undefined;

/** Pairs of draws that agree on every key given; an undefined value agrees with nothing. */
function pairsSharing(voters: readonly Voter[], keys: readonly VoterKey[]): number {
  const groups = new Map<string, number>();
  for (const v of voters) {
    const parts = keys.map((k) => k(v));
    if (parts.some((p) => p === undefined)) continue;
    const key = JSON.stringify(parts);
    groups.set(key, (groups.get(key) ?? 0) + v.draws);
  }
  let total = 0;
  for (const n of groups.values()) total += pairsOf(n);
  return total;
}

const byOracle: VoterKey = (v) => v.id;
const byPin: VoterKey = (v) => (v.pin === undefined ? undefined : modelFamily(v.pin));
const byRecorded: VoterKey = (v) =>
  v.recorded === undefined ? undefined : modelFamily(v.recorded);

/** True when two different model names among the voters fall in one model family. */
function familyMerged(voters: readonly Voter[]): boolean {
  const names = new Map<string, Set<string>>();
  for (const v of voters) {
    for (const m of [v.pin, v.recorded]) {
      if (m === undefined) continue;
      const family = modelFamily(m);
      const set = names.get(family) ?? new Set<string>();
      set.add(m.trim().toLowerCase());
      names.set(family, set);
    }
  }
  return [...names.values()].some((s) => s.size > 1);
}

/**
 * The default correlation of the draws pooled: 0.75 for each pair that shares an oracle id or a
 * model family (pinned or recorded), 0 for each pair that shares neither, averaged over pairs.
 * Two pins of one family are one voice: jev-1.13 and jev-1.14 shared 89% of their errors (phi
 * 0.785; e2e T5-05, T5-08). With equal weights the log-odds pool's design effect is 1 + (n - 1)
 * times the mean pairwise correlation, so the mean is exact for it; a scalar cannot weight
 * mixed pairs apart (state a measured `correlations` matrix for that). Shared pairs are counted
 * by inclusion and exclusion over the three relations, grouped by member, so the cost is
 * linear in the members however many samples a run may draw.
 */
function defaultRho(voters: readonly Voter[]): Rho {
  const pairs = pairsOf(voters.reduce((sum, v) => sum + v.draws, 0));
  const s = (...keys: VoterKey[]): number => pairsSharing(voters, keys);
  const shared =
    s(byOracle) +
    s(byPin) +
    s(byRecorded) -
    s(byOracle, byPin) -
    s(byOracle, byRecorded) -
    s(byPin, byRecorded) +
    s(byOracle, byPin, byRecorded);
  if (pairs === 0 || shared <= 0) return { value: 0, source: "default-independent" };
  const family = familyMerged(voters) ? { family: true as const } : {};
  if (shared >= pairs) return { value: REPLICA_RHO, source: "default-replica", ...family };
  return { value: (REPLICA_RHO * shared) / pairs, source: "default-mixed", ...family };
}

/**
 * The members a strategy pools and how many draws each makes: each member once for an
 * ensemble, members cycled to `draws` samples for a sequential run (a member sampled again is
 * a replica of itself). `answers`, when given, are the decisions in draw order, and add the
 * model each member's answers recorded.
 */
function votersOf(
  members: readonly Member[],
  draws: number,
  answers?: readonly Decision[],
): Voter[] {
  const n = members.length;
  const recorded = new Map<number, string>();
  answers?.forEach((d, i) => {
    const j = i % n;
    if (d.model !== undefined && d.failedOpen !== true && !recorded.has(j)) {
      recorded.set(j, d.model);
    }
  });
  return members.map((m, j) => {
    const pin = advertisedModel(m.oracle);
    const model = recorded.get(j);
    return {
      id: m.oracle.id,
      ...(pin !== undefined ? { pin } : {}),
      ...(model !== undefined ? { recorded: model } : {}),
      draws: Math.floor(draws / n) + (j < draws % n ? 1 : 0),
    };
  });
}

/** The context for asks outside any registered gate: engine defaults, id "adhoc:<questionId>". */
class AdhocGate implements GateContext {
  readonly floors: readonly FloorRule[] = [];
  readonly bypass: readonly BypassRule[] = [];
  readonly tags: readonly string[] = [];
  readonly id: string;
  constructor(
    private readonly engine: Engine,
    questionId: string,
  ) {
    this.id = `adhoc:${questionId}`;
  }
  get mode(): Mode {
    return this.engine.mode;
  }
  get auditRate(): number {
    return this.engine.auditRate;
  }
}

/** What a gate's report may borrow from: the engine's profiles, and the gate's pin if it has one. */
interface Lenders {
  readonly profiles: readonly CalibrationProfile[];
  readonly model?: string;
}

function summarize(
  rows: readonly DecisionRecord[],
  opts: ReportOptions,
  trust: TrustRegistry,
  measurable = true,
  lenders?: Lenders,
): QuestionReport {
  // Counts and figures read the current configuration, as the bar and the grade do; the rows
  // of older ones are counted, and an unregistered source is flagged wherever it appears.
  const { current, older } = currentConfiguration(rows);
  const graded = current.filter((r) => !settledWithoutAnswer(r));
  // Moment labels grade the oracle but fit nothing; consequence labels are only counted.
  const s = scoredFromLedger(graded, { sources: COUNTED_SOURCES, trust });
  const consequence = scoredFromLedger(graded, { sources: ["consequence"], trust }).length;
  const unregistered = scoredFromLedger(
    rows.filter((r) => !settledWithoutAnswer(r)),
    { sources: ["unregistered"], trust },
  ).length;
  const unselected = scoredFromLedger(graded, { unselectedOnly: true, trust });
  // The bar and the grade are read as `ratchet report` reads them, with the same defaults.
  const { bar, grade, levers, battery } = gateEvidence(rows, {
    levers: {
      ...(opts.targetAccuracy !== undefined ? { target: opts.targetAccuracy } : {}),
      ...(opts.minSupport !== undefined ? { minSupport: opts.minSupport } : {}),
      ...(opts.minEstimated !== undefined ? { minEstimated: opts.minEstimated } : {}),
    },
    trust,
    measurable,
    ...(lenders !== undefined ? { profiles: lenders.profiles } : {}),
    ...(lenders?.model !== undefined ? { pin: lenders.model } : {}),
  });
  const expected = expectedAccuracy(graded);
  return {
    n: rows.length,
    older: older.length,
    labelled: s.length,
    unselected: unselected.length,
    consequence,
    unregistered,
    ...(expected !== undefined ? { expectedAccuracy: expected } : {}),
    ...(s.length > 0
      ? {
          accuracy: mean(s.map((x) => (x.correct ? 1 : 0))),
          brier: brier(s),
          ece: ece(s),
        }
      : {}),
    ...bar,
    grade,
    levers,
    ...(battery !== undefined ? { battery } : {}),
  };
}

function groupBy(
  rows: readonly DecisionRecord[],
  key: (r: DecisionRecord) => string,
): Map<string, DecisionRecord[]> {
  const out = new Map<string, DecisionRecord[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/**
 * The front door, and the registry of decision points. The engine holds what every gate
 * shares (the oracle, the ledger, the budget, the audit randomness, engine-wide floors); each
 * gate holds its own question or battery, policy, floors, mode and rollout contract. Asks
 * outside a gate still work and are recorded under an anonymous gate. Start in shadow mode;
 * enforce once the report earns it.
 */
export class Engine implements Asker {
  readonly oracle: Oracle;
  readonly ledger: Ledger;
  /** The default mode for every gate that does not set its own. */
  mode: Mode;
  /** The default blind-audit rate for every gate that does not set its own. */
  readonly auditRate: number;
  /** How label sources map to trust classes: `DEFAULT_TRUST` with `labelTrust` laid over it. */
  readonly labelTrust: TrustRegistry;
  /** Profiles a gate with no fitted bar may be graded borrowed from, each checked. */
  readonly profiles: readonly CalibrationProfile[];
  private readonly floors: readonly FloorRule[];
  private readonly bypass: readonly BypassRule[];
  private readonly keepState: boolean;
  private readonly tags: readonly string[];
  private readonly rand: Rand;
  private readonly budgetUsd: number | undefined;
  private readonly reserveUsd: number | undefined;
  private readonly daily: DailySpend | undefined;
  private readonly oracleDefaults: FailOpenOptions;
  private readonly registry = new Map<string, Gate>();
  /** Single-question gates by question id, so askAll can route a question to its gate. */
  private readonly byQuestion = new Map<string, GateContext>();
  /** The costliest validly priced request this instance has recorded. */
  private largestRequest = 0;
  /** Requests whose cost is unknown and that nothing could price yet; the instance cap waits. */
  private unpriced = 0;
  /**
   * USD spent through this engine instance so far. An unknown or invalid reported cost is
   * counted at its conservative estimate (`DecisionRecord.costEstimate`), so this never goes
   * down and never becomes NaN.
   */
  spent = 0;

  constructor(opts: EngineOptions) {
    this.oracleDefaults = opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {};
    this.oracle = failOpen(opts.oracle, this.oracleDefaults);
    this.ledger = opts.ledger ?? new MemoryLedger();
    this.mode = opts.mode ?? "shadow";
    this.floors = opts.floors ?? [];
    this.bypass = opts.bypass ?? [];
    this.keepState = opts.keepState ?? false;
    this.tags = opts.tags ?? [];
    this.auditRate = clamp(opts.auditRate ?? 0, 0, 1);
    this.labelTrust = trustRegistry(opts.labelTrust);
    this.profiles = (opts.profiles ?? []).map(parseProfile);
    this.rand = rng(opts.seed ?? Date.now());
    // A NaN, negative or infinite cap would never trip (e2e V1): refuse it as the daily cap does.
    if (opts.budgetUsd !== undefined && !(Number.isFinite(opts.budgetUsd) && opts.budgetUsd > 0)) {
      throw new Error("budgetUsd must be a positive number of USD");
    }
    this.budgetUsd = opts.budgetUsd;
    if (opts.reserveUsd !== undefined && !isValidCost(opts.reserveUsd)) {
      throw new Error("reserveUsd must be a non-negative number of USD");
    }
    this.reserveUsd = opts.reserveUsd;
    this.daily =
      opts.dailyBudgetUsd === undefined
        ? undefined
        : new DailySpend(this.ledger, {
            capUsd: opts.dailyBudgetUsd,
            ...(opts.reserveUsd !== undefined ? { reserveUsd: opts.reserveUsd } : {}),
          });
  }

  /**
   * True once the instance cap is reached, or while a request whose cost is unknown has nothing
   * to price it by; asks then fail open without calling the oracle.
   */
  get overBudget(): boolean {
    return this.budgetUsd !== undefined && (this.unpriced > 0 || this.spent >= this.budgetUsd);
  }

  /**
   * What an unknown cost is charged: the larger of `reserveUsd` and the costliest validly priced
   * request on record (this instance's, or the ledger's when a daily cap read it). `none` when
   * neither exists.
   */
  private unknownCost(): { readonly usd: number; readonly basis: CostBasis } {
    const reserve = this.reserveUsd ?? 0;
    const largest = Math.max(this.largestRequest, this.daily?.largestUsd ?? 0);
    if (reserve <= 0 && largest <= 0) return { usd: 0, basis: "none" };
    return reserve >= largest
      ? { usd: reserve, basis: "reserve" }
      : { usd: largest, basis: "largest" };
  }

  /**
   * Charge one request's decisions (undefined for a battery's combined row, which costs
   * nothing). A decision whose cost is unknown or invalid is charged its known part plus an
   * even share of one request's estimate, and says so on its row; the rest are charged as
   * reported, exactly as before.
   */
  private price(decisions: readonly (Decision | undefined)[]): Pricing {
    const problems = decisions.map((d) => (d === undefined ? undefined : costProblem(d)));
    const unknown = problems.filter((p) => p !== undefined).length;
    const estimate = unknown > 0 ? this.unknownCost() : undefined;
    let known = 0;
    const rows = decisions.map((d, i): Priced => {
      if (d === undefined) return { cost: 0 };
      const problem = problems[i];
      if (problem === undefined) {
        known += d.cost;
        return { cost: d.cost };
      }
      const part = knownCost(d);
      known += part;
      return {
        cost: part + (estimate === undefined ? 0 : estimate.usd / unknown),
        costEstimate: { reason: problem.slice(0, 160), basis: estimate?.basis ?? "none" },
      };
    });
    return { rows, known, unpriced: estimate?.basis === "none" };
  }

  /** After a request's rows are written: learn its price, and price any request waiting on one. */
  private settleRequest(pricing: Pricing): void {
    this.largestRequest = Math.max(this.largestRequest, pricing.known);
    if (pricing.unpriced) this.unpriced++;
    if (this.unpriced === 0) return;
    const estimate = this.unknownCost();
    if (estimate.usd <= 0) return;
    this.spent += this.unpriced * estimate.usd;
    this.unpriced = 0;
  }

  /** Today's recorded spend against `dailyBudgetUsd`, or undefined when no daily cap is set. */
  async spentToday(): Promise<SpendSnapshot | undefined> {
    return this.daily?.snapshot();
  }

  /**
   * Admit one request before it buys any answer: the instance cap first, then a reservation
   * against the day's cap. A refused request fails open without calling an oracle. Without a
   * daily cap this stays synchronous, so an engine that does not use one gains no latency.
   */
  private admit(): Admission | Promise<Admission> {
    if (this.overBudget) return refused("instance");
    const daily = this.daily;
    if (!daily) return ADMITTED;
    return daily
      .reserve()
      .then((reservation) =>
        reservation
          ? { refused: undefined, release: (cost: number) => daily.release(reservation, cost) }
          : refused("daily"),
      );
  }

  /** Registered gates by id. Anonymous gates (asks outside a gate) are not listed. */
  get gates(): ReadonlyMap<string, Gate> {
    return this.registry;
  }

  /**
   * Register a decision point and return it. Ids are unique per engine and "adhoc:" is
   * reserved for anonymous gates. A single-question gate also claims its question id, so
   * `ask` and `askAll` on that question are recorded under the gate (the first gate to claim
   * an id keeps it).
   */
  gate<Q extends GateQuestion>(spec: GateSpec<Q>): Gate<GateVerdict<Q>> {
    if (this.registry.has(spec.id)) throw new Error(`gate ${spec.id} is already registered`);
    const g = new GateImpl<GateVerdict<Q>>(this, spec);
    // A rule scoped to a question this gate never shows its rules would never fire (e2e T4-08).
    checkRuleScopes(g, { floors: this.floors, bypass: this.bypass });
    // A strategy every ask would throw on, with no ledger row, is refused here instead.
    checkStrategy(
      spec.strategy,
      `gate ${spec.id}`,
      Array.isArray(spec.question) ? "judge" : (spec.question as Question).kind,
    );
    this.registry.set(spec.id, g);
    const own = g.ownQuestion;
    if (own && !this.byQuestion.has(own.id)) this.byQuestion.set(own.id, g);
    return g;
  }

  private exhausted(q: Question, budget: BudgetKind = "instance"): CompoundDecision {
    const d: Decision = {
      verdict: neutralVerdict(q),
      oracle: this.oracle.id,
      latencyMs: 0,
      cost: 0,
      at: new Date().toISOString(),
      failedOpen: true,
    };
    const waiting = budget === "instance" && this.unpriced > 0 ? { unpriced: this.unpriced } : {};
    return {
      ...single(d),
      detail: { budgetExhausted: true, budget, spent: this.spent, ...waiting },
    };
  }

  /** A question whose strategy no ask could run: failed open, nothing bought, the reason kept. */
  private invalidStrategy(q: Question, error: unknown): CompoundDecision {
    const message = error instanceof Error ? error.message : String(error);
    const d: Decision = {
      verdict: neutralVerdict(q),
      oracle: this.oracle.id,
      latencyMs: 0,
      cost: 0,
      at: new Date().toISOString(),
      failedOpen: true,
      error: message.slice(0, 160),
    };
    return { ...single(d), detail: { invalidStrategy: true } };
  }

  /**
   * Stop a compound request buying once the instance cap is spent partway through it (e2e V1
   * round 2): the cap is checked per request, so one sequential run could otherwise buy far
   * past it. Each answer's cost is counted as it arrives, an unknown one at its estimate; once
   * the instance's recorded spend plus the request's own reaches the cap, or an unknown cost
   * has nothing to price it by, further calls fail open without buying. Members asked in
   * parallel (an ensemble) all start before any cost is known, so they are bounded by their
   * number, as before.
   */
  private metered(oracle: Oracle, meter: { usd: number; blind: boolean }): Oracle {
    const cap = this.budgetUsd;
    if (cap === undefined) return oracle;
    return {
      id: oracle.id,
      decide: async (state, questions, opts) => {
        if (meter.blind || this.unpriced > 0 || this.spent + meter.usd >= cap) {
          const at = new Date().toISOString();
          return questions.map((q) => ({
            verdict: neutralVerdict(q),
            oracle: oracle.id,
            latencyMs: 0,
            cost: 0,
            at,
            failedOpen: true,
            error: "instance budget spent partway through this request",
          }));
        }
        const ds = await oracle.decide(state, questions, opts);
        for (const d of ds) {
          if (costProblem(d) === undefined) meter.usd += d.cost;
          else {
            const estimate = this.unknownCost();
            if (estimate.usd <= 0) meter.blind = true;
            meter.usd += estimate.usd / Math.max(1, ds.length);
          }
        }
        return ds;
      },
    };
  }

  /** A floor already fixes the action; no answer could change it, so none is bought. */
  private floored(q: Question, error: string | undefined): CompoundDecision {
    const d: Decision = {
      verdict: neutralVerdict(q),
      oracle: "floor",
      latencyMs: 0,
      cost: 0,
      at: new Date().toISOString(),
      ...(error !== undefined ? { error } : {}),
    };
    return { ...single(d), strategy: "floored", oracle: "floor", detail: { floored: true } };
  }

  private bypassed(q: Question, goIsYes: boolean): CompoundDecision {
    const d: Decision = {
      verdict: { kind: "judge", questionId: q.id, pYes: goIsYes ? 1 : 0, confidence: 1 },
      oracle: "bypass",
      latencyMs: 0,
      cost: 0,
      at: new Date().toISOString(),
    };
    return { ...single(d), strategy: "bypass", oracle: "bypass", detail: { bypass: true } };
  }

  /** Every backend in an engine request shares its failure and timeout contract. */
  private guarded(oracle: Oracle): Oracle {
    return oracle === this.oracle ? oracle : failOpen(oracle, this.oracleDefaults);
  }

  private async decide(state: string, q: Question, spec: StrategySpec): Promise<CompoundDecision> {
    if (this.overBudget) return this.exhausted(q);
    // What this request has bought so far, for the instance cap partway through it.
    const meter = { usd: 0, blind: false };
    if (spec === "single") {
      const [d] = await this.oracle.decide(state, [q]);
      if (!d) throw new Error("oracle returned nothing");
      return single(d);
    }
    if ("ensemble" in spec) {
      const { k, frames, members, ...pool } = spec.ensemble;
      const ms = members ?? replicate(this.oracle, k ?? 3, frames ? { frames } : {});
      // Replicas of one oracle are not independent voters: paraphrases of one question had an
      // error correlation of 0.77 on BoolQ. However the members were spelled, voters that share
      // an oracle or a model family default to that unless the caller measured otherwise (T5-01).
      const rho = this.rhoFor(pool, votersOf(ms, ms.length));
      const d = await ensemble(state, q, {
        ...pool,
        ...(rho.source === "caller" ? {} : { correlation: rho.value }),
        members: ms.map((m) => ({ ...m, oracle: this.metered(this.guarded(m.oracle), meter) })),
      });
      return this.withRho(d, q, pool, rho, votersOf(ms, ms.length, d.members), (live) => {
        // As `ensemble` pools: weights follow the members that answered.
        const weights =
          pool.weights && live.length !== d.members.length
            ? d.members.flatMap((m, i) => (m.failedOpen ? [] : [pool.weights?.[i] ?? 1]))
            : pool.weights;
        return {
          ...(pool.method !== undefined ? { method: pool.method } : {}),
          ...(weights ? { weights } : {}),
          ...(pool.priorYes !== undefined ? { priorYes: pool.priorYes } : {}),
        };
      });
    }
    if ("cascade" in spec) {
      return cascade(state, q, {
        ...spec.cascade,
        tiers: spec.cascade.tiers.map((t) => ({
          ...t,
          oracle: this.metered(this.guarded(t.oracle), meter),
        })),
      });
    }
    const {
      k,
      members,
      settleAbove,
      settleLead,
      maxSamples,
      minSamples,
      maxFailedSamples,
      ...pool
    } = spec.sequential;
    const ms = members ?? replicate(this.oracle, k ?? maxSamples);
    // Early stopping does not make repeated answers independent (the same design effect), and
    // a member sampled again is a replica of itself, so the voters are the draws, cycled.
    const draws = Math.max(1, Math.floor(maxSamples));
    const rho = this.rhoFor(pool, votersOf(ms, draws));
    const d = await sequential(state, q, {
      ...pool,
      ...(rho.source === "caller" ? {} : { correlation: rho.value }),
      members: ms.map((m) => ({ ...m, oracle: this.metered(this.guarded(m.oracle), meter) })),
      settleAbove,
      maxSamples,
      ...(settleLead !== undefined ? { settleLead } : {}),
      ...(minSamples !== undefined ? { minSamples } : {}),
      ...(maxFailedSamples !== undefined ? { maxFailedSamples } : {}),
    });
    return this.withRho(d, q, pool, rho, votersOf(ms, draws, d.members), () => ({
      ...(pool.method !== undefined ? { method: pool.method } : {}),
      // As `sequential` pools: a weight belongs to a member, so sample i takes the weight of
      // member i mod the member count, and a failed sample's is left out.
      ...(pool.weights
        ? {
            weights: d.members.flatMap((m, i) =>
              m.failedOpen ? [] : [pool.weights?.[i % ms.length] ?? 1],
            ),
          }
        : {}),
      ...(pool.priorYes !== undefined ? { priorYes: pool.priorYes } : {}),
    }));
  }

  /**
   * The caller's correlation when stated, a scalar or a `correlations` matrix, which always
   * wins; else the default for these voters.
   */
  private rhoFor(pool: PoolOptions, voters: readonly Voter[]): Rho {
    if (pool.correlation !== undefined || pool.correlations !== undefined) {
      return { value: pool.correlation ?? 0, source: "caller" };
    }
    return defaultRho(voters);
  }

  /**
   * Record where the pool's correlation came from on the row (`detail.rhoSource`, and
   * `detail.correlation` for a default; `rhoMatrix` when the caller pooled with a matrix,
   * `rhoFamily` when two model names were read as one family). When the models the answers
   * recorded show voters sharing a model that nothing said up front (two oracle ids, one pin),
   * the default rises and the answered verdicts are pooled again at it: the decision can only
   * become more cautious. A caller's correlation is never replaced (e2e V2 E1, E2). A sequential
   * run stopped where it stopped; only its final verdict is pooled again.
   */
  private withRho(
    d: CompoundDecision,
    q: Question,
    pool: PoolOptions,
    rho: Rho,
    answered: readonly Voter[],
    poolOf: (live: readonly Decision[]) => Omit<PoolOptions, "correlation">,
  ): CompoundDecision {
    if (rho.source === "caller") {
      const matrix = pool.correlations !== undefined ? { rhoMatrix: true } : {};
      return { ...d, detail: { ...d.detail, rhoSource: "caller", ...matrix } };
    }
    const after = defaultRho(answered);
    const live = d.members.filter((m) => m.failedOpen !== true);
    const rise = after.value > rho.value + 1e-12 && d.failedOpen !== true && live.length > 1;
    const used = rise ? after : rho;
    const detail = {
      ...d.detail,
      correlation: used.value,
      rhoSource: used.source,
      ...(used.family ? { rhoFamily: true } : {}),
      ...(rise ? { rhoFrom: "recorded-model" } : {}),
    };
    if (!rise) return { ...d, detail };
    const verdict = poolVerdicts(
      q,
      live.map((m) => m.verdict),
      { ...poolOf(live), correlation: used.value },
    );
    return { ...d, verdict, detail };
  }

  private floorsOf(gate: GateContext): readonly FloorRule[] {
    return gate.floors.length === 0 ? this.floors : [...this.floors, ...gate.floors];
  }

  private bypassOf(gate: GateContext): readonly BypassRule[] {
    return gate.bypass.length === 0 ? this.bypass : [...this.bypass, ...gate.bypass];
  }

  /**
   * Floors first, then bypasses; either can settle a question before any answer is bought. Both
   * get the state itself, not only its text: entry floors read its entries, and a bypass must
   * match its trusted block as well as its text, so untrusted text cannot grant one.
   */
  private preempt(state: StateLike, gate: GateContext, q: Question, policy: GatePolicy): Preempted {
    // A floor that throws or answers outside the vocabulary fails closed to review, and says so
    // on the row, rather than aborting the ask with no row or being ignored (e2e T4-13).
    const { floor, errors } = evaluateFloors(this.floorsOf(gate), state, q);
    const floorError = errors.length > 0 ? errors.join("; ").slice(0, 160) : undefined;
    const noted = floorError !== undefined ? { floorError } : {};
    const fixed = floor === "refuse" || (floor === "review" && policy.refuseBelow === undefined);
    if (fixed) return { floor, decision: this.floored(q, floorError), ...noted };
    if (bypassFor(this.bypassOf(gate), state, q)) {
      return { floor, decision: this.bypassed(q, policy.goIsYes ?? true), ...noted };
    }
    return { floor, decision: undefined, ...noted };
  }

  /** Mode, action and tags for one ruling under one gate, including the blind-audit draw. */
  private settle(
    gate: GateContext,
    ruling: Ruling,
    opts: { readonly baseline?: Action; readonly tags?: readonly string[] },
  ): Settled {
    const mode = gate.mode;
    let action: Action = mode === "enforce" ? ruling.action : (opts.baseline ?? "review");
    const tags = [...this.tags, ...gate.tags, ...(opts.tags ?? [])];
    let audited = false;
    // Every act the draw below may send to review records the chance that it would, drawn or
    // not, so audited acts can be weighted by their inclusion probability (Horvitz-Thompson).
    const auditable = mode === "enforce" && action === "act";
    if (auditable && gate.auditRate > 0 && this.rand() < gate.auditRate) {
      action = "review";
      audited = true;
      tags.push("audit");
    }
    return {
      mode,
      soft: ruling.action,
      action,
      tags,
      audited,
      ...(ruling.floor !== undefined ? { floor: ruling.floor } : {}),
      ...(auditable ? { auditProbability: gate.auditRate } : {}),
    };
  }

  private row(
    state: StateLike,
    requestId: string,
    gate: GateContext,
    q: Question,
    questionHash: string,
    d: CompoundDecision,
    go: number,
    s: Settled,
    opts: AskOptions,
    priced: Priced,
    floorError: string | undefined,
    combined = false,
  ): DecisionRecord {
    const error =
      floorError === undefined || d.error === floorError
        ? d.error
        : d.error === undefined
          ? floorError
          : `${d.error}; ${floorError}`.slice(0, 320);
    return {
      id: newRecordId(),
      at: d.at,
      gateId: gate.id,
      requestId,
      ...(combined ? { combined: true as const } : {}),
      questionId: q.id,
      kind: q.kind,
      prompt: q.prompt,
      questionHash,
      policyHash: hashPolicy(opts.policy),
      ...(opts.evidenceVersion !== undefined ? { evidenceVersion: opts.evidenceVersion } : {}),
      stateHash: state.hash,
      trustedHash: state.trustedHash,
      untrusted: [...state.untrusted],
      ...(this.keepState ? { state: state.text } : {}),
      oracle: d.oracle,
      ...(d.model !== undefined ? { model: d.model } : {}),
      strategy: d.strategy,
      verdict: d.verdict,
      go,
      confidence: d.verdict.confidence,
      agreement: d.agreement,
      ...sourced(trailOf(d), gate.barSource),
      soft: s.soft,
      action: s.action,
      mode: s.mode,
      ...(s.floor !== undefined && s.floor !== "act" ? { floor: s.floor } : {}),
      // A battery's members carry its spend; the combined row is derived and costs nothing.
      cost: combined ? 0 : priced.cost,
      ...(!combined && priced.costEstimate !== undefined
        ? { costEstimate: priced.costEstimate }
        : {}),
      latencyMs: d.latencyMs,
      failedOpen: d.failedOpen === true,
      ...(error !== undefined ? { error } : {}),
      ...(typeof d.vendor?.batch === "number" ? { batch: d.vendor.batch } : {}),
      tags: s.tags,
      ...(s.auditProbability !== undefined ? { auditProbability: s.auditProbability } : {}),
    };
  }

  /**
   * Count a row's cost and write it. Rows are priced before they get here (`price`), so the
   * cost is a finite non-negative number; the guard is for the next path that forgets: a NaN or
   * a negative must never freeze or lower recorded spend (e2e T4-06).
   */
  private async append(rec: DecisionRecord): Promise<void> {
    if (isValidCost(rec.cost)) this.spent += rec.cost;
    this.daily?.record(rec.cost, rec);
    await this.ledger.append(rec);
  }

  /**
   * The request path every gate and `askAll` share. Floors and bypasses settle what they
   * can without a call; every remaining single-strategy question goes to the oracle in one
   * request, which is how decision models want to be used; other strategies run per
   * question. Every row produced shares one request id. Internal: call `ask`, `askAll`, or a
   * gate's methods instead.
   */
  async runLanes(input: StateInput, lanes: readonly Lane[]): Promise<AskResult[]> {
    const state = asStateLike(input);
    const requestId = newRequestId();
    const planned: Planned[] = lanes.map((original) => {
      // Capture the effective policy before an asynchronous oracle can outlive a config edit.
      const lane = { ...original, opts: { ...original.opts, policy: { ...original.opts.policy } } };
      return { lane, ...this.preempt(state, lane.gate, lane.question, lane.opts.policy) };
    });
    // A strategy given per ask is checked as a gate's is at registration (e2e V1 round 2: an
    // unbounded `maxSamples` bought 501 answers in one ask). An invalid one fails its question
    // open, to review, with the reason on its row, and buys nothing.
    for (const p of planned) {
      const strategy = p.lane.opts.strategy;
      if (p.decision !== undefined || strategy === undefined || strategy === "single") continue;
      try {
        checkStrategy(strategy, `question ${p.lane.question.id}`, p.lane.question.kind);
      } catch (error) {
        p.decision = this.invalidStrategy(p.lane.question, error);
      }
    }
    const open = planned.filter((p) => p.decision === undefined);
    const batched = open.filter((p) => (p.lane.opts.strategy ?? "single") === "single");
    const others = open.filter((p) => (p.lane.opts.strategy ?? "single") !== "single");
    const admitting = open.length > 0 ? this.admit() : ADMITTED;
    const admission = admitting instanceof Promise ? await admitting : admitting;
    let requestCost = 0;
    try {
      const budget = admission.refused;
      const batch = async (): Promise<void> => {
        if (batched.length === 0) return;
        const qs = batched.map((p) => p.lane.question);
        const ds =
          budget !== undefined
            ? qs.map((q) => this.exhausted(q, budget))
            : await this.oracle.decide(state.text, qs);
        batched.forEach((p, i) => {
          const d = ds[i];
          if (!d) throw new Error("oracle returned too few decisions");
          p.decision = single(d);
        });
      };
      await Promise.all([
        batch(),
        ...others.map(async (p) => {
          p.decision =
            budget !== undefined
              ? this.exhausted(p.lane.question, budget)
              : await this.decide(state.text, p.lane.question, p.lane.opts.strategy ?? "single");
        }),
      ]);
      return await this.recordLanes(state, requestId, planned, (cost) => {
        requestCost += cost;
      });
    } finally {
      admission.release(requestCost);
    }
  }

  /**
   * Rule, settle and append each planned lane of one request, in lane order. `spent` hears the
   * request's validly reported cost, which is what the default reservation learns from.
   */
  private async recordLanes(
    state: StateLike,
    requestId: string,
    planned: readonly Planned[],
    spent: (cost: number) => void,
  ): Promise<AskResult[]> {
    const out: AskResult[] = [];
    const pricing = this.price(planned.map((p) => p.decision));
    spent(pricing.known);
    for (const [i, p] of planned.entries()) {
      const decision = p.decision as CompoundDecision;
      const { gate, question, opts } = p.lane;
      const ruling = rule(decision, opts.policy, p.floor);
      const s = this.settle(gate, ruling, opts);
      const rec = this.row(
        state,
        requestId,
        gate,
        question,
        hashQuestion(question),
        decision,
        ruling.go,
        s,
        opts,
        pricing.rows[i] ?? { cost: 0 },
        p.floorError,
      );
      await this.append(rec);
      out.push({
        recordId: rec.id,
        requestId,
        gateId: gate.id,
        decision,
        ruling,
        action: s.action,
        mode: s.mode,
        audited: s.audited,
      });
    }
    this.settleRequest(pricing);
    return out;
  }

  /**
   * A battery in one request. Members are combined into one judge verdict, the policy rules
   * on that, and the ledger gets one row per member plus a combined row that carries the
   * ruling and takes the label. If any member failed open the battery fails open: a battery
   * missing a member is not the battery whose bar was fitted. Internal: call `gate.ask`.
   */
  async runBattery(
    input: StateInput,
    gate: GateContext,
    plan: BatteryPlan,
    opts: AskOptions,
  ): Promise<AskResult<JudgeVerdict>> {
    opts = { ...opts, policy: { ...opts.policy } };
    const state = asStateLike(input);
    const requestId = newRequestId();
    const pre = this.preempt(state, gate, plan.question, opts.policy);
    const admitting = pre.decision ? ADMITTED : this.admit();
    const admission = admitting instanceof Promise ? await admitting : admitting;
    let pricing: Pricing | undefined;
    try {
      let decision: CompoundDecision;
      let members: readonly Decision[] = [];
      if (pre.decision) decision = pre.decision;
      else {
        const budget = admission.refused;
        members =
          budget !== undefined
            ? plan.members.map((q) => this.exhausted(q, budget))
            : await this.oracle.decide(state.text, plan.members);
        decision = this.combineBattery(plan, members);
      }
      // The members carry the battery's spend; the combined row costs nothing.
      pricing = this.price([...members, undefined]);
      return await this.recordBattery(
        state,
        requestId,
        gate,
        plan,
        opts,
        pre.floor,
        members,
        decision,
        pricing,
        pre.floorError,
      );
    } finally {
      admission.release(pricing?.known ?? 0);
    }
  }

  /** Rule a battery's combined verdict and append its member rows and its combined row. */
  private async recordBattery(
    state: StateLike,
    requestId: string,
    gate: GateContext,
    plan: BatteryPlan,
    opts: AskOptions,
    floor: Action,
    members: readonly Decision[],
    decision: CompoundDecision,
    pricing: Pricing,
    floorError: string | undefined,
  ): Promise<AskResult<JudgeVerdict>> {
    const ruling = rule(decision, opts.policy, floor);
    const s = this.settle(gate, ruling, opts);
    const goIsYes = opts.policy.goIsYes ?? true;
    for (const [i, m] of members.entries()) {
      const q = plan.members[i];
      if (!q) throw new Error("oracle returned too many decisions");
      const d = single(m);
      await this.append(
        this.row(
          state,
          requestId,
          gate,
          q,
          hashQuestion(q),
          d,
          goProbability(d.verdict, goIsYes),
          s,
          opts,
          pricing.rows[i] ?? { cost: 0 },
          undefined,
        ),
      );
    }
    const rec = this.row(
      state,
      requestId,
      gate,
      plan.question,
      plan.questionHash,
      decision,
      ruling.go,
      s,
      opts,
      { cost: 0 },
      floorError,
      true,
    );
    await this.append(rec);
    this.settleRequest(pricing);
    return {
      recordId: rec.id,
      requestId,
      gateId: gate.id,
      decision: decision as CompoundDecision<JudgeVerdict>,
      ruling,
      action: s.action,
      mode: s.mode,
      audited: s.audited,
    };
  }

  private combineBattery(plan: BatteryPlan, members: readonly Decision[]): CompoundDecision {
    if (members.length !== plan.members.length) {
      throw new Error(
        `oracle answered ${members.length} of ${plan.members.length} battery members`,
      );
    }
    const failed = members.filter((d) => d.failedOpen === true);
    const oracle = members[0]?.oracle ?? this.oracle.id;
    const model = members.find((d) => d.model !== undefined)?.model;
    const detail: Record<string, unknown> = { members: members.length, combine: plan.method };
    if (failed.length > 0) {
      const exhausted = members.some((d) => isCompound(d) && d.detail.budgetExhausted === true);
      const error = failed.find((d) => d.error !== undefined)?.error;
      const base = compoundOf("battery", neutralVerdict(plan.question), members, {
        parallel: true,
        oracle,
        detail: {
          ...detail,
          failedMembers: failed.length,
          ...(exhausted ? { budgetExhausted: true, spent: this.spent } : {}),
        },
      });
      return {
        ...base,
        failedOpen: true,
        ...(error !== undefined ? { error } : {}),
        ...(model !== undefined ? { model } : {}),
      };
    }
    // A combiner is caller code: one that throws or answers with something that is not a
    // probability (2, NaN, a string) fails the battery open, to review, rather than being
    // clamped into a confident act or aborting the ask with no ledger row.
    let combined: unknown;
    let problem: string | undefined;
    try {
      combined = plan.combine(members.map((d) => d.verdict as JudgeVerdict));
    } catch (error) {
      problem = `combiner threw: ${error instanceof Error ? error.message : String(error)}`;
    }
    const pYes = (combined as { readonly pYes?: unknown } | undefined)?.pYes;
    if (problem === undefined && !isProbability(pYes)) {
      problem = `combiner returned p(yes) ${String(pYes)}, not a probability`;
    }
    if (problem !== undefined || !isProbability(pYes)) {
      const base = compoundOf("battery", neutralVerdict(plan.question), members, {
        parallel: true,
        oracle,
        detail: { ...detail, combinerFailed: true },
      });
      return {
        ...base,
        failedOpen: true,
        error: (problem ?? "combiner failed").slice(0, 160),
        ...(model !== undefined ? { model } : {}),
      };
    }
    // Recompute the confidence from p(yes) and own the id, whatever else the combiner said.
    const verdict = judgeVerdictFrom(plan.question, pYes);
    const base = compoundOf("battery", verdict, members, { parallel: true, oracle, detail });
    return { ...base, ...(model !== undefined ? { model } : {}) };
  }

  private adhoc(q: Question): GateContext {
    return new AdhocGate(this, q.id);
  }

  /**
   * Ask one question about a state. Recorded under the gate that owns the question, if one
   * is registered, otherwise under the anonymous gate "adhoc:<questionId>".
   */
  async ask<Q extends Question>(
    state: StateInput,
    question: Q,
    opts: AskOptions,
  ): Promise<AskResult<VerdictFor<Q>>> {
    const [r] = await this.askAll(state, [question], opts);
    if (!r) throw new Error("engine returned no result");
    return r as AskResult<VerdictFor<Q>>;
  }

  /**
   * Ask several different questions about one state. Single-strategy questions go in one
   * oracle call, which is how decision models want to be used. Each question is recorded
   * under the gate that owns it (its floors, bypasses, mode and audit rate apply) or under
   * an anonymous gate; the options given here rule it either way.
   */
  async askAll(
    state: StateInput,
    questions: readonly Question[],
    opts: AskOptions | ((q: Question) => AskOptions),
  ): Promise<AskResult[]> {
    const optsFor = typeof opts === "function" ? opts : () => opts;
    return this.runLanes(
      state,
      questions.map((q) => ({
        gate: this.byQuestion.get(q.id) ?? this.adhoc(q),
        question: q,
        opts: optsFor(q),
      })),
    );
  }

  private async rowById(id: string): Promise<DecisionRecord | undefined> {
    if (this.ledger.get) return this.ledger.get(id);
    return (await this.ledger.all()).find((r) => r.id === id);
  }

  private async rowsOfRequest(requestId: string): Promise<readonly DecisionRecord[]> {
    if (this.ledger.request) return this.ledger.request(requestId);
    return (await this.ledger.all()).filter((r) => r.requestId === requestId);
  }

  /**
   * Record what turned out to be true. Labelling a battery's combined row also labels its
   * members (same request, same gate): each takes its own truth from `memberTruths` when the
   * label names its question id, else the battery's truth, and is re-scored against its own
   * lean. The battery's truth is what lets a learned combiner be fitted from the ledger; a
   * member's own truth is what calibrates a member of an any/all battery on its own question.
   * Throws, writing nothing, when `memberTruths` is given for a row that is not a battery's
   * combined row, or names a question that is not one of its members, or gives a truth that is
   * not a boolean: a typo would otherwise fall back to the battery's truth without a word.
   */
  async label(recordId: string, outcome: Omit<Outcome, "at"> & { at?: string }): Promise<boolean> {
    const full: Outcome = { ...outcome, at: outcome.at ?? new Date().toISOString() };
    const own = full.memberTruths;
    let members: readonly DecisionRecord[] | undefined;
    if (own !== undefined) {
      const row = await this.rowById(recordId);
      if (row === undefined) return false;
      if (row.combined !== true) {
        throw new Error(`label ${recordId}: memberTruths applies to a battery's combined row only`);
      }
      members = (await this.rowsOfRequest(row.requestId)).filter((m) => isMemberOf(row, m));
      // A floored or refused battery request has no member rows: its members are read from the
      // registered gate, and the map is recorded on the combined row alone (e2e V2 M2). With
      // neither, there is nothing to check the names against, and nothing to label with them.
      const spec = this.registry.get(row.gateId)?.spec.question;
      const ids = new Set(
        members.length > 0
          ? members.map((m) => m.questionId)
          : Array.isArray(spec)
            ? spec.map((q: Question) => q.id)
            : [],
      );
      for (const [id, truth] of Object.entries(own)) {
        if (ids.size > 0 && !ids.has(id)) {
          throw new Error(
            `label ${recordId}: memberTruths names "${id}", which is not a member of battery ${row.gateId} (${[...ids].join(", ")})`,
          );
        }
        if (typeof truth !== "boolean") {
          throw new Error(`label ${recordId}: memberTruths.${id} must be true or false`);
        }
      }
    }
    if (!(await this.ledger.label(recordId, full))) return false;
    const row = await this.rowById(recordId);
    if (row?.combined !== true) return true;
    const inherited: { readonly id: string; readonly outcome: Outcome }[] = [];
    for (const m of members ?? (await this.rowsOfRequest(row.requestId))) {
      if (!isMemberOf(row, m)) continue;
      const outcome = inheritOutcome(row, m, full);
      if (outcome) inherited.push({ id: m.id, outcome });
    }
    // One write for the lot where the ledger can (e2e T2-11), else one label per member.
    if (this.ledger.labelAll) await this.ledger.labelAll(inherited);
    else for (const l of inherited) await this.ledger.label(l.id, l.outcome);
    return true;
  }

  /** The report for one gate's decision rows (a battery's combined rows; its members excluded). */
  async gateReport(gateId: string, opts: ReportOptions = {}): Promise<QuestionReport> {
    const rows = decisionRows(await this.ledger.all()).filter((r) => r.gateId === gateId);
    return summarize(rows, opts, this.labelTrust, true, this.lendersFor(gateId));
  }

  /** The profiles a gate's report may borrow from, with the model its rollout pins, if any. */
  private lendersFor(gateId: string): Lenders | undefined {
    if (this.profiles.length === 0) return undefined;
    const pin = this.registry.get(gateId)?.spec.rollout?.evidence?.model;
    return { profiles: this.profiles, ...(pin !== undefined ? { model: pin } : {}) };
  }

  /** What the ledger says: calibration, shadow agreement, and a fitted bar per question and per gate. */
  async report(opts: ReportOptions = {}): Promise<Report> {
    const rows = await this.ledger.all();
    const decisions = decisionRows(rows);
    const graded = decisions.filter((r) => !settledWithoutAnswer(r));
    const trust = this.labelTrust;
    const scored = scoredFromLedger(graded, { sources: COUNTED_SOURCES, trust });
    const byQuestion: Record<string, QuestionReport> = {};
    // A battery member's rows are features of its battery's decision, not decisions, so they
    // hold no planned sample and grade no better than estimated.
    const decided = new Set(decisions.map((r) => r.id));
    for (const [id, mine] of groupBy(rows, (r) => r.questionId)) {
      setOwn(
        byQuestion,
        id,
        summarize(
          mine,
          opts,
          trust,
          mine.every((r) => decided.has(r.id)),
        ),
      );
    }
    const byGate: Record<string, QuestionReport> = {};
    // A profile is matched against a gate, so only the per-gate figures borrow from one.
    for (const [id, mine] of groupBy(decisions, (r) => r.gateId)) {
      setOwn(byGate, id, summarize(mine, opts, trust, true, this.lendersFor(id)));
    }
    return {
      records: rows.length,
      labelled: scored.length,
      consequence: scoredFromLedger(graded, { sources: ["consequence"], trust }).length,
      unregistered: scoredFromLedger(graded, { sources: ["unregistered"], trust }).length,
      failedOpen: decisions.filter((r) => r.failedOpen).length,
      cost: rows.reduce((s, r) => s + r.cost, 0),
      meanLatencyMs: mean(decisions.map((r) => r.latencyMs)),
      shadowAgreement: shadowAgreement(decisions),
      ...(scored.length > 0
        ? { brier: brier(scored), ece: ece(scored), reliability: reliability(scored) }
        : {}),
      byQuestion,
      byGate,
    };
  }
}
