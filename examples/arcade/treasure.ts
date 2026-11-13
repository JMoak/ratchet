import {
  type DemotionSettings,
  Engine,
  judge,
  MemoryLedger,
  type Oracle,
  resolvePlan,
} from "../../src/index.ts";
import {
  type Arm,
  type BatchRow,
  batchSeed,
  type Cell,
  check,
  choice,
  ledgerView,
  mean,
  numeric,
  objectInput,
  type Sweep,
  share,
  stream,
  tableOracle,
  worldsOf,
} from "./shared.ts";

/**
 * Treasure Survey: when to stop checking Scout's digs, decided two ways.
 *
 * Every dig Scout proposes is right with some true accuracy the crew cannot see. While Scout is
 * supervised you dig by hand and see whether it was right; once promoted, Scout digs alone.
 * "Trust it when it looks good" promotes as soon as the last twenty digs read at the promise,
 * looking again after every dig, and then stops watching. The engine's rollout fixes a sample
 * before any label is read, tests it once by an exact bound, and after promoting keeps a share
 * of digs for a person to audit, so a Scout that slips is sent back.
 *
 * Whether a dig finds treasure is the simulation's. It labels the ledger and never enters a
 * state.
 */
const DIGS = 300;
const EXPEDITIONS = 204;
const ACCURACIES = [0.86, 0.91, 0.94, 0.97, 0.99, 0.997] as const;
const question = judge("Does digging here uncover treasure rather than an empty pit?", {
  id: "treasure.present",
});

type Demotion = "window" | "detector" | "first-error";

export interface TreasureSettings {
  readonly promise: number;
  readonly allow: number;
  readonly audit: number;
  readonly demotion: Demotion;
}

interface World {
  readonly accuracy: number;
  /** The dig at which Scout slips ten points, in about one world in three. */
  readonly driftAt: number | undefined;
  /** Whether Scout's proposal at each dig is right. */
  readonly right: readonly boolean[];
}

/**
 * World `seed`. A batch passes `stratum` so its worlds hold every accuracy equally often and
 * slip in every other one: balanced counts make each rate steadier than a random mix would.
 */
function worldAt(seed: number, stratum?: number): World {
  const rand = stream(seed, 0);
  const drawn = Math.floor(rand() * ACCURACIES.length);
  const slips = rand() < 0.4;
  const accuracy = ACCURACIES[stratum === undefined ? drawn : stratum % ACCURACIES.length] ?? 0.94;
  const drifts = stratum === undefined ? slips : Math.floor(stratum / ACCURACIES.length) % 2 === 0;
  const driftAt = drifts ? 100 + Math.floor(rand() * 120) : undefined;
  const right = Array.from({ length: DIGS }, (_, dig) => {
    const p = driftAt !== undefined && dig >= driftAt ? accuracy - 0.1 : accuracy;
    return stream(seed, dig + 1)() < p;
  });
  return { accuracy, driftAt, right };
}

type Mode = "hand" | "alone" | "audited";

interface Run {
  /** Who dug each time: you by hand (supervised), Scout alone, or Scout with a person checking. */
  readonly digs: readonly Mode[];
  readonly promotedAt: number | undefined;
  readonly demotedAt: number | undefined;
  readonly story: string;
}

/** Promote once the last twenty digs read at the promise, looking after every dig; then trust. */
function peek(world: World, settings: TreasureSettings): Run {
  const digs: Mode[] = [];
  let promotedAt: number | undefined;
  for (let dig = 0; dig < DIGS; dig++) {
    digs.push(promotedAt === undefined ? "hand" : "alone");
    if (promotedAt === undefined && dig >= 19) {
      const recent = world.right.slice(dig - 19, dig + 1).filter(Boolean).length / 20;
      if (recent >= settings.promise) promotedAt = dig + 1;
    }
  }
  return {
    digs,
    promotedAt,
    demotedAt: undefined,
    story:
      promotedAt === undefined
        ? "Never looked good enough: supervised to the end."
        : `Promoted after dig ${promotedAt}, when the last 20 read at the promise.`,
  };
}

const demotionOf = (kind: Demotion): DemotionSettings =>
  kind === "window"
    ? { kind: "window" }
    : kind === "detector"
      ? { kind: "detector" }
      : { kind: "first-error" };

/** The engine's rollout: one planned exact test to promote, audits to demote. */
async function earn(
  seed: number,
  world: World,
  settings: TreasureSettings,
  ledger: MemoryLedger,
  live?: Oracle,
): Promise<Run> {
  const table = new Map<string, number>();
  const engine = new Engine({
    oracle: live ?? tableOracle("treasure.scout", "seeded-scout-v3", table),
    ledger,
    seed,
    keepState: true,
  });
  const gate = engine.gate({
    id: "treasure.dig",
    question,
    policy: { actAbove: 0.8 },
    evidenceVersion: "expedition-v1",
    promisedAccuracy: settings.promise,
    auditRate: settings.audit,
    rollout: {
      maxErrors: settings.allow,
      demotion: demotionOf(settings.demotion),
      now: () => "2026-01-01T00:00:00.000Z",
    },
  });
  const plan = resolvePlan({ target: settings.promise, maxErrors: settings.allow });
  await gate.rollout.evaluate();
  const digs: Mode[] = [];
  let promotedAt: number | undefined;
  let demotedAt: number | undefined;
  let story = `Supervised to the end: the planned sample of ${plan.sampleSize} digs was not complete.`;
  let sampled = 0;
  let closed = false;
  for (let dig = 0; dig < DIGS; dig++) {
    const text = `expedition: ${seed}\ndig: ${dig + 1}\ndetector: strong, steady echo`;
    table.set(text, 0.97);
    const answer = await gate.ask(text);
    const truth = world.right[dig] === true;
    const label = () => engine.label(answer.recordId, { truth, correct: truth });
    if (answer.mode === "shadow") {
      // Supervised: you dig, so every proposal is labelled.
      digs.push("hand");
      await label();
      if (closed || answer.ruling.action !== "act") continue;
      sampled++;
      if (sampled < plan.sampleSize) continue;
      const status = await gate.rollout.evaluate();
      if (status.mode === "enforce") {
        promotedAt ??= dig + 1;
        story = `Promoted after dig ${dig + 1}: ${status.grade.kind === "measured" ? status.grade.errors : 0} wrong of ${plan.sampleSize} planned digs.`;
        sampled = 0;
      } else if (status.reason.startsWith("rejected")) {
        closed = true;
        story =
          demotedAt === undefined
            ? `Never promoted: the planned sample of ${plan.sampleSize} digs held too many wrong ones.`
            : `${story} The sample taken after that failed, so Scout stays supervised.`;
      }
      continue;
    }
    if (!answer.audited) {
      digs.push("alone");
      continue;
    }
    // An audited dig goes to a person, whose label is what can demote.
    digs.push("audited");
    await label();
    const status = await gate.rollout.evaluate();
    if (status.mode === "shadow") {
      demotedAt ??= dig + 1;
      story = `${story} Sent back to supervision after dig ${dig + 1}.`;
      sampled = 0;
    }
  }
  return { digs, promotedAt, demotedAt, story };
}

const pct = (p: number, digits = 0): string => `${(100 * p).toFixed(digits)}%`;
const accuracyAt = (world: World, dig: number): number =>
  world.driftAt !== undefined && dig >= world.driftAt ? world.accuracy - 0.1 : world.accuracy;

function tally(world: World, run: Run, promise: number) {
  const alone = run.digs.filter((m) => m === "alone").length;
  const pits = run.digs.filter((m, dig) => m === "alone" && world.right[dig] !== true).length;
  const good = world.accuracy >= promise;
  return {
    good,
    promoted: run.promotedAt !== undefined,
    alone,
    pits,
    // A demotion while Scout still kept the promise.
    wronglyDemoted: run.demotedAt !== undefined && accuracyAt(world, run.demotedAt - 1) >= promise,
    // A slip that the loop caught, among Scouts promoted before they slipped.
    slipped:
      world.driftAt !== undefined &&
      run.promotedAt !== undefined &&
      run.promotedAt <= world.driftAt,
    caught:
      world.driftAt !== undefined && run.demotedAt !== undefined && run.demotedAt > world.driftAt,
  };
}

function cells(world: World, run: Run): Cell[] {
  return run.digs.map((mode, dig): Cell => {
    const right = world.right[dig] === true;
    const n = `Dig ${dig + 1}`;
    if (mode === "hand") {
      return right
        ? { kind: "alt", note: `${n}: you dug where Scout said. Treasure.` }
        : { kind: "held", note: `${n}: you dug where Scout said. Empty, and you saw it.` };
    }
    if (mode === "audited") {
      return right
        ? { kind: "skip", note: `${n}: an audit. A person checked Scout's dig: treasure.` }
        : { kind: "held", note: `${n}: an audit. A person checked Scout's dig: empty.` };
    }
    return right
      ? { kind: "ok", note: `${n}: Scout dug alone. Treasure.` }
      : { kind: "bad", note: `${n}: Scout dug alone. An empty pit, and nobody saw.` };
  });
}

function summary(world: World, run: Run): string {
  const alone = run.digs.filter((m) => m === "alone").length;
  const pits = run.digs.filter((m, dig) => m === "alone" && world.right[dig] !== true).length;
  return alone === 0
    ? run.story
    : `${run.story} Scout dug ${alone} alone, ${pits} of them empty pits nobody saw.`;
}

function verdict(world: World, run: Run, promise: number): Arm["verdict"] {
  const alone = run.digs.filter((m) => m === "alone").length;
  if (alone === 0) return world.accuracy >= promise ? "safe" : "good";
  const pits = run.digs.filter((m, dig) => m === "alone" && world.right[dig] !== true).length;
  return share(pits, alone) > 1 - promise ? "bad" : "good";
}

async function batch(settings: TreasureSettings, worlds: number, engineOnly = false) {
  const tallies: ReturnType<typeof tally>[][] = [[], []];
  for (let i = 0; i < worlds; i++) {
    const seed = batchSeed(i);
    const world = worldAt(seed, i);
    if (!engineOnly) tallies[0]?.push(tally(world, peek(world, settings), settings.promise));
    tallies[1]?.push(
      tally(world, await earn(seed, world, settings, new MemoryLedger()), settings.promise),
    );
  }
  const figures = (arm: number) => {
    const all = tallies[arm] ?? [];
    const good = all.filter((t) => t.good);
    const bad = all.filter((t) => !t.good);
    const promotedGood = good.filter((t) => t.promoted);
    const slipped = all.filter((t) => t.slipped);
    return {
      falsePromotion: share(bad.filter((t) => t.promoted).length, bad.length),
      power: share(promotedGood.length, good.length),
      alone: mean(good.map((t) => t.alone)) / DIGS,
      pits: mean(all.map((t) => t.pits)),
      wronglyDemoted: share(
        promotedGood.filter((t) => t.wronglyDemoted).length,
        promotedGood.length,
      ),
      caught: share(slipped.filter((t) => t.caught).length, slipped.length),
    };
  };
  return [figures(0), figures(1)] as const;
}

export function settingsOf(input: Record<string, unknown>): TreasureSettings {
  const promise = numeric(input, "promise", 0.95, 0.9, 0.98);
  if (![0.9, 0.95, 0.98].includes(promise)) throw new Error("promise must be 0.9, 0.95 or 0.98.");
  return {
    promise,
    allow: numeric(input, "allow", 0, 0, 2, true),
    audit: numeric(input, "audit", 0.2, 0, 0.5),
    demotion: choice(input, "demotion", ["window", "detector", "first-error"] as const, "window"),
  };
}

export async function play(input: unknown, liveOracle?: Oracle) {
  const data = objectInput(input);
  const seed = numeric(data, "seed", 4, 0, 1_000_000, true);
  const settings = settingsOf(data);
  if (data.sweep !== undefined && typeof data.sweep !== "boolean") {
    throw new Error("sweep must be a boolean.");
  }

  const world = worldAt(seed);
  const ledger = new MemoryLedger();
  const peeked = peek(world, settings);
  const earned = await earn(seed, world, settings, ledger, liveOracle);
  const arms: Arm[] = [
    {
      id: "baseline",
      label: "Trust it when it looks good",
      verdict: verdict(world, peeked, settings.promise),
      summary: summary(world, peeked),
      cells: cells(world, peeked),
    },
    {
      id: "engine",
      label: "Earn it, then keep watching",
      verdict: verdict(world, earned, settings.promise),
      summary: summary(world, earned),
      cells: cells(world, earned),
    },
  ];

  const worlds = worldsOf(data, EXPEDITIONS);
  const [b, e] = await batch(settings, worlds);
  const rows: BatchRow[] = [
    {
      label: "Scouts worse than the promise that were promoted",
      baseline: b.falsePromotion,
      engine: e.falsePromotion,
      unit: "pct",
      better: "low",
    },
    {
      label: "Scouts as good as the promise that were promoted",
      baseline: b.power,
      engine: e.power,
      unit: "pct",
      better: "high",
    },
    {
      label: "Digs a good Scout did alone",
      baseline: b.alone,
      engine: e.alone,
      unit: "pct",
      better: "high",
    },
    {
      label: "Empty pits nobody saw, per expedition",
      baseline: b.pits,
      engine: e.pits,
      unit: "num",
      better: "low",
    },
    {
      label: "Scouts that slipped and were sent back",
      baseline: b.caught,
      engine: e.caught,
      unit: "pct",
      better: "high",
    },
    {
      label: "Good Scouts sent back while still good",
      baseline: b.wronglyDemoted,
      engine: e.wronglyDemoted,
      unit: "pct",
      better: "low",
    },
  ];
  const checks = [
    check("Worse Scouts promoted", e.falsePromotion, "max", 0.05),
    check("Digs a good Scout did alone", e.alone, "min", 0.3),
    check("Empty pits nobody saw, per expedition", e.pits, "max", 1.5, "num"),
  ];

  let sweep: Sweep | undefined;
  if (data.sweep === true) {
    const values = [0, 0.05, 0.1, 0.2, 0.3, 0.5];
    const runs = [];
    for (const audit of values) runs.push((await batch({ ...settings, audit }, 72, true))[1]);
    sweep = {
      lever: "Share of Scout's digs audited",
      values,
      current: settings.audit,
      series: [
        { label: "Digs a good Scout did alone", values: runs.map((r) => r.alone) },
        { label: "Scouts that slipped and were sent back", values: runs.map((r) => r.caught) },
        {
          label: "Good Scouts sent back while still good",
          values: runs.map((r) => r.wronglyDemoted),
        },
      ],
    };
  }

  const plan = resolvePlan({ target: settings.promise, maxErrors: settings.allow });
  const slip =
    world.driftAt === undefined
      ? ""
      : ` It slips to ${pct(world.accuracy - 0.1)} at dig ${world.driftAt + 1}.`;
  return {
    game: "treasure",
    title: "Treasure Survey",
    seed,
    settings,
    plan: { sampleSize: plan.sampleSize, maxErrors: plan.maxErrors, confidence: plan.confidence },
    judgeSource: liveOracle ? "live" : "seeded simulation",
    world: {
      note: `${DIGS} digs. Scout is really right ${pct(world.accuracy, 1)} of the time, against a promise of ${pct(settings.promise)}.${slip} The planned sample is ${plan.sampleSize} digs with at most ${plan.maxErrors} wrong.`,
      arms,
    },
    batch: {
      worlds,
      labels: ["Trust it when it looks good", "Earn it, then keep watching"],
      headline: `Worse Scouts promoted: ${pct(b.falsePromotion)} → ${pct(e.falsePromotion)}. Empty pits nobody saw: ${b.pits.toFixed(1)} → ${e.pits.toFixed(1)} an expedition.`,
      rows,
    },
    target: {
      text: "Promote at most 5 in 100 Scouts that are worse than the promise, let a good Scout do 30 in 100 digs alone, and leave at most 1.5 empty pits unseen per expedition.",
      checks,
      met: checks.every((c) => c.met),
    },
    ...(sweep !== undefined ? { sweep } : {}),
    ledger: await ledgerView(ledger),
  };
}
