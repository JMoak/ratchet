/**
 * Track T3 runner: business decisions beyond agents. Five phases, each through the real engine
 * and a JSONL ledger, labelled as the decider from corpus files fixed before the first call:
 *
 *   approvals     refunds and expenses against a written policy; raw vs digested vs relative dates
 *   routing       8-way pick and 4-level rate on 256 tickets; fit half, freeze, validate half
 *   moderation    a 4-question battery: logodds (rho 0 and measured), max, learned, isotonic
 *   multilingual  60 tickets in es/de/ja with English vs translated rubrics
 *   coldstart     a profile from the routing ledger lent to a sibling gate; grade walk on every surface
 *
 *   bun experiments/e2e/t3-triage/main.ts [--offline] [--phase a,b,...] [--run <dir>]
 *
 * --offline swaps Jev for seeded SimOracles that know the decider's labels (so every rate is a
 * property of the simulator, not of Jev) and exercises the same wiring with no spend. --run
 * continues an existing run directory (coldstart reads the routing ledger it holds).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type SimConfig, SimOracle, type TruthFn } from "../../../src/oracles/sim.ts";
import type { Oracle } from "../../../src/types.ts";
import {
  corpusHash,
  gitHead,
  guard,
  JEV_113,
  JEV_114,
  jev113,
  jev114,
  progress,
  runDir,
  writeJson,
} from "../lib.ts";
import { approvals } from "./phases/approvals.ts";
import { coldstart } from "./phases/coldstart.ts";
import { moderation } from "./phases/moderation.ts";
import { multilingual } from "./phases/multilingual.ts";
import { routing } from "./phases/routing.ts";
import { CORPUS, ledgerSpend, Manifest } from "./util.ts";

export const TRACK = "t3-triage";

export interface Ctx {
  readonly dir: string;
  readonly offline: boolean;
  readonly manifest: Manifest;
  /** The primary oracle (jev-1.13), or a simulator that knows `truth` offline. */
  oracle(truth: TruthFn, sim?: Partial<SimConfig>): Oracle;
  /** A second model pin (jev-1.14), for profile expiry. */
  other(truth: TruthFn): Oracle;
  /** Before every live phase: throws past the evaluation ceiling or this track's own cap. */
  guard(phase: string): Promise<void>;
  /** Per-phase results, written to results.json as each phase ends. */
  result(phase: string, value: unknown): void;
  /** Markdown lines for the run's summary.md. */
  md(line?: string): void;
}

const TRACK_CAP_USD = 1.0;
const PHASES = ["approvals", "routing", "moderation", "multilingual", "coldstart"] as const;
type Phase = (typeof PHASES)[number];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const offline = process.argv.includes("--offline");
  const phases = (arg("phase")?.split(",") ?? [...PHASES]) as Phase[];
  for (const p of phases) if (!PHASES.includes(p)) throw new Error(`unknown phase ${p}`);
  const reuse = arg("run");
  const dir = reuse ?? runDir(TRACK, offline ? "offline" : "live");
  const corpora = Object.fromEntries(
    ["approvals", "routing", "sibling", "moderation", "multilingual"].map((n) => [
      n,
      corpusHash(JSON.parse(readFileSync(join(CORPUS, `${n}.json`), "utf8"))),
    ]),
  );
  const manifestPath = join(dir, "manifest.json");
  const previous = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>)
    : {};
  if (reuse && JSON.stringify(previous.corpora) !== JSON.stringify(corpora)) {
    throw new Error("the corpora changed since this run began; start a new run");
  }
  const manifest = new Manifest(manifestPath, {
    ...previous,
    track: TRACK,
    gitHead: gitHead(),
    offline,
    corpora,
    models: offline
      ? { primary: "SimOracle", other: "SimOracle" }
      : { primary: JEV_113, other: JEV_114 },
    oracleIds: offline ? {} : { primary: "jev113@openrouter", other: "jev114@openrouter" },
    trackCapUsd: TRACK_CAP_USD,
    runs: [...((previous.runs as unknown[]) ?? []), { phases, at: new Date().toISOString() }],
  });
  const resultsPath = join(dir, "results.json");
  const results: Record<string, unknown> = existsSync(resultsPath)
    ? (JSON.parse(readFileSync(resultsPath, "utf8")) as Record<string, unknown>)
    : {};
  const lines: string[] = [];
  let seed = 101;
  const ctx: Ctx = {
    dir,
    offline,
    manifest,
    oracle(truth, sim = {}) {
      if (!offline) return jev113();
      return new SimOracle(
        { accuracy: 0.85, temperature: 1, seed: seed++, id: "sim-primary", ...sim },
        truth,
      );
    },
    other(truth) {
      if (!offline) return jev114();
      return new SimOracle({ accuracy: 0.7, seed: seed++, id: "sim-other" }, truth);
    },
    async guard(phase) {
      if (offline) return;
      // The guard reads every track's billed spend; this track's own is what its ledgers recorded.
      await guard(`${TRACK}:${phase}`);
      const mine = ledgerSpend(dir);
      manifest.set("trackSpentUsd", mine);
      if (mine > TRACK_CAP_USD) throw new Error(`track cap reached: $${mine.toFixed(4)}`);
    },
    result(phase, value) {
      results[phase] = value;
      writeJson(resultsPath, results);
    },
    md(line = "") {
      lines.push(line);
      progress(line);
    },
  };
  const run: Record<Phase, (c: Ctx) => Promise<void>> = {
    approvals,
    routing,
    moderation,
    multilingual,
    coldstart,
  };
  for (const p of phases) {
    ctx.md(`\n## ${p}\n`);
    await run[p](ctx);
    await Bun.write(join(dir, "summary.md"), `${lines.join("\n")}\n`);
  }
  await ctx.guard("end");
  progress(`run directory: ${dir}`);
}

if (import.meta.main) await main();
