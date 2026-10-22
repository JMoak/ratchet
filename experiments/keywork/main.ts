/**
 * Replay keywork's answered asks through Ratchet's tool gate, in shadow.
 *
 *   keywork sessions decisions --out decisions.jsonl        (in keywork, per workspace)
 *   bun run keywork --export decisions.jsonl                 dry run: validate, show one state
 *   bun run keywork --export decisions.jsonl --live          ask Jev, label, report
 *   bun run keywork --export decisions.jsonl --smoke --live  the same on the smoke set
 *
 * Without --live nothing leaves the machine and nothing is written. With --live each new
 * person-answered call is asked once and labelled with the person's answer, under a spend cap
 * per UTC day that is read from the ledger, so running the command again cannot reset it.
 * A plain run is in the fit phase until KEYWORK_FREEZE is set and in the evidence phase after;
 * --smoke replays the answers before the fit phase began. Each phase ingests only its own
 * answers into a ledger of its own (see phase.ts). The ledgers live under experiments/out/,
 * which is gitignored; they keep rendered states so `ratchet review` can show them, and those
 * states never leave this machine.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Engine } from "../../src/engine.ts";
import { JsonlLedger } from "../../src/ledger/ledger.ts";
import { jev, jevViaOpenRouter } from "../../src/oracles/systemone.ts";
import type { Oracle } from "../../src/types.ts";
import { keyworkGateSpec } from "./gate.ts";
import { type AnswerWindow, ingestDecisions, withinWindow } from "./ingest.ts";
import { currentPhase, PHASE_LEDGERS, type Phase, phaseSpec } from "./phase.ts";
import { parseToolDecisions, type ToolDecision } from "./record.ts";
import { keyworkReport } from "./report.ts";
import { toolCallState } from "./state.ts";

const USAGE =
  "Usage: bun run keywork --export <file> [--export <file> ...] [--smoke] [--ledger <path>] [--live] [--budget <usd per day>]";

interface Args {
  readonly exports: readonly string[];
  readonly ledger: string | undefined;
  readonly smoke: boolean;
  readonly live: boolean;
  readonly budgetUsd: number;
}

function parseArgs(argv: readonly string[]): Args {
  const exports: string[] = [];
  let ledger: string | undefined;
  let smoke = false;
  let live = false;
  let budgetUsd = 0.05;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--"))
        throw new Error(`${arg} needs a value\n${USAGE}`);
      return next;
    };
    if (arg === "--export") exports.push(value());
    else if (arg === "--ledger") ledger = value();
    else if (arg === "--smoke") smoke = true;
    else if (arg === "--live") live = true;
    else if (arg === "--budget") budgetUsd = Number(value());
    else throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
  if (exports.length === 0) throw new Error(USAGE);
  if (!(budgetUsd > 0 && budgetUsd <= 1)) throw new Error("--budget must be in (0, 1] USD a day");
  return { exports, ledger, smoke, live, budgetUsd };
}

/** The phase's own ledger unless one is named, and never another phase's ledger. */
function ledgerFor(phase: Phase, named: string | undefined): string {
  const path = resolve(named ?? PHASE_LEDGERS[phase]);
  const owner = (Object.keys(PHASE_LEDGERS) as Phase[]).find(
    (p) => resolve(PHASE_LEDGERS[p]) === path,
  );
  if (owner !== undefined && owner !== phase) {
    throw new Error(`${named} is the ${owner} ledger; a ${phase} run never writes there`);
  }
  return path;
}

function describeWindow(window: AnswerWindow): string {
  const parts = [
    ...(window.since !== undefined ? [`from ${window.since}`] : []),
    ...(window.before !== undefined ? [`before ${window.before}`] : []),
  ];
  return parts.join(" and ") || "every answer";
}

async function readExports(paths: readonly string[]): Promise<ToolDecision[]> {
  const decisions: ToolDecision[] = [];
  for (const path of paths) {
    const parsed = parseToolDecisions(await readFile(path, "utf8"));
    for (const { line, reason } of parsed.rejected) {
      console.error(`${path}:${line}: rejected: ${reason}`);
    }
    decisions.push(...parsed.decisions);
  }
  return decisions;
}

const unused: Oracle = {
  id: "unused",
  decide: () => Promise.reject(new Error("a dry run never asks the oracle")),
};

function liveOracle(): Oracle {
  const options = { maxRetries: 0 } as const;
  if (process.env.TYPESAFE_API_KEY) return jev(options);
  if (process.env.OPENROUTER_API_KEY) return jevViaOpenRouter(options);
  throw new Error("--live needs TYPESAFE_API_KEY or OPENROUTER_API_KEY in .env");
}

const args = parseArgs(process.argv.slice(2));
const phase: Phase = args.smoke ? "smoke" : currentPhase();
const spec = phaseSpec(phase);
const ledgerPath = ledgerFor(phase, args.ledger);
const decisions = await readExports(args.exports);
const people = decisions.filter((d) => d.answer.by === "person");
const chosen = people
  .filter((d) => withinWindow(d, spec.window))
  .sort((a, b) => Date.parse(a.answer.at) - Date.parse(b.answer.at));
if (args.live) await mkdir(dirname(ledgerPath), { recursive: true });
const engine = new Engine({
  oracle: args.live ? liveOracle() : unused,
  ledger: new JsonlLedger(ledgerPath),
  mode: "shadow",
  keepState: true,
  dailyBudgetUsd: args.budgetUsd,
  reserveUsd: 0.001,
});
const gate = engine.gate(keyworkGateSpec());

console.log(
  `${decisions.length} decisions read; ${people.length} answered by a person; ${chosen.length} ` +
    `in the ${phase} phase (${describeWindow(spec.window)}).`,
);
if (!args.live) {
  const first = chosen[0];
  if (first !== undefined) {
    console.log("\nDry run. This is the exact text the gate would send for the earliest answer:\n");
    console.log(toolCallState(first).text);
  }
  console.log("\nNothing was sent or written. Add --live to ask Jev in shadow.\n");
} else {
  const result = await ingestDecisions(engine, gate, decisions, spec.window);
  console.log(
    `Asked ${result.asked}; ${result.already} were already in the ledger; ` +
      `${result.outsideWindow} in other phases; ${result.steering} denied for the moment, not the call; skipped ` +
      `${Object.entries(result.skipped)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}. Recorded spend $${engine.spent.toFixed(6)}.`,
  );
  if (result.stoppedAtBudget) {
    console.log(
      `Stopped at the daily spend cap ($${args.budgetUsd} a UTC day); run again tomorrow or raise --budget.`,
    );
  }
  console.log("");
}
console.log(keyworkReport(await engine.ledger.all(), gate, { phase, decisions }));
