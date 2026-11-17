import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKS, type PackId, packState } from "../../examples/decision-packs/packs.ts";
import { JsonlLedger } from "../../src/ledger/ledger.ts";
import { SimOracle } from "../../src/oracles/sim.ts";
import { digest } from "../tournament/corpus.ts";
import { liveOracles, Purchases } from "../tournament/live.ts";
import { CASES } from "./curriculum.ts";
import {
  acquire,
  evaluate,
  fitPack,
  observations,
  PACK_ARMS,
  PACK_PROTOCOL,
  type PackBars,
  VARIANTS,
} from "./evaluate.ts";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--offline" && arg !== "--live" && !arg.startsWith("--budget=")))
  throw new Error("Usage: bun run decision-packs [--offline|--live] [--budget=5]");
if (args.includes("--offline") && args.includes("--live"))
  throw new Error("Choose offline or live");
const live = args.includes("--live");
const root = fileURLToPath(new URL("../../", import.meta.url));
const dir = join(
  root,
  "experiments/out/decision-packs",
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${live ? "live" : "offline"}`,
);
mkdirSync(dir, { recursive: true });
const json = (name: string, value: unknown) =>
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
json("manifest.json", {
  at: new Date().toISOString(),
  live,
  protocol: PACK_PROTOCOL,
  curriculumHash: digest(CASES),
  packHash: digest(PACKS),
  sourceHashes: Object.fromEntries(
    [
      "main.ts",
      "evaluate.ts",
      "curriculum.ts",
      "../../examples/decision-packs/packs.ts",
      "../tournament/live.ts",
    ].map((name) => [name, digest(readFileSync(new URL(name, import.meta.url), "utf8"))]),
  ),
});
json("curriculum.json", CASES);
json("packs.json", PACKS);
json(
  "sources.json",
  Object.fromEntries(
    [
      "main.ts",
      "evaluate.ts",
      "curriculum.ts",
      "../../examples/decision-packs/packs.ts",
      "../tournament/live.ts",
    ].map((name) => [name, readFileSync(new URL(name, import.meta.url), "utf8")]),
  ),
);
const purchases = new Purchases(
  Number(args.find((arg) => arg.startsWith("--budget="))?.slice(9) ?? 5),
  (purchase) => appendFileSync(join(dir, "purchases.jsonl"), `${JSON.stringify(purchase)}\n`),
);
const truths = new Map(CASES.map((item) => [packState(item.input).text, item.supported]));
const oracles = live
  ? liveOracles(purchases)
  : {
      cheap: new SimOracle(
        { id: "pack-cheap-sim", seed: 701, accuracy: 0.82, correlation: 0.6, latencyMs: 0 },
        (state) => ({ judge: truths.get(state) ?? false }),
      ),
      strong: new SimOracle(
        { id: "pack-strong-sim", seed: 733, accuracy: 0.94, correlation: 0.3, latencyMs: 0 },
        (state) => ({ judge: truths.get(state) ?? false }),
      ),
    };
const ledger = new JsonlLedger(join(dir, "observations.jsonl"));
const progress = (message: string) => process.stderr.write(`${message}\n`);
const frozen: Partial<Record<PackId, PackBars>> = {};
progress(`Decision packs ${live ? "live" : "offline"}: ${dir}`);
for (const split of ["fit", "evaluation", "challenge"] as const) {
  const items = CASES.filter((item) => item.split === split);
  for (const variant of VARIANTS) {
    progress(`${split}/${variant}: ${items.length} cases`);
    await acquire(
      items,
      variant === "strong" ? oracles.strong : oracles.cheap,
      variant,
      ledger,
      () => live && purchases.stopped,
    );
  }
  if (split === "fit") {
    const labelled = observations(items, await ledger.all());
    for (const pack of PACKS)
      frozen[pack.id] = await fitPack(labelled.filter((item) => item.item.pack === pack.id));
    json("frozen.json", {
      at: new Date().toISOString(),
      bars: frozen,
      fitHash: digest(items),
      protocolHash: digest(PACK_PROTOCOL),
    });
  }
}
const scored = observations(CASES, await ledger.all());
const results = [];
for (const item of scored.filter((value) => value.item.split !== "fit")) {
  const bars = frozen[item.item.pack];
  if (!bars) throw new Error("No frozen bars");
  for (const arm of PACK_ARMS)
    results.push({ ...(await evaluate(item, arm, bars)), split: item.item.split });
}
json("results.json", results);
const rows = await ledger.all();
const lines = [
  "# Applied decision packs: teaching-transfer pilot",
  "",
  `Mode: **${live ? "live models" : "SIMULATION ONLY"}**. Four packs, 16 worked teaching examples and 48 separate labelled cases in 24 paired source families.`,
  "Labels and rationales were authored by the assistant before acquisition. They are provisional development labels, not independent expert adjudications or evidence of clinical/financial competence.",
  "All measurement calls run in shadow. Policy comparisons replay the recorded judgments through real gates and trusted-entry floors in memory; no external action is executed.",
  "The comparison is bare question versus rubric versus rubric plus worked examples at the same 0.98 threshold. Fitted arms and the cross-family cascade are secondary exploratory comparisons.",
  `Complete-matrix ${live ? "provider-billed" : "simulated"} acquisition cost: $${(live ? purchases.spent : rows.reduce((sum, row) => sum + row.cost, 0)).toFixed(6)}. Failed judgments: ${rows.filter((row) => row.failedOpen).length}/${rows.length}.`,
  "If any judgment failed after billing, per-arm costs are lower bounds; the acquisition figure includes all provider-reported charges. Runs with provider failures are incomplete comparisons.",
  `Recorded models: ${[...new Set(rows.map((row) => row.model ?? row.oracle))].join(", ")}.`,
  "Per-arm costs below estimate consumed judgments from the recorded matrix, excluding expert authoring, generation, review, and integration. Synthetic runs measure wiring only; their teaching effects are not meaningful.",
  "",
];
for (const pack of PACKS) {
  lines.push(
    `## ${pack.title}`,
    "",
    `Allowed use: ${pack.allowedAction}`,
    `Exploratory frozen bars: ${JSON.stringify(frozen[pack.id])}.`,
    "",
  );
  lines.push(
    "### Judgment quality before policy floors (all non-fit cases)",
    "",
    "| Prompt | Answer agreement | Brier loss | Mean p on supported | Mean p on unsupported |",
    "| --- | ---: | ---: | ---: | ---: |",
  );
  const probe = scored.filter((value) => value.item.pack === pack.id && value.item.split !== "fit");
  for (const variant of VARIANTS) {
    const valid = probe.filter((value) => !value.observations[variant].failed);
    const positives = valid.filter((value) => value.truth);
    const negatives = valid.filter((value) => !value.truth);
    const average = (items: typeof valid) =>
      items.length
        ? (
            items.reduce((sum, value) => sum + value.observations[variant].p, 0) / items.length
          ).toFixed(3)
        : "n/a";
    const correct = valid.filter(
      (value) => value.observations[variant].p >= 0.5 === value.truth,
    ).length;
    const brier = valid.length
      ? (
          valid.reduce(
            (sum, value) => sum + (value.observations[variant].p - Number(value.truth)) ** 2,
            0,
          ) / valid.length
        ).toFixed(4)
      : "n/a";
    lines.push(
      `| ${variant} | ${correct}/${valid.length} (${probe.length - valid.length} failed) | ${brier} | ${average(positives)} | ${average(negatives)} |`,
    );
  }
  lines.push("");
  for (const split of ["evaluation", "challenge"] as const) {
    lines.push(
      `### ${split}`,
      "",
      "| Approach | Supported draft acts | Unsupported acts | Handoffs | Supported held | Judge calls | Judge cost |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const arm of PACK_ARMS) {
      const own = results.filter(
        (row) => row.pack === pack.id && row.arm === arm && row.split === split,
      );
      lines.push(
        `| ${arm} | ${own.filter((row) => row.correctAct).length}/${own.length} | ${own.filter((row) => row.wrongAct).length} | ${own.filter((row) => !row.acted).length} | ${own.filter((row) => row.missedSupported).length} | ${own.reduce((sum, row) => sum + row.calls, 0)} | $${own.reduce((sum, row) => sum + row.cost, 0).toFixed(6)} |`,
      );
    }
    lines.push("");
  }
}
lines.push(
  "## What this can establish",
  "",
  "This is a small curriculum and a working evaluation, not a validated domain model. Fit sets have four cases per pack and can only propose a bar. Positive/negative claims sharing a source form one family; neither repeated calls nor paired claims are independent trials. Do not pool these cases into a 98% reliability claim.",
  "Next gate: domain specialists blind-review the labels and input contracts; freeze the recipe; acquire representative cases from different documents, institutions, entities and time periods; evaluate once under a planned sample. Production labels use independent blind/census sources. Curriculum labels deliberately remain unregistered and cannot promote these gates.",
  "For medicine, draft screening annotations retain independent human final inclusion/exclusion. Finance drafts never authorize payments, trades, write-offs or journal postings. A source or arithmetic control failure, or any request beyond draft use, forces review even with a perfectly confident oracle.",
  "",
);
writeFileSync(join(dir, "report.md"), lines.join("\n"));
process.stdout.write(lines.join("\n"));
progress(`Saved ${join(dir, "report.md")}`);
