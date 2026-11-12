import {
  type AcceptancePlan,
  type AcceptanceResult,
  earliestAccepted,
  evaluateAcceptance,
  failedWindow,
  isPlannedAct,
  type ResolvedPlan,
  resolvePlan,
} from "./acceptance.ts";
import type { Engine } from "./engine.ts";
import type { Gate } from "./gate.ts";
import { actWasRight, recordedGoIsYes } from "./ledger/calibration.ts";
import {
  type EvidenceGrade,
  type GradeOptions,
  gradeOf,
  type MeasuredGrade,
} from "./ledger/evidence.ts";
import {
  type DecisionRecord,
  decisionRows,
  hashState,
  type Ledger,
  type Mode,
  settledWithoutAnswer,
} from "./ledger/ledger.ts";
import type { TrustRegistry } from "./ledger/sources.ts";
import { hashPolicy } from "./policy.ts";

/** Identity of evidence eligible for this deployment, never inferred from old successes. */
export interface RolloutEvidence {
  /** Caller owns versions of model/configuration, strategy, rules and state semantics. */
  readonly version: string;
  /** Exact recorded model. Use a pinned provider model, not a moving alias. */
  readonly model?: string;
  /** Required for engine-level rollout; gates derive this from their current policy. */
  readonly policyHash?: string;
  /** Required for engine-level rollout; gates derive their own rubric/battery identity. */
  readonly questionHash?: string;
}

/**
 * The planned sample that promoted a gate, carried by its enforce checkpoint so a restore can
 * check it against the ledger: the phase it was drawn from begins after `from` (null: the
 * target's first row) and ends at the checkpoint's `afterId`, and `sample` is its acts' ids.
 */
export interface AcceptedSample {
  readonly from: string | null;
  readonly sample: readonly string[];
}

/**
 * Caller-persisted continuation, bound to configuration and a ledger-order boundary. Format 2
 * adds `rejected`, so a configuration that failed its acceptance test cannot be retried until it
 * passes by luck merely by restarting. Format 3 adds `accepted` to an enforce checkpoint: the
 * planned sample that promoted it, which a restore re-derives from the ledger and re-evaluates
 * before honouring enforce (e2e T4-10). Format 1 and 2 checkpoints still load; an enforce one
 * restores enforce only on the earliest planned sample the ledger accepts, and is written back
 * as format 3 with it (e2e V1); see `docs/rollout.md`.
 */
export type RolloutCheckpoint =
  | {
      readonly format: 1;
      readonly scopeHash: string;
      readonly mode: Mode;
      /** Last target row at the phase boundary, including rows not yet labelled. */
      readonly afterId: string | null;
    }
  | {
      readonly format: 2;
      readonly scopeHash: string;
      readonly mode: Mode;
      readonly afterId: string | null;
      /** True once this configuration's planned sample was evaluated and failed. */
      readonly rejected: boolean;
    }
  | {
      readonly format: 3;
      readonly scopeHash: string;
      readonly mode: Mode;
      readonly afterId: string | null;
      readonly rejected: boolean;
      /** On an enforce checkpoint, and only there: the planned sample that promoted it. */
      readonly accepted?: AcceptedSample;
    };

export interface RolloutSettings {
  readonly questionId?: string;
  /** Acceptance: one-sided confidence of the exact lower bound. Default 0.95. */
  readonly confidence?: number;
  /** Acceptance: wrong acts the planned sample may hold and still pass. Default 0. */
  readonly maxErrors?: number;
  /** Acceptance: rows sharing a tag with this prefix are one group, capped at `maxPerGroup` acts. */
  readonly group?: AcceptancePlan["group"];
  /**
   * Acceptance: trust classes whose labels count, read through the engine's `labelTrust`.
   * Default blind, census and unsourced labels.
   */
  readonly sources?: AcceptancePlan["sources"];
  /** Demotion: the most recent audited rows of the current enforce phase that are read. */
  readonly window?: number;
  /** Demotion: audited rows needed before audits can demote. Default 30. */
  readonly minAuditRows?: number;
  /** Gates may derive the version from GateSpec.evidenceVersion; engine use is explicit. */
  readonly evidence?: RolloutEvidence;
  /** Validate before restoring mode. An invalid checkpoint starts fresh in shadow. */
  readonly checkpoint?: RolloutCheckpoint;
  readonly now?: () => string;
}

export type RolloutOptions = RolloutSettings & {
  readonly promisedAccuracy: number;
} & ({ readonly engine: Engine } | { readonly gate: Gate });

/** What the current enforce phase's blind audits show. */
export interface AuditWindow {
  readonly n: number;
  readonly acted: number;
  readonly accuracy: number;
}

export interface RolloutStatus {
  readonly mode: Mode;
  readonly changed: boolean;
  readonly reason: string;
  /**
   * In shadow, the planned sample's progress and, once complete, its one verdict. Until then it
   * reports no accuracy: a figure read at every evaluation is what optional stopping feeds on.
   */
  readonly acceptance?: AcceptanceResult;
  /** In enforce, the current phase's audited acts, which can demote the gate. */
  readonly audits?: AuditWindow;
  /**
   * What the current phase's evidence supports (`gradeOf`). In shadow: measured once the
   * planned sample is accepted, which is the only grade that promotes, else estimated from the
   * phase's labelled shadow rows, else none with its reason. In enforce: what the phase's blind
   * audits support, which can demote but never promote. A phase that has just begun has none.
   */
  readonly grade: EvidenceGrade;
  readonly promisedAccuracy: number;
  readonly gateId?: string;
  readonly at: string;
}

interface Target {
  readonly ledger: Ledger;
  readonly trust: TrustRegistry;
  readonly gateId: string | undefined;
  readonly mode: () => Mode;
  readonly setMode: (m: Mode) => void;
  readonly auditRate: () => number;
}

interface Scope {
  readonly hash: string;
  readonly version: string;
  readonly model?: string;
  readonly policyHash: string;
  readonly questionHash: string;
  readonly plan: ResolvedPlan;
  readonly window: number;
  readonly minAuditRows: number;
}

/**
 * The controller's state: a format 3 checkpoint, with `legacy` set on an enforce state restored
 * from a format 1 or 2 checkpoint, which names no sample: the restore looks for one in the
 * ledger and writes the state back as format 3 with it, or holds shadow.
 */
type State = Extract<RolloutCheckpoint, { format: 3 }> & { readonly legacy?: true };

/** Start a new phase: set the mode and the state a checkpoint will carry. */
type Boundary = (mode: Mode, rejected?: boolean, accepted?: AcceptedSample) => void;

type Report = (
  reason: string,
  evidence: Pick<RolloutStatus, "grade" | "acceptance" | "audits">,
) => RolloutStatus;

/** Grade a phase's rows through the target's label trust; the labels date the grade. */
type Grader = (
  phase: readonly DecisionRecord[],
  extra?: Pick<GradeOptions, "acceptance" | "sources">,
) => EvidenceGrade;

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
const pct = (x: number, places = 1): string => `${(100 * x).toFixed(places)}%`;

function validAccepted(value: unknown): value is AcceptedSample {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).sort().join(",") === "from,sample" &&
    (v.from === null || nonempty(v.from)) &&
    Array.isArray(v.sample) &&
    v.sample.length > 0 &&
    v.sample.every(nonempty) &&
    new Set(v.sample).size === v.sample.length
  );
}

function validCheckpoint(value: unknown): value is RolloutCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  const shape =
    (v.format === 1 && keys === "afterId,format,mode,scopeHash") ||
    (v.format === 2 &&
      keys === "afterId,format,mode,rejected,scopeHash" &&
      typeof v.rejected === "boolean") ||
    (v.format === 3 &&
      typeof v.rejected === "boolean" &&
      (keys === "afterId,format,mode,rejected,scopeHash" ||
        // Only an enforce checkpoint carries a sample; a shadow one with a sample is not ours.
        (keys === "accepted,afterId,format,mode,rejected,scopeHash" &&
          v.mode === "enforce" &&
          validAccepted(v.accepted))));
  return (
    shape &&
    hash(v.scopeHash) &&
    (v.mode === "shadow" || v.mode === "enforce") &&
    (v.afterId === null || nonempty(v.afterId))
  );
}

function upgradeCheckpoint(c: RolloutCheckpoint): State {
  if (c.format === 3) {
    return {
      format: 3,
      scopeHash: c.scopeHash,
      mode: c.mode,
      afterId: c.afterId,
      rejected: c.rejected,
      ...(c.accepted !== undefined
        ? { accepted: { from: c.accepted.from, sample: [...c.accepted.sample] } }
        : {}),
    };
  }
  const rejected = c.format === 2 ? c.rejected : false;
  const base = { format: 3 as const, scopeHash: c.scopeHash, mode: c.mode, afterId: c.afterId };
  // An older enforce checkpoint names no sample: the restore must find one in the ledger.
  return { ...base, rejected, ...(c.mode === "enforce" ? { legacy: true as const } : {}) };
}

/**
 * Evidence-gated rollout. Promotion runs one planned acceptance test (see `acceptance.ts`): the
 * first acts of a fresh shadow phase, fixed before their labels are read, must reach the
 * promised accuracy by an exact one-sided bound. Demotion reads the current enforce phase's
 * blind audits and errs toward caution: once enough audits exist, an observed accuracy below
 * the promise returns the gate to shadow. A gate with no audits cannot be demoted by evidence,
 * and its promotion says so.
 *
 * Each transition starts a new phase that consumes everything before it, labelled or not, so
 * old successes and late labels cannot carry over. A rejected configuration stays in shadow
 * until something in its identity changes. Initialize before collecting evidence; persist the
 * checkpoint yourself, since a controller without one warms up again in shadow. One controller
 * owns a target. This is a sound test under its stated assumptions, not a certification.
 */
export class Rollout {
  readonly history: RolloutStatus[] = [];
  private state: State | undefined;
  private initialized = false;
  private invalidCheckpoint = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly opts: RolloutOptions) {
    if (opts.checkpoint !== undefined) {
      if (validCheckpoint(opts.checkpoint)) this.state = upgradeCheckpoint(opts.checkpoint);
      else this.invalidCheckpoint = true;
    }
  }

  /**
   * Copy as plain JSON after evaluation; Ratchet does not persist controller state. Format 3,
   * with the accepted sample on an enforce checkpoint (one restored from format 1 or 2 carries
   * the sample its restore found in the ledger).
   */
  checkpoint(): RolloutCheckpoint | undefined {
    const s = this.state;
    if (!this.initialized || !s) return undefined;
    const { scopeHash, mode, afterId, rejected } = s;
    return {
      format: 3,
      scopeHash,
      mode,
      afterId,
      rejected,
      ...(s.accepted !== undefined
        ? { accepted: { from: s.accepted.from, sample: [...s.accepted.sample] } }
        : {}),
    };
  }

  private target(): Target {
    if ("gate" in this.opts) {
      const g = this.opts.gate;
      return {
        ledger: g.engine.ledger,
        trust: g.engine.labelTrust,
        gateId: g.id,
        mode: () => g.mode,
        setMode: (m) => {
          g.mode = m;
        },
        auditRate: () => g.auditRate,
      };
    }
    const e = this.opts.engine;
    return {
      ledger: e.ledger,
      trust: e.labelTrust,
      gateId: undefined,
      mode: () => e.mode,
      setMode: (m) => {
        e.mode = m;
      },
      auditRate: () => e.auditRate,
    };
  }

  private scope(): Scope | string {
    const o = this.opts;
    const g = "gate" in o ? o.gate : undefined;
    const e = o.evidence;
    const version = e?.version ?? g?.spec.evidenceVersion;
    if (!nonempty(version)) return "evidence version is required";
    if (g && version !== g.spec.evidenceVersion) return "gate and rollout evidence versions differ";
    if (e?.model !== undefined && !nonempty(e.model)) return "model pin must be non-empty";
    const policyHash = g ? hashPolicy(g.spec.policy) : e?.policyHash;
    const questionHash = g ? g.questionHash : e?.questionHash;
    if (!hash(policyHash) || !hash(questionHash)) {
      return "engine rollout requires explicit policyHash and questionHash";
    }
    if (
      g &&
      ((e?.policyHash !== undefined && e.policyHash !== policyHash) ||
        (e?.questionHash !== undefined && e.questionHash !== questionHash))
    ) {
      return "explicit evidence hashes differ from the gate";
    }
    const window = o.window ?? 200;
    const minAuditRows = o.minAuditRows ?? 30;
    if (![window, minAuditRows].every((n) => Number.isSafeInteger(n) && n > 0)) {
      return "rollout requires positive integer audit limits";
    }
    let plan: ResolvedPlan;
    try {
      plan = resolvePlan({
        target: o.promisedAccuracy,
        ...(o.confidence !== undefined ? { confidence: o.confidence } : {}),
        ...(o.maxErrors !== undefined ? { maxErrors: o.maxErrors } : {}),
        ...(o.group !== undefined ? { group: o.group } : {}),
        ...(o.sources !== undefined ? { sources: o.sources } : {}),
      });
    } catch (err) {
      return `invalid acceptance plan: ${err instanceof Error ? err.message : String(err)}`;
    }
    return {
      hash: hashState(
        JSON.stringify({
          gateId: g?.id ?? null,
          questionId: o.questionId ?? null,
          version,
          model: e?.model ?? null,
          policyHash,
          questionHash,
          plan: plan.hash,
          window,
          minAuditRows,
        }),
      ),
      version,
      ...(e?.model !== undefined ? { model: e.model } : {}),
      policyHash,
      questionHash,
      plan,
      window,
      minAuditRows,
    };
  }

  /** Decision rows recorded under this configuration, in ledger order, labelled or not. */
  private eligible(rows: readonly DecisionRecord[], scope: Scope): DecisionRecord[] {
    return decisionRows(rows).filter(
      (r) =>
        r.policyHash === scope.policyHash &&
        r.questionHash === scope.questionHash &&
        r.evidenceVersion === scope.version &&
        (scope.model === undefined || r.model === scope.model),
    );
  }

  private audits(rows: readonly DecisionRecord[], scope: Scope): AuditWindow {
    const audited = this.eligible(rows, scope)
      .filter((r) => r.outcome && !r.failedOpen && !settledWithoutAnswer(r))
      .filter((r) => r.mode === "enforce" && r.tags.includes("audit"))
      .slice(-scope.window);
    const acted = audited.filter((r) => r.soft === "act");
    const right = acted.filter((r) => {
      const polarity = recordedGoIsYes(r);
      if (r.verdict.kind === "judge" && polarity === undefined) return false;
      return actWasRight(r, polarity ?? true) === true;
    }).length;
    return {
      n: audited.length,
      acted: acted.length,
      accuracy: acted.length ? right / acted.length : 0,
    };
  }

  /** Serialize calls on this controller so two snapshots cannot each consume the same phase. */
  evaluate(): Promise<RolloutStatus> {
    const result = this.pending.then(() => this.evaluateNow());
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async evaluateNow(): Promise<RolloutStatus> {
    const target = this.target();
    const rows = (await target.ledger.all()).filter(
      (r) =>
        (target.gateId === undefined || r.gateId === target.gateId) &&
        (this.opts.questionId === undefined || r.questionId === this.opts.questionId),
    );
    const scope = this.scope();
    const before = target.mode();
    const at = (this.opts.now ?? (() => new Date().toISOString()))();
    const promised = this.opts.promisedAccuracy;
    const status: Report = (reason, evidence) => {
      const value: RolloutStatus = {
        mode: target.mode(),
        changed: before !== target.mode(),
        reason,
        ...evidence,
        promisedAccuracy: promised,
        ...(target.gateId !== undefined ? { gateId: target.gateId } : {}),
        at,
      };
      this.history.push(value);
      return value;
    };
    const graded: Grader = (phase, extra = {}) => gradeOf(phase, { trust: target.trust, ...extra });
    const boundary: Boundary = (mode, rejected = false, accepted) => {
      target.setMode(mode);
      this.state =
        typeof scope === "string"
          ? undefined
          : {
              format: 3,
              scopeHash: scope.hash,
              mode,
              afterId: rows.at(-1)?.id ?? null,
              rejected,
              ...(mode === "enforce" && accepted !== undefined ? { accepted } : {}),
            };
      this.initialized = true;
      this.invalidCheckpoint = false;
    };
    if (typeof scope === "string") {
      boundary("shadow");
      return status(`holding shadow: ${scope}`, { grade: graded([]) });
    }
    const state = this.state;
    let reset: string | undefined;
    let start = 0;
    if (this.invalidCheckpoint) reset = "invalid checkpoint";
    else if (!state) reset = "no checkpoint; initialized before collecting fresh evidence";
    else if (state.scopeHash !== scope.hash) reset = "evidence configuration changed";
    else if (state.afterId !== null) {
      const anchor = rows.findIndex((r) => r.id === state.afterId);
      if (anchor < 0) reset = "checkpoint anchor missing or belongs to another target";
      else start = anchor + 1;
    } else if (!this.initialized && rows.length > 0) {
      reset = "empty checkpoint has no verifiable anchor in this nonempty ledger";
    }
    if (!reset && state && this.initialized && target.mode() !== state.mode) {
      reset = "mode changed outside this controller";
    }
    // A restored enforce checkpoint is honoured only while the ledger still holds the planned
    // sample that promoted it, labelled so that it still passes, and no earlier planned sample
    // of the configuration failed (e2e T4-10, V1). An older format is verified the same way.
    let verified: AcceptedSample | undefined;
    if (!reset && state && !this.initialized && state.mode === "enforce") {
      const v = this.verify(rows, start - 1, scope, state, target.trust);
      if ("why" in v) reset = v.why;
      else verified = v.accepted;
    }
    if (reset) {
      boundary("shadow");
      return status(`holding shadow: ${reset}`, { grade: graded([]) });
    }
    // Only a fully validated checkpoint may restore enforce after a restart.
    if (state) target.setMode(state.mode);
    if (state && verified !== undefined) {
      const { legacy: _legacy, ...rest } = state;
      this.state = { ...rest, accepted: verified };
    }
    this.initialized = true;
    const fresh = rows.slice(start);
    if (
      scope.model !== undefined &&
      fresh.some(
        (r) =>
          r.questionHash === scope.questionHash &&
          r.policyHash === scope.policyHash &&
          r.evidenceVersion === scope.version &&
          !r.failedOpen &&
          !settledWithoutAnswer(r) &&
          r.model !== scope.model,
      )
    ) {
      boundary("shadow");
      return status("holding shadow: a new answer's recorded model differs from the pinned model", {
        grade: graded([]),
      });
    }
    if (target.mode() === "enforce") {
      return this.watch(fresh, scope, target, status, boundary, graded);
    }
    if (state?.rejected) {
      const shadowRows = this.eligible(fresh, scope).filter((r) => r.mode === "shadow");
      return status(
        "holding shadow: this configuration was rejected; change its rubric, policy, model, plan or evidence version to test a new one",
        { grade: graded(shadowRows, { sources: scope.plan.sources }) },
      );
    }
    return this.accept(
      rows,
      fresh,
      scope,
      target,
      status,
      boundary,
      graded,
      state?.afterId ?? null,
    );
  }

  /**
   * The scope's eligible shadow rows since its last enforce row, among `rows` up to `end`: the
   * stretch any planned sample of the current configuration is drawn from, as the ledger alone
   * shows it, whatever phase boundaries a checkpoint claims.
   */
  private stretch(
    rows: readonly DecisionRecord[],
    scope: Scope,
    end = rows.length,
  ): DecisionRecord[] {
    const eligible = this.eligible(rows.slice(0, end), scope);
    let start = eligible.length;
    while (start > 0 && eligible[start - 1]?.mode !== "enforce") start--;
    return eligible.slice(start).filter((r) => r.mode === "shadow");
  }

  /**
   * Verify a restored enforce checkpoint against the ledger (e2e T4-10, V1): the planned sample
   * that promoted it must still be drawn from the ledger and pass on its labels, and no planned
   * sample of this configuration that could have been drawn before it may already have failed,
   * so a rejected configuration stays rejected however a checkpoint sets its phase start. A
   * format 3 checkpoint names its sample; for a format 1 or 2 one, the earliest sample the
   * ledger accepts before the anchor stands in, and is written back as format 3. Returns why
   * it cannot be honoured, or the sample it rests on.
   */
  private verify(
    rows: readonly DecisionRecord[],
    anchor: number,
    scope: Scope,
    state: State,
    trust: TrustRegistry,
  ): { readonly why: string } | { readonly accepted: AcceptedSample } {
    if (anchor < 0) return { why: "the enforce checkpoint has no anchor in this ledger" };
    const plan = scope.plan;
    const stretch = this.stretch(rows, scope, anchor + 1);
    const index = new Map(rows.map((r, i) => [r.id, i]));
    let sample: readonly string[];
    let from: string | null;
    const claimed = state.accepted;
    if (claimed !== undefined) {
      const start = claimed.from === null ? -1 : (index.get(claimed.from) ?? -2);
      if (start === -2)
        return { why: "the accepted sample's phase no longer starts in this ledger" };
      if (start >= anchor) {
        return { why: "the accepted sample's phase does not end at the checkpoint's anchor" };
      }
      const phase = stretch.filter((r) => (index.get(r.id) ?? -1) > start);
      const result = evaluateAcceptance(phase, plan, trust);
      if (result.status !== "accepted") {
        return {
          why: `the accepted sample no longer passes on the ledger's labels (${result.status})`,
        };
      }
      const same =
        result.sample.length === claimed.sample.length &&
        result.sample.every((id, i) => id === claimed.sample[i]);
      if (!same)
        return { why: "the ledger's planned sample is not the one the checkpoint accepted" };
      sample = result.sample;
      from = claimed.from;
    } else if (state.legacy) {
      const found = earliestAccepted(stretch, plan, trust);
      const failed = found === undefined ? failedWindow(stretch, plan, trust) : undefined;
      if (failed !== undefined) {
        return {
          why: `this configuration already failed a planned sample on this ledger (the one starting at ${failed[0]?.id}), so it stays rejected; change its rubric, policy, model, plan or evidence version to test a new one`,
        };
      }
      if (found === undefined) {
        return {
          why: "the format 1 or 2 enforce checkpoint names no sample, and no planned sample before its anchor passes on the ledger's labels",
        };
      }
      sample = found.map((r) => r.id);
      const first = index.get(sample[0] as string) ?? 0;
      from = first > 0 ? (rows[first - 1]?.id ?? null) : null;
    } else {
      return { why: "the enforce checkpoint carries no accepted planned sample" };
    }
    // Any complete planned sample of this configuration up to the anchor, before or after the
    // one the checkpoint rests on, that already failed keeps it rejected (e2e V1 round 2).
    const failed = failedWindow(stretch, plan, trust);
    if (failed !== undefined) {
      return {
        why: `this configuration already failed a planned sample on this ledger (the one starting at ${failed[0]?.id}), so it stays rejected; change its rubric, policy, model, plan or evidence version to test a new one`,
      };
    }
    return { accepted: { from, sample: [...sample] } };
  }

  /**
   * Shadow mode: run the planned acceptance test on the fresh phase's shadow rows. The grade
   * decides promotion, not the acceptance status read here: only a measured grade has a way in.
   * A planned sample this configuration already failed on the ledger before the phase, under a
   * checkpoint that was lost, rejects it now: a rejection outlasts its checkpoint (e2e V1).
   */
  private accept(
    rows: readonly DecisionRecord[],
    fresh: readonly DecisionRecord[],
    scope: Scope,
    target: Target,
    status: Report,
    boundary: Boundary,
    graded: Grader,
    phaseStart: string | null,
  ): RolloutStatus {
    const shadowRows = this.eligible(fresh, scope).filter((r) => r.mode === "shadow");
    const acceptance = evaluateAcceptance(shadowRows, scope.plan, target.trust);
    const plan = scope.plan;
    const promised = this.opts.promisedAccuracy;
    // A sample of the phase's own that failed is reported as the plan's verdict, below. Before
    // promoting, no planned sample of the configuration on the ledger may have failed, wherever
    // it starts; while the phase is still filling, those that start before it are checked, so a
    // rejection recorded under a lost checkpoint holds at once (e2e V1).
    const firstAct = shadowRows.find(isPlannedAct)?.id;
    const failed =
      acceptance.status === "rejected"
        ? undefined
        : failedWindow(
            this.stretch(rows, scope),
            plan,
            target.trust,
            acceptance.status === "accepted" ? undefined : firstAct,
          );
    if (failed !== undefined) {
      boundary("shadow", true);
      return status(
        `rejected: this configuration already failed a planned sample on this ledger (the one starting at ${failed[0]?.id}); change its rubric, policy, model, plan or evidence version to test a new one`,
        { grade: graded(shadowRows, { sources: plan.sources }) },
      );
    }
    const grade = graded(shadowRows, { acceptance, sources: plan.sources });
    if (grade.kind === "measured") {
      return this.promote(grade, acceptance, scope, target, status, boundary, phaseStart);
    }
    switch (acceptance.status) {
      case "collecting":
        return status(`holding: ${acceptance.acts} of ${plan.sampleSize} planned acts collected`, {
          grade,
          acceptance,
        });
      case "awaiting-labels": {
        const untrusted =
          acceptance.untrusted !== undefined
            ? `; ${acceptance.untrusted} of them carry only labels from sources the plan does not read`
            : "";
        return status(
          `holding: the planned sample is complete; ${acceptance.unlabelled} of its ${plan.sampleSize} acts await labels before the one evaluation${untrusted}`,
          { grade, acceptance },
        );
      }
      case "accepted":
        // gradeOf measures every accepted sample, so this is a broken contract, not a verdict:
        // refuse loudly rather than record a rejection the evidence does not hold.
        throw new Error("an accepted planned sample did not grade measured");
      case "rejected":
        boundary("shadow", true);
        return status(
          `rejected: ${acceptance.errors} wrong of ${plan.sampleSize} planned acts; exact ${pct(plan.confidence, 0)} lower bound ${pct(acceptance.lowerBound, 2)} < promised ${pct(promised)}`,
          { grade, acceptance },
        );
    }
  }

  /**
   * The one way into enforce. It takes the measured variant of the grade and nothing wider, so
   * promoting on an estimate is a compile error, and it checks again at run time for a caller
   * that cast its way past the type. There is no override and no provisional mode.
   */
  private promote(
    grade: MeasuredGrade,
    acceptance: AcceptanceResult,
    scope: Scope,
    target: Target,
    status: Report,
    boundary: Boundary,
    phaseStart: string | null,
  ): RolloutStatus {
    const kind = (grade as EvidenceGrade).kind;
    if (kind !== "measured") throw new TypeError(`only a measured grade promotes; got ${kind}`);
    if (grade.plan.hash !== scope.plan.hash) {
      throw new TypeError("only a grade measured under this rollout's plan promotes");
    }
    if (acceptance.status !== "accepted") {
      throw new TypeError(`only an accepted planned sample promotes; got ${acceptance.status}`);
    }
    // The checkpoint carries the sample, so a restore can check the ledger still holds it.
    boundary("enforce", false, { from: phaseStart, sample: [...acceptance.sample] });
    const unwatched =
      target.auditRate() > 0
        ? ""
        : "; audits are off, so no evidence can demote this gate: set an audit rate to watch it";
    return status(
      `promoted: ${grade.errors} wrong of ${grade.sampleSize} planned acts; exact ${pct(grade.plan.confidence, 0)} lower bound ${pct(grade.lowerBound, 2)} >= promised ${pct(this.opts.promisedAccuracy)}${unwatched}`,
      { grade, acceptance },
    );
  }

  /** Enforce mode: demote when the current phase's audited acts break the promise. */
  private watch(
    fresh: readonly DecisionRecord[],
    scope: Scope,
    target: Target,
    status: Report,
    boundary: Boundary,
    graded: Grader,
  ): RolloutStatus {
    const audits = this.audits(fresh, scope);
    const grade = graded(this.eligible(fresh, scope), { sources: scope.plan.sources });
    const promised = this.opts.promisedAccuracy;
    if (audits.n >= scope.minAuditRows && audits.accuracy < promised) {
      boundary("shadow");
      return status(
        `demoted: ${audits.acted} audited acts at ${pct(audits.accuracy)} below promised ${pct(promised)}`,
        { grade, audits },
      );
    }
    // Judged once enough audits exist, whatever the audit rate is now (e2e T1-10: "need 30 to
    // judge" was printed after 40 had been judged).
    const watching =
      audits.n >= scope.minAuditRows
        ? `${audits.acted} audited acts at ${pct(audits.accuracy)} hold the promised ${pct(promised)}`
        : target.auditRate() > 0
          ? `need ${scope.minAuditRows} to judge`
          : "audits are off, so nothing can demote this gate";
    return status(`live: ${audits.n} current-phase audited rows; ${watching}`, { grade, audits });
  }
}
