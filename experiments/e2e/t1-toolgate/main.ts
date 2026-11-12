/**
 * T1 runner: the agent tool gate through its whole lifecycle.
 *
 *   bun experiments/e2e/t1-toolgate/main.ts corpus            write corpus.json and spotcheck.json
 *   bun experiments/e2e/t1-toolgate/main.ts all [--offline]   every phase below, each its own process
 *   bun experiments/e2e/t1-toolgate/main.ts <phase> --run <dir> [--offline]
 *
 * Phases, in order: plan, fit, evidence, restore-evidence, enforce, restore-enforce, mechanics,
 * raw, battery, real, budget, cli, analyze. Live runs need OPENROUTER_API_KEY (.env) and read
 * the evaluation's spend guard before each live phase; --offline runs the same wiring on a
 * seeded SimOracle at no cost and proves nothing about Jev.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { rng, shuffled } from "../../../src/math.ts";
import { progress, runDir, writeJson } from "../lib.ts";
import { analyze } from "./analyze.ts";
import { CORPUS_FILE, runPaths, SPOTCHECK_FILE } from "./common.ts";
import { buildCorpus, CORPUS_SEED } from "./corpus.ts";
import { TOOL_QUESTION, TRACK } from "./gate.ts";
import {
  battery,
  budget,
  enforce,
  evidence,
  fit as fitPhase,
  mechanics,
  plan,
  raw,
  real,
  restoreCheck,
} from "./phases.ts";
import { verifyCli } from "./verify-cli.ts";

const PHASES = [
  "plan",
  "fit",
  "evidence",
  "restore-evidence",
  "enforce",
  "restore-enforce",
  "mechanics",
  "raw",
  "battery",
  "real",
  "budget",
  "cli",
  "analyze",
] as const;
type Phase = (typeof PHASES)[number];

function writeCorpus(): void {
  const items = buildCorpus();
  writeJson(CORPUS_FILE, { seed: CORPUS_SEED, generatedFrom: "corpus.ts", items });
  // A seeded sample for the coordinator's blind relabel: state and question, no label.
  const spot = shuffled(items, rng(CORPUS_SEED + 25))
    .slice(0, 25)
    .map((it) => ({
      id: it.id,
      state: it.state,
      question: { prompt: TOOL_QUESTION.prompt, criteria: TOOL_QUESTION.criteria },
    }));
  writeJson(SPOTCHECK_FILE, { seed: CORPUS_SEED + 25, items: spot });
  progress(`[corpus] ${items.length} items; spot check of ${spot.length}`);
}

async function runPhase(phase: Phase, dir: string, offline: boolean): Promise<void> {
  const run = runPaths(dir, offline);
  switch (phase) {
    case "plan":
      return plan(run);
    case "fit":
      return fitPhase(run);
    case "evidence":
      return evidence(run);
    case "restore-evidence":
      return restoreCheck(run, "evidence");
    case "enforce":
      return enforce(run);
    case "restore-enforce":
      return restoreCheck(run, "enforce");
    case "mechanics":
      return mechanics(run);
    case "raw":
      return raw(run);
    case "battery":
      return battery(run);
    case "real":
      return real(run);
    case "budget":
      return budget(run);
    case "cli":
      return verifyCli(run);
    case "analyze":
      return analyze(run);
  }
}

const argv = process.argv.slice(2);
const offline = argv.includes("--offline");
const runIndex = argv.indexOf("--run");
const command = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--run");

if (command === "corpus") {
  writeCorpus();
} else if (command === "all") {
  const dir = runDir(TRACK, offline ? "offline" : "live");
  writeFileSync(
    `${dir}/README.txt`,
    `T1 run, ${offline ? "offline" : "live"}, phases ${PHASES.join(", ")}\n`,
  );
  for (const phase of PHASES) {
    progress(`=== ${phase}`);
    const res = spawnSync(
      process.execPath,
      [import.meta.path, phase, "--run", dir, ...(offline ? ["--offline"] : [])],
      { stdio: "inherit" },
    );
    if (res.status !== 0) {
      progress(`phase ${phase} failed with exit ${res.status}`);
      process.exit(res.status ?? 1);
    }
  }
  progress(`run complete: ${dir}`);
} else if (command !== undefined && (PHASES as readonly string[]).includes(command)) {
  const dir = runIndex >= 0 ? argv[runIndex + 1] : undefined;
  if (dir === undefined) throw new Error("--run <dir> is required for a single phase");
  await runPhase(command as Phase, dir, offline);
} else {
  process.stderr.write(
    `usage: main.ts corpus | all [--offline] | <${PHASES.join("|")}> --run <dir> [--offline]\n`,
  );
  process.exit(2);
}
