import {
  Engine,
  effectiveN,
  judge,
  judgeVerdictFrom,
  MemoryLedger,
  type Oracle,
  poolJudge,
} from "../../src/index.ts";
import { rng } from "../../src/math.ts";
import { ledgerView, numeric, objectInput, sandboxMode } from "./shared.ts";

const names = ["Meadow", "Brook", "Hill"];
const seasons = 12;
const question = judge("Is the fruit ripe enough to harvest?", { id: "orchard.ripe" });

/** Seeded toy biology supplies labels; neither policy nor previous verdicts enter this state. */
function treeAt(seed: number, turn: number, tree: number, fruit: string) {
  const random = rng(seed + turn * 131 + tree * 7919 + fruit.charCodeAt(0) * 47);
  const ripeness = 0.2 + random() * 0.7;
  const truth = random() < ripeness;
  const haze = random() < 0.18;
  const commonSignal = haze ? !truth : truth;
  const votes = Array.from({ length: 5 }, () => {
    const agrees = random() < 0.84;
    const confident = 0.68 + random() * 0.19;
    return agrees === commonSignal ? confident : 1 - confident;
  });
  return {
    tree,
    name: names[tree] ?? "Tree",
    clue: ripeness > 0.7 ? "Sun-kissed" : ripeness < 0.45 ? "Still blushing" : "Almost golden",
    truth,
    votes,
  };
}

function scout(index: number, votes: readonly number[]): Oracle {
  return {
    id: `orchard.mock-scout-${index + 1}`,
    decide: async (_state, questions) =>
      questions.map((q) => {
        if (q.kind !== "judge") throw new Error("Orchard scouts answer judge questions only.");
        return {
          verdict: judgeVerdictFrom(q, votes[index] ?? 0.5),
          oracle: `orchard.mock-scout-${index + 1}`,
          model: "seeded-orchard-v1",
          at: new Date().toISOString(),
          latencyMs: 0,
          cost: 0,
        };
      }),
  };
}

export async function play(input: unknown) {
  const data = objectInput(input);
  const seed = numeric(data, "seed", 712, 0, 1_000_000, true);
  const correlation = numeric(data, "correlation", 0.5, 0, 1);
  const threshold = numeric(data, "threshold", 0.9, 0.5, 1);
  const mode = sandboxMode(data);
  const fruit = data.fruit ?? "apple";
  if (fruit !== "apple" && fruit !== "pear" && fruit !== "plum") {
    throw new Error("fruit must be apple, pear, or plum.");
  }
  const strategy = data.strategy ?? "ensemble";
  if (strategy !== "ensemble" && strategy !== "solo") {
    throw new Error("strategy must be ensemble or solo.");
  }
  const choices = data.choices ?? [0];
  if (
    !Array.isArray(choices) ||
    choices.length > seasons ||
    choices.some((value) => !Number.isInteger(value) || value < 0 || value > 2)
  ) {
    throw new Error("choices must contain up to 12 tree numbers, each 0, 1, or 2.");
  }
  const ledger = new MemoryLedger();
  const history = [];
  let score = 0;
  let harvested = 0;
  let spoiled = 0;
  for (const [turn, tree] of choices.entries()) {
    const state = treeAt(seed, turn, tree, fruit);
    const members = state.votes.map((_, index) => ({ oracle: scout(index, state.votes) }));
    const engine = new Engine({
      oracle: scout(0, state.votes),
      ledger,
      mode,
      auditRate: 0,
      keepState: true,
    });
    const gate = engine.gate({
      id: "orchard.harvest",
      question,
      policy: { actAbove: threshold },
      strategy:
        strategy === "solo" ? "single" : { ensemble: { members, correlation, method: "logodds" } },
    });
    const result = await gate.ask(
      JSON.stringify({ turn: turn + 1, tree: state.name, fruit, clue: state.clue }),
    );
    const tookFruit = result.action === "act";
    if (tookFruit) {
      score += state.truth ? 3 : -4;
      if (state.truth) harvested++;
      else spoiled++;
    }
    await engine.label(result.recordId, {
      truth: state.truth,
      correct: result.decision.verdict.pYes >= 0.5 === state.truth,
    });
    const votes = strategy === "solo" ? state.votes.slice(0, 1) : state.votes;
    history.push({
      turn: turn + 1,
      tree: state.name,
      truth: state.truth,
      probability: result.ruling.go,
      suggested: result.ruling.action,
      actual: result.action,
      votes,
      score,
      points: tookFruit ? (state.truth ? 3 : -4) : 0,
    });
  }
  const last = history.at(-1);
  const curve = Array.from({ length: 11 }, (_, index) => {
    const rho = index / 10;
    return {
      correlation: rho,
      probability: last
        ? poolJudge(
            last.votes.map((probability) => judgeVerdictFrom(question, probability)),
            { correlation: rho },
          ).pYes
        : null,
    };
  });
  return {
    title: "Signal Orchard",
    seed,
    mode,
    strategy,
    fruit,
    correlation,
    threshold,
    turn: choices.length,
    totalTurns: seasons,
    done: choices.length === seasons,
    effectiveScouts: effectiveN(strategy === "solo" ? 1 : 5, correlation),
    score,
    harvested,
    spoiled,
    suggestedHarvests: history.filter((row) => row.suggested === "act").length,
    history,
    curve,
    trees:
      choices.length === seasons
        ? []
        : names.map((_, index) => {
            const tree = treeAt(seed, choices.length, index, fruit);
            return { tree: index, name: tree.name, clue: tree.clue };
          }),
    ledger: await ledgerView(ledger),
  };
}
