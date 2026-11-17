import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlLedger } from "../../src/ledger/ledger.ts";
import { buildCodeTasks, digest } from "./corpus.ts";
import { liveOracles, Purchases } from "./live.ts";
import { report } from "./report.ts";
import { collect, fitBars, PROTOCOL, readScoredTasks, simulatedOracles } from "./runner.ts";
import { buildSqlTasks } from "./sql.ts";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--live" && arg !== "--offline" && !arg.startsWith("--budget=")))
  throw new Error("Usage: bun run tournament [--offline|--live] [--budget=5]");
if (args.includes("--live") && args.includes("--offline"))
  throw new Error("Choose live or offline");
const live = args.includes("--live");
const root = fileURLToPath(new URL("../../", import.meta.url));
const dir = join(
  root,
  "experiments/out/tournament",
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${live ? "live" : "offline"}`,
);
mkdirSync(dir, { recursive: true });
const json = (name: string, value: unknown) =>
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
const tasks = [...buildCodeTasks(), ...(await buildSqlTasks())];
const sourceFiles = [
  "corpus.ts",
  "sql.ts",
  "runner.ts",
  "report.ts",
  "types.ts",
  "live.ts",
  "main.ts",
];
json("manifest.json", {
  protocol: PROTOCOL,
  corpusHash: digest(tasks),
  createdAt: new Date().toISOString(),
  live,
  sources: Object.fromEntries(
    sourceFiles.map((name) => [name, digest(readFileSync(new URL(name, import.meta.url), "utf8"))]),
  ),
});
json("corpus.json", tasks);
json(
  "sources.json",
  Object.fromEntries(
    sourceFiles.map((name) => [name, readFileSync(new URL(name, import.meta.url), "utf8")]),
  ),
);
const purchases = new Purchases(
  Number(args.find((arg) => arg.startsWith("--budget="))?.slice(9) ?? 5),
  (receipt) => appendFileSync(join(dir, "purchases.jsonl"), `${JSON.stringify(receipt)}\n`),
);
const oracles = live ? liveOracles(purchases) : simulatedOracles(tasks);
const cheap = new JsonlLedger(join(dir, "cheap.jsonl"));
const strong = new JsonlLedger(join(dir, "strong.jsonl"));
const progress = (message: string) => process.stderr.write(`${message}\n`);
progress(`Tournament ${live ? "live" : "offline"}: ${tasks.length} tasks. ${dir}`);
for (const split of ["fit", "evaluation", "challenge"] as const) {
  const subset = tasks.filter((t) => t.split === split);
  progress(`Phase: ${split}`);
  await collect(subset, oracles.cheap, cheap, "cheap", progress, () => live && purchases.stopped);
  if (live && purchases.stopped)
    throw new Error(`Live acquisition stopped; receipts and partial ledger preserved at ${dir}`);
  await collect(
    subset,
    oracles.strong,
    strong,
    "strong",
    progress,
    () => live && purchases.stopped,
  );
  if (live && purchases.stopped)
    throw new Error(`Live acquisition stopped; receipts and partial ledger preserved at ${dir}`);
  if (split === "fit") {
    const fitted = fitBars(
      readScoredTasks(subset, [...(await cheap.all()), ...(await strong.all())]),
    );
    json("frozen.json", {
      bars: fitted,
      at: new Date().toISOString(),
      fitHash: digest(subset),
      protocolHash: digest(PROTOCOL),
    });
  }
}
const scored = readScoredTasks(tasks, [...(await cheap.all()), ...(await strong.all())]);
const frozen = JSON.parse(readFileSync(join(dir, "frozen.json"), "utf8")) as {
  bars: ReturnType<typeof fitBars>;
};
const markdown =
  report(scored, frozen.bars, live ? "live models" : "SIMULATION ONLY") +
  (live
    ? `\nProvider-billed acquisition total (including failed answers): $${purchases.spent.toFixed(6)}. If any answer failed after billing, replay arm costs are lower bounds and the comparison is incomplete.\n`
    : "");
writeFileSync(join(dir, "report.md"), markdown);
json("scored.json", scored);
process.stdout.write(markdown);
progress(`Saved ${join(dir, "report.md")}`);
