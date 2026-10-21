import {
  Engine,
  judge,
  judgeVerdictFrom,
  MemoryLedger,
  type Oracle,
  pick,
  pickVerdictFrom,
  State,
} from "../../src/index.ts";
import { ledgerView, numeric, objectInput, sandboxMode } from "./shared.ts";

const MATERIALS = {
  plank: { name: "Timber plank", capacity: 2, cost: 1, anchored: true },
  truss: { name: "Steel truss", capacity: 4, cost: 2, anchored: true },
  stone: { name: "Stone arch", capacity: 7, cost: 3, anchored: true },
  glass: { name: "Glass ribbon", capacity: 1, cost: 1, anchored: true },
  floating: { name: "Floating deck", capacity: 9, cost: 1, anchored: false },
};
type Material = keyof typeof MATERIALS;
const names = Object.keys(MATERIALS) as Material[];
const SHIFT = 14;

function material(value: unknown): value is Material {
  return typeof value === "string" && Object.hasOwn(MATERIALS, value);
}

/** Seed changes physical loads, prices and stock; the baseline is affordable by construction. */
function crossing(seed: number) {
  let value = seed >>> 0;
  const roll = (count: number) => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return Math.floor((value / 0x100000000) * count);
  };
  const materials = {
    plank: { ...MATERIALS.plank, capacity: 2 + roll(2), cost: 1 + roll(2), stock: 1 },
    truss: { ...MATERIALS.truss, capacity: 4 + roll(2), cost: 2 + roll(2), stock: 1 },
    stone: { ...MATERIALS.stone, cost: 3 + roll(2), stock: 1 },
    glass: { ...MATERIALS.glass, capacity: 1 + roll(2), stock: 2 },
    floating: { ...MATERIALS.floating, stock: 2 },
  };
  const loads = Array.from({ length: 5 }, () => 1 + roll(7));
  let supplies = 3;
  for (const load of loads) {
    const best = names
      .filter((name) => materials[name].anchored && materials[name].capacity >= load)
      .sort((a, b) => materials[a].cost - materials[b].cost)[0];
    if (!best) throw new Error("Crossing has no feasible material.");
    materials[best].stock++;
    supplies += materials[best].cost;
  }
  return { loads, materials, supplies };
}

/** Reconstruct only physical observations; an inspection never installs a held proposal. */
export async function play(input: unknown, liveOracle?: Oracle) {
  const options = objectInput(input);
  const mode = sandboxMode(options);
  const seed = numeric(options, "seed", 42, 0, 0xffffffff, true);
  const attempts = options.attempts ?? [];
  if (!Array.isArray(attempts) || attempts.length > 30 || !attempts.every(material)) {
    throw new Error("attempts must contain at most 30 known bridge materials.");
  }
  const commands = options.commands ?? attempts;
  if (
    !Array.isArray(commands) ||
    commands.length > 30 ||
    commands.some(
      (command) =>
        command !== "agent" &&
        !material(command) &&
        !(
          command &&
          typeof command === "object" &&
          material(command.material) &&
          command.manual === true
        ),
    )
  ) {
    throw new Error("commands must contain at most 30 agent turns or manual materials.");
  }
  if (options.failJudge !== undefined && typeof options.failJudge !== "boolean") {
    throw new Error("failJudge must be a boolean.");
  }
  const world = crossing(seed);
  const { loads, materials } = world;
  const initialSupplies = world.supplies;
  let supplies = initialSupplies;
  const ledger = new MemoryLedger();
  const observations = new Map<string, { truth: boolean; inspected: boolean; margin: number }>();
  const simulator: Oracle = {
    id: "bridge-observation-engineer",
    async decide(state, questions) {
      if (options.failJudge) throw new Error("The engineer is offline.");
      const observation = observations.get(state);
      return questions.map((q) => {
        if (q.kind !== "judge" || !observation) throw new Error("Engineer expects a load test.");
        const probability = !observation.truth
          ? 0.05
          : observation.inspected
            ? 0.99
            : observation.margin === 0
              ? 0.72
              : 0.96;
        return {
          verdict: judgeVerdictFrom(q, probability),
          oracle: "bridge-observation-engineer",
          model: "visible-load-and-inspection-v2",
          cost: 0,
          latencyMs: 0,
          at: new Date().toISOString(),
        };
      });
    },
  };
  const oracle = options.failJudge ? simulator : (liveOracle ?? simulator);
  const engine = new Engine({ oracle, ledger, mode, keepState: true });
  const gate = engine.gate({
    id: "bridge.verify-piece",
    question: judge(
      "Will the proposed anchored bridge piece carry the required load for this span? Use a completed physical inspection when present.",
      { id: "bridge.load" },
    ),
    policy: { actAbove: 0.8, refuseBelow: 0.2 },
    floors: [
      (state) =>
        state.includes("anchored: false") || state.includes("available: false")
          ? "refuse"
          : undefined,
    ],
  });
  const built: Material[] = [];
  const inspections = new Map<string, boolean>();
  const history: {
    material: Material | "wait";
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
  let elapsed = 0;
  let paused = false;
  let stalledTurns = 0;
  let delivery = false;
  const events: string[] = [];
  for (const [turn, command] of commands.entries()) {
    if (built.length === loads.length || elapsed >= SHIFT) break;
    const span = built.length;
    const load = loads[span];
    if (load === undefined) throw new Error("The bridge has no remaining span.");
    const manual = typeof command === "object";
    const active = mode === "enforce" || manual;
    if (active) {
      elapsed++;
      if (elapsed === 4) {
        supplies += 2;
        materials.truss.stock++;
        delivery = true;
        stalledTurns = 0;
        events.push("Turn 4: the supply boat delivered 2 supplies and a steel truss.");
      }
    }
    let name: Material = manual ? command.material : command;
    if (command === "agent") {
      // A repeated hold is not new evidence. Let the clock finish without buying more retries.
      if (active && stalledTurns >= 3) {
        paused = true;
        history.push({
          material: "wait",
          span: span + 1,
          load,
          capacity: 0,
          truth: false,
          suggested: "review",
          actual: "review",
          result: "Crew waits for takeover · repeated proposal remains held; no new oracle call",
          probability: 0,
          failedOpen: false,
        });
        continue;
      }
      const candidates = names.filter(
        (name) =>
          materials[name].anchored &&
          materials[name].capacity >= load &&
          materials[name].cost <= supplies &&
          materials[name].stock > 0,
      );
      const preferred =
        candidates.sort((a, b) => materials[a].cost - materials[b].cost)[0] ?? "wait";
      // A single feasible material needs no preference vote. It still faces the load gate.
      if (candidates.length === 1 && material(preferred)) {
        name = preferred;
      } else {
        const chooser: Oracle = options.failJudge
          ? oracle
          : (liveOracle ?? {
              id: "bridge.scripted-builder",
              async decide(_state, questions) {
                return questions.map((q) => {
                  if (q.kind !== "pick") throw new Error("Builder expects a material choice.");
                  return {
                    verdict: pickVerdictFrom(
                      q,
                      q.options.map((option) => (option === preferred ? 0.95 : 0.01)),
                    ),
                    oracle: "bridge.scripted-builder",
                    model: "visible-load-stock-script-v2",
                    cost: 0,
                    latencyMs: 0,
                    at: new Date().toISOString(),
                  };
                });
              },
            });
        const picker = new Engine({ oracle: chooser, ledger, mode, keepState: true });
        const selected = await picker
          .gate({
            id: "bridge.choose-material",
            question: pick(
              "Choose the cheapest of the eligible bridge materials listed in the state. Code has checked their load, anchor, stock and cost constraints. Choose wait if none is useful; return also ends this turn without placing a piece.",
              candidates.length ? [...candidates, "wait"] : ["wait", "return"],
              { id: "bridge.material" },
            ),
            policy: { actAbove: 0.55 },
          })
          .ask(
            JSON.stringify({
              attempt: turn + 1,
              built,
              requiredLoad: load,
              remainingLoads: loads.slice(span),
              supplies,
              minutesLeft: SHIFT - elapsed,
              materials: Object.fromEntries(candidates.map((name) => [name, materials[name]])),
              inspections: names.flatMap((name) => {
                const passed = inspections.get(`${span}:${name}`);
                return passed === undefined ? [] : [{ material: name, loadTestPassed: passed }];
              }),
            }),
          );
        paused = selected.action !== "act" || selected.decision.failedOpen === true;
        if (paused || !material(selected.decision.verdict.choice)) {
          if (active) stalledTurns++;
          history.push({
            material: "wait",
            span: span + 1,
            load,
            capacity: 0,
            truth: false,
            suggested: selected.ruling.action,
            actual: selected.action,
            result: active
              ? "Proposal held · crew waits one minute; no piece placed"
              : "Shadow suggestion · no world action",
            probability: selected.ruling.go,
            failedOpen: selected.decision.failedOpen ?? false,
          });
          continue;
        }
        name = selected.decision.verdict.choice;
      }
    }
    const piece = materials[name];
    const available = piece.stock > 0 && piece.cost <= supplies;
    const inspection = inspections.get(`${span}:${name}`);
    gate.mode = manual ? "shadow" : mode;
    const state = State.create("Bridge Builder: reversible toy construction")
      .field("finished_spans", built.length)
      .field("attempt", turn + 1)
      .field("built_materials", built)
      .field("required_load", load)
      .field("proposed_material", name)
      .field("capacity", piece.capacity)
      .field("anchored", piece.anchored)
      .field("available", available)
      .field("physical_inspection", inspection === undefined ? "not performed" : inspection)
      .build();
    const truth = piece.anchored && piece.capacity >= load;
    observations.set(state.text, {
      truth,
      inspected: inspection === true,
      margin: piece.capacity - load,
    });
    const answer = await gate.ask(state, {
      baseline: manual ? (piece.anchored && available ? "act" : "refuse") : "review",
    });
    paused = command === "agent" && answer.action === "review";
    let result = "Shadow observation · no world action";
    if (answer.action === "act") {
      built.push(name);
      score -= piece.cost;
      supplies -= piece.cost;
      piece.stock--;
      if (truth) {
        stalledTurns = 0;
        score += 5;
        result = "Placed · load test passed";
      } else {
        built.pop();
        collapses++;
        stalledTurns++;
        result = "Placed · collapsed · last checkpoint restored";
      }
    } else if (active && answer.action === "review") {
      stalledTurns++;
      inspections.set(`${span}:${name}`, truth);
      result = `Placement held · crew inspected the piece: load test ${truth ? "passed" : "failed"}`;
    } else if (active && answer.action === "refuse") {
      stalledTurns++;
      result = !piece.anchored
        ? "Rejected · missing anchor · crew waits"
        : !available
          ? "Rejected · no stock or insufficient supplies · crew waits"
          : "Rejected · inadequate load capacity · crew waits";
    }
    await engine.label(answer.recordId, {
      truth,
      correct: answer.decision.verdict.pYes >= 0.5 === truth,
      note: "Physical toy load-test truth; inspection is not placement permission.",
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
  const nextLoad = loads[built.length];
  const stranded =
    delivery &&
    nextLoad !== undefined &&
    !names.some(
      (name) =>
        materials[name].anchored &&
        materials[name].capacity >= nextLoad &&
        materials[name].stock > 0 &&
        materials[name].cost <= supplies,
    );
  const complete = built.length === loads.length;
  const done = complete || stranded || elapsed >= SHIFT || commands.length === 30;
  return {
    title: "Bridge Builder",
    mode,
    seed,
    loads,
    materials,
    initialSupplies,
    built,
    history,
    complete,
    score,
    collapses,
    supplies,
    turns: history.length,
    minutesLeft: SHIFT - elapsed,
    events,
    done,
    endReason: complete
      ? "Bolt crossed safely."
      : stranded
        ? "No affordable stocked material can carry the next span."
        : done
          ? "The crew's shift ended before the crossing was complete."
          : null,
    paused,
    judgeSource: liveOracle ? "live" : "observation-based simulation",
    remaining: loads.length - built.length,
    ledger: await ledgerView(ledger),
  };
}
