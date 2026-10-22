import {
  type AcceptancePlan,
  type AcceptanceResult,
  evaluateAcceptance,
  type ResolvedPlan,
  resolvePlan,
} from "./acceptance.ts";
import type { Engine } from "./engine.ts";
import type { Gate } from "./gate.ts";
import { actWasRight, recordedGoIsYes } from "./ledger/calibration.ts";
import {
  type DecisionRecord,
  decisionRows,
  hashState,
  type Ledger,
  type Mode,
  settledWithoutAnswer,
} from "./ledger/ledger.ts";
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
 * Caller-persisted continuation, bound to configuration and a ledger-order boundary. Format 2
 * adds `rejected`, so a configuration that failed its acceptance test cannot be retried until it
 * passes by luck merely by restarting. Format 1 checkpoints still load, as never rejected.
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
    };

export interface RolloutSettings {
  readonly questionId?: string;
  /** Acceptance: one-sided confidence of the exact lower bound. Default 0.95. */
  readonly confidence?: number;
  /** Acceptance: wrong acts the planned sample may hold and still pass. Default 0. */
  readonly maxErrors?: number;
  /** Acceptance: rows sharing a tag with this prefix are one group, capped at `maxPerGroup` acts. */
  readonly group?: AcceptancePlan["group"];
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
  readonly promisedAccuracy: number;
  readonly gateId?: string;
  readonly at: string;
}

interface Target {
  readonly ledger: Ledger;
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

type State = Extract<RolloutCheckpoint, { format: 2 }>;

type Report = (
  reason: string,
  evidence?: Pick<RolloutStatus, "acceptance" | "audits">,
) => RolloutStatus;

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
const pct = (x: number, places = 1): string => `${(100 * x).toFixed(places)}%`;

function validCheckpoint(value: unknown): value is RolloutCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(",");
  const shape =
    (v.format === 1 && keys === "afterId,format,mode,scopeHash") ||
    (v.format === 2 &&
      keys === "afterId,format,mode,rejected,scopeHash" &&
      typeof v.rejected === "boolean");
  return (
    shape &&
    hash(v.scopeHash) &&
    (v.mode === "shadow" || v.mode === "enforce") &&
    (v.afterId === null || nonempty(v.afterId))
  );
}

function upgradeCheckpoint(c: RolloutCheckpoint): State {
  return c.format === 2 ? { ...c } : { ...c, format: 2, rejected: false };
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

  /** Copy as plain JSON after evaluation; Ratchet does not persist controller state. */
  checkpoint(): RolloutCheckpoint | undefined {
    return this.initialized && this.state ? { ...this.state } : undefined;
  }

  private target(): Target {
    if ("gate" in this.opts) {
      const g = this.opts.gate;
      return {
        ledger: g.engine.ledger,
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
    const status: Report = (reason, evidence = {}) => {
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
    const boundary = (mode: Mode, rejected = false): void => {
      target.setMode(mode);
      this.state =
        typeof scope === "string"
          ? undefined
          : {
              format: 2,
              scopeHash: scope.hash,
              mode,
              afterId: rows.at(-1)?.id ?? null,
              rejected,
            };
      this.initialized = true;
      this.invalidCheckpoint = false;
    };
    if (typeof scope === "string") {
      boundary("shadow");
      return status(`holding shadow: ${scope}`);
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
    if (reset) {
      boundary("shadow");
      return status(`holding shadow: ${reset}`);
    }
    // Only a fully validated checkpoint may restore enforce after a restart.
    if (state) target.setMode(state.mode);
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
      return status("holding shadow: a new answer's recorded model differs from the pinned model");
    }
    if (target.mode() === "enforce") return this.watch(fresh, scope, target, status, boundary);
    if (state?.rejected) {
      return status(
        "holding shadow: this configuration was rejected; change its rubric, policy, model, plan or evidence version to test a new one",
      );
    }
    return this.accept(fresh, scope, target, status, boundary);
  }

  /** Shadow mode: run the planned acceptance test on the fresh phase's shadow rows. */
  private accept(
    fresh: readonly DecisionRecord[],
    scope: Scope,
    target: Target,
    status: Report,
    boundary: (mode: Mode, rejected?: boolean) => void,
  ): RolloutStatus {
    const shadowRows = this.eligible(fresh, scope).filter((r) => r.mode === "shadow");
    const acceptance = evaluateAcceptance(shadowRows, scope.plan);
    const plan = scope.plan;
    const promised = this.opts.promisedAccuracy;
    switch (acceptance.status) {
      case "collecting":
        return status(`holding: ${acceptance.acts} of ${plan.sampleSize} planned acts collected`, {
          acceptance,
        });
      case "awaiting-labels":
        return status(
          `holding: the planned sample is complete; ${acceptance.unlabelled} of its ${plan.sampleSize} acts await labels before the one evaluation`,
          { acceptance },
        );
      case "accepted": {
        boundary("enforce");
        const unwatched =
          target.auditRate() > 0
            ? ""
            : "; audits are off, so no evidence can demote this gate: set an audit rate to watch it";
        return status(
          `promoted: ${acceptance.errors} wrong of ${plan.sampleSize} planned acts; exact ${pct(plan.confidence, 0)} lower bound ${pct(acceptance.lowerBound, 2)} >= promised ${pct(promised)}${unwatched}`,
          { acceptance },
        );
      }
      case "rejected":
        boundary("shadow", true);
        return status(
          `rejected: ${acceptance.errors} wrong of ${plan.sampleSize} planned acts; exact ${pct(plan.confidence, 0)} lower bound ${pct(acceptance.lowerBound, 2)} < promised ${pct(promised)}`,
          { acceptance },
        );
    }
  }

  /** Enforce mode: demote when the current phase's audited acts break the promise. */
  private watch(
    fresh: readonly DecisionRecord[],
    scope: Scope,
    target: Target,
    status: Report,
    boundary: (mode: Mode) => void,
  ): RolloutStatus {
    const audits = this.audits(fresh, scope);
    const promised = this.opts.promisedAccuracy;
    if (audits.n >= scope.minAuditRows && audits.accuracy < promised) {
      boundary("shadow");
      return status(
        `demoted: ${audits.acted} audited acts at ${pct(audits.accuracy)} below promised ${pct(promised)}`,
        { audits },
      );
    }
    const watching =
      target.auditRate() > 0
        ? `need ${scope.minAuditRows} to judge`
        : "audits are off, so nothing can demote this gate";
    return status(`live: ${audits.n} current-phase audited rows; ${watching}`, { audits });
  }
}
