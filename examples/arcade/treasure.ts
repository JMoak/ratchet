import {
  coverageAt,
  Engine,
  fitThreshold,
  isUnselected,
  judge,
  judgeVerdictFrom,
  MemoryLedger,
  type Oracle,
  pick,
  pickVerdictFrom,
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
    const signal =
      chance >= 0.8
        ? "strong metal echo"
        : chance >= 0.6
          ? "steady metal echo"
          : chance >= 0.4
            ? "faint metal echo"
            : "mostly static";
    return {
      id: `${phase}.${index + 1}`,
      landmark,
      truth,
      probability,
      signal,
      state: JSON.stringify({
        seed,
        phase,
        terrain,
        site: index + 1,
        landmark,
        signal,
        detector: compass === "bold" ? "overconfident" : "measured",
      }),
    };
  });
}

export async function play(input: unknown, liveOracle?: Oracle) {
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
  const interactive = data.commands !== undefined;
  const commands = data.commands ?? Array.from({ length: count }, (_, index) => index);
  if (
    !Array.isArray(commands) ||
    commands.length > 18 ||
    commands.some(
      (command) =>
        command !== "agent" &&
        command !== "camp" &&
        !(
          typeof command === "number" &&
          Number.isInteger(command) &&
          command >= 0 &&
          command < count
        ) &&
        !(
          command &&
          typeof command === "object" &&
          Number.isInteger(command.site) &&
          command.site >= 0 &&
          command.site < count &&
          (command.move === "dig" || command.move === "survey")
        ),
    )
  )
    throw new Error("commands must contain up to 18 agent, survey, or dig moves.");
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
  const engine = new Engine({
    oracle: liveOracle ?? oracle,
    ledger,
    keepState: true,
    mode: "shadow",
    auditRate: 0,
  });
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
  const explored: {
    id: string;
    site: number;
    landmark: string;
    probability: number;
    truth: boolean | null;
    suggested: string;
    actual: string;
    dug: boolean;
    moved: boolean;
    signal: string;
    actor: string;
    energy: number;
    event: string;
  }[] = [];
  let score = 0;
  let found = 0;
  let empty = 0;
  let energy = 24;
  let shovels = 6;
  let position = -1;
  let turns = 0;
  let returned = false;
  let endReason = "";
  const visited = new Set<number>();
  if (phase === "expedition") {
    const expeditionGate = engine.gate({
      id: "treasure.expedition",
      question,
      mode,
      policy: { actAbove: threshold },
    });
    for (const [turn, command] of commands.entries()) {
      if (interactive && (energy < 2 || shovels === 0 || returned)) break;
      turns++;
      if (command === "camp") {
        returned = true;
        endReason = "You brought Scout back to camp.";
        break;
      }
      let index =
        typeof command === "number" ? command : typeof command === "object" ? command.site : -1;
      const manual = typeof command === "object";
      const distance = (target: number) =>
        position < 0
          ? 1
          : Math.abs((position % 4) - (target % 4)) +
            Math.abs(Math.floor(position / 4) - Math.floor(target / 4));
      // A held decision never authorizes a dig. This separate, code-owned survey
      // consumes daylight and travel energy, so failures cannot create retry loops.
      const surveyFallback = (reason: string) => {
        const next = expedition
          .map((site, siteIndex) => ({ ...site, siteIndex, distance: distance(siteIndex) }))
          .filter((site) => !visited.has(site.siteIndex) && site.distance + 1 <= energy)
          .sort((a, b) => a.distance - b.distance)[0];
        const moved = mode === "enforce" && next !== undefined;
        if (moved) {
          position = next.siteIndex;
          visited.add(position);
          energy -= next.distance + 1;
        } else if (mode === "enforce") {
          energy = Math.max(0, energy - 1);
        }
        explored.push({
          id: next?.id ?? `wait.${turn}`,
          site: moved ? next.siteIndex : -1,
          landmark: moved ? next.landmark : "Camp",
          probability: 0.5,
          truth: null,
          suggested: "review",
          actual: "review",
          dug: false,
          moved,
          signal: moved ? next.signal : "Waiting",
          actor: "code",
          energy,
          event: moved
            ? `${reason} Scout surveyed the nearest reachable unvisited site instead; no dig.`
            : `${reason} ${mode === "shadow" ? "Shadow preview; Scout stayed at camp." : "Scout waited; daylight and one energy used."}`,
        });
      };
      if (command === "agent") {
        const available = expedition.map((site, i) => ({
          site: i,
          signal: site.signal,
          distance: distance(i),
          visited: visited.has(i),
        }));
        const candidates = available
          .filter((site) => !site.visited && site.distance + 2 <= energy)
          .sort((a, b) => {
            const signalRank = (signal: string) =>
              signal.startsWith("strong")
                ? 4
                : signal.startsWith("steady")
                  ? 3
                  : signal.startsWith("faint")
                    ? 2
                    : 1;
            return signalRank(b.signal) - signalRank(a.signal) || a.distance - b.distance;
          })
          .slice(0, 3);
        if (mode === "enforce" && candidates.length === 0) {
          returned = true;
          endReason = "No unvisited dig site fits the remaining supplies. Scout returned to camp.";
          break;
        }
        const preferred = candidates[0]?.site;
        const chosen = preferred === undefined ? "camp" : String(preferred);
        const chooser: Oracle = liveOracle ?? {
          id: "treasure.scripted-explorer",
          async decide(_state, questions) {
            return questions.map((q) => {
              if (q.kind !== "pick") throw new Error("Explorer expects a destination.");
              return {
                verdict: pickVerdictFrom(
                  q,
                  q.options.map((option) =>
                    option === chosen ? 0.88 : 0.12 / (q.options.length - 1),
                  ),
                ),
                oracle: "treasure.scripted-explorer",
                model: "visible-detector-script-v1",
                cost: 0,
                latencyMs: 0,
                at: new Date().toISOString(),
              };
            });
          },
        };
        const picker = new Engine({ oracle: chooser, ledger, mode, keepState: true });
        const selection = await picker
          .gate({
            id: "treasure.choose-site",
            question: pick(
              "Choose among these feasible sites. Prefer the strongest metal echo, then shortest travel, then lowest site number on a tie. Travel is followed by a separate dig judgment. Choose camp if supplies should be saved.",
              [...candidates.map((site) => String(site.site)), "camp"],
              { id: "treasure.destination" },
            ),
            policy: { actAbove: 0.55 },
          })
          .ask(
            JSON.stringify({
              turn: turn + 1,
              daylightRemaining: 18 - turn,
              terrain,
              position,
              energy,
              shovels,
              candidates,
              surveyedSites: [...visited],
            }),
          );
        if (selection.action !== "act" || selection.decision.failedOpen === true) {
          surveyFallback("Destination held for review.");
          continue;
        }
        if (selection.decision.verdict.choice === "camp") {
          returned = true;
          endReason = "Scout chose to bring the remaining supplies back to camp.";
          break;
        }
        index = Number(selection.decision.verdict.choice);
      }
      const alreadyDug = explored.some((row) => row.site === index && row.dug);
      if (interactive && visited.has(index) && !(manual && command.move === "dig" && !alreadyDug)) {
        if (mode === "enforce") surveyFallback("That site was already explored.");
        continue;
      }
      const site = expedition[index];
      if (!site) continue;
      const travelCost = interactive ? distance(index) : 0;
      if (interactive && travelCost + 1 > energy) continue;
      const survey = manual && command.move === "survey";
      if (interactive && !survey && travelCost + 2 > energy) continue;
      expeditionGate.mode = manual ? "shadow" : mode;
      const result = await expeditionGate.ask(site.state, {
        baseline: manual && !survey ? "act" : "review",
      });
      await engine.label(result.recordId, {
        truth: site.truth,
        correct: result.ruling.go >= 0.5 === site.truth,
      });
      const moved = !interactive || manual || mode === "enforce";
      const dug =
        result.action === "act" && (!interactive || (shovels > 0 && travelCost + 2 <= energy));
      if (moved && interactive) {
        position = index;
        visited.add(index);
        energy -= travelCost + (dug ? 2 : 1);
        if (dug) shovels--;
      }
      if (dug) {
        score += site.truth ? 5 : -8;
        if (site.truth) found++;
        else empty++;
      }
      explored.push({
        id: site.id,
        site: index,
        landmark: site.landmark,
        probability: result.ruling.go,
        truth: site.truth,
        suggested: result.ruling.action,
        actual: result.action,
        dug,
        moved,
        signal: site.signal,
        actor: command === "agent" ? "agent" : "player",
        energy,
        event: !moved
          ? "Shadow suggestion; explorer stayed at camp."
          : dug
            ? site.truth
              ? "Treasure recovered! +5 points."
              : "Empty pit. −8 points."
            : "Survey completed; dig held for review. Scout can continue to a different site.",
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
    interactive,
    energy,
    shovels,
    position,
    visited: [...visited],
    turns,
    daylight: Math.max(0, 18 - turns),
    done:
      phase === "expedition" &&
      (returned ||
        energy < 2 ||
        shovels === 0 ||
        explored.filter((row) => row.dug).length === count ||
        turns >= 18),
    paused: false,
    endReason:
      endReason ||
      (energy < 2
        ? "Travel energy ran low; Scout returned to camp."
        : shovels === 0
          ? "The last shovel was used; Scout returned to camp."
          : turns >= 18
            ? "Daylight ended; Scout returned to camp."
            : ""),
    goal: 15,
    won: score >= 15,
    judgeSource: liveOracle ? "live" : "seeded simulation",
    map: expedition.map((site, index) => ({
      site: index,
      landmark: site.landmark,
      signal: site.signal,
      visited: visited.has(index),
      dug: explored.some((row) => row.site === index && row.dug),
      truth: explored.some((row) => row.site === index && row.dug) ? site.truth : null,
    })),
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
