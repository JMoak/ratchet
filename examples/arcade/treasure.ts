import {
  coverageAt,
  Engine,
  fitThreshold,
  isUnselected,
  judge,
  judgeVerdictFrom,
  MemoryLedger,
  type Oracle,
  reliability,
  scoredForYes,
} from "../../src/index.ts";
import { rng } from "../../src/math.ts";
import { ledgerView, numeric, objectInput, sandboxMode } from "./shared.ts";

const count = 12;
type Phase = "practice" | "expedition";
const landmarks = ["Old pier", "Dune", "Stone arch", "Palm grove", "Lookout", "Tide pool"];

/** Separate seed offsets make the expedition a fresh toy map, with labels outside oracle state. */
function makeMap(seed: number, phase: Phase, terrain: string, compass: string) {
  const terrainOffset = terrain === "coast" ? 17 : terrain === "canyon" ? 101 : 227;
  const random = rng(seed + (phase === "practice" ? 177 : 317_711) + terrainOffset * 73);
  return Array.from({ length: count }, (_, index) => {
    const chance = [0.25, 0.45, 0.65, 0.8, 0.9][Math.floor(random() * 5)] ?? 0.5;
    const truth = random() < chance;
    const probability = compass === "bold" ? (chance >= 0.5 ? 0.94 : 0.06) : chance;
    const landmark = landmarks[index % landmarks.length] ?? "Beach";
    return {
      id: `${phase}.${index + 1}`,
      landmark,
      truth,
      probability,
      state: JSON.stringify({ seed, phase, terrain, site: index + 1, landmark }),
    };
  });
}

export async function play(input: unknown) {
  const data = objectInput(input);
  const seed = numeric(data, "seed", 46, 0, 1_000_000, true);
  const threshold = numeric(data, "threshold", 0.8, 0.5, 1);
  const mode = sandboxMode(data);
  const phase = data.phase ?? "practice";
  if (phase !== "practice" && phase !== "expedition") {
    throw new Error("phase must be practice or expedition.");
  }
  const terrain = data.terrain ?? "coast";
  if (terrain !== "coast" && terrain !== "canyon" && terrain !== "island") {
    throw new Error("terrain must be coast, canyon, or island.");
  }
  const compass = data.compass ?? "honest";
  if (compass !== "honest" && compass !== "bold") {
    throw new Error("compass must be honest or bold.");
  }
  const practice = makeMap(seed, "practice", terrain, compass);
  const expedition = makeMap(seed, "expedition", terrain, compass);
  const signals = new Map(
    [...practice, ...expedition].map((site) => [site.state, site.probability]),
  );
  const oracle: Oracle = {
    id: "treasure.mock-compass",
    decide: async (state, questions) =>
      questions.map((question) => {
        if (question.kind !== "judge") throw new Error("The compass answers judge questions.");
        const probability = signals.get(state);
        if (probability === undefined) throw new Error("Unknown map position.");
        return {
          verdict: judgeVerdictFrom(question, probability),
          oracle: "treasure.mock-compass",
          model: `seeded-treasure-${compass}-v1`,
          at: new Date().toISOString(),
          latencyMs: 0,
          cost: 0,
        };
      }),
  };
  const ledger = new MemoryLedger();
  const engine = new Engine({ oracle, ledger, keepState: true, mode: "shadow", auditRate: 0 });
  const question = judge("Does digging here uncover treasure rather than an empty pit?", {
    id: "treasure.present",
  });
  const practiceGate = engine.gate({
    id: "treasure.practice",
    question,
    policy: { actAbove: threshold },
  });
  const observed = [];
  for (const site of practice) {
    const result = await practiceGate.ask(site.state);
    await engine.label(result.recordId, {
      truth: site.truth,
      correct: result.ruling.go >= 0.5 === site.truth,
    });
    observed.push({
      id: site.id,
      landmark: site.landmark,
      probability: result.ruling.go,
      truth: site.truth,
      suggested: result.ruling.action,
      actual: result.action,
    });
  }
  // Freeze the practice-only fit before asking any expedition question. All fit rows are shadow.
  const fitRows = (await ledger.all()).filter(
    (row) => row.gateId === "treasure.practice" && isUnselected(row),
  );
  const scored = scoredForYes(fitRows);
  const fit = fitThreshold(scored, 0.8, 3);
  const candidate = fit ? Math.max(0.5, fit.threshold) : null;
  const support = candidate === null ? null : coverageAt(scored, candidate);
  const suggestedThreshold =
    support && support.n >= 3 && support.accuracy >= 0.8 ? candidate : null;
  const bins = reliability(scored, 5).filter((bin) => bin.n > 0);
  const explored = [];
  let score = 0;
  let found = 0;
  let empty = 0;
  if (phase === "expedition") {
    const expeditionGate = engine.gate({
      id: "treasure.expedition",
      question,
      mode,
      policy: { actAbove: threshold },
    });
    for (const site of expedition) {
      const result = await expeditionGate.ask(site.state);
      await engine.label(result.recordId, {
        truth: site.truth,
        correct: result.ruling.go >= 0.5 === site.truth,
      });
      if (result.action === "act") {
        score += site.truth ? 5 : -8;
        if (site.truth) found++;
        else empty++;
      }
      explored.push({
        id: site.id,
        landmark: site.landmark,
        probability: result.ruling.go,
        truth: site.truth,
        suggested: result.ruling.action,
        actual: result.action,
      });
    }
  }
  return {
    title: "Treasure Survey",
    seed,
    terrain,
    compass,
    phase,
    mode,
    threshold,
    frozen: phase === "expedition",
    practice: observed,
    expedition: explored,
    fit: {
      sourceGate: "treasure.practice",
      sourceCount: fitRows.length,
      sourceStateHashes: fitRows.map((row) => row.stateHash),
      sourceModes: [...new Set(fitRows.map((row) => row.mode))],
      target: 0.8,
      suggestedThreshold,
      support: suggestedThreshold === null ? 0 : (support?.n ?? 0),
      accuracy: suggestedThreshold === null ? null : (support?.accuracy ?? null),
    },
    bins,
    score,
    found,
    empty,
    suggestedDigs: explored.filter((site) => site.suggested === "act").length,
    missed: explored.filter((site) => site.truth && site.actual !== "act").length,
    ledger: await ledgerView(ledger),
  };
}
