import { type PoolMethod, type PoolOptions, poolJudge } from "./compound/aggregate.ts";
import { type LogisticModel, poolLearned } from "./compound/learned.ts";
import type {
  Asker,
  AskOptions,
  AskResult,
  BatteryPlan,
  Engine,
  GateContext,
  QuestionReport,
  ReportOptions,
  StrategySpec,
} from "./engine.ts";
import type { BypassRule, FloorRule } from "./floors.ts";
import { hashQuestion, hashState, type Mode } from "./ledger/ledger.ts";
import { clamp } from "./math.ts";
import type { GatePolicy } from "./policy.ts";
import { Rollout, type RolloutSettings } from "./rollout.ts";
import type {
  Action,
  JudgeQuestion,
  JudgeVerdict,
  Question,
  StateInput,
  Verdict,
  VerdictFor,
} from "./types.ts";

/** One question, or a battery of judge questions combined into one. */
export type GateQuestion = Question | readonly JudgeQuestion[];

/**
 * How a battery's members become one judge verdict. Log-odds (the default) is for members that
 * are evidence for one answer; a disjunction (any member yes means yes) takes `"any"`, a
 * conjunction (every member must say yes) takes `"all"`; a learned combiner fits either. The
 * log-odds sum inverts a disjunction and saturates a conjunction (e2e T3-01, T2-05).
 * - a `PoolMethod` ("logodds", "any", "all", "max", "min", ...) or `PoolOptions` goes through
 *   `pool`. Use the options form to state the members' error correlation: decomposed
 *   questions about one state on one model are not independent voters, and the pool shrinks
 *   by the design effect only when told to. Measure it from the ledger.
 * - a `LogisticModel` goes through `poolLearned`: weights fitted on labelled member rows.
 * - a function is called with the member verdicts in battery order. One that throws or returns
 *   a p(yes) that is not a probability fails the battery open, to review.
 */
export type Combiner =
  | PoolMethod
  | PoolOptions
  | LogisticModel
  | ((verdicts: readonly JudgeVerdict[]) => JudgeVerdict);

/** The verdict a gate's asks return: a judge verdict for a battery, else the question's own. */
export type GateVerdict<Q extends GateQuestion> = Q extends readonly JudgeQuestion[]
  ? JudgeVerdict
  : Q extends Question
    ? VerdictFor<Q>
    : Verdict;

export interface GateSpec<Q extends GateQuestion = GateQuestion> {
  /** Stable decision-point id, e.g. "bash.safe". Ledger rows carry it. "adhoc:" is reserved. */
  readonly id: string;
  /** One question, or a battery of judge questions combined into one. */
  readonly question: Q;
  /**
   * For batteries: how members become one judge verdict. Default "logodds" at correlation 0,
   * for members that are evidence for one answer; "any" for a disjunction, "all" for a
   * conjunction (`Combiner`).
   */
  readonly combine?: Combiner;
  readonly policy: GatePolicy;
  /**
   * Where the policy's bar came from, when it was borrowed (`policyFromProfile`): the profile's
   * hash. The engine writes it into `detail` on every row of the gate, so replay and reports can
   * tell borrowed traffic from fitted, and a report reads the gate as stale once its model pin
   * no longer matches that profile.
   */
  readonly barSource?: { readonly profileHash: string };
  /**
   * Bump when model/configuration, strategy, opaque rules or state semantics change, or when a
   * question is renamed or its rubric replaced: a renamed question is a new one, and the old
   * one's labels keep grading the gate until this moves. One version per gate.
   */
  readonly evidenceVersion?: string;
  /** Added to the engine's floors for this gate. */
  readonly floors?: readonly FloorRule[];
  /** Added to the engine's bypasses for this gate. */
  readonly bypass?: readonly BypassRule[];
  /** For a single question only; a battery is always one request. */
  readonly strategy?: StrategySpec;
  /** Accuracy promised on acted rows; drives the gate's Rollout. */
  readonly promisedAccuracy?: number;
  /** Rollout thresholds beyond the promise (window, minimum shadow and audit rows). */
  readonly rollout?: RolloutSettings;
  /** Per-gate override of the engine's mode. Unset, the gate follows the engine. */
  readonly mode?: Mode;
  /** Per-gate override of the engine's blind-audit rate. */
  readonly auditRate?: number;
  readonly tags?: readonly string[];
}

export interface GateAskOptions {
  /** In shadow mode, what the application is doing anyway. Default review. */
  readonly baseline?: Action;
  readonly tags?: readonly string[];
}

export interface GateAskManyOptions extends GateAskOptions {
  /** Requests in flight at once. Default 8. */
  readonly concurrency?: number;
}

/**
 * One decision point: the unit of configuration, learning and rollout. A gate owns its
 * question (or battery), policy, floors, bypasses, strategy, rollout contract and its slice
 * of the ledger (every row it writes carries its id). It is also an `Asker`: recipes run
 * through a gate record their per-item questions under the gate's id, mode and floors.
 */
export interface Gate<V extends Verdict = Verdict> extends Asker {
  readonly id: string;
  readonly spec: GateSpec;
  readonly engine: Engine;
  /** True when the gate's question is a battery. */
  readonly isBattery: boolean;
  /** Rubric identity used by this gate's own decision rows (combined identity for batteries). */
  readonly questionHash: string;
  /** The gate's own mode, or the engine's when the gate never set one. Assigning pins it. */
  mode: Mode;
  readonly auditRate: number;
  /** The gate's rollout controller. Throws if the spec has no `promisedAccuracy`. */
  readonly rollout: Rollout;
  ask(state: StateInput, opts?: GateAskOptions): Promise<AskResult<V>>;
  /** Several states, one gate: one request per state, bounded concurrency, budget-aware. */
  askMany(states: readonly StateInput[], opts?: GateAskManyOptions): Promise<AskResult<V>[]>;
  report(opts?: ReportOptions): Promise<QuestionReport>;
}

export function isBattery(q: GateQuestion): q is readonly JudgeQuestion[] {
  return Array.isArray(q);
}

function combinerFor(
  c: Combiner | undefined,
  n: number,
  gateId: string,
): { combine: (vs: readonly JudgeVerdict[]) => JudgeVerdict; method: string; key: unknown } {
  if (c === undefined) {
    return {
      combine: (vs) => poolJudge(vs, { method: "logodds" }),
      method: "logodds",
      key: "logodds",
    };
  }
  if (typeof c === "string") {
    return { combine: (vs) => poolJudge(vs, { method: c }), method: c, key: c };
  }
  if (typeof c === "function") return { combine: c, method: "function", key: "function" };
  if (c.weights !== undefined && c.weights.length !== n) {
    throw new Error(`gate ${gateId}: combiner has ${c.weights.length} weights for ${n} members`);
  }
  if ("bias" in c) {
    return {
      combine: (vs) => poolLearned(vs, c),
      method: "learned",
      key: { weights: c.weights, bias: c.bias },
    };
  }
  return { combine: (vs) => poolJudge(vs, c), method: c.method ?? "logodds", key: c };
}

/**
 * The key under which a scoped rule records the question scope it was built with (the id or
 * pattern `forQuestion` was given), so a gate can refuse at registration a rule that can never
 * fire on it. A registered symbol (`Symbol.for`), so floors.ts can set it without importing
 * this module: `Object.defineProperty(rule, Symbol.for("ratchet.questionScope"), { value: id })`.
 */
export const QUESTION_SCOPE: unique symbol = Symbol.for("ratchet.questionScope");

/** The question scope a rule was built with, when it carries one; undefined when it is opaque. */
export function questionScope(rule: unknown): string | RegExp | undefined {
  if (typeof rule !== "function") return undefined;
  const scope = (rule as unknown as Readonly<Record<symbol, unknown>>)[QUESTION_SCOPE];
  return typeof scope === "string" || scope instanceof RegExp ? scope : undefined;
}

/** Global and sticky patterns must not make the check depend on earlier tests. */
function scopeMatches(scope: string | RegExp, id: string): boolean {
  if (typeof scope === "string") return scope === id;
  const lastIndex = scope.lastIndex;
  try {
    scope.lastIndex = 0;
    return scope.test(id);
  } finally {
    scope.lastIndex = lastIndex;
  }
}

const showScope = (scope: string | RegExp): string =>
  typeof scope === "string" ? JSON.stringify(scope) : String(scope);

/**
 * Refuse a scoped floor or bypass that can never fire on this gate (e2e T4-08: a floor scoped
 * to a battery member's id never fired, because floors see the battery's combined question,
 * whose id is the gate id, and never its members). A rule, the gate's own or the engine's, is
 * refused when its scope names one of this battery's members and not the battery itself. Any
 * other unmatched scope is allowed: an engine rule may be meant for another gate, and a gate's
 * own rule may serve questions asked through it as an Asker. A rule whose scope is opaque (a
 * plain function) cannot be checked and is not.
 */
export function checkRuleScopes(
  gate: Pick<GateImpl, "id" | "floors" | "bypass" | "ownQuestion" | "spec">,
  engine: { readonly floors: readonly FloorRule[]; readonly bypass: readonly BypassRule[] },
): void {
  const asked = gate.ownQuestion?.id ?? gate.id;
  const q = gate.spec.question;
  const members = isBattery(q) ? q.map((m) => m.id) : [];
  const memberHit = (scope: string | RegExp): string | undefined =>
    members.find((m) => scopeMatches(scope, m));
  const rules = [
    ...gate.floors.map((r) => ({ r, kind: "floor", owner: "its" })),
    ...gate.bypass.map((r) => ({ r, kind: "bypass", owner: "its" })),
    ...engine.floors.map((r) => ({ r, kind: "floor", owner: "an engine" })),
    ...engine.bypass.map((r) => ({ r, kind: "bypass", owner: "an engine" })),
  ];
  for (const { r, kind, owner } of rules) {
    const scope = questionScope(r);
    if (scope === undefined || scopeMatches(scope, asked)) continue;
    // Only a scope that names one of this battery's members is certainly dead. Any other
    // scope may serve questions asked through the gate as an Asker (`gate.askAll` records
    // them under the gate, with its floors), so it is left alone.
    const member = memberHit(scope);
    if (member === undefined) continue;
    throw new Error(
      `gate ${gate.id}: ${owner} ${kind} scoped to ${showScope(scope)} names battery member "${member}", but floors and bypasses see only the battery's combined question "${asked}", so it would never fire; scope it to "${gate.id}" or test the member's evidence in the rule itself`,
    );
  }
}

/** Run `fn` over `items` with at most `limit` in flight, keeping input order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

/** The engine's implementation of `Gate`. Construct through `engine.gate(spec)`. */
export class GateImpl<V extends Verdict = Verdict> implements Gate<V>, GateContext {
  readonly id: string;
  readonly auditRate: number;
  readonly floors: readonly FloorRule[];
  readonly bypass: readonly BypassRule[];
  readonly tags: readonly string[];
  readonly isBattery: boolean;
  readonly barSource?: { readonly profileHash: string };
  /** The single question this gate owns, or undefined for a battery. */
  readonly ownQuestion: Question | undefined;
  private readonly battery: BatteryPlan | undefined;
  private pinnedMode: Mode | undefined;
  private controller: Rollout | undefined;

  constructor(
    readonly engine: Engine,
    readonly spec: GateSpec,
  ) {
    const id = spec.id;
    if (!id.trim()) throw new Error("gate id must be non-empty");
    if (id.startsWith("adhoc:")) throw new Error(`gate id ${id}: "adhoc:" is reserved`);
    const promise = spec.promisedAccuracy;
    if (promise !== undefined && !(promise > 0 && promise <= 1)) {
      throw new Error(`gate ${id}: promisedAccuracy must be in (0, 1]`);
    }
    const source = spec.barSource;
    if (source !== undefined) {
      if (typeof source.profileHash !== "string" || source.profileHash.trim() === "") {
        throw new Error(`gate ${id}: barSource must name the profile's hash`);
      }
      // Copied, so a later edit to the caller's object cannot relabel rows already promised.
      this.barSource = { profileHash: source.profileHash };
    }
    this.id = id;
    this.auditRate = clamp(spec.auditRate ?? engine.auditRate, 0, 1);
    this.floors = spec.floors ?? [];
    this.bypass = spec.bypass ?? [];
    this.tags = spec.tags ?? [];
    this.pinnedMode = spec.mode;
    const q = spec.question;
    if (isBattery(q)) {
      if (q.length === 0) throw new Error(`gate ${id}: a battery needs at least one member`);
      if (q.some((m) => m.kind !== "judge")) {
        throw new Error(`gate ${id}: battery members must be judge questions`);
      }
      const ids = q.map((m) => m.id);
      if (new Set(ids).size !== ids.length) {
        throw new Error(`gate ${id}: battery member ids must be distinct`);
      }
      if (ids.includes(id)) {
        throw new Error(`gate ${id}: a battery member may not share the gate's id`);
      }
      if (spec.strategy !== undefined && spec.strategy !== "single") {
        throw new Error(
          `gate ${id}: a battery is asked in one request; strategies are per question`,
        );
      }
      const { combine, method, key } = combinerFor(spec.combine, q.length, id);
      this.battery = {
        question: { kind: "judge", id, prompt: `battery ${id}: ${ids.join(", ")}` },
        members: q,
        combine,
        method,
        questionHash: hashState(JSON.stringify({ battery: q, combine: key })),
      };
      this.isBattery = true;
      this.ownQuestion = undefined;
    } else {
      if (spec.combine !== undefined) {
        throw new Error(`gate ${id}: combine applies to batteries only`);
      }
      this.battery = undefined;
      this.isBattery = false;
      this.ownQuestion = q;
    }
  }

  get mode(): Mode {
    return this.pinnedMode ?? this.engine.mode;
  }

  get questionHash(): string {
    return this.battery?.questionHash ?? hashQuestion(this.ownQuestion as Question);
  }

  set mode(m: Mode) {
    this.pinnedMode = m;
  }

  get rollout(): Rollout {
    if (!this.controller) {
      const promise = this.spec.promisedAccuracy;
      if (promise === undefined) {
        throw new Error(`gate ${this.id} has no promisedAccuracy; a rollout needs a promise`);
      }
      this.controller = new Rollout({
        ...(this.spec.rollout ?? {}),
        gate: this,
        promisedAccuracy: promise,
      });
    }
    return this.controller;
  }

  private optionsFor(opts: GateAskOptions): AskOptions {
    return {
      policy: this.spec.policy,
      ...(this.spec.evidenceVersion !== undefined
        ? { evidenceVersion: this.spec.evidenceVersion }
        : {}),
      ...(this.spec.strategy !== undefined ? { strategy: this.spec.strategy } : {}),
      ...(opts.baseline !== undefined ? { baseline: opts.baseline } : {}),
      ...(opts.tags !== undefined ? { tags: opts.tags } : {}),
    };
  }

  async ask(state: StateInput, opts: GateAskOptions = {}): Promise<AskResult<V>> {
    const o = this.optionsFor(opts);
    if (this.battery) {
      return (await this.engine.runBattery(state, this, this.battery, o)) as AskResult<V>;
    }
    const question = this.ownQuestion as Question;
    const [r] = await this.engine.runLanes(state, [{ gate: this, question, opts: o }]);
    if (!r) throw new Error(`gate ${this.id}: engine returned no result`);
    return r as AskResult<V>;
  }

  askMany(states: readonly StateInput[], opts: GateAskManyOptions = {}): Promise<AskResult<V>[]> {
    const { concurrency, ...rest } = opts;
    return mapLimit(states, concurrency ?? 8, (s) => this.ask(s, rest));
  }

  askAll(
    state: StateInput,
    questions: readonly Question[],
    opts: AskOptions | ((q: Question) => AskOptions),
  ): Promise<AskResult[]> {
    const optsFor = typeof opts === "function" ? opts : () => opts;
    return this.engine.runLanes(
      state,
      questions.map((question) => ({ gate: this, question, opts: optsFor(question) })),
    );
  }

  report(opts: ReportOptions = {}): Promise<QuestionReport> {
    return this.engine.gateReport(this.id, opts);
  }
}
