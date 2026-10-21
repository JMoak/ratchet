import type { PoolOptions } from "./compound/aggregate.ts";
import { type CascadeOptions, cascade } from "./compound/cascade.ts";
import { type CompoundDecision, compoundOf, isCompound, single } from "./compound/compound.ts";
import { ensemble, type Member, replicate } from "./compound/ensemble.ts";
import { sequential } from "./compound/sequential.ts";
import { type BypassRule, bypassFor, type FloorRule, floorFor } from "./floors.ts";
import { type Gate, GateImpl, type GateQuestion, type GateSpec, type GateVerdict } from "./gate.ts";
import {
  brier,
  ece,
  expectedAccuracy,
  type FittedThreshold,
  fitThreshold,
  type ReliabilityBin,
  reliability,
  scoredFromLedger,
  shadowAgreement,
} from "./ledger/calibration.ts";
import {
  type DecisionRecord,
  decisionRows,
  hashQuestion,
  hashState,
  inheritOutcome,
  isMemberOf,
  type Ledger,
  MemoryLedger,
  type Mode,
  newRecordId,
  newRequestId,
  type Outcome,
  settledWithoutAnswer,
} from "./ledger/ledger.ts";
import { clamp, mean, type Rand, rng } from "./math.ts";
import { type FailOpenOptions, failOpen } from "./oracles/oracle.ts";
import { type GatePolicy, goProbability, hashPolicy, type Ruling, rule } from "./policy.ts";
import { judgeVerdictFrom, neutralVerdict } from "./questions.ts";
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

export type StrategySpec =
  | "single"
  | {
      readonly ensemble: PoolOptions & {
        /** Replicate the engine's default oracle k times with shuffled options. */
        readonly k?: number;
        readonly frames?: readonly ((prompt: string) => string)[];
        /** Or supply explicit members (other oracles, other transforms). */
        readonly members?: readonly Member[];
      };
    }
  | { readonly cascade: CascadeOptions }
  | {
      readonly sequential: PoolOptions & {
        readonly k?: number;
        readonly members?: readonly Member[];
        readonly settleAbove: number;
        readonly maxSamples: number;
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
   * In-flight requests and their strategy members can exceed it; costs are known afterward.
   */
  readonly budgetUsd?: number;
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

export interface ReportOptions {
  readonly targetAccuracy?: number;
  readonly minSupport?: number;
}

/**
 * Calibration figures read only rows an answer was bought for. Rows a floor or a bypass
 * settled carry placeholder confidences (0 and 1) that no oracle stated, so they count in `n`
 * and nowhere else.
 */
export interface QuestionReport {
  readonly n: number;
  readonly labelled: number;
  readonly accuracy?: number;
  readonly brier?: number;
  readonly ece?: number;
  /** Labelled shadow/audit rows; audits represent only the policy's acted population. */
  readonly unselected: number;
  /** Label-free estimate: mean stated confidence. Its gap from `accuracy` is miscalibration. */
  readonly expectedAccuracy?: number;
  readonly fitted?: FittedThreshold;
  /** Fit source, not a guarantee of representative labels or independently validated accuracy. */
  readonly fittedFrom?: "unselected" | "all";
}

export interface Report {
  /** Every ledger row, battery members included. */
  readonly records: number;
  /**
   * The figures from here to `reliability` are over decision rows (battery members excluded);
   * `labelled`, `brier`, `ece` and `reliability` also skip rows a floor or bypass settled.
   */
  readonly labelled: number;
  readonly failedOpen: number;
  /** Spend over every row. A battery's members carry its cost; its combined row carries 0. */
  readonly cost: number;
  readonly meanLatencyMs: number;
  readonly shadowAgreement: number;
  readonly brier?: number;
  readonly ece?: number;
  readonly reliability?: readonly ReliabilityBin[];
  /** Per question id over every row, so each battery member is calibrated against the battery's truth. */
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
 * are its hash, and nothing is untrusted. Built states pass through unchanged.
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
}

interface Planned {
  readonly lane: Lane;
  readonly floor: Action;
  decision: CompoundDecision | undefined;
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

function summarize(rows: readonly DecisionRecord[], opts: ReportOptions): QuestionReport {
  const target = opts.targetAccuracy ?? 0.95;
  const minSupport = opts.minSupport ?? 20;
  const graded = rows.filter((r) => !settledWithoutAnswer(r));
  const s = scoredFromLedger(graded);
  const unselected = scoredFromLedger(graded, { unselectedOnly: true });
  // Selected successes cannot overturn sufficient negative shadow evidence (selection bias).
  const useUnselected = unselected.length >= minSupport;
  const fitted = fitThreshold(useUnselected ? unselected : s, target, minSupport);
  const fittedFrom = fitted ? (useUnselected ? "unselected" : "all") : undefined;
  const expected = expectedAccuracy(graded);
  return {
    n: rows.length,
    labelled: s.length,
    unselected: unselected.length,
    ...(expected !== undefined ? { expectedAccuracy: expected } : {}),
    ...(s.length > 0
      ? {
          accuracy: mean(s.map((x) => (x.correct ? 1 : 0))),
          brier: brier(s),
          ece: ece(s),
        }
      : {}),
    ...(fitted ? { fitted } : {}),
    ...(fittedFrom ? { fittedFrom } : {}),
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
  private readonly floors: readonly FloorRule[];
  private readonly bypass: readonly BypassRule[];
  private readonly keepState: boolean;
  private readonly tags: readonly string[];
  private readonly rand: Rand;
  private readonly budgetUsd: number | undefined;
  private readonly oracleDefaults: FailOpenOptions;
  private readonly registry = new Map<string, Gate>();
  /** Single-question gates by question id, so askAll can route a question to its gate. */
  private readonly byQuestion = new Map<string, GateContext>();
  /** USD spent through this engine instance so far. */
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
    this.rand = rng(opts.seed ?? Date.now());
    this.budgetUsd = opts.budgetUsd;
  }

  /** True once the cap is reached; asks then fail open without calling the oracle. */
  get overBudget(): boolean {
    return this.budgetUsd !== undefined && this.spent >= this.budgetUsd;
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
    this.registry.set(spec.id, g);
    const own = g.ownQuestion;
    if (own && !this.byQuestion.has(own.id)) this.byQuestion.set(own.id, g);
    return g;
  }

  private exhausted(q: Question): CompoundDecision {
    const d: Decision = {
      verdict: neutralVerdict(q),
      oracle: this.oracle.id,
      latencyMs: 0,
      cost: 0,
      at: new Date().toISOString(),
      failedOpen: true,
    };
    return { ...single(d), detail: { budgetExhausted: true, spent: this.spent } };
  }

  /** A floor already fixes the action; no answer could change it, so none is bought. */
  private floored(q: Question): CompoundDecision {
    const d: Decision = {
      verdict: neutralVerdict(q),
      oracle: "floor",
      latencyMs: 0,
      cost: 0,
      at: new Date().toISOString(),
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
    if (spec === "single") {
      const [d] = await this.oracle.decide(state, [q]);
      if (!d) throw new Error("oracle returned nothing");
      return single(d);
    }
    if ("ensemble" in spec) {
      const { k, frames, members, ...pool } = spec.ensemble;
      const ms = members ?? replicate(this.oracle, k ?? 3, frames ? { frames } : {});
      // Replicas of one oracle are not independent voters: paraphrases of one question had an
      // error correlation of 0.77 on BoolQ. Default to that unless the caller measured otherwise.
      const correlation = pool.correlation ?? (members ? 0 : 0.75);
      return ensemble(state, q, {
        ...pool,
        correlation,
        members: ms.map((m) => ({ ...m, oracle: this.guarded(m.oracle) })),
      });
    }
    if ("cascade" in spec) {
      return cascade(state, q, {
        ...spec.cascade,
        tiers: spec.cascade.tiers.map((t) => ({ ...t, oracle: this.guarded(t.oracle) })),
      });
    }
    const { k, members, settleAbove, maxSamples, minSamples, ...pool } = spec.sequential;
    const ms = members ?? replicate(this.oracle, k ?? maxSamples);
    // Early stopping does not make repeated answers independent (the same design effect).
    const correlation = pool.correlation ?? (members ? 0 : 0.75);
    return sequential(state, q, {
      ...pool,
      correlation,
      members: ms.map((m) => ({ ...m, oracle: this.guarded(m.oracle) })),
      settleAbove,
      maxSamples,
      ...(minSamples !== undefined ? { minSamples } : {}),
    });
  }

  private floorsOf(gate: GateContext): readonly FloorRule[] {
    return gate.floors.length === 0 ? this.floors : [...this.floors, ...gate.floors];
  }

  private bypassOf(gate: GateContext): readonly BypassRule[] {
    return gate.bypass.length === 0 ? this.bypass : [...this.bypass, ...gate.bypass];
  }

  /** Floors first, then bypasses; either can settle a question before any answer is bought. */
  private preempt(
    state: StateLike,
    gate: GateContext,
    q: Question,
    policy: GatePolicy,
  ): { readonly floor: Action; readonly decision: CompoundDecision | undefined } {
    const floor = floorFor(this.floorsOf(gate), state.text, q);
    const fixed = floor === "refuse" || (floor === "review" && policy.refuseBelow === undefined);
    if (fixed) return { floor, decision: this.floored(q) };
    if (bypassFor(this.bypassOf(gate), state.text, q)) {
      return { floor, decision: this.bypassed(q, policy.goIsYes ?? true) };
    }
    return { floor, decision: undefined };
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
    if (
      mode === "enforce" &&
      action === "act" &&
      gate.auditRate > 0 &&
      this.rand() < gate.auditRate
    ) {
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
    };
  }

  private row(
    state: StateLike,
    requestId: string,
    gateId: string,
    q: Question,
    questionHash: string,
    d: CompoundDecision,
    go: number,
    s: Settled,
    opts: AskOptions,
    combined = false,
  ): DecisionRecord {
    return {
      id: newRecordId(),
      at: d.at,
      gateId,
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
      soft: s.soft,
      action: s.action,
      mode: s.mode,
      ...(s.floor !== undefined && s.floor !== "act" ? { floor: s.floor } : {}),
      // A battery's members carry its spend; the combined row is derived and costs nothing.
      cost: combined ? 0 : d.cost,
      latencyMs: d.latencyMs,
      failedOpen: d.failedOpen === true,
      ...(d.error !== undefined ? { error: d.error } : {}),
      ...(typeof d.vendor?.batch === "number" ? { batch: d.vendor.batch } : {}),
      tags: s.tags,
    };
  }

  private async append(rec: DecisionRecord): Promise<void> {
    this.spent += rec.cost;
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
    const open = planned.filter((p) => p.decision === undefined);
    const batched = open.filter((p) => (p.lane.opts.strategy ?? "single") === "single");
    const others = open.filter((p) => (p.lane.opts.strategy ?? "single") !== "single");
    const batch = async (): Promise<void> => {
      if (batched.length === 0) return;
      const qs = batched.map((p) => p.lane.question);
      const ds = this.overBudget
        ? qs.map((q) => this.exhausted(q))
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
        p.decision = await this.decide(
          state.text,
          p.lane.question,
          p.lane.opts.strategy ?? "single",
        );
      }),
    ]);
    const out: AskResult[] = [];
    for (const p of planned) {
      const decision = p.decision as CompoundDecision;
      const { gate, question, opts } = p.lane;
      const ruling = rule(decision, opts.policy, p.floor);
      const s = this.settle(gate, ruling, opts);
      const rec = this.row(
        state,
        requestId,
        gate.id,
        question,
        hashQuestion(question),
        decision,
        ruling.go,
        s,
        opts,
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
    let members: readonly Decision[] = [];
    let decision: CompoundDecision;
    if (pre.decision) decision = pre.decision;
    else {
      members = this.overBudget
        ? plan.members.map((q) => this.exhausted(q))
        : await this.oracle.decide(state.text, plan.members);
      decision = this.combineBattery(plan, members);
    }
    const ruling = rule(decision, opts.policy, pre.floor);
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
          gate.id,
          q,
          hashQuestion(q),
          d,
          goProbability(d.verdict, goIsYes),
          s,
          opts,
        ),
      );
    }
    const rec = this.row(
      state,
      requestId,
      gate.id,
      plan.question,
      plan.questionHash,
      decision,
      ruling.go,
      s,
      opts,
      true,
    );
    await this.append(rec);
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
    const combined = plan.combine(members.map((d) => d.verdict as JudgeVerdict));
    // Normalise whatever the combiner returned: clamp, recompute confidence, and own the id.
    const verdict = judgeVerdictFrom(plan.question, combined.pYes);
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
   * members (same request, same gate): each inherits the battery's truth, re-scored against
   * its own lean, which is what lets a learned combiner be fitted from the ledger.
   */
  async label(recordId: string, outcome: Omit<Outcome, "at"> & { at?: string }): Promise<boolean> {
    const full: Outcome = { ...outcome, at: outcome.at ?? new Date().toISOString() };
    if (!(await this.ledger.label(recordId, full))) return false;
    const row = await this.rowById(recordId);
    if (row?.combined !== true) return true;
    for (const m of await this.rowsOfRequest(row.requestId)) {
      if (!isMemberOf(row, m)) continue;
      const inherited = inheritOutcome(row, m, full);
      if (inherited) await this.ledger.label(m.id, inherited);
    }
    return true;
  }

  /** The report for one gate's decision rows (a battery's combined rows; its members excluded). */
  async gateReport(gateId: string, opts: ReportOptions = {}): Promise<QuestionReport> {
    const rows = decisionRows(await this.ledger.all()).filter((r) => r.gateId === gateId);
    return summarize(rows, opts);
  }

  /** What the ledger says: calibration, shadow agreement, and a fitted bar per question and per gate. */
  async report(opts: ReportOptions = {}): Promise<Report> {
    const rows = await this.ledger.all();
    const decisions = decisionRows(rows);
    const scored = scoredFromLedger(decisions.filter((r) => !settledWithoutAnswer(r)));
    const byQuestion: Record<string, QuestionReport> = {};
    for (const [id, mine] of groupBy(rows, (r) => r.questionId)) {
      byQuestion[id] = summarize(mine, opts);
    }
    const byGate: Record<string, QuestionReport> = {};
    for (const [id, mine] of groupBy(decisions, (r) => r.gateId)) {
      byGate[id] = summarize(mine, opts);
    }
    return {
      records: rows.length,
      labelled: scored.length,
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
