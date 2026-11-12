/**
 * Freeze V4's policies from wave-1 fit data only, with the new engine, before any fresh call.
 *
 * Study A (tool gate): T1's fit-split rows of the live run (gate `t1.toolgate`, evidence version
 * `t1-toolgate-fit-v1`, tag `split:fit`, blind decider labels), read the way `report` now reads
 * a gate: `fitActBar`, act side, conservative (95% Wilson lower bound at the promise), support
 * 30. The bar is `actAbove` as the report states it ("act above X"). Promise 0.95; when no
 * conservative bar exists there, the 0.90 conservative bar is frozen as a second, explicitly
 * secondary policy.
 *
 * Study B (moderation battery): T3's moderation fit-split requests (gate `mod.action`, combined
 * rows, not floored, items whose corpus split is `fit`), their member answers re-pooled with
 * each combiner: `any` (noisy-OR, what the gate's `combine: "any"` does), `logodds` (the gate
 * default) and a learned logistic combiner fitted here on the same rows (`fitLogistic`, Newton).
 * The act is publishing without a moderator (`goIsYes: false`), so each bar is fitted on
 * P(no action) against whether publishing was right, conservative, support 30, at 0.95 and,
 * as the secondary, 0.90. The point bars are recorded beside them for reading only.
 *
 *   bun experiments/e2e/verify/v4-fresh/freeze.ts      prints the freeze; writes nothing
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { poolJudge } from "../../../../src/compound/aggregate.ts";
import {
  batteryFeatures,
  fitLogistic,
  type LogisticModel,
  poolLearned,
} from "../../../../src/compound/learned.ts";
import {
  type ActBar,
  describeActBar,
  fitActBar,
  SATURATION_CUT,
} from "../../../../src/ledger/bars.ts";
import { fitThreshold, type Scored, wilsonLower } from "../../../../src/ledger/calibration.ts";
import { type DecisionRecord, JsonlLedger } from "../../../../src/ledger/ledger.ts";
import { type GatePolicy, hashPolicy } from "../../../../src/policy.ts";
import type { JudgeVerdict } from "../../../../src/types.ts";
import { E2E_OUT, ROOT, sha256 } from "../../lib.ts";
import { SUB_QUESTIONS } from "./mod-corpus.ts";

export const T1_RUN = join(E2E_OUT, "t1-toolgate", "2026-11-12T10-22-04-541Z-live");
export const T1_LEDGER = join(T1_RUN, "ledger.jsonl");
export const T1_GATE = "t1.toolgate";
export const T1_FIT_VERSION = "t1-toolgate-fit-v1";
export const T3_RUN = join(E2E_OUT, "t3-triage", "2026-11-12T10-19-41-682Z-live");
export const T3_LEDGER = join(T3_RUN, "moderation.jsonl");
export const T3_GATE = "mod.action";
const T3_MOD_CORPUS = join(ROOT, "experiments", "e2e", "t3-triage", "corpus", "moderation.json");

/** The promise, the secondary target, and the support every bar needs (REPORT_DEFAULTS). */
export const PROMISE = 0.95;
export const SECONDARY = 0.9;
export const MIN_SUPPORT = 30;
/** Wave 1's pre-registered act bar on T1 (0.57 point bar at 98% plus a 0.05 band). */
export const WAVE1_ACT_ABOVE = 0.62;

export interface FrozenBar {
  readonly target: number;
  readonly actAbove?: number;
  readonly policy?: GatePolicy;
  readonly policyHash?: string;
  /** Fit-set acts at or above the bar, their precision and its Wilson lower bound. */
  readonly fitActs?: number;
  readonly fitPrecision?: number;
  readonly fitLower?: number;
  readonly fitCoverage?: number;
  /** The point-estimate bar at the same target, for reading only. */
  readonly pointBar?: number;
  readonly sentence: string;
}

const fileHash = (path: string): string => sha256(readFileSync(path, "utf8"));

function frozen(bar: ActBar, target: number, goIsYes: boolean): FrozenBar {
  const f = bar.fitted;
  const sentence = describeActBar(bar, { target, minSupport: MIN_SUPPORT, minEstimated: 30 });
  const point = bar.pointFitted?.threshold;
  if (f === undefined)
    return { target, ...(point !== undefined ? { pointBar: point } : {}), sentence };
  const policy: GatePolicy = goIsYes
    ? { actAbove: f.threshold }
    : { actAbove: f.threshold, goIsYes: false };
  return {
    target,
    actAbove: f.threshold,
    policy,
    policyHash: hashPolicy(policy),
    fitActs: f.n,
    fitPrecision: f.accuracy,
    fitLower: wilsonLower(f.accuracy, f.n),
    fitCoverage: f.coverage,
    ...(point !== undefined ? { pointBar: point } : {}),
    sentence,
  };
}

/** A bar from scored items the same way `fitActBar` reads rows (conservative, support 30). */
function barFromScored(items: readonly Scored[]): (target: number) => ActBar {
  return (target) => {
    const fitted = fitThreshold(items, target, MIN_SUPPORT, { conservative: true });
    const point = fitThreshold(items, target, MIN_SUPPORT);
    return {
      fittedFrom: "unselected",
      fitRows: items.length,
      ...(fitted !== undefined ? { fitted } : {}),
      ...(point !== undefined ? { pointFitted: point } : {}),
    };
  };
}

// ---------------------------------------------------------------------------
// Study A
// ---------------------------------------------------------------------------

export interface ToolFreeze {
  readonly source: {
    readonly ledger: string;
    readonly ledgerSha256: string;
    readonly gate: string;
    readonly evidenceVersion: string;
  };
  readonly fitRows: number;
  readonly fitLabelled: number;
  readonly fitAnswered: number;
  readonly pinnedModel?: string;
  readonly primary: FrozenBar;
  readonly secondary: FrozenBar;
  /** Which frozen policy the live gate registers: the primary when it exists, else the secondary. */
  readonly live: "primary" | "secondary";
  readonly wave1: { readonly policy: GatePolicy; readonly policyHash: string };
  readonly rule: string;
}

export async function freezeTool(): Promise<ToolFreeze> {
  const all = await new JsonlLedger(T1_LEDGER).all();
  const fit = all.filter(
    (r) =>
      r.gateId === T1_GATE && r.evidenceVersion === T1_FIT_VERSION && r.tags.includes("split:fit"),
  );
  if (fit.length === 0) throw new Error("no T1 fit rows found");
  const models = [...new Set(fit.flatMap((r) => (r.model ? [r.model] : [])))];
  const at = (target: number) => fitActBar(fit, { target, minSupport: MIN_SUPPORT });
  const primary = frozen(at(PROMISE), PROMISE, true);
  const secondary = frozen(at(SECONDARY), SECONDARY, true);
  const wave1: GatePolicy = { actAbove: WAVE1_ACT_ABOVE };
  return {
    source: {
      ledger: T1_LEDGER.replace(/\\/g, "/").split("/experiments/")[1] ?? T1_LEDGER,
      ledgerSha256: fileHash(T1_LEDGER),
      gate: T1_GATE,
      evidenceVersion: T1_FIT_VERSION,
    },
    fitRows: fit.length,
    fitLabelled: fit.filter((r) => r.outcome !== undefined).length,
    fitAnswered: fit.filter((r) => r.strategy !== "floored" && !r.failedOpen).length,
    ...(models.length === 1 ? { pinnedModel: models[0] as string } : {}),
    primary,
    secondary,
    live: primary.policy !== undefined ? "primary" : "secondary",
    wave1: { policy: wave1, policyHash: hashPolicy(wave1) },
    rule: `fitActBar(T1 fit-split rows, target, minSupport ${MIN_SUPPORT}): act side, conservative (95% Wilson lower bound >= target); actAbove = the fitted bar, no band. Primary target ${PROMISE}; secondary ${SECONDARY}, frozen too and used live only when the primary has no bar.`,
  };
}

// ---------------------------------------------------------------------------
// Study B
// ---------------------------------------------------------------------------

export const COMBINERS = ["any", "logodds", "learned"] as const;
export type CombinerName = (typeof COMBINERS)[number];

export interface ModRequest {
  readonly state: string;
  readonly truth: boolean;
  readonly members: readonly JudgeVerdict[];
  readonly recordedPYes: number;
}

/** Group a battery's ledger rows into requests with members in battery order. */
export function modRequests(
  rows: readonly DecisionRecord[],
  gate: string,
  truthOf: (state: string) => boolean | undefined,
): ModRequest[] {
  const mine = rows.filter((r) => r.gateId === gate);
  const byRequest = new Map<string, DecisionRecord[]>();
  for (const r of mine) {
    const a = byRequest.get(r.requestId) ?? [];
    a.push(r);
    byRequest.set(r.requestId, a);
  }
  return mine
    .filter((r) => r.combined === true && !r.failedOpen && r.strategy !== "floored")
    .flatMap((c) => {
      const truth = c.state === undefined ? undefined : truthOf(c.state);
      const sibs = byRequest.get(c.requestId) ?? [];
      const ms = SUB_QUESTIONS.map((q) =>
        sibs.find((m) => m.combined !== true && m.questionId === q),
      );
      if (truth === undefined || c.state === undefined || ms.some((m) => m === undefined))
        return [];
      return [
        {
          state: c.state,
          truth,
          members: (ms as DecisionRecord[]).map((m) => m.verdict as JudgeVerdict),
          recordedPYes: (c.verdict as JudgeVerdict).pYes,
        },
      ];
    });
}

export function pYesOf(c: CombinerName, vs: readonly JudgeVerdict[], model: LogisticModel): number {
  switch (c) {
    case "any":
      return poolJudge(vs, { method: "any" }).pYes;
    case "logodds":
      return poolJudge(vs, { method: "logodds" }).pYes;
    case "learned":
      return poolLearned(vs, model).pYes;
  }
}

/** Publishing is the act: go is P(no action); it was right when no action was needed. */
export const publishScored = (
  c: CombinerName,
  rs: readonly ModRequest[],
  model: LogisticModel,
): Scored[] => rs.map((r) => ({ confidence: 1 - pYesOf(c, r.members, model), correct: !r.truth }));

export const saturated = (p: number): boolean => Math.min(p, 1 - p) < SATURATION_CUT;

export interface ModFreeze {
  readonly source: {
    readonly ledger: string;
    readonly ledgerSha256: string;
    readonly gate: string;
    readonly corpus: string;
  };
  readonly fitRequests: number;
  readonly fitNoAction: number;
  /** Max |recorded combined pYes - logodds re-pool| on the fit rows: the re-pool is the gate's. */
  readonly repoolCheck: number;
  /** The report's own act bar on the recorded (logodds) combined rows, for comparison. */
  readonly reportLogodds: { readonly primary: string; readonly secondary: string };
  readonly logistic: LogisticModel & {
    readonly converged?: boolean;
    readonly iterations?: number;
    readonly loss?: number;
  };
  readonly bars: Record<
    CombinerName,
    { readonly primary: FrozenBar; readonly secondary: FrozenBar; readonly fitSaturated: number }
  >;
  readonly live: {
    readonly combine: "any";
    readonly which: "primary" | "secondary" | "none";
    readonly policy: GatePolicy;
    readonly policyHash: string;
  };
  readonly rule: string;
}

export async function freezeModeration(): Promise<ModFreeze> {
  const corpus = JSON.parse(readFileSync(T3_MOD_CORPUS, "utf8")) as {
    items: { state: string; split: "fit" | "heldout"; label: { truth: boolean } }[];
  };
  const fitTruth = new Map(
    corpus.items.filter((i) => i.split === "fit").map((i) => [i.state, i.label.truth]),
  );
  const rows = await new JsonlLedger(T3_LEDGER).all();
  const fit = modRequests(rows, T3_GATE, (s) => fitTruth.get(s));
  if (fit.length === 0) throw new Error("no T3 moderation fit requests found");
  const fitted = fitLogistic(fit.map((r) => ({ x: batteryFeatures(r.members), y: r.truth })));
  const model: LogisticModel = { weights: fitted.weights, bias: fitted.bias };
  const repoolCheck = Math.max(
    ...fit.map((r) => Math.abs(r.recordedPYes - pYesOf("logodds", r.members, model))),
  );
  // The report's reading of the recorded combined rows of the fit split (logodds as recorded).
  const fitStates = new Set(fit.map((r) => r.state));
  const recordedFit = rows.filter(
    (r) =>
      r.gateId === T3_GATE &&
      r.combined === true &&
      r.state !== undefined &&
      fitStates.has(r.state),
  );
  const reportAt = (target: number) =>
    describeActBar(fitActBar(recordedFit, { target, minSupport: MIN_SUPPORT }), {
      target,
      minSupport: MIN_SUPPORT,
      minEstimated: 30,
    });
  const bars = Object.fromEntries(
    COMBINERS.map((c) => {
      const at = barFromScored(publishScored(c, fit, model));
      return [
        c,
        {
          primary: frozen(at(PROMISE), PROMISE, false),
          secondary: frozen(at(SECONDARY), SECONDARY, false),
          fitSaturated:
            fit.filter((r) => saturated(pYesOf(c, r.members, model))).length / fit.length,
        },
      ];
    }),
  ) as ModFreeze["bars"];
  const any = bars.any;
  const which = any.primary.policy ? "primary" : any.secondary.policy ? "secondary" : "none";
  // With no bar at all the gate publishes nothing (go can never reach 1 + epsilon): the honest hold.
  const livePolicy: GatePolicy =
    which === "primary"
      ? (any.primary.policy as GatePolicy)
      : which === "secondary"
        ? (any.secondary.policy as GatePolicy)
        : { actAbove: 1, goIsYes: false };
  return {
    source: {
      ledger: T3_LEDGER.replace(/\\/g, "/").split("/experiments/")[1] ?? T3_LEDGER,
      ledgerSha256: fileHash(T3_LEDGER),
      gate: T3_GATE,
      corpus: "experiments/e2e/t3-triage/corpus/moderation.json (split: fit)",
    },
    fitRequests: fit.length,
    fitNoAction: fit.filter((r) => !r.truth).length,
    repoolCheck,
    reportLogodds: { primary: reportAt(PROMISE), secondary: reportAt(SECONDARY) },
    logistic: {
      ...model,
      ...("converged" in fitted ? { converged: fitted.converged } : {}),
      ...("iterations" in fitted ? { iterations: fitted.iterations } : {}),
      ...("loss" in fitted ? { loss: fitted.loss } : {}),
    },
    bars,
    live: { combine: "any", which, policy: livePolicy, policyHash: hashPolicy(livePolicy) },
    rule: `Each combiner's member re-pool of T3's moderation fit split, publish side (goIsYes false), fitThreshold(conservative, minSupport ${MIN_SUPPORT}) at ${PROMISE} (primary) and ${SECONDARY} (secondary); learned = fitLogistic on the same rows (its bar is in-sample). The live gate combines with "any" at its primary bar, else its secondary.`,
  };
}

if (import.meta.main) {
  const tool = await freezeTool();
  const mod = await freezeModeration();
  process.stdout.write(`${JSON.stringify({ tool, mod }, null, 2)}\n`);
}
