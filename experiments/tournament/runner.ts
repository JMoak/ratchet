import { Engine } from "../../src/engine.ts";
import type { DecisionRecord, Ledger } from "../../src/ledger/ledger.ts";
import { SimOracle } from "../../src/oracles/sim.ts";
import { rule } from "../../src/policy.ts";
import { judge, judgeVerdictFrom } from "../../src/questions.ts";
import type { Oracle } from "../../src/types.ts";
import { renderCandidate } from "./corpus.ts";
import type { Arm, Bars, Score, ScoredTask, Selection, Task } from "./types.ts";

export const QUESTION = judge(
  "Does this candidate implementation satisfy EVERY stated requirement for all permitted inputs? Passing the public examples alone is insufficient. Judge only functional correctness, not style.",
  {
    id: "tournament.correct",
    criteria: {
      yes: "Every requirement is met, including edge cases.",
      no: "At least one permitted input violates a requirement.",
    },
  },
);

export const PROTOCOL = {
  version: "tournament/1",
  seed: 20261117,
  candidatesPerTask: 4,
  variantsPerFamily: 3,
  grid: [0.5, 0.7, 0.8, 0.9, 0.95, 0.98, 0.995, 1] as readonly number[],
  fitMinAcceptedTasks: 4,
  fitMaxWrongTasks: 0,
  primaryComparison: "cascade minus tests: correctly completed tasks / all tasks",
  secondaryComparison: "cascade minus strong-fit: cost and correct completions",
  inferenceUnit: "task family, stratified by domain",
  promotion: "none; authored pilot, not representative traffic",
  wrongAcceptCosts: [5, 20, 100],
} as const;

export function simulatedOracles(tasks: readonly Task[]): { cheap: Oracle; strong: Oracle } {
  const truths = new Map(
    tasks.flatMap((t) => t.candidates.map((c) => [renderCandidate(t, c), c.hiddenPass] as const)),
  );
  const truth = (state: string) => ({ judge: truths.get(state) ?? false });
  return {
    cheap: new SimOracle(
      { id: "cheap-sim", seed: 381, accuracy: 0.82, correlation: 0.6, latencyMs: 0 },
      truth,
    ),
    strong: new SimOracle(
      { id: "strong-sim", seed: 907, accuracy: 0.94, correlation: 0.3, latencyMs: 0 },
      truth,
    ),
  };
}

/** Full census, in shadow: even candidates a deployed selector would skip are labelled. */
export async function collect(
  tasks: readonly Task[],
  oracle: Oracle,
  ledger: Ledger,
  tier: "cheap" | "strong",
  progress: (message: string) => void = () => {},
  stop: () => boolean = () => false,
): Promise<void> {
  const engine = new Engine({
    oracle,
    ledger,
    mode: "shadow",
    keepState: true,
    timeoutMs: 15000,
    labelTrust: { "tournament:executable": "blind" },
  });
  const gate = engine.gate({
    id: `tournament.${tier}`,
    question: QUESTION,
    policy: { actAbove: 0.95 },
    evidenceVersion: PROTOCOL.version,
  });
  let n = 0;
  for (const task of tasks) {
    for (const candidate of task.candidates) {
      if (stop()) throw new Error("Acquisition stopped; partial records preserved");
      const answer = await gate.ask(renderCandidate(task, candidate), {
        tags: [
          `task:${task.id}`,
          `candidate:${candidate.id}`,
          `family:${task.family}`,
          `split:${task.split}`,
        ],
      });
      await engine.label(answer.recordId, {
        truth: candidate.hiddenPass,
        correct: answer.decision.verdict.pYes >= 0.5 === candidate.hiddenPass,
        source: "tournament:executable",
        note: "Authored candidate evaluated on public and hidden checks before model calls; bounded test evidence, not a proof over all inputs.",
      });
      if (++n % 12 === 0) progress(`${tier}: ${n} candidates recorded`);
    }
  }
}

function tagged(row: DecisionRecord, prefix: string): string | undefined {
  return row.tags?.find((tag) => tag.startsWith(prefix))?.slice(prefix.length);
}

/** Fitting and analysis recover scores AND labels from the ledger, never from a model answer. */
export function readScoredTasks(
  tasks: readonly Task[],
  rows: readonly DecisionRecord[],
): ScoredTask[] {
  const byKey = new Map<string, DecisionRecord>();
  for (const row of rows) {
    const key = `${row.gateId}|${tagged(row, "task:")}|${tagged(row, "candidate:")}`;
    if (byKey.has(key)) throw new Error(`Duplicate scored candidate: ${key}`);
    byKey.set(key, row);
  }
  return tasks.map((task) => ({
    ...task,
    candidates: task.candidates.map((candidate) => {
      const get = (tier: string): DecisionRecord => {
        const row = byKey.get(`tournament.${tier}|${task.id}|${candidate.id}`);
        if (
          row?.mode !== "shadow" ||
          row.verdict.kind !== "judge" ||
          typeof row.outcome?.truth !== "boolean" ||
          row.outcome.source !== "tournament:executable"
        )
          throw new Error(`Missing unselected labelled row: ${task.id}/${candidate.id}/${tier}`);
        return row;
      };
      const cheap = get("cheap");
      const strong = get("strong");
      if (cheap.outcome?.truth !== strong.outcome?.truth) throw new Error("Paired labels disagree");
      const score = (row: DecisionRecord): Score => ({
        p: row.go,
        cost: row.cost,
        latencyMs: row.latencyMs,
        failed: row.failedOpen === true,
        model: row.model ?? row.oracle,
      });
      return {
        ...candidate,
        hiddenPass: cheap.outcome?.truth === true,
        cheap: score(cheap),
        strong: score(strong),
      };
    }),
  }));
}

/** Use the product policy, including fail-open, instead of reproducing its threshold rules. */
function passes(score: Score, bar: number | null): boolean {
  if (bar === null) return false;
  return (
    rule(
      {
        verdict: judgeVerdictFrom(QUESTION, score.p),
        oracle: score.model,
        model: score.model,
        cost: score.cost,
        latencyMs: score.latencyMs,
        at: "2026-11-17T00:00:00Z",
        ...(score.failed ? { failedOpen: true as const } : {}),
      },
      { actAbove: bar },
    ).action === "act"
  );
}

/** Frozen-pool replay; truth is consulted only for the ceiling and AFTER selection. */
export function select(task: ScoredTask, arm: Arm, bars: Bars, limit = 4): Selection {
  let chosen: ScoredTask["candidates"][number] | undefined;
  let cost = 0;
  let latencyMs = 0;
  let calls = 0;
  let inspected = 0;
  const ask = (score: Score, bar: number | null): boolean => {
    // An unsupported fit hands off without purchasing a judgment.
    if (bar === null) return false;
    cost += score.cost;
    latencyMs += score.latencyMs;
    calls++;
    return passes(score, bar);
  };
  for (const candidate of task.candidates.slice(0, limit)) {
    inspected++;
    let accept = false;
    if (arm === "first") accept = true;
    else if (arm === "ceiling") accept = candidate.publicPass && candidate.hiddenPass;
    else if (candidate.publicPass) {
      switch (arm) {
        case "tests":
          accept = true;
          break;
        case "cheap-fixed":
          accept = ask(candidate.cheap, 0.95);
          break;
        case "cheap-fit":
          accept = ask(candidate.cheap, bars.cheap);
          break;
        case "strong-fit":
          accept = ask(candidate.strong, bars.strong);
          break;
        case "cascade":
          accept =
            ask(candidate.cheap, bars.cascadeCheap) || ask(candidate.strong, bars.cascadeStrong);
          break;
        case "two-keys":
          accept = ask(candidate.cheap, bars.cheap) && ask(candidate.strong, bars.strong);
          break;
      }
    }
    if (accept) {
      chosen = candidate;
      break;
    }
  }
  return {
    task: task.id,
    family: task.family,
    domain: task.domain,
    arm,
    selected: chosen?.id ?? null,
    correct: chosen?.hiddenPass === true,
    wrong: chosen !== undefined && !chosen.hiddenPass,
    solvable: task.candidates.slice(0, limit).some((c) => c.publicPass && c.hiddenPass),
    inspected,
    calls,
    cost,
    latencyMs,
  };
}

export const EMPTY_BARS: Bars = {
  cheap: null,
  strong: null,
  cascadeCheap: null,
  cascadeStrong: null,
};

/** Fit the actual first-accepted TASK outcome, not precision across interchangeable candidates. */
export function fitBars(tasks: readonly ScoredTask[]): Bars {
  if (tasks.some((t) => t.split !== "fit")) throw new Error("Only fit tasks may choose bars");
  const best = (arm: Arm, options: readonly Bars[]): Bars | undefined => {
    let winner: { bars: Bars; correct: number; cost: number } | undefined;
    for (const bars of options) {
      const results = tasks.map((t) => select(t, arm, bars));
      const correct = results.filter((r) => r.correct).length;
      const wrong = results.filter((r) => r.wrong).length;
      const cost = results.reduce((sum, r) => sum + r.cost, 0);
      if (correct < PROTOCOL.fitMinAcceptedTasks || wrong > PROTOCOL.fitMaxWrongTasks) continue;
      if (!winner || correct > winner.correct || (correct === winner.correct && cost < winner.cost))
        winner = { bars, correct, cost };
    }
    return winner?.bars;
  };
  // Descending order makes ties deterministic and cautious; a failed fit stays unsupported.
  const grid = [...PROTOCOL.grid].reverse();
  const cheap =
    best(
      "cheap-fit",
      grid.map((bar) => ({ ...EMPTY_BARS, cheap: bar })),
    )?.cheap ?? null;
  const strong =
    best(
      "strong-fit",
      grid.map((bar) => ({ ...EMPTY_BARS, strong: bar })),
    )?.strong ?? null;
  const choices = [...grid, null];
  const cascade = best(
    "cascade",
    choices.flatMap((a) =>
      choices.map((b) => ({ ...EMPTY_BARS, cascadeCheap: a, cascadeStrong: b })),
    ),
  );
  return {
    cheap,
    strong,
    cascadeCheap: cascade?.cascadeCheap ?? null,
    cascadeStrong: cascade?.cascadeStrong ?? null,
  };
}
