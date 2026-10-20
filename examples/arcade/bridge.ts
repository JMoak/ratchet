import { Engine, judge, MemoryLedger, SimOracle, State } from "../../src/index.ts";
import { ledgerView, numeric, objectInput, sandboxMode } from "./shared.ts";

const LOADS = [2, 4, 3, 6, 2] as const;
const MATERIALS = {
  plank: { name: "Timber plank", capacity: 2, cost: 1, anchored: true },
  truss: { name: "Steel truss", capacity: 4, cost: 2, anchored: true },
  stone: { name: "Stone arch", capacity: 6, cost: 3, anchored: true },
  glass: { name: "Glass ribbon", capacity: 1, cost: 1, anchored: true },
  floating: { name: "Floating deck", capacity: 9, cost: 1, anchored: false },
} as const;
type Material = keyof typeof MATERIALS;

function material(value: unknown): value is Material {
  return typeof value === "string" && Object.hasOwn(MATERIALS, value);
}

/**
 * Replaying proposals reconstructs world state without trusting browser-supplied progress.
 * Only actual acts change the toy world; shadow recommendations are never commits.
 */
export async function play(input: unknown) {
  const options = objectInput(input);
  const mode = sandboxMode(options);
  const seed = numeric(options, "seed", 42, 0, 0xffffffff, true);
  const attempts = options.attempts ?? [];
  if (!Array.isArray(attempts) || attempts.length > 30 || !attempts.every(material)) {
    throw new Error("attempts must contain at most 30 known bridge materials.");
  }
  if (options.failJudge !== undefined && typeof options.failJudge !== "boolean") {
    throw new Error("failJudge must be a boolean.");
  }
  const ledger = new MemoryLedger();
  const truths = new Map<string, boolean>();
  const simulator = new SimOracle(
    {
      accuracy: 0.9,
      concentration: 12,
      seed,
      latencyMs: 0,
      costPerQuestion: 0,
      id: "bridge-simulated-engineer",
    },
    (state) => ({ judge: truths.get(state) ?? false }),
  );
  const oracle = options.failJudge
    ? {
        id: "bridge-offline-engineer",
        decide: async () => {
          throw new Error("The simulated engineer is offline.");
        },
      }
    : simulator;
  const engine = new Engine({ oracle, ledger, mode, keepState: true });
  const gate = engine.gate({
    id: "bridge.verify-piece",
    question: judge(
      "Will the proposed anchored bridge piece carry the required load for this span?",
      { id: "bridge.load" },
    ),
    policy: { actAbove: 0.8, refuseBelow: 0.2 },
    floors: [(state) => (state.includes("anchored: false") ? "refuse" : undefined)],
  });
  const built: Material[] = [];
  const history: {
    material: Material;
    span: number;
    load: number;
    capacity: number;
    truth: boolean;
    suggested: string;
    actual: string;
    result: string;
    probability: number;
    failedOpen: boolean;
  }[] = [];
  let score = 0;
  let collapses = 0;
  for (const name of attempts) {
    if (built.length === LOADS.length) break;
    const piece = MATERIALS[name];
    const span = built.length;
    const load = LOADS[span];
    if (load === undefined) throw new Error("The bridge has no remaining span.");
    // Only observed world facts enter the next state, never previous model verdicts.
    const state = State.create("Bridge Builder: reversible toy construction")
      .field("finished_spans", built.length)
      .field("built_materials", built)
      .field("required_load", load)
      .field("proposed_material", name)
      .field("capacity", piece.capacity)
      .field("anchored", piece.anchored)
      .build();
    const truth = piece.anchored && piece.capacity >= load;
    truths.set(state.text, truth); // Synthetic truth belongs only to the simulator.
    const answer = await gate.ask(state);
    let result = mode === "shadow" ? "Observed only" : "Held for review";
    if (answer.action === "act") {
      // Place first, then let the toy world's load test reveal the outcome.
      built.push(name);
      score -= piece.cost;
      if (truth) {
        score += 5;
        result = "Placed · load test passed";
      } else {
        built.pop();
        collapses++;
        result = "Placed · collapsed · last checkpoint restored";
      }
    } else if (answer.action === "refuse") {
      result = piece.anchored ? "Rejected · try a stronger piece" : "Rejected · missing anchor";
    }
    await engine.label(answer.recordId, {
      truth,
      correct: answer.decision.verdict.pYes >= 0.5 === truth,
      note: "Toy load-test truth; floor and failure placeholders are not engineer answers.",
    });
    history.push({
      material: name,
      span: span + 1,
      load,
      capacity: piece.capacity,
      truth,
      suggested: answer.ruling.action,
      actual: answer.action,
      result,
      probability: answer.ruling.go,
      failedOpen: answer.decision.failedOpen ?? false,
    });
  }
  return {
    title: "Bridge Builder",
    mode,
    seed,
    loads: LOADS,
    materials: MATERIALS,
    built,
    history,
    complete: built.length === LOADS.length,
    score,
    collapses,
    remaining: LOADS.length - built.length,
    ledger: await ledgerView(ledger),
  };
}
