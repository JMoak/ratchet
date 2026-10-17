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
import { hashState, type Mode } from "./ledger/ledger.ts";
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
 * How a battery's members become one judge verdict.
 * - a `PoolMethod` ("logodds", "max", "min", ...) or `PoolOptions` goes through `pool`. Use
 *   the options form to state the members' error correlation: decomposed questions about one
 *   state on one model are not independent voters, and the pool shrinks by the design effect
 *   only when told to. Measure it from the ledger.
 * - a `LogisticModel` goes through `poolLearned`: weights fitted on labelled member rows.
 * - a function is called with the member verdicts in battery order.
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
  /** For batteries: how members become one judge verdict. Default "logodds" at correlation 0. */
  readonly combine?: Combiner;
  readonly policy: GatePolicy;
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
