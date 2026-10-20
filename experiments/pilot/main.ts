import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SimOracle } from "../../src/oracles/sim.ts";
import { jevViaOpenRouter } from "../../src/oracles/systemone.ts";
import { runEvidenceExperiment } from "./evidence.ts";
import { runPilot, scenarioState } from "./runner.ts";
import { pilotScenarios, pilotSources } from "./scenarios.ts";

const args = process.argv.slice(2);
if (args.some((x) => x !== "--live")) throw new Error("Usage: bun run pilot [--live]");
const live = args.includes("--live");
const root = resolve("experiments/out/pilot");
await mkdir(root, { recursive: true });
const out = join(
  root,
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${live ? "live" : "sim"}`,
);
const truth = new Map(pilotScenarios.map((s) => [scenarioState(s).text, { judge: s.truth }]));
const oracle = live
  ? jevViaOpenRouter({
      model: "typesafe/jev-1.13",
      maxRetries: 0,
      fetch: ((input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(15_000) })) as typeof fetch,
    })
  : new SimOracle(
      { accuracy: 0.85, seed: 20261020, costPerQuestion: 0, id: "pilot-sim" },
      (state) => truth.get(state),
    );
console.log(`Running ${pilotScenarios.length} ${live ? "live" : "simulated"} shadow scenarios.`);
const result = await runPilot({
  oracle,
  scenarios: pilotScenarios,
  out,
  backend: live ? "live" : "simulated",
  model: live ? "typesafe/jev-1.13" : "SimOracle accuracy=0.85 seed=20261020",
});
await writeFile(join(out, "sources.json"), `${JSON.stringify(pilotSources, null, 2)}\n`);
await writeFile(
  join(out, "evidence.json"),
  `${JSON.stringify(runEvidenceExperiment(), null, 2)}\n`,
);
console.log(`Output: ${out}`);
console.log(`Requests: ${result.requests}; recorded spend: $${result.billedUsd.toFixed(6)}`);
console.log(
  `Shadow: ${result.total.actualActs} actual acts; ${result.total.suggestedActs} suggested acts; ` +
    `${result.total.wrongSuggestedActs} wrong suggestions; ${result.total.failedOpen} failed open.`,
);
console.log("Authored fixtures cannot authorize production enforcement.");
if (live && result.total.failedOpen > 0) {
  console.error("Live results include backend failures; inspect results.json and ledger.jsonl.");
}
