import {
  Engine,
  effectiveN,
  judge,
  judgeVerdictFrom,
  MemoryLedger,
  type Oracle,
  pick,
  pickVerdictFrom,
  poolJudge,
} from "../../src/index.ts";
import { rng } from "../../src/math.ts";
import { ledgerView, numeric, objectInput, sandboxMode } from "./shared.ts";

const names = ["Meadow", "Brook", "Hill"];
const seasons = 12;
const question = judge("Is the fruit ripe enough to harvest?", { id: "orchard.ripe" });

/** Seeded toy biology supplies labels; neither policy nor previous verdicts enter this state. */
function weatherAt(seed: number, turn: number) {
  return rng(seed + turn * 131 + 91)() < 0.35 ? "Cool rain" : "Warm sunshine";
}

function treeAt(seed: number, turn: number, tree: number, fruit: string, picked = 0) {
  const random = rng(seed + tree * 7919 + fruit.charCodeAt(0) * 47);
  let ripeness = 0.18 + random() * 0.4 - picked * 0.045;
  for (let day = 0; day < turn; day++) {
    ripeness += weatherAt(seed, day) === "Warm sunshine" ? 0.075 : 0.025;
  }
  const truth = ripeness >= 0.7;
  // Scouts read the same noisy ripeness sensor, not the hidden outcome label.
  // Shared sensor error is why pooling exposes a correlation parameter.
  const observation = rng(seed + turn * 131 + tree * 7919 + picked * 47);
  const commonSignal = ripeness + (observation() - 0.5) * 0.12;
  const votes = Array.from({ length: 5 }, () => {
    return Math.max(
      0.02,
      Math.min(0.98, 0.5 + (commonSignal - 0.7) * 2.5 + (observation() - 0.5) * 0.22),
    );
  });
  return {
    tree,
    name: names[tree] ?? "Tree",
    clue: ripeness >= 0.7 ? "Sun-kissed" : ripeness < 0.45 ? "Still blushing" : "Almost golden",
    firmness: ripeness >= 0.7 ? "Soft with a sweet scent" : "Firm with little scent",
    colorCoverage: Math.round(Math.max(0, Math.min(1, commonSignal)) * 100),
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

export async function play(input: unknown, liveOracle?: Oracle) {
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
  const commands = data.commands ?? choices;
  if (
    !Array.isArray(commands) ||
    commands.length > seasons ||
    commands.some(
      (command) =>
        command !== "agent" &&
        command !== "rest" &&
        !(
          typeof command === "number" &&
          Number.isInteger(command) &&
          command >= 0 &&
          command <= 2
        ) &&
        !(
          command &&
          typeof command === "object" &&
          Number.isInteger(command.tree) &&
          command.tree >= 0 &&
          command.tree <= 2 &&
          command.manual === true
        ),
    )
  ) {
    throw new Error("commands must contain up to 12 agent, rest, or manual tree moves.");
  }
  const ledger = new MemoryLedger();
  const history = [];
  const stock = [4, 4, 4];
  let position = -1;
  let score = 0;
  let harvested = 0;
  let spoiled = 0;
  for (const [turn, command] of commands.entries()) {
    const manual = typeof command === "object";
    let tree = typeof command === "number" ? command : manual ? command.tree : -1;
    let choiceFailed = false;
    if (command === "agent") {
      const visible = names.map((name, index) => {
        const observation = treeAt(seed, turn, index, fruit, 4 - (stock[index] ?? 0));
        return {
          name,
          clue: observation.clue,
          firmness: observation.firmness,
          colorCoverage: observation.colorCoverage,
          remaining: stock[index] ?? 0,
        };
      });
      const preferred = visible
        .map((item, index) => ({
          index,
          colorCoverage: item.colorCoverage,
          value:
            item.remaining === 0
              ? -1
              : item.clue === "Sun-kissed"
                ? 3
                : item.clue === "Almost golden"
                  ? 2
                  : 1,
        }))
        .sort(
          (a, b) =>
            b.value - a.value ||
            b.colorCoverage - a.colorCoverage ||
            (stock[b.index] ?? 0) - (stock[a.index] ?? 0) ||
            Math.abs(a.index - position) - Math.abs(b.index - position),
        )[0];
      const selected =
        preferred && preferred.value > 2 ? (names[preferred.index] ?? "rest") : "rest";
      const oracle: Oracle = liveOracle ?? {
        id: "orchard.scripted-gardener",
        async decide(_state, questions) {
          return questions.map((q) => {
            if (q.kind !== "pick") throw new Error("The gardener chooses a destination.");
            return {
              verdict: pickVerdictFrom(
                q,
                q.options.map((option) => (option === selected ? 0.97 : 0.01)),
              ),
              oracle: "orchard.scripted-gardener",
              model: "visible-clue-script-v1",
              at: new Date().toISOString(),
              cost: 0,
              latencyMs: 0,
            };
          });
        },
      };
      const picker = new Engine({ oracle, ledger, mode, keepState: true });
      const destination = picker.gate({
        id: "orchard.choose-tree",
        question: pick(
          "Choose a nonempty tree with sun-kissed, soft, sweet-smelling fruit. Prefer fullest color coverage, then more remaining fruit, then the closest tree on ties. Rest if no fruit is ripe. This chooses a destination only; a separate gate judges harvesting.",
          [...names, "rest"],
          { id: "orchard.destination" },
        ),
        policy: { actAbove: 0.55 },
      });
      const selectedTree = await destination.ask(
        JSON.stringify({
          day: turn + 1,
          daysLeft: seasons - turn,
          weather: weatherAt(seed, turn),
          fruit,
          trees: visible,
          gardenerAt: position < 0 ? "shed" : names[position],
        }),
      );
      choiceFailed = selectedTree.decision.failedOpen === true || selectedTree.action !== "act";
      tree = choiceFailed ? -1 : names.indexOf(selectedTree.decision.verdict.choice);
    }
    if (tree < 0 || (stock[tree] ?? 0) === 0) {
      history.push({
        turn: turn + 1,
        tree: "Shed",
        treeIndex: -1,
        truth: false,
        probability: 0.5,
        suggested: "review",
        actual: "review",
        votes: [] as number[],
        score,
        points: 0,
        actor: command === "agent" ? "agent" : "player",
        weather: weatherAt(seed, turn),
        event: choiceFailed
          ? `Choice held for review. Pip waited; ${weatherAt(seed, turn).toLowerCase()} ripened the orchard. No fruit taken.`
          : `Rested a day; ${weatherAt(seed, turn).toLowerCase()} ripened the orchard. No fruit taken.`,
      });
      continue;
    }
    const state = treeAt(seed, turn, tree, fruit, 4 - (stock[tree] ?? 0));
    const members = state.votes.map((_, index) => ({
      oracle: liveOracle ?? scout(index, state.votes),
    }));
    const engine = new Engine({
      oracle: liveOracle ?? scout(0, state.votes),
      ledger,
      mode: manual ? "shadow" : mode,
      auditRate: 0,
      keepState: true,
    });
    const gate = engine.gate({
      id: "orchard.harvest",
      question,
      policy: { actAbove: threshold },
      strategy:
        strategy === "solo" || liveOracle
          ? "single"
          : { ensemble: { members, correlation, method: "logodds" } },
    });
    const result = await gate.ask(
      JSON.stringify({
        turn: turn + 1,
        tree: state.name,
        fruit,
        clue: state.clue,
        firmness: state.firmness,
        colorCoverage: state.colorCoverage,
        weather: weatherAt(seed, turn),
        remainingFruit: stock[tree],
      }),
      { baseline: manual ? "act" : "review" },
    );
    const tookFruit = result.action === "act";
    if (tookFruit) {
      stock[tree] = (stock[tree] ?? 0) - 1;
      position = tree;
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
      treeIndex: tree,
      truth: state.truth,
      probability: result.ruling.go,
      suggested: result.ruling.action,
      actual: result.action,
      votes,
      score,
      points: tookFruit ? (state.truth ? 3 : -4) : 0,
      actor: command === "agent" ? "agent" : "player",
      weather: weatherAt(seed, turn),
      event: tookFruit
        ? `${manual ? "You" : "Gardener"} harvested ${state.name}: ${state.truth ? "ripe fruit +3" : "unripe fruit −4"}.`
        : `${state.name} stayed untouched; ${mode === "shadow" ? "shadow suggestion" : "harvest held for review"}. ${weatherAt(seed, turn)} advanced the season a day.`,
    });
  }
  const last = history.at(-1);
  const curve = Array.from({ length: 11 }, (_, index) => {
    const rho = index / 10;
    return {
      correlation: rho,
      probability: last?.votes.length
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
    turn: commands.length,
    totalTurns: seasons,
    done: commands.length === seasons,
    won: score >= 12,
    goal: 12,
    position,
    paused: false,
    weather: weatherAt(seed, commands.length),
    stock,
    judgeSource: liveOracle ? "live" : "seeded simulation",
    effectiveScouts: effectiveN(strategy === "solo" ? 1 : 5, correlation),
    score,
    harvested,
    spoiled,
    suggestedHarvests: history.filter((row) => row.suggested === "act").length,
    history,
    curve,
    trees:
      commands.length === seasons
        ? []
        : names.map((_, index) => {
            const tree = treeAt(seed, commands.length, index, fruit, 4 - (stock[index] ?? 0));
            return {
              tree: index,
              name: tree.name,
              clue: tree.clue,
              firmness: tree.firmness,
              colorCoverage: tree.colorCoverage,
              remaining: stock[index] ?? 0,
            };
          }),
    ledger: await ledgerView(ledger),
  };
}
