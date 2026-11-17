import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKS, packSpec } from "../../examples/decision-packs/packs.ts";
import { JsonlLedger } from "../../src/ledger/ledger.ts";
import { LlmJsonOracle } from "../../src/oracles/llm-json.ts";
import { RuleOracle } from "../../src/oracles/rules.ts";
import { jevViaOpenRouter } from "../../src/oracles/systemone.ts";
import { Purchases } from "../tournament/live.ts";
import { DEMO_CASES, DEMO_DRAFT } from "./fixture.ts";
import {
  BASE_PACK,
  capture,
  compileDraft,
  hash,
  measure,
  parseCases,
  type Score,
  TEACHER_MODEL,
  teach,
  teacherRequest,
  teachingExamples,
} from "./forge.ts";

const args = process.argv.slice(2);
const value = (name: string) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!args.length || args.includes("--help")) {
  console.log(
    [
      "bun run forge --demo --offline",
      "bun run forge --demo --live [--budget=5] [--teacher=openai/gpt-6-astra]",
      "bun run forge --cases=reviewed.jsonl --live [--budget=5]",
      "bun run forge --cases=reviewed.jsonl --offline --draft=reviewed-draft.json",
      "Live sends the selected case export to OpenRouter. All decisions remain in shadow.",
    ].join("\n"),
  );
  process.exit(0);
}
if (
  args.some((arg) => !/^(--demo|--live|--offline|--(?:cases|draft|budget|teacher)=.+)$/.test(arg))
)
  throw new Error("Unknown forge option; use --help");
const live = args.includes("--live");
const demo = args.includes("--demo");
const inputPath = value("cases");
if (live === args.includes("--offline") || demo === Boolean(inputPath))
  throw new Error("Choose --live or --offline, and --demo or --cases=path");
if (live && value("draft")) throw new Error("Live mode authors one new draft; omit --draft");
if (!live && !demo && !value("draft")) throw new Error("Offline custom cases need --draft=path");
const cases = parseCases(
  demo
    ? DEMO_CASES.map((item) => JSON.stringify(item)).join("\n")
    : readFileSync(inputPath as string, "utf8"),
);
const apiKey = process.env.OPENROUTER_API_KEY;
if (live && !apiKey) throw new Error("Load the key with the secure experiment launcher");
const root = fileURLToPath(new URL("../out/forge/", import.meta.url));
mkdirSync(root, { recursive: true });
const dir = join(
  root,
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${live ? "live" : "offline"}`,
);
mkdirSync(dir);
const json = (name: string, data: unknown) =>
  writeFileSync(join(dir, name), `${JSON.stringify(data, null, 2)}\n`);
const purchases = new Purchases(Number(value("budget") ?? 5), (receipt) =>
  appendFileSync(join(dir, "purchases.jsonl"), `${JSON.stringify(receipt)}\n`),
);
const teacherModel = value("teacher") ?? TEACHER_MODEL;
console.log(`Recipe forge ${live ? "live" : "offline wiring only"}: ${dir}`);
writeFileSync(
  join(dir, "cases.jsonl"),
  `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`,
);
json(
  "sources.json",
  Object.fromEntries(
    [
      "./forge.ts",
      "./fixture.ts",
      "./main.ts",
      "../../examples/decision-packs/packs.ts",
      "../tournament/live.ts",
    ].map((name) => [name, readFileSync(new URL(name, import.meta.url), "utf8")]),
  ),
);

try {
  const captured = new JsonlLedger(join(dir, "cases-ledger.jsonl"));
  await capture(cases, captured);
  const examples = teachingExamples(cases, await captured.all());
  json("teacher-request.json", teacherRequest(examples));
  console.log(
    `Captured ${cases.length} cases; teacher sees ${examples.length} teaching cases only.`,
  );
  const teacher = live
    ? await teach(examples, apiKey as string, purchases.fetch, teacherModel)
    : {
        model: "offline:hand-authored",
        draft: value("draft")
          ? (JSON.parse(readFileSync(value("draft") as string, "utf8")) as unknown)
          : DEMO_DRAFT,
      };
  json("teacher.json", teacher);
  const { draft, pack } = compileDraft(teacher.draft, examples);
  const recipe = {
    schema: "ratchet.forged-recipe/1",
    status: "draft",
    task: "skuby.reply-fact-supported",
    teacher: teacher.model,
    draft,
    pack,
    evidenceVersion: packSpec(pack).evidenceVersion,
    provenance: examples.filter((item) => draft.exampleIds.includes(item.id)),
    inputHash: hash(cases),
    teachingHash: hash(examples),
    testHash: hash(cases.filter((c) => c.split === "test")),
    threshold: 0.98,
    mode: "shadow",
    qualification: "none; exploratory comparison only",
  };
  // Freeze the exact recipe and split before the first held-out model call.
  json("recipe.json", recipe);
  console.log(`Compiled ${draft.rubric.length} rules and ${pack.examples.length} linked examples.`);
  const offline = new RuleOracle([], "offline:unassessed");
  const cheap = live
    ? jevViaOpenRouter({
        apiKey: apiKey as string,
        model: "typesafe/jev-1.13",
        fetch: purchases.fetch,
        maxRetries: 0,
      })
    : offline;
  const strong = live
    ? new LlmJsonOracle({
        apiKey: apiKey as string,
        model: teacherModel,
        fetch: purchases.fetch,
        maxTokens: 4096,
      })
    : offline;
  const generic = PACKS.find((p) => p.id === "enterprise");
  if (!generic) throw new Error("Missing procurement baseline");
  const ledger = new JsonlLedger(join(dir, "observations.jsonl"));
  const heldOut = cases.filter((item) => item.split === "test");
  const scores: Score[] = [];
  for (const arm of [
    { id: "jev-bare", pack: BASE_PACK, oracle: cheap, teaching: "bare" },
    { id: "jev-generic", pack: generic, oracle: cheap, teaching: "taught" },
    { id: "jev-forged", pack, oracle: cheap, teaching: "taught" },
    { id: "flagship-forged", pack, oracle: strong, teaching: "taught" },
  ] as const) {
    console.log(`${arm.id}: ${heldOut.length} held-out cases`);
    scores.push(
      ...(await measure(
        heldOut,
        ledger,
        arm.pack,
        arm.oracle,
        arm.id,
        arm.teaching,
        () => live && purchases.stopped,
      )),
    );
    json("scores.json", scores);
  }
  if (purchases.stopped) throw new Error("Billing cutoff; this comparison is incomplete");
  const report = [
    "# SKUby recipe forge: first executable slice",
    "",
    `Mode: **${live ? "LIVE, exploratory" : "OFFLINE WIRING ONLY: no model judgments"}**.`,
    `Cases: ${examples.length} teaching; ${heldOut.length} test across ${new Set(heldOut.map((c) => c.group)).size} groups.`,
    `Label sources: ${[...new Set(cases.map((c) => c.label.source))].join(", ")}.`,
    demo
      ? "Every case is assistant-authored. This is not the owner's traffic or independent expert validation."
      : "Caller-supplied cases and provenance; the importer cannot authenticate who reviewed them.",
    `Teacher: ${teacher.model}. Recipe: ${recipe.evidenceVersion}.`,
    "Teacher saw teaching cases only; selected examples retain their ledger labels. Recipe frozen before evaluation.",
    "All gates stayed in shadow. Hypothetical acts use the same provisional 0.98 bar and code-owned floors; no fitting or promotion.",
    "The generic baseline is Ratchet's procurement pack, not SKUby's current second-look provider.",
    "",
    "| Arm | Correct answers / valid judgments | Brier | Supported would-act | Unsupported would-act | Handoffs | Hard holds | Unavailable |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const arm of [...new Set(scores.map((s) => s.arm))]) {
    const rows = scores.filter((s) => s.arm === arm);
    const valid = rows.filter((s) => !s.failed && !s.floor);
    const brier = valid.length
      ? (valid.reduce((sum, s) => sum + (s.p - Number(s.truth)) ** 2, 0) / valid.length).toFixed(4)
      : "n/a";
    report.push(
      `| ${arm} | ${valid.filter((s) => s.p >= 0.5 === s.truth).length}/${valid.length} | ${brier} | ${rows.filter((s) => s.wouldAct && s.truth).length} | ${rows.filter((s) => s.wouldAct && !s.truth).length} | ${rows.filter((s) => !s.wouldAct).length} | ${rows.filter((s) => s.floor).length} | ${rows.filter((s) => s.failed && !s.floor).length} |`,
    );
  }
  report.push(
    "",
    `Provider-reported total including teacher and comparison: $${purchases.spent.toFixed(6)} (${purchases.calls} requests).`,
    `Recorded comparison models: ${[...new Set(scores.map((s) => s.model))].join(", ")}.`,
    "Hard holds are excluded from answer/Brier metrics. Unavailable judgments are counted separately and never act.",
    "This small, paired authored test can demonstrate wiring and suggest further study. It cannot establish deployment accuracy or everyday review savings.",
    "No background collector, inbox, production adapter or weight training is installed.",
    "",
  );
  writeFileSync(join(dir, "report.md"), report.join("\n"));
  console.log(report.join("\n"));
} catch (error) {
  json("failure.json", {
    at: new Date().toISOString(),
    reason: error instanceof Error ? error.message : "Run failed",
  });
  throw error;
}
