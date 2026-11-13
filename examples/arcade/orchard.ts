import { Engine, effectiveN, judge, MemoryLedger, type Oracle } from "../../src/index.ts";
import {
  type Arm,
  type BatchRow,
  batchSeed,
  type Cell,
  check,
  ledgerView,
  mean,
  normal,
  numeric,
  objectInput,
  reading,
  type Sweep,
  share,
  stream,
  tableOracle,
  worldsOf,
} from "./shared.ts";

/**
 * Signal Orchard: the same scouts, pooled two ways.
 *
 * Pip picks a fruit only when the scouts' pooled answer clears the bar, and the orchard promises
 * its buyer that 95 picked fruit in 100 are ripe. Scouts of one family carry the same sensor, so
 * their mistakes come together: their errors correlate at 0.7. "Count every voice" pools them as
 * if each were independent and so claims more than it knows. The engine's pool takes the
 * correlation as a parameter and shrinks the evidence to what is independent; a second family
 * with its own sensor adds evidence that more scouts of the first cannot.
 *
 * Ripeness is the simulation's. It labels the ledger and never enters a scout's state.
 */
const FRUIT = 20;
const FAMILY_CORRELATION = 0.7;
const STRENGTH = 0.9;
const FAMILIES = ["meadow", "brook", "hill"] as const;
const question = judge("Is this fruit ripe enough to pick?", { id: "orchard.ripe" });

export interface OrchardSettings {
  readonly scouts: number;
  readonly families: number;
  readonly assumed: number;
  readonly bar: number;
}

interface Fruit {
  readonly ripe: boolean;
  /** What each scout would state, in panel order. */
  readonly stated: readonly number[];
  readonly text: string;
}

/** Scout `i` belongs to family `i mod families`, so a panel spreads evenly across families. */
const familyOf = (scout: number, families: number): number => scout % families;
const keyOf = (scout: number, families: number): string =>
  `${FAMILIES[familyOf(scout, families)]}-${Math.floor(scout / families) + 1}`;

function fruitAt(seed: number, index: number, settings: OrchardSettings): Fruit {
  const rand = stream(seed, index);
  const ripe = rand() < 0.5;
  // One shared draw per family is the sensor's error; each scout adds a little of its own.
  const shared = FAMILIES.map(() => normal(rand));
  const own = Array.from({ length: 7 }, () => normal(rand));
  const looks = Array.from({ length: settings.scouts }, (_, i) => {
    const family = shared[familyOf(i, settings.families)] ?? 0;
    return (
      Math.sqrt(FAMILY_CORRELATION) * family + Math.sqrt(1 - FAMILY_CORRELATION) * (own[i] ?? 0)
    );
  });
  const stated = looks.map((noise) => reading(ripe, STRENGTH, noise));
  // A ripe fruit reads sweeter; the picking line is 12 Brix.
  const brix = (noise: number) => (12 + (ripe ? STRENGTH : -STRENGTH) + noise).toFixed(1);
  const text = [
    `orchard: ${seed}`,
    `fruit: ${index + 1}`,
    "picking line: 12.0 Brix",
    ...looks.map((noise, i) => `${keyOf(i, settings.families)} measured: ${brix(noise)} Brix`),
  ].join("\n");
  return { ripe, stated, text };
}

interface Pick {
  readonly fruit: Fruit;
  readonly pooled: number;
  readonly picked: boolean;
}

/** The panel pooled at `assumed` within-family correlation, through a real gate. */
async function season(
  seed: number,
  settings: OrchardSettings,
  assumed: number,
  gateId: string,
  ledger: MemoryLedger,
  live?: Oracle,
): Promise<Pick[]> {
  const tables = Array.from({ length: settings.scouts }, () => new Map<string, number>());
  const members = tables.map((table, i) => ({
    oracle: tableOracle(`orchard.${keyOf(i, settings.families)}`, "seeded-scout-v3", table),
    label: keyOf(i, settings.families),
  }));
  // Scouts of one family share the assumed correlation; families are independent of each other.
  const correlations = Object.fromEntries(
    members.map((a, i) => [
      a.label,
      Object.fromEntries(
        members
          .filter((b) => b !== a)
          .map((b, j) => [
            b.label,
            familyOf(i, settings.families) === familyOf(j >= i ? j + 1 : j, settings.families)
              ? assumed
              : 0,
          ]),
      ),
    ]),
  );
  const first = members[0]?.oracle as Oracle;
  const engine = new Engine({ oracle: live ?? first, ledger, mode: "enforce", keepState: true });
  const gate = engine.gate({
    id: gateId,
    question,
    policy: { actAbove: settings.bar },
    ...(settings.scouts > 1 && !live
      ? { strategy: { ensemble: { members, correlations, priorYes: 0.5 } } }
      : {}),
  });
  const picks: Pick[] = [];
  for (let index = 0; index < FRUIT; index++) {
    const fruit = fruitAt(seed, index, settings);
    for (const [i, table] of tables.entries()) table.set(fruit.text, fruit.stated[i] ?? 0.5);
    const answer = await gate.ask(fruit.text);
    await engine.label(answer.recordId, {
      truth: fruit.ripe,
      correct: answer.ruling.go >= 0.5 === fruit.ripe,
    });
    picks.push({ fruit, pooled: answer.ruling.go, picked: answer.action === "act" });
  }
  return picks;
}

const pct = (p: number): string => `${Math.round(p * 100)}%`;
const profit = (picks: readonly Pick[]): number =>
  picks.reduce((sum, p) => sum + (p.picked ? (p.fruit.ripe ? 1 : -10) : 0), 0);

function cells(picks: readonly Pick[]): Cell[] {
  return picks.map((p, i): Cell => {
    const said = `Fruit ${i + 1}: the pool said ${pct(p.pooled)} ripe`;
    if (p.picked) {
      return p.fruit.ripe
        ? { kind: "ok", note: `${said}, picked. Ripe.` }
        : { kind: "bad", text: "×", note: `${said}, picked. It was not ripe.` };
    }
    return p.fruit.ripe
      ? { kind: "skip", note: `${said}, left on the tree. It was ripe.` }
      : { kind: "empty", note: `${said}, left on the tree. Not ripe.` };
  });
}

function summary(picks: readonly Pick[]): string {
  const picked = picks.filter((p) => p.picked);
  const unripe = picked.filter((p) => !p.fruit.ripe).length;
  if (picked.length === 0) return "Picked nothing: no fruit cleared the bar.";
  return `Picked ${picked.length}, ${unripe} of them unripe. Profit ${profit(picks)}.`;
}

function verdict(picks: readonly Pick[]): Arm["verdict"] {
  const picked = picks.filter((p) => p.picked);
  if (picked.some((p) => !p.fruit.ripe)) return "bad";
  return picked.length === 0 ? "safe" : "good";
}

/** Twenty fruit a season, so 300 seasons are 6,000 decisions an arm. */
const SEASONS = 300;

async function batch(settings: OrchardSettings, worlds: number, engineOnly = false) {
  const arms: Pick[][] = [[], []];
  const profits: number[][] = [[], []];
  for (let i = 0; i < worlds; i++) {
    const seed = batchSeed(i);
    for (const [arm, assumed] of [0, settings.assumed].entries()) {
      if (engineOnly && arm === 0) continue;
      const picks = await season(seed, settings, assumed, "orchard.pick", new MemoryLedger());
      arms[arm]?.push(...picks);
      profits[arm]?.push(profit(picks));
    }
  }
  const figures = (arm: number) => {
    const picked = (arms[arm] ?? []).filter((p) => p.picked);
    return {
      precision: share(picked.filter((p) => p.fruit.ripe).length, picked.length),
      claimed: mean(picked.map((p) => p.pooled)),
      picked: picked.length / worlds,
      profit: mean(profits[arm] ?? []),
    };
  };
  return [figures(0), figures(1)] as const;
}

export function settingsOf(input: Record<string, unknown>): OrchardSettings {
  const scouts = numeric(input, "scouts", 5, 1, 7, true);
  return {
    scouts,
    families: Math.min(scouts, numeric(input, "families", 1, 1, 3, true)),
    assumed: numeric(input, "assumed", FAMILY_CORRELATION, 0, 0.95),
    bar: numeric(input, "bar", 0.95, 0.5, 0.99),
  };
}

export async function play(input: unknown, liveOracle?: Oracle) {
  const data = objectInput(input);
  const seed = numeric(data, "seed", 18, 0, 1_000_000, true);
  const settings = settingsOf(data);
  if (data.sweep !== undefined && typeof data.sweep !== "boolean") {
    throw new Error("sweep must be a boolean.");
  }

  const ledger = new MemoryLedger();
  const naive = await season(seed, settings, 0, "orchard.count-every-voice", new MemoryLedger());
  const honest = await season(
    seed,
    settings,
    settings.assumed,
    "orchard.count-independent",
    ledger,
    liveOracle,
  );
  const arms: Arm[] = [
    {
      id: "baseline",
      label: "Count every voice",
      verdict: verdict(naive),
      summary: summary(naive),
      cells: cells(naive),
    },
    {
      id: "engine",
      label: "Count what is independent",
      verdict: verdict(honest),
      summary: summary(honest),
      cells: cells(honest),
    },
  ];

  const worlds = worldsOf(data, SEASONS);
  const [b, e] = await batch(settings, worlds);
  const looks = settings.scouts * FRUIT;
  const rows: BatchRow[] = [
    {
      label: "Picked fruit that was ripe",
      baseline: b.precision,
      engine: e.precision,
      unit: "pct",
      better: "high",
    },
    {
      label: "What the pool claimed for those picks",
      baseline: b.claimed,
      engine: e.claimed,
      unit: "pct",
      better: "none",
    },
    {
      label: "Fruit picked per season, of 20",
      baseline: b.picked,
      engine: e.picked,
      unit: "num",
      better: "none",
    },
    {
      label: "Profit per season (+1 ripe, −10 unripe)",
      baseline: b.profit,
      engine: e.profit,
      unit: "num",
      better: "high",
    },
    {
      label: "Scout looks per season",
      baseline: looks,
      engine: looks,
      unit: "num",
      better: "none",
    },
  ];
  const checks = [
    check("Picked fruit that was ripe", e.precision, "min", 0.95),
    check("Fruit picked per season", e.picked, "min", 7, "num"),
    check("Scout looks per season", looks, "max", 80, "num"),
  ];

  let sweep: Sweep | undefined;
  if (data.sweep === true) {
    const values = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    const runs = [];
    for (const assumed of values) {
      runs.push((await batch({ ...settings, assumed }, 120, true))[1]);
    }
    sweep = {
      lever: "Assumed correlation within a family",
      values,
      current: settings.assumed,
      series: [
        { label: "Picked fruit that was ripe", values: runs.map((r) => r.precision) },
        { label: "What the pool claimed", values: runs.map((r) => r.claimed) },
        { label: "Share of fruit picked", values: runs.map((r) => r.picked / FRUIT) },
      ],
    };
  }

  const perFamily = Math.ceil(settings.scouts / settings.families);
  return {
    game: "orchard",
    title: "Signal Orchard",
    seed,
    settings,
    judgeSource: liveOracle ? "live" : "seeded simulation",
    world: {
      note: `${settings.scouts} scouts from ${settings.families} ${settings.families === 1 ? "family" : "families"}. ${perFamily} scouts sharing a sensor are worth ${effectiveN(perFamily, FAMILY_CORRELATION).toFixed(1)} independent ones.`,
      arms,
    },
    batch: {
      worlds,
      labels: ["Count every voice", "Count what is independent"],
      headline: `Picked fruit that was ripe: ${pct(b.precision)} → ${pct(e.precision)}. Both pools claimed ${pct(Math.min(b.claimed, e.claimed))} or more.`,
      rows,
    },
    target: {
      text: "Keep the promise of 95 ripe in 100 picked, pick at least 7 fruit a season, and pay for no more than 80 scout looks.",
      checks,
      met: checks.every((c) => c.met),
    },
    ...(sweep !== undefined ? { sweep } : {}),
    ledger: await ledgerView(ledger),
  };
}
