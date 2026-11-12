/**
 * T4 red team: try hard to break ratchet. `bun experiments/e2e/t4-redteam/main.ts --offline`
 * runs every non-model attack deterministically (fault injection, budgets, invariants, ledger
 * and CLI robustness, hook stdin); without `--offline` it then runs the one live phase, the
 * arithmetic and date weak-spot run (raw vs digested facts), against Jev through OpenRouter
 * (`--live-only` skips the offline sections). The live injection study was not run in wave 1.
 * `--only <name>` runs one offline section. Outputs land in experiments/out/e2e/t4-redteam/.
 */
import { join } from "node:path";
import { progress, runDir, writeJson } from "../lib.ts";
import { runBudgetAttacks } from "./budget.ts";
import { Findings, findingsTable, TRACK } from "./common.ts";
import { runFaultMatrix } from "./faults.ts";
import { runInvariantAttacks } from "./invariants.ts";
import { runLedgerCliAttacks } from "./ledgercli.ts";

const args = process.argv.slice(2);
const offlineOnly = args.includes("--offline");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;
const liveOnly = args.includes("--live-only");

async function offline(dir: string): Promise<void> {
  const findings = new Findings();
  const sections: string[] = ["# T4 red team: offline attacks", ""];
  const want = (name: string) => only === undefined || only === name;
  if (want("faults")) {
    progress("[offline] fault matrix");
    const m = await runFaultMatrix(findings);
    sections.push(
      "## Fault matrix (worst outcome per path and fault)",
      "",
      m.markdown,
      "",
      `Enforced acts on garbage: ${m.enforcedActs.length}; cells that threw: ${m.threw.length}.`,
      "",
    );
    writeJson(join(dir, "fault-cells.json"), m.cells);
  }
  if (want("budget")) {
    progress("[offline] budgets");
    sections.push("## Budgets", "", await runBudgetAttacks(findings), "");
  }
  if (want("invariants")) {
    progress("[offline] invariants");
    sections.push("## Invariants", "", await runInvariantAttacks(findings), "");
  }
  if (want("ledger")) {
    progress("[offline] ledger and CLI");
    sections.push("## Ledger and CLI", "", await runLedgerCliAttacks(findings), "");
  }
  sections.push("## Every attack", "", findingsTable(findings.rows), "");
  const text = sections.join("\n");
  await Bun.write(join(dir, "offline.md"), text);
  writeJson(join(dir, "offline-findings.json"), findings.rows);
  process.stdout.write(`${text}\n`);
  progress(
    `[offline] ${findings.rows.length} attacks, ${findings.broken.length} broke a contract; ${dir}`,
  );
}

async function main(): Promise<void> {
  if (!liveOnly) await offline(runDir(TRACK, "offline"));
  if (offlineOnly) return;
  const { runLive } = await import("./live.ts");
  await runLive();
}

await main();
