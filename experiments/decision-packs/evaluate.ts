import {
  type DecisionPack,
  PACKS,
  packQuestion,
  packSpec,
  packState,
  type Teaching,
} from "../../examples/decision-packs/packs.ts";
import { Engine } from "../../src/engine.ts";
import { type DecisionRecord, type Ledger, MemoryLedger } from "../../src/ledger/ledger.ts";
import { judgeVerdictFrom } from "../../src/questions.ts";
import type { Decision, Oracle } from "../../src/types.ts";
import type { Case } from "./curriculum.ts";

export const VARIANTS = ["bare", "rubric", "taught", "strong"] as const;
export type Variant = (typeof VARIANTS)[number];
export const PACK_ARMS = [
  "review-all",
  "bare",
  "rubric",
  "taught-fixed",
  "bare-fit",
  "rubric-fit",
  "taught-fit",
  "strong-fit",
  "cascade",
] as const;
export type PackArm = (typeof PACK_ARMS)[number];
export interface Observation {
  readonly p: number;
  readonly failed: boolean;
  readonly cost: number;
  readonly model: string;
}
export interface LabelledCase {
  readonly item: Case;
  readonly truth: boolean;
  readonly observations: Record<Variant, Observation>;
}
export interface PackBars {
  readonly bare: number | null;
  readonly rubric: number | null;
  readonly taught: number | null;
  readonly strong: number | null;
}
export interface PackResult {
  readonly id: string;
  readonly pack: string;
  readonly arm: PackArm;
  readonly acted: boolean;
  readonly correctAct: boolean;
  readonly wrongAct: boolean;
  readonly missedSupported: boolean;
  readonly cost: number;
  readonly calls: number;
}

export const PACK_PROTOCOL = {
  version: "decision-packs/2",
  source: "curriculum:authored",
  labelStatus: "assistant-authored, not independently reviewed",
  primary: "taught-fixed versus bare at the same 0.98 act bar, per pack",
  secondary:
    "cascade versus strong-fit; correct draft findings, unsupported findings, handoffs and cost",
  grid: [1, 0.995, 0.98, 0.95, 0.9, 0.8, 0.7, 0.5],
  fitMinCorrect: 2,
  fitMaxWrong: 0,
  cascade: "taught accepts at its frozen bar; otherwise strong at its frozen bar",
  promotion: "none; authored labels remain unregistered and cannot promote a recipe",
} as const;

export async function acquire(
  items: readonly Case[],
  oracle: Oracle,
  variant: Variant,
  ledger: Ledger,
  stop: () => boolean = () => false,
): Promise<void> {
  const engine = new Engine({ oracle, ledger, mode: "shadow", keepState: true, timeoutMs: 15000 });
  const gates = new Map(
    PACKS.map((pack) => [
      pack.id,
      engine.gate({
        id: `measure.${pack.id}.${variant}`,
        question: packQuestion(pack, variant === "strong" ? "taught" : variant),
        policy: { actAbove: 0.98 },
        mode: "shadow",
        evidenceVersion: PACK_PROTOCOL.version,
      }),
    ]),
  );
  for (const item of items) {
    if (stop())
      throw new Error(
        "Acquisition stopped after a provider/billing failure; partial records preserved",
      );
    const gate = gates.get(item.pack);
    if (!gate) throw new Error("Unknown pack");
    const result = await gate.ask(packState(item.input), {
      tags: [
        `case:${item.id}`,
        `family:${item.family}`,
        `split:${item.split}`,
        "authored-curriculum",
      ],
    });
    await engine.label(result.recordId, {
      truth: item.supported,
      correct: result.decision.verdict.pYes >= 0.5 === item.supported,
      source: PACK_PROTOCOL.source,
      note: item.rationale,
    });
  }
}

export function observations(
  items: readonly Case[],
  rows: readonly DecisionRecord[],
): LabelledCase[] {
  return items.map((item) => {
    let truth: boolean | undefined;
    const entries = VARIANTS.map((variant) => {
      const matches = rows.filter(
        (row) =>
          row.gateId === `measure.${item.pack}.${variant}` && row.tags?.includes(`case:${item.id}`),
      );
      const row = matches[0];
      if (
        matches.length !== 1 ||
        !row ||
        row.mode !== "shadow" ||
        row.outcome?.source !== PACK_PROTOCOL.source ||
        typeof row.outcome.truth !== "boolean"
      )
        throw new Error(`Missing or ambiguous labelled observation for ${item.id}/${variant}`);
      if (truth !== undefined && truth !== row.outcome.truth)
        throw new Error("Paired labels disagree");
      truth = row.outcome.truth;
      return [
        variant,
        {
          p: row.go,
          failed: row.failedOpen === true,
          cost: row.cost,
          model: row.model ?? row.oracle,
        },
      ] as const;
    });
    return {
      item,
      truth: truth === true,
      observations: Object.fromEntries(entries) as Record<Variant, Observation>,
    };
  });
}

/** Replay through the real gate and entry floors; enforcement is in memory and executes nothing. */
async function replay(
  pack: DecisionPack,
  item: Case,
  observation: Observation,
  teaching: Teaching,
  bar: number | null,
) {
  if (bar === null) return { acted: false, cost: 0, calls: 0 };
  let calls = 0;
  const question = packQuestion(pack, teaching);
  const oracle: Oracle = {
    id: "recorded-observation",
    async decide() {
      calls++;
      const decision: Decision = {
        verdict: judgeVerdictFrom(question, observation.p),
        oracle: "recorded-observation",
        model: observation.model,
        cost: observation.cost,
        latencyMs: 0,
        at: new Date().toISOString(),
        ...(observation.failed ? { failedOpen: true as const } : {}),
      };
      // failOpen strips adapter flags. A recorded failed result must throw again on replay.
      if (observation.failed) throw new Error("Recorded judgment failed");
      return [decision];
    },
  };
  const engine = new Engine({ oracle, ledger: new MemoryLedger() });
  const gate = engine.gate({
    ...packSpec(pack, teaching),
    mode: "enforce",
    auditRate: 0,
    policy: { actAbove: bar },
  });
  const result = await gate.ask(packState(item.input), { tags: ["replay:authored-curriculum"] });
  return { acted: result.action === "act", cost: calls ? observation.cost : 0, calls };
}

export async function evaluate(
  item: LabelledCase,
  arm: PackArm,
  bars: PackBars,
): Promise<PackResult> {
  const pack = PACKS.find((p) => p.id === item.item.pack);
  if (!pack) throw new Error("Unknown pack");
  let result = { acted: false, cost: 0, calls: 0 };
  if (arm !== "review-all") {
    const variant: Variant =
      arm === "strong-fit"
        ? "strong"
        : arm === "bare" || arm === "bare-fit"
          ? "bare"
          : arm === "rubric" || arm === "rubric-fit"
            ? "rubric"
            : "taught";
    const bar =
      arm === "strong-fit"
        ? bars.strong
        : arm === "bare-fit"
          ? bars.bare
          : arm === "rubric-fit"
            ? bars.rubric
            : arm === "taught-fit" || arm === "cascade"
              ? bars.taught
              : 0.98;
    result = await replay(
      pack,
      item.item,
      item.observations[variant],
      variant === "strong" ? "taught" : variant,
      bar,
    );
    if (arm === "cascade" && !result.acted) {
      const next = await replay(pack, item.item, item.observations.strong, "taught", bars.strong);
      result = {
        acted: next.acted,
        cost: result.cost + next.cost,
        calls: result.calls + next.calls,
      };
    }
  }
  return {
    id: item.item.id,
    pack: item.item.pack,
    arm,
    ...result,
    correctAct: result.acted && item.truth,
    wrongAct: result.acted && !item.truth,
    missedSupported: !result.acted && item.truth,
  };
}

export async function fitPack(items: readonly LabelledCase[]): Promise<PackBars> {
  if (items.some((item) => item.item.split !== "fit"))
    throw new Error("Only fit cases may set bars");
  if (new Set(items.map((item) => item.item.pack)).size !== 1)
    throw new Error("Fit one domain recipe at a time");
  const bars: {
    bare: number | null;
    rubric: number | null;
    taught: number | null;
    strong: number | null;
  } = { bare: null, rubric: null, taught: null, strong: null };
  for (const key of VARIANTS) {
    let best = -1;
    for (const bar of PACK_PROTOCOL.grid) {
      const proposed = { ...bars, [key]: bar };
      const results = await Promise.all(
        items.map((item) => evaluate(item, `${key}-fit`, proposed)),
      );
      const correct = results.filter((row) => row.correctAct).length;
      if (
        correct >= PACK_PROTOCOL.fitMinCorrect &&
        !results.some((row) => row.wrongAct) &&
        correct > best
      ) {
        bars[key] = bar;
        best = correct;
      }
    }
  }
  return bars;
}
