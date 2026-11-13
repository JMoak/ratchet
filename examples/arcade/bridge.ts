import { Engine, judge, MemoryLedger, type Oracle, runChain } from "../../src/index.ts";
import {
  type Arm,
  type BatchRow,
  batchSeed,
  type Cell,
  check,
  flag,
  ledgerView,
  mean,
  normal,
  numeric,
  objectInput,
  reading,
  SWEEP_WORLDS,
  type Sweep,
  share,
  stream,
  tableOracle,
  WORLDS,
  worldsOf,
} from "./shared.ts";

/**
 * Bridge Builder: a chain of dependent steps, built two ways on the same seeded gorge.
 *
 * Bolt lays one piece per span. A piece is sound about four times in five, less often on a hard
 * span, and one flawed piece anywhere drops the bridge when Bolt walks it. "Build and hope" lays
 * every span once and walks. The ratchet has an inspector read each piece before it is
 * committed: a piece the gate does not act on is torn down and laid again, so progress is only
 * ever made of verified pieces. A chain that runs out of attempts stops short with nobody on it.
 *
 * Ground truth (is the piece sound) is the simulation's. It labels the ledger and never enters
 * an inspector's state.
 */
const PRIOR = 0.8;
const question = judge("Is this bridge piece sound enough to carry the span's load?", {
  id: "bridge.sound",
});

export interface BridgeSettings {
  readonly spans: number;
  readonly bar: number;
  readonly attempts: number;
  readonly pooled: boolean;
  readonly second: boolean;
}

interface Piece {
  readonly span: number;
  readonly attempt: number;
  readonly sound: boolean;
  /** What each inspection crew would state for this piece. */
  readonly crews: readonly [number, number];
  readonly text: string;
}

/** Piece `attempt` of `span` in world `seed`: the same piece whichever arm lays it. */
function pieceAt(seed: number, span: number, attempt: number, second: boolean): Piece {
  const hard = stream(seed, span)() < 0.2;
  const rand = stream(seed, span, attempt + 1);
  const sound = rand() < (hard ? 0.65 : 0.88);
  const strength = hard ? 1.1 : 1.5;
  const looks = [normal(rand), normal(rand)] as const;
  const crews = [
    reading(sound, strength, looks[0], PRIOR),
    reading(sound, strength, looks[1], PRIOR),
  ] as const;
  // A load test deflects less on a sound piece; the tolerance is 4 mm.
  const deflection = (look: number) => (4 - (sound ? strength : -strength) - look).toFixed(2);
  const text = [
    `gorge: ${seed}`,
    `span: ${span + 1}`,
    `attempt: ${attempt + 1}`,
    "load test tolerance: 4.00 mm deflection",
    `crew A measured: ${deflection(looks[0])} mm`,
    ...(second ? [`crew B measured: ${deflection(looks[1])} mm`] : []),
  ].join("\n");
  return { span, attempt, sound, crews, text };
}

interface SpanRun {
  readonly attempts: readonly { readonly piece: Piece; readonly stated: number | null }[];
  readonly committed: Piece | undefined;
}

interface Run {
  readonly outcome: "crossed" | "collapsed" | "stopped";
  /** The span that failed: the first flawed one walked on, or the one that ran out of attempts. */
  readonly at: number | undefined;
  readonly materials: number;
  readonly inspections: number;
  readonly spans: readonly SpanRun[];
}

/** Lay every span once and walk: the product of the per-span chances. */
function hope(seed: number, settings: BridgeSettings): Run {
  const spans = Array.from({ length: settings.spans }, (_, span) => {
    const piece = pieceAt(seed, span, 0, settings.second);
    return { attempts: [{ piece, stated: null }], committed: piece };
  });
  const flawed = spans.findIndex((s) => !s.committed.sound);
  return {
    outcome: flawed < 0 ? "crossed" : "collapsed",
    at: flawed < 0 ? undefined : flawed,
    materials: settings.spans,
    inspections: 0,
    spans,
  };
}

/** Verify each piece before it is committed (`runChain`), then walk what was committed. */
async function ratchet(
  seed: number,
  settings: BridgeSettings,
  ledger: MemoryLedger,
  live?: Oracle,
): Promise<Run> {
  const tables = [new Map<string, number>(), new Map<string, number>()] as const;
  const crewA = live ?? tableOracle("bridge.crew-a", "seeded-inspector-v3", tables[0]);
  const crewB = tableOracle("bridge.crew-b", "seeded-inspector-v3", tables[1]);
  const engine = new Engine({ oracle: crewA, ledger, mode: "enforce", keepState: true });
  const gate = engine.gate({
    id: "bridge.inspect",
    question,
    policy: { actAbove: settings.bar },
    // Two crews with their own instruments: independent looks, and the base rate counted once.
    ...(settings.second && !live
      ? {
          strategy: {
            ensemble: {
              members: [
                { oracle: crewA, label: "crew-a" },
                { oracle: crewB, label: "crew-b" },
              ],
              correlation: 0,
              priorYes: PRIOR,
            },
          },
        }
      : {}),
  });
  const runs: { piece: Piece; stated: number | null }[][] = Array.from(
    { length: settings.spans },
    () => [],
  );
  const steps = Array.from({ length: settings.spans }, (_, span) => ({
    name: `span-${span + 1}`,
    ...(settings.pooled ? {} : { maxAttempts: settings.attempts }),
    propose: async (built: readonly Piece[]) => {
      const piece = pieceAt(seed, span, runs[span]?.length ?? 0, settings.second);
      tables[0].set(piece.text, piece.crews[0]);
      tables[1].set(piece.text, piece.crews[1]);
      return [...built, piece];
    },
    verify: async (_before: readonly Piece[], after: readonly Piece[]) => {
      const piece = after.at(-1) as Piece;
      const answer = await gate.ask(piece.text);
      await engine.label(answer.recordId, {
        truth: piece.sound,
        correct: answer.ruling.go >= 0.5 === piece.sound,
      });
      runs[span]?.push({ piece, stated: answer.decision.failedOpen ? null : answer.ruling.go });
      return answer;
    },
  }));
  const chain = await runChain<readonly Piece[]>(
    [],
    steps,
    { actAbove: settings.bar },
    settings.pooled ? { attemptPool: settings.spans * settings.attempts } : {},
  );
  const spans = runs.map((attempts, span) => ({ attempts, committed: chain.state[span] }));
  const materials = runs.reduce((n, a) => n + a.length, 0);
  const inspections = materials * (settings.second && !live ? 2 : 1);
  if (!chain.ok) {
    return { outcome: "stopped", at: chain.state.length, materials, inspections, spans };
  }
  const flawed = chain.state.findIndex((p) => !p.sound);
  return {
    outcome: flawed < 0 ? "crossed" : "collapsed",
    at: flawed < 0 ? undefined : flawed,
    materials,
    inspections,
    spans,
  };
}

const pct = (p: number): string => `${Math.round(p * 100)}%`;

function cells(run: Run, inspected: boolean): Cell[] {
  return run.spans.map((span, index): Cell => {
    const n = span.attempts.length;
    const tries = span.attempts
      .map((a, i) => {
        const last = i === n - 1 && span.committed !== undefined;
        const stated = a.stated === null ? "no reading" : `read ${pct(a.stated)} sound`;
        return `attempt ${i + 1} ${stated}, ${last ? "committed" : "torn down"}`;
      })
      .join("; ");
    const where = `Span ${index + 1}`;
    if (n === 0) return { kind: "empty", note: `${where}: never reached.` };
    if (span.committed === undefined) {
      return { kind: "held", text: String(n), note: `${where}: ${tries}. Out of attempts.` };
    }
    const text = n > 1 ? String(n) : "";
    if (!inspected) {
      return span.committed.sound
        ? { kind: "ok", note: `${where}: laid once, sound.` }
        : { kind: "bad", text: "×", note: `${where}: laid once, flawed, and nobody looked.` };
    }
    return span.committed.sound
      ? { kind: "ok", text, note: `${where}: ${tries}. Sound.` }
      : { kind: "bad", text: "×", note: `${where}: ${tries}. The inspector passed a flaw.` };
  });
}

function summary(run: Run, total: number): string {
  if (run.outcome === "crossed") return `Crossed. ${run.materials} pieces laid.`;
  if (run.outcome === "stopped") {
    return `Stopped at span ${(run.at ?? 0) + 1} of ${total}, out of attempts. Nobody was on it.`;
  }
  return `Collapsed at span ${(run.at ?? 0) + 1} with Bolt on it.`;
}

async function batch(settings: BridgeSettings, worlds: number) {
  const hoped: Run[] = [];
  const built: Run[] = [];
  for (let i = 0; i < worlds; i++) {
    hoped.push(hope(batchSeed(i), settings));
    built.push(await ratchet(batchSeed(i), settings, new MemoryLedger()));
  }
  const rate = (runs: readonly Run[], outcome: Run["outcome"]) =>
    share(runs.filter((r) => r.outcome === outcome).length, runs.length);
  return {
    crossed: [rate(hoped, "crossed"), rate(built, "crossed")] as const,
    collapsed: [rate(hoped, "collapsed"), rate(built, "collapsed")] as const,
    stopped: [rate(hoped, "stopped"), rate(built, "stopped")] as const,
    materials: [mean(hoped.map((r) => r.materials)), mean(built.map((r) => r.materials))] as const,
    inspections: [0, mean(built.map((r) => r.inspections))] as const,
  };
}

export function settingsOf(input: Record<string, unknown>): BridgeSettings {
  return {
    spans: numeric(input, "spans", 10, 4, 16, true),
    bar: numeric(input, "bar", 0.9, 0.5, 0.99),
    attempts: numeric(input, "attempts", 3, 1, 5, true),
    pooled: flag(input, "pooled", false),
    second: flag(input, "second", false),
  };
}

export async function play(input: unknown, liveOracle?: Oracle) {
  const data = objectInput(input);
  const seed = numeric(data, "seed", 3, 0, 1_000_000, true);
  const settings = settingsOf(data);
  const wantSweep = flag(data, "sweep", false);
  const worlds = worldsOf(data, WORLDS);

  const ledger = new MemoryLedger();
  const baseline = hope(seed, settings);
  const engine = await ratchet(seed, settings, ledger, liveOracle);
  const arms: Arm[] = [
    {
      id: "baseline",
      label: "Build and hope",
      verdict: baseline.outcome === "crossed" ? "good" : "bad",
      summary: summary(baseline, settings.spans),
      cells: cells(baseline, false),
    },
    {
      id: "engine",
      label: "The ratchet",
      verdict:
        engine.outcome === "crossed" ? "good" : engine.outcome === "stopped" ? "safe" : "bad",
      summary: summary(engine, settings.spans),
      cells: cells(engine, true),
    },
  ];

  const b = await batch(settings, worlds);
  const rows: BatchRow[] = [
    { label: "Crossed", baseline: b.crossed[0], engine: b.crossed[1], unit: "pct", better: "high" },
    {
      label: "Collapsed with Bolt on it",
      baseline: b.collapsed[0],
      engine: b.collapsed[1],
      unit: "pct",
      better: "low",
    },
    {
      label: "Stopped short, nobody on it",
      baseline: b.stopped[0],
      engine: b.stopped[1],
      unit: "pct",
      better: "none",
    },
    {
      label: "Pieces laid per bridge",
      baseline: b.materials[0],
      engine: b.materials[1],
      unit: "num",
      better: "none",
    },
    {
      label: "Inspections per bridge",
      baseline: b.inspections[0],
      engine: b.inspections[1],
      unit: "num",
      better: "none",
    },
  ];
  const budget = Math.round(settings.spans * 1.4);
  const checks = [
    check("Crossed", b.crossed[1], "min", 0.95),
    check("Collapsed", b.collapsed[1], "max", 0.04),
    check("Pieces laid per bridge", b.materials[1], "max", budget, "num"),
  ];

  let sweep: Sweep | undefined;
  if (wantSweep) {
    const values = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.97, 0.99];
    const runs = [];
    for (const bar of values) runs.push(await batch({ ...settings, bar }, SWEEP_WORLDS));
    sweep = {
      lever: "Inspector's bar",
      values,
      current: settings.bar,
      series: [
        { label: "Crossed", values: runs.map((r) => r.crossed[1]) },
        { label: "Collapsed", values: runs.map((r) => r.collapsed[1]) },
        { label: "Stopped short", values: runs.map((r) => r.stopped[1]) },
      ],
    };
  }

  return {
    game: "bridge",
    title: "Bridge Builder",
    seed,
    settings,
    judgeSource: liveOracle ? "live" : "seeded simulation",
    world: {
      note: `${settings.spans} spans. A piece is sound about four times in five, so laying every span once and walking works ${pct(b.crossed[0])} of the time.`,
      arms,
    },
    batch: {
      worlds,
      labels: ["Build and hope", "The ratchet"],
      headline: `Crossed ${pct(b.crossed[0])} → ${pct(b.crossed[1])}. Collapses ${pct(b.collapsed[0])} → ${pct(b.collapsed[1])}.`,
      rows,
    },
    target: {
      text: `Cross 95 gorges in 100, collapse in at most 4, and lay no more than ${budget} pieces a bridge.`,
      checks,
      met: checks.every((c) => c.met),
    },
    ...(sweep !== undefined ? { sweep } : {}),
    ledger: await ledgerView(ledger),
  };
}
