import {
  type AcceptancePlan,
  type AcceptanceProgress,
  type AcceptanceResult,
  acceptanceProgress,
  earliestAccepted,
  evaluateAcceptance,
  failedWindow,
  isPlannedAct,
  type ResolvedPlan,
  resolvePlan,
  rightToAct,
} from "./acceptance.ts";
import {
  type DetectorRule,
  type DetectorSpec,
  demotionAlternatives,
  detectorStatistic,
  falseAlarmBound,
  fewestAlarmErrors,
  outgoingQualityLimit,
  startDetector,
  stepDetector,
  worstOutgoingQuality,
} from "./anytime.ts";
import type { Engine } from "./engine.ts";
import type { Gate } from "./gate.ts";
import {
  type EvidenceGrade,
  type GradeOptions,
  gradeOf,
  type MeasuredGrade,
} from "./ledger/evidence.ts";
import { adjudicateRows } from "./ledger/labels.ts";
import {
  type DecisionRecord,
  decisionRows,
  hashState,
  type Ledger,
  type Mode,
  settledWithoutAnswer,
} from "./ledger/ledger.ts";
import { admits, type TrustRegistry } from "./ledger/sources.ts";
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

/**
 * When an audited act still without a label the plan reads is overdue, and what follows. Ledger
 * order decides, never a timestamp: the first such audit is overdue once `after` audited acts
 * have been recorded after it.
 */
export interface OverdueAudits {
  /** Audited acts recorded after the first unlabelled one that make it overdue: a positive integer. */
  readonly after: number;
  /** "report" says so in the status and changes nothing; "demote" returns the gate to shadow. */
  readonly action: "report" | "demote";
}

/**
 * How the current enforce phase's audits return a gate to shadow.
 *
 * - `window`, the default: once `minAuditRows` audited rows exist, the last `window` of them
 *   demote when their accuracy is below the promise. It has no false-alarm control: at an audit
 *   rate of 0.2 it demotes a healthy 99% gate 47% of the time within 1,000 acts.
 * - `detector`: a mixture e-detector (`stepDetector`) over the phase's audited acts in ledger
 *   order, through the labelled prefix. If every audited act, given those before it, is wrong
 *   with probability at most the promised error rate, it alarms within n audits with
 *   probability at most n/threshold, and its mean run to a false alarm is at least threshold
 *   audits. Defaults: threshold 1000, `DEMOTION_SHIFTS`, rule "shiryaev-roberts".
 * - `first-error`: back to shadow at the first audited act that was wrong. With a zero-error plan
 *   the loop is Dodge's continuous sampling plan CSP-1, whose outgoing quality has a limit.
 *
 * `overdue` (default `{ after: 30, action: "report" }`) handles an audit whose label does not
 * come: never as an error, which would void the detector's guarantee, but as its own matter.
 */
export type DemotionSettings =
  | { readonly kind: "window" }
  | {
      readonly kind: "detector";
      /** The alarm threshold A, a finite number above 1. Default 1000. */
      readonly threshold?: number;
      /** Post-change error rates as multiples of the promised one. Default `DEMOTION_SHIFTS`. */
      readonly shifts?: readonly number[];
      /** Default "shiryaev-roberts"; "cusum" alarms no sooner. */
      readonly rule?: DetectorRule;
      readonly overdue?: OverdueAudits;
    }
  | { readonly kind: "first-error"; readonly overdue?: OverdueAudits };

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
  /**
   * Acceptance: how a planned act's labels are read. Default `latest`, the latest label, as
   * always. `confirm-wrong` counts an act wrong only once a second blind reviewer confirms the
   * "wrong" (a third breaks a tie), and holds the sample awaiting labels until then, because a
   * reviewer's rate of false "wrong" labels can be as large as the promise's whole error budget.
   * It is part of the plan's identity, so opting in starts a fresh phase. Promotion only:
   * demotion reads an audit's latest label under every demotion rule, so an unconfirmed "wrong"
   * audit can still return the gate to shadow, which is the cautious direction (decided
   * 2026-11-12: demotion does not wait for confirmation).
   */
  readonly adjudication?: AcceptancePlan["adjudication"];
  /** Demotion (window rule): the most recent audited rows of the current enforce phase read. */
  readonly window?: number;
  /** Demotion (window rule): audited rows needed before audits can demote. Default 30. */
  readonly minAuditRows?: number;
  /**
   * Demotion: the rule that returns an enforcing gate to shadow. Absent, or `{ kind: "window" }`,
   * is the window rule, unchanged. Any other kind is part of the evidence configuration, so
   * opting into it, or changing it, starts a fresh phase.
   */
  readonly demotion?: DemotionSettings;
  /** Gates may derive the version from GateSpec.evidenceVersion; engine use is explicit. */
  readonly evidence?: RolloutEvidence;
  /** Validate before restoring mode. An invalid checkpoint starts fresh in shadow. */
  readonly checkpoint?: RolloutCheckpoint;
  readonly now?: () => string;
}

export type RolloutOptions = RolloutSettings & {
  readonly promisedAccuracy: number;
} & ({ readonly engine: Engine } | { readonly gate: Gate });

/**
 * What the window rule read of the current enforce phase: its audited acts whose label the
 * plan's sources admit, cut to the last `window`. `n` and `acted` are the same count (a row
 * that was not an act is not an audited act), and `accuracy` is the share of them that were
 * right to act on.
 */
export interface AuditWindow {
  readonly n: number;
  readonly acted: number;
  readonly accuracy: number;
  /** Audited acts of the phase labelled only by a source the plan does not read, when any. */
  readonly untrusted?: number;
}

/**
 * What a `detector` or `first-error` demotion read from the current enforce phase. Recomputed
 * from the ledger at every evaluation; nothing of it is stored in a checkpoint.
 */
export interface AuditReadout {
  /**
   * Audited acts of the phase, labelled or not, in ledger order: enforce rows tagged "audit"
   * that the policy ruled act and an oracle answered without failing open.
   */
  readonly audited: number;
  /**
   * Audited acts the rule read. The detector reads the labelled prefix in ledger order and stops
   * at an alarm; first-error reads every audited act with a label the plan reads.
   */
  readonly read: number;
  /** Of those read, the acts that were wrong to act on. */
  readonly wrong: number;
  /** Audited acts without a label the plan reads: no label, or one only from another source. */
  readonly pending: number;
  /** Of those pending, the acts whose only label came from a source the plan does not read. */
  readonly untrusted: number;
  /** The first pending audited act, and how many audited acts were recorded after it. */
  readonly firstPending?: { readonly id: string; readonly later: number };
  /** True once the first pending audit has at least `overdue.after` audited acts after it. */
  readonly overdue: boolean;
}

export interface DetectorReadout extends AuditReadout {
  readonly kind: "detector";
  readonly rule: DetectorRule;
  /** The mean of the per-shift statistics after the audits read (`detectorStatistic`). */
  readonly statistic: number;
  readonly threshold: number;
  /**
   * `falseAlarmBound(read, threshold)`: for a gate that keeps its promise, the most chance of an
   * alarm within the audits read. It says nothing once they reach the threshold.
   */
  readonly falseAlarmBound: number;
  /** The statistic reached the threshold; the evaluation that reads this demotes the gate. */
  readonly alarmed: boolean;
}

export interface FirstErrorReadout extends AuditReadout {
  readonly kind: "first-error";
}

export type DemotionReadout = DetectorReadout | FirstErrorReadout;

/** The window rule's figures for the phase, as `audits` reports them, with its limits. */
export interface WindowReadout {
  readonly kind: "window";
  readonly audits: AuditWindow;
  readonly window: number;
  readonly minAuditRows: number;
}

/**
 * What `Rollout.progress()` reads of the current phase without changing anything. `none`: there
 * is no phase to read (before the first evaluation, or one the next evaluation will replace),
 * with the reason. `rejected`: the configuration is held in shadow. `shadow`: the planned
 * sample in progress. `enforce`: what the demotion rule has read.
 */
export type RolloutProgress = {
  readonly promisedAccuracy: number;
  readonly gateId?: string;
} & (
  | { readonly phase: "none"; readonly reason: string }
  | { readonly phase: "rejected"; readonly reason: string }
  | { readonly phase: "shadow"; readonly acceptance: AcceptanceProgress }
  | { readonly phase: "enforce"; readonly demotion: DemotionReadout | WindowReadout }
);

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
   * In enforce under a `detector` or `first-error` demotion, in place of `audits`: what the rule
   * read. Never present under the window rule.
   */
  readonly demotion?: DemotionReadout;
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
  readonly demotion: ResolvedDemotion;
}

/** A demotion setting validated, with every default filled. */
type ResolvedDemotion =
  | { readonly kind: "window" }
  | {
      readonly kind: "detector";
      readonly spec: DetectorSpec & { readonly threshold: number; readonly rule: DetectorRule };
      /** The post-change error rates it bets on: what the shifts resolve to at this promise. */
      readonly alternatives: readonly number[];
      readonly overdue: OverdueAudits;
    }
  | { readonly kind: "first-error"; readonly overdue: OverdueAudits };

type AuditRule = Exclude<ResolvedDemotion, { readonly kind: "window" }>;

const DEMOTION_KEYS: Readonly<Record<ResolvedDemotion["kind"], readonly string[]>> = {
  window: ["kind"],
  detector: ["kind", "threshold", "shifts", "rule", "overdue"],
  "first-error": ["kind", "overdue"],
};

/** Validate an overdue setting; a string says why it is invalid. */
function resolveOverdue(value: unknown): OverdueAudits | string {
  if (value === undefined) return { after: 30, action: "report" };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "overdue must be { after, action }";
  }
  const v = value as Record<string, unknown>;
  const extra = Object.keys(v).find((k) => k !== "after" && k !== "action");
  if (extra !== undefined) return `overdue takes no "${extra}" setting`;
  if (!(Number.isSafeInteger(v.after) && (v.after as number) > 0)) {
    return "overdue after must be a positive integer";
  }
  if (v.action !== "report" && v.action !== "demote") {
    return 'overdue action must be "report" or "demote"';
  }
  return { after: v.after as number, action: v.action };
}

/**
 * Validate a demotion setting against the promise and fill its defaults; a string says why it
 * is invalid. Read as untyped, since settings often arrive as parsed JSON: an unknown kind or a
 * setting the kind does not take is refused rather than ignored, so a misplaced option cannot
 * look as if it applied. The detector's own checks (`startDetector`) decide its threshold, shifts
 * and rule.
 */
function resolveDemotion(value: unknown, promise: number): ResolvedDemotion | string {
  if (value === undefined) return { kind: "window" };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "demotion must be an object with a kind";
  }
  const v = value as Record<string, unknown>;
  const kind = v.kind;
  if (kind !== "window" && kind !== "detector" && kind !== "first-error") {
    return `unknown kind "${String(kind)}"; use "window", "detector" or "first-error"`;
  }
  const extra = Object.keys(v).find((k) => !DEMOTION_KEYS[kind].includes(k));
  if (extra !== undefined) return `the ${kind} rule takes no "${extra}" setting`;
  if (kind === "window") return { kind };
  const overdue = resolveOverdue(v.overdue);
  if (typeof overdue === "string") return overdue;
  if (kind === "first-error") return { kind, overdue };
  const spec = {
    promise,
    threshold: (v.threshold === undefined ? 1000 : v.threshold) as number,
    rule: (v.rule === undefined ? "shiryaev-roberts" : v.rule) as DetectorRule,
    ...(v.shifts !== undefined ? { shifts: v.shifts as readonly number[] } : {}),
  };
  try {
    startDetector(spec);
    return { kind, spec, alternatives: demotionAlternatives(promise, spec.shifts), overdue };
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * What a demotion rule adds to the scope hash. The detector is named by the error rates it bets
 * on rather than by the shifts as written, so a change to the module's defaults is a new
 * configuration, while writing the defaults out is not.
 */
function demotionIdentity(d: AuditRule): Readonly<Record<string, unknown>> {
  const overdue = { after: d.overdue.after, action: d.overdue.action };
  if (d.kind === "first-error") return { kind: d.kind, overdue };
  const { threshold, rule } = d.spec;
  return { kind: d.kind, threshold, rule, alternatives: [...d.alternatives], overdue };
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
  evidence: Pick<RolloutStatus, "grade" | "acceptance" | "audits" | "demotion">,
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
 * blind audits and errs toward caution: by default, once enough audits exist, an observed
 * accuracy below the promise returns the gate to shadow; `demotion` opts into a change detector
 * with a stated false-alarm bound, or into a return at the first audited error. A gate with no
 * audits cannot be demoted by evidence, and its promotion says so.
 *
 * Each transition starts a new phase that consumes everything before it, labelled or not, so
 * old successes and late labels cannot carry over. A rejected configuration stays in shadow
 * until something in its identity changes. A gate promoted again after a demotion has passed a
 * second planned test on fresh evidence: each test can promote a gate that breaks its promise
 * with probability up to 1 - confidence, so every re-promotion spends that error budget again
 * (record how many times a gate was promoted, as for configurations tried in turn). Initialize
 * before collecting evidence; persist the checkpoint yourself, since a controller without one
 * warms up again in shadow. One controller owns a target. This is a sound test under its stated
 * assumptions, not a certification.
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
        ...(o.adjudication !== undefined ? { adjudication: o.adjudication } : {}),
      });
    } catch (err) {
      return `invalid acceptance plan: ${err instanceof Error ? err.message : String(err)}`;
    }
    const demotion = resolveDemotion(o.demotion, o.promisedAccuracy);
    if (typeof demotion === "string") return `invalid demotion: ${demotion}`;
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
          // The window rule stays out of the identity, so every checkpoint written before
          // demotion kinds existed keeps its scope; any other rule is part of it.
          ...(demotion.kind === "window" ? {} : { demotion: demotionIdentity(demotion) }),
        }),
      ),
      version,
      ...(e?.model !== undefined ? { model: e.model } : {}),
      policyHash,
      questionHash,
      plan,
      window,
      minAuditRows,
      demotion,
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

  /**
   * What the window rule reads: the phase's audited acts, as the other demotion rules define
   * them (`readDemotion`), with a label the plan's sources admit, as acceptance and the enforce
   * grade read labels. One set of rows gives both `n` and `accuracy`. A label from a source the
   * plan does not read is selected by its outcome (a revert lands on a wrong act, an acceptance
   * on a right one), so it neither demotes a gate nor keeps one enforced; `untrusted` counts
   * those acts, so they are not dropped silently.
   */
  private audits(rows: readonly DecisionRecord[], scope: Scope, trust: TrustRegistry): AuditWindow {
    const filter = { sources: scope.plan.sources, trust };
    const reads = (r: DecisionRecord): boolean =>
      r.outcome !== undefined && admits(filter, r.outcome.source);
    const audited = this.eligible(rows, scope).filter(
      (r) => r.mode === "enforce" && r.tags.includes("audit") && isPlannedAct(r),
    );
    const untrusted = audited.filter((r) => r.outcome !== undefined && !reads(r)).length;
    const read = audited.filter(reads).slice(-scope.window);
    const right = read.filter(rightToAct).length;
    return {
      n: read.length,
      acted: read.length,
      accuracy: read.length ? right / read.length : 0,
      ...(untrusted > 0 ? { untrusted } : {}),
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

  /** The target's rows, in ledger order, labelled or not. */
  private async targetRows(target: Target): Promise<DecisionRecord[]> {
    return (await target.ledger.all()).filter(
      (r) =>
        (target.gateId === undefined || r.gateId === target.gateId) &&
        (this.opts.questionId === undefined || r.questionId === this.opts.questionId),
    );
  }

  /** True when a new answer of the scope's rubric, policy and version recorded another model. */
  private modelDrifted(fresh: readonly DecisionRecord[], scope: Scope): boolean {
    return (
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
    );
  }

  private async evaluateNow(): Promise<RolloutStatus> {
    const target = this.target();
    const rows = await this.targetRows(target);
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
    if (this.modelDrifted(fresh, scope)) {
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
        {
          grade: graded(this.asPlanReads(shadowRows, scope, target.trust), {
            sources: scope.plan.sources,
          }),
        },
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
   * Shadow rows as the plan's label rule reads them (`adjudicateRows`): unchanged under
   * `latest`; under `confirm-wrong`, a settled row carries the label that settled it and a
   * disputed one carries none. Shadow grades read these. Enforce grades stay on the latest
   * label, which is what every demotion rule reads.
   */
  private asPlanReads(
    rows: readonly DecisionRecord[],
    scope: Scope,
    trust: TrustRegistry,
  ): DecisionRecord[] {
    const rule = scope.plan.adjudication;
    return rule === undefined
      ? rows.slice()
      : adjudicateRows(rows, rule, { sources: scope.plan.sources, trust });
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
    // The grade reads each label as the plan's rule does, so it cannot disagree with the test
    // beside it: a disputed act is unlabelled to both, and a settled one carries the label that
    // settled it, which is also the label an accepted sample's sources and date count.
    const read = this.asPlanReads(shadowRows, scope, target.trust);
    if (failed !== undefined) {
      boundary("shadow", true);
      return status(
        `rejected: this configuration already failed a planned sample on this ledger (the one starting at ${failed[0]?.id}); change its rubric, policy, model, plan or evidence version to test a new one`,
        { grade: graded(read, { sources: plan.sources }) },
      );
    }
    const grade = graded(read, { acceptance, sources: plan.sources });
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
    const rate = target.auditRate();
    const unwatched =
      rate > 0
        ? watchedBy(scope, rate)
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
    if (scope.demotion.kind !== "window") {
      return this.detect(fresh, scope, scope.demotion, target, status, boundary, graded);
    }
    const audits = this.audits(fresh, scope, target.trust);
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
    const unread =
      audits.untrusted !== undefined
        ? `; ${plural(audits.untrusted, "audited act")} labelled only from sources the plan does not read`
        : "";
    return status(`live: ${audits.n} current-phase audited rows; ${watching}${unread}`, {
      grade,
      audits,
    });
  }

  /**
   * Enforce mode under a detector or first-error rule. The audited acts are the phase's eligible
   * enforce rows tagged "audit" that the policy ruled act and an oracle answered without failing
   * open, in ledger order and never cut to a window; a label counts when the plan's sources admit
   * it through the target's trust registry, as in acceptance.
   *
   * The detector steps once per audited act through the contiguous labelled prefix only (wrong:
   * acting was not right, as acceptance reads it), and never skips an unlabelled audit to read
   * later ones: when a label's arrival depends on its outcome, reading in arrival order is not
   * valid. Its state is a pure function of that prefix, so it is recomputed from the ledger at
   * every evaluation and a restart reproduces it. First-error reads every labelled audited act:
   * a wrong act anywhere is a wrong act, so a pending audit cannot hide a later one.
   *
   * An unlabelled audit is never a step of either rule (as an error it would void the detector's
   * false-alarm bound); `overdue` reports it, or demotes on it, separately, by ledger order.
   */
  private detect(
    fresh: readonly DecisionRecord[],
    scope: Scope,
    rule: AuditRule,
    target: Target,
    status: Report,
    boundary: Boundary,
    graded: Grader,
  ): RolloutStatus {
    const { readout, firstWrong } = this.readDemotion(fresh, scope, rule, target.trust);
    const grade = graded(this.eligible(fresh, scope), { sources: scope.plan.sources });
    const evidence = { grade, demotion: readout };
    const promised = this.opts.promisedAccuracy;
    if (readout.kind === "detector" && readout.alarmed) {
      boundary("shadow");
      return status(
        `demoted: the ${ruleName(readout.rule)} detector alarmed on ${plural(readout.read, "audited act")} read in ledger order, ${readout.wrong} wrong: statistic ${statistic(readout.statistic)} reached threshold ${readout.threshold}; ${alarmGuarantee(readout, promised)}`,
        evidence,
      );
    }
    if (firstWrong !== undefined) {
      boundary("shadow");
      return status(
        `demoted: audited act ${firstWrong} was wrong to act on, and the first audited error returns the gate to shadow (${readout.read} labelled of ${plural(readout.audited, "audited act")} read, ${readout.wrong} wrong)`,
        evidence,
      );
    }
    const first = readout.firstPending;
    if (readout.overdue && first !== undefined && rule.overdue.action === "demote") {
      boundary("shadow");
      return status(
        `demoted: audit ${first.id} has had no label the plan reads while ${laterAudits(first.later)}, at least the ${rule.overdue.after} allowed; a missing label is never read as an error, so an overdue audit returns the gate to shadow instead`,
        evidence,
      );
    }
    if (readout.audited === 0 && target.auditRate() <= 0) {
      return status(
        "live: 0 current-phase audited acts; audits are off, so nothing can demote this gate",
        evidence,
      );
    }
    const read =
      readout.kind === "detector"
        ? `the ${ruleName(readout.rule)} detector read ${readout.read}, ${readout.wrong} wrong: statistic ${statistic(readout.statistic)} below threshold ${readout.threshold}`
        : `${readout.read} labelled, none wrong; the first audited error returns the gate to shadow`;
    const untrusted =
      readout.untrusted > 0
        ? ` (${readout.untrusted} labelled only from sources it does not read)`
        : "";
    const pending =
      readout.pending === 0
        ? ""
        : `; ${readout.pending} still without a label the plan reads${untrusted}${readout.kind === "detector" ? ", and the detector reads nothing past the first of them" : ""}`;
    const overdue =
      readout.overdue && first !== undefined
        ? `; overdue: audit ${first.id} has had no label the plan reads while ${laterAudits(first.later)}`
        : "";
    const off = target.auditRate() > 0 ? "" : "; audits are off now, so no new audit is drawn";
    return status(
      `live: ${plural(readout.audited, "current-phase audited act")}; ${read}${pending}${overdue}${off}`,
      evidence,
    );
  }

  /**
   * What a detector or first-error rule reads from the phase (see `detect`), and for
   * first-error the first wrong audited act, which demotes.
   */
  private readDemotion(
    fresh: readonly DecisionRecord[],
    scope: Scope,
    rule: AuditRule,
    trust: TrustRegistry,
  ): { readonly readout: DemotionReadout; readonly firstWrong?: string } {
    const filter = { sources: scope.plan.sources, trust };
    const reads = (r: DecisionRecord): boolean =>
      r.outcome !== undefined && admits(filter, r.outcome.source);
    const audited = this.eligible(fresh, scope).filter(
      (r) => r.mode === "enforce" && r.tags.includes("audit") && isPlannedAct(r),
    );
    const labelled = audited.filter(reads);
    const at = audited.findIndex((r) => !reads(r));
    const first = at < 0 ? undefined : audited[at];
    const later = audited.length - 1 - at;
    const counts = {
      audited: audited.length,
      pending: audited.length - labelled.length,
      untrusted: audited.filter((r) => r.outcome !== undefined && !reads(r)).length,
      ...(first !== undefined ? { firstPending: { id: first.id, later } } : {}),
      overdue: first !== undefined && later >= rule.overdue.after,
    };
    if (rule.kind === "first-error") {
      const wrong = labelled.filter((r) => !rightToAct(r));
      const firstWrong = wrong[0]?.id;
      const { audited: n, ...rest } = counts;
      return {
        readout: {
          kind: "first-error",
          audited: n,
          read: labelled.length,
          wrong: wrong.length,
          ...rest,
        },
        ...(firstWrong !== undefined ? { firstWrong } : {}),
      };
    }
    const spec = rule.spec;
    let state = startDetector(spec);
    let wrong = 0;
    for (const r of audited) {
      if (state.alarmed || !reads(r)) break;
      const error = !rightToAct(r);
      if (error) wrong++;
      state = stepDetector(spec, state, error);
    }
    const { audited: n, ...rest } = counts;
    return {
      readout: {
        kind: "detector",
        rule: spec.rule,
        audited: n,
        read: state.audits,
        wrong,
        ...rest,
        statistic: detectorStatistic(state),
        threshold: spec.threshold,
        falseAlarmBound: falseAlarmBound(state.audits, spec.threshold),
        alarmed: state.alarmed,
      },
    };
  }

  /**
   * Read the current phase without evaluating it: nothing is promoted, demoted, rejected or
   * written, `history` is untouched and the checkpoint stays as it was. In shadow it is the
   * planned sample in progress (`acceptanceProgress` over the phase's shadow rows); in enforce,
   * what the demotion rule has read (under the window rule, the figures `audits` reports).
   *
   * Before the first `evaluate()` it returns phase "none" and reads nothing: that evaluation is
   * what places the phase boundary after the rows already present, or verifies a restored
   * checkpoint against the ledger, so until it runs there is no phase, and reading one would
   * count history the evaluation excludes or show an enforce phase it may refuse. It also
   * returns "none", with the reason, when the next evaluation would start a fresh phase (the
   * configuration changed or is invalid, the anchor is gone, the mode was changed outside the
   * controller, or a new answer came from another model than the pin). It does not search the
   * ledger for a planned sample that failed before the phase (e2e V1), which the next
   * evaluation does, so a shadow readout can look healthy for a configuration that evaluation
   * rejects. Calls queue behind `evaluate()`, so a readout never interleaves with a transition.
   */
  progress(): Promise<RolloutProgress> {
    const result = this.pending.then(() => this.progressNow());
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async progressNow(): Promise<RolloutProgress> {
    const target = this.target();
    const head = {
      promisedAccuracy: this.opts.promisedAccuracy,
      ...(target.gateId !== undefined ? { gateId: target.gateId } : {}),
    };
    const none = (reason: string): RolloutProgress => ({ ...head, phase: "none", reason });
    const fresh = "the next evaluate() starts a fresh shadow phase";
    if (!this.initialized) {
      return none(
        "not evaluated yet: the first evaluate() places the phase boundary, or verifies the checkpoint, so there is no phase to read",
      );
    }
    const scope = this.scope();
    if (typeof scope === "string") return none(`holding shadow: ${scope}`);
    const state = this.state;
    if (!state) return none(`no phase yet; ${fresh}`);
    if (state.scopeHash !== scope.hash) return none(`the evidence configuration changed; ${fresh}`);
    if (target.mode() !== state.mode) {
      return none(`the mode was changed outside this controller; ${fresh}`);
    }
    const rows = await this.targetRows(target);
    let start = 0;
    if (state.afterId !== null) {
      const anchor = rows.findIndex((r) => r.id === state.afterId);
      if (anchor < 0) return none(`the phase's anchor is missing from the ledger; ${fresh}`);
      start = anchor + 1;
    }
    const phase = rows.slice(start);
    if (this.modelDrifted(phase, scope)) {
      return none(`a new answer's recorded model differs from the pinned model; ${fresh}`);
    }
    if (state.mode === "enforce") {
      const d = scope.demotion;
      const demotion: DemotionReadout | WindowReadout =
        d.kind === "window"
          ? {
              kind: "window",
              audits: this.audits(phase, scope, target.trust),
              window: scope.window,
              minAuditRows: scope.minAuditRows,
            }
          : this.readDemotion(phase, scope, d, target.trust).readout;
      return { ...head, phase: "enforce", demotion };
    }
    if (state.rejected) {
      return {
        ...head,
        phase: "rejected",
        reason:
          "this configuration was rejected; change its rubric, policy, model, plan or evidence version to test a new one",
      };
    }
    const shadowRows = this.eligible(phase, scope).filter((r) => r.mode === "shadow");
    return {
      ...head,
      phase: "shadow",
      acceptance: acceptanceProgress(shadowRows, scope.plan, target.trust),
    };
  }
}

const ruleName = (rule: DetectorRule): string => (rule === "cusum" ? "CUSUM" : "Shiryaev-Roberts");

/** A detector statistic rounded down, so a value below its threshold never prints as reaching it. */
function statistic(x: number): string {
  return x < 100 ? (Math.floor(x * 100) / 100).toFixed(2) : String(Math.floor(x));
}

/** A small share to three significant figures. */
function pct3(x: number): string {
  const v = 100 * x;
  return v > 0 && v < 0.001 ? "under 0.001%" : `${v.toPrecision(3)}%`;
}

/** "1 audited act", "4 audited acts". */
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

const laterAudits = (n: number): string =>
  n === 1 ? "1 later one was audited" : `${n} later ones were audited`;

/**
 * The detector's guarantee at the audits it read, in plain words: n/A while it says something
 * (`falseAlarmBound`), then the mean run to a false alarm.
 */
function alarmGuarantee(d: DetectorReadout, promised: number): string {
  const keeps = `for a gate that keeps its promised ${pct(promised)}`;
  return d.read < d.threshold
    ? `${keeps}, an alarm within ${plural(d.read, "audit")} has probability at most ${pct(d.falseAlarmBound, 2)}`
    : `${keeps}, the mean number of audits to a false alarm is at least ${d.threshold}`;
}

/**
 * What a promotion says about the rule that will watch the gate, at its audit rate (above 0).
 * The window rule adds nothing, as before.
 *
 * Detector: the fewest consecutive audited errors that can demote it (`fewestAlarmErrors`), and
 * the acts that many audits take on average at the audit rate, k / rate.
 *
 * First error, with a zero-error plan: the loop is then Dodge's continuous sampling plan CSP-1,
 * whose clearance is the planned sample (no enforce phase starts until the first `sampleSize`
 * acts of a shadow phase are all right) and whose sampling fraction is the audit rate, so its
 * outgoing quality has a limit: at most `outgoingQualityLimit` of act-eligible decisions become
 * wrong executed acts at any stationary error rate, and at most `worstOutgoingQuality` against
 * any error sequence that cannot see the audit draw. Both rest on what the controller cannot
 * check: audit labels are correct and arrive, and are evaluated, before the next act; the audit
 * draw is unpredictable and independent of whether the act is right; every shadow decision is
 * made and labelled by a person; and, for the stationary figure, acts are independent at one
 * error rate. A planned sample that fails keeps the gate in shadow for good, which only lowers
 * these figures. When the plan allows errors its clearance is not a run of right acts, so no
 * limit is stated.
 */
function watchedBy(scope: Scope, rate: number): string {
  const d = scope.demotion;
  if (d.kind === "window") return "";
  if (d.kind === "detector") {
    const name = `a ${ruleName(d.spec.rule)} detector at threshold ${d.spec.threshold}`;
    let fewest: number;
    try {
      fewest = fewestAlarmErrors(d.spec);
    } catch {
      return `; demotion: ${name}, which no run of fewer than a million audited errors can trip`;
    }
    const errors = fewest === 1 ? "a single audited error" : `${fewest} consecutive audited errors`;
    return `; demotion: ${name}; ${errors} can demote it, about ${plural(Math.round(fewest / rate), "act")} at an audit rate of ${rate}`;
  }
  const first = "; demotion: the first audited error returns it to shadow";
  const plan = scope.plan;
  if (plan.maxErrors > 0) {
    return `${first}; no outgoing-quality limit is stated, because the plan allows ${plural(plan.maxErrors, "wrong act")} in its planned sample`;
  }
  const limit = outgoingQualityLimit(plan.sampleSize, rate).limit;
  const worst = worstOutgoingQuality(plan.sampleSize, rate);
  return `${first}; as a continuous sampling plan with a ${plan.sampleSize}-act clearance, at most ${pct3(limit)} of act-eligible decisions become wrong executed acts at any stationary error rate, and ${pct3(worst)} against any error sequence that cannot see the audit draw, if audit labels are correct and prompt`;
}

/**
 * One or two plain sentences for a progress readout (`Rollout.progress()`), for an application
 * to print or log. Pure: it reads only the value given.
 */
export function describeProgress(p: RolloutProgress): string {
  switch (p.phase) {
    case "none":
      return `No phase to read: ${p.reason}.`;
    case "rejected":
      return `Holding shadow: ${p.reason}.`;
    case "shadow":
      return describeSample(p.acceptance);
    case "enforce":
      return describeWatch(p.demotion, p.promisedAccuracy);
  }
}

function describeSample(a: AcceptanceProgress): string {
  const plan = a.plan;
  const head = `Planned sample: ${a.acts} of ${a.sampleSize} acts collected`;
  if (a.acts === 0) return `${head}; nothing to read yet.`;
  const prefix =
    a.prefix.acts === a.acts
      ? ""
      : `; the labelled prefix is ${plural(a.prefix.acts, "act")} long (${a.prefix.wrong} wrong)`;
  const untrusted =
    a.untrusted > 0 ? `; ${a.untrusted} labelled only from sources the plan does not read` : "";
  const doomed = a.cannotPass
    ? `; with ${a.wrong} wrong, more than the ${plan.maxErrors} the plan allows, the sample cannot pass unless a label is corrected`
    : "";
  return `${head}, ${a.labelled} labelled by sources the plan reads (${a.wrong} wrong)${prefix}${untrusted}. Running ${pct(plan.confidence, 0)} lower bound on accuracy ${pct(a.lowerBound, 2)}, valid at every look; it decides nothing, the planned test alone promotes${doomed}.`;
}

function describeWatch(d: DemotionReadout | WindowReadout, promised: number): string {
  if (d.kind === "window") {
    const a = d.audits;
    return `Window rule: ${plural(a.n, "current-phase audited row")}, ${plural(a.acted, "act")} at ${pct(a.accuracy)} against the promised ${pct(promised)}. It judges the last ${d.window} once ${d.minAuditRows} exist.`;
  }
  const first = d.firstPending;
  const overdue =
    d.overdue && first !== undefined
      ? `, the first (${first.id}) overdue with ${plural(first.later, "later audit")}`
      : "";
  const pending =
    d.pending === 0 ? "" : `; ${d.pending} still without a label the plan reads${overdue}`;
  const audited = plural(d.audited, "current-phase audited act");
  if (d.kind === "first-error") {
    const next =
      d.wrong > 0
        ? "One was wrong, so the next evaluation returns the gate to shadow."
        : "The first audited error returns the gate to shadow.";
    return `First-error rule: ${audited}, ${d.read} labelled (${d.wrong} wrong)${pending}. ${next}`;
  }
  const alarmed = d.alarmed ? ", so the next evaluation returns the gate to shadow" : "";
  return `${ruleName(d.rule)} detector: ${audited}, ${d.read} read through the labelled prefix (${d.wrong} wrong)${pending}. Statistic ${statistic(d.statistic)} against threshold ${d.threshold}${alarmed}; ${alarmGuarantee(d, promised)}.`;
}
