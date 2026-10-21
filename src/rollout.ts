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

/** Caller-persisted continuation, bound to configuration and a ledger-order boundary. */
export interface RolloutCheckpoint {
  readonly format: 1;
  readonly scopeHash: string;
  readonly mode: Mode;
  /** Last target row at the phase boundary, including rows not yet labelled. */
  readonly afterId: string | null;
}

export interface RolloutSettings {
  readonly questionId?: string;
  /** Most recent eligible labelled rows in the current phase, in ledger insertion order. */
  readonly window?: number;
  readonly minShadowRows?: number;
  readonly minAuditRows?: number;
  readonly minActed?: number;
  /** Gates may derive the version from GateSpec.evidenceVersion; engine use is explicit. */
  readonly evidence?: RolloutEvidence;
  /** Validate before restoring mode. An invalid checkpoint starts fresh in shadow. */
  readonly checkpoint?: RolloutCheckpoint;
  readonly now?: () => string;
}

export type RolloutOptions = RolloutSettings & {
  readonly promisedAccuracy: number;
} & ({ readonly engine: Engine } | { readonly gate: Gate });

export interface RolloutStatus {
  readonly mode: Mode;
  readonly changed: boolean;
  readonly reason: string;
  readonly window: { readonly n: number; readonly acted: number; readonly accuracy: number };
  readonly promisedAccuracy: number;
  readonly gateId?: string;
  readonly at: string;
}

interface Target {
  readonly ledger: Ledger;
  readonly gateId: string | undefined;
  readonly mode: () => Mode;
  readonly setMode: (m: Mode) => void;
}

interface Scope {
  readonly hash: string;
  readonly version: string;
  readonly model?: string;
  readonly policyHash: string;
  readonly questionHash: string;
}

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{16}$/.test(value);

function validCheckpoint(value: unknown): value is RolloutCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).sort().join(",") === "afterId,format,mode,scopeHash" &&
    v.format === 1 &&
    hash(v.scopeHash) &&
    (v.mode === "shadow" || v.mode === "enforce") &&
    (v.afterId === null || nonempty(v.afterId))
  );
}

/**
 * Empirical rollout, not statistical certification. Initialize before collecting evidence.
 * Promotion and demotion consume the entire current phase, including unlabelled rows.
 * Only fresh shadow rows can promote; only current enforce audits can demote.
 * One controller owns a target. Persist checkpoints yourself; missing state warms up again.
 */
export class Rollout {
  readonly history: RolloutStatus[] = [];
  private state: RolloutCheckpoint | undefined;
  private initialized = false;
  private invalidCheckpoint = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly opts: RolloutOptions) {
    if (opts.checkpoint !== undefined) {
      if (validCheckpoint(opts.checkpoint)) this.state = { ...opts.checkpoint };
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
    const thresholds = {
      window: o.window ?? 200,
      minShadowRows: o.minShadowRows ?? 100,
      minAuditRows: o.minAuditRows ?? 30,
      minActed: o.minActed ?? 20,
    };
    if (
      !(o.promisedAccuracy > 0 && o.promisedAccuracy <= 1) ||
      !Object.values(thresholds).every((n) => Number.isSafeInteger(n) && n > 0)
    ) {
      return "rollout requires a promise in (0, 1] and positive integer sample limits";
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
          promisedAccuracy: o.promisedAccuracy,
          ...thresholds,
        }),
      ),
      version,
      ...(e?.model !== undefined ? { model: e.model } : {}),
      policyHash,
      questionHash,
    };
  }

  private select(
    rows: readonly DecisionRecord[],
    audited: boolean,
    scope: Scope,
  ): DecisionRecord[] {
    return decisionRows(rows)
      .filter((r) => r.outcome && !r.failedOpen && !settledWithoutAnswer(r))
      .filter(
        (r) =>
          r.policyHash === scope.policyHash &&
          r.questionHash === scope.questionHash &&
          r.evidenceVersion === scope.version &&
          (scope.model === undefined || r.model === scope.model),
      )
      .filter((r) =>
        audited ? r.mode === "enforce" && r.tags.includes("audit") : r.mode === "shadow",
      )
      .slice(-(this.opts.window ?? 200));
  }

  private actedAccuracy(rows: readonly DecisionRecord[]): { acted: number; accuracy: number } {
    const acted = rows.filter((r) => r.soft === "act");
    const right = acted.filter((r) => {
      const polarity = recordedGoIsYes(r);
      if (r.verdict.kind === "judge" && polarity === undefined) return false;
      return actWasRight(r, polarity ?? true) === true;
    }).length;
    return { acted: acted.length, accuracy: acted.length ? right / acted.length : 0 };
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
    const status = (reason: string, window = { n: 0, acted: 0, accuracy: 0 }): RolloutStatus => {
      const value: RolloutStatus = {
        mode: target.mode(),
        changed: before !== target.mode(),
        reason,
        window,
        promisedAccuracy: promised,
        ...(target.gateId !== undefined ? { gateId: target.gateId } : {}),
        at,
      };
      this.history.push(value);
      return value;
    };
    const boundary = (mode: Mode): void => {
      target.setMode(mode);
      this.state =
        typeof scope === "string"
          ? undefined
          : { format: 1, scopeHash: scope.hash, mode, afterId: rows.at(-1)?.id ?? null };
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
    const live = target.mode() === "enforce";
    const selected = this.select(fresh, live, scope);
    const { acted, accuracy } = this.actedAccuracy(selected);
    const window = { n: selected.length, acted, accuracy };
    if (!live) {
      const enough =
        selected.length >= (this.opts.minShadowRows ?? 100) && acted >= (this.opts.minActed ?? 20);
      if (enough && accuracy >= promised) {
        boundary("enforce");
        return status(
          `promoted: ${acted} fresh shadow acts at ${(100 * accuracy).toFixed(1)}% >= promised ${(100 * promised).toFixed(1)}%`,
          window,
        );
      }
      return status(
        enough
          ? `holding: shadow acts at ${(100 * accuracy).toFixed(1)}% below promised ${(100 * promised).toFixed(1)}%`
          : `holding: ${selected.length} fresh labelled shadow rows, ${acted} acts; need ${this.opts.minShadowRows ?? 100} and ${this.opts.minActed ?? 20}`,
        window,
      );
    }
    if (selected.length >= (this.opts.minAuditRows ?? 30) && accuracy < promised) {
      boundary("shadow");
      return status(
        `demoted: ${acted} audited acts at ${(100 * accuracy).toFixed(1)}% below promised ${(100 * promised).toFixed(1)}%`,
        window,
      );
    }
    return status(
      `live: ${selected.length} current-phase audited rows; need ${this.opts.minAuditRows ?? 30} to judge`,
      window,
    );
  }
}
