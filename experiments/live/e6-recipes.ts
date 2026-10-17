/**
 * E6. The recipes, live: speculative decision-tree flattening versus two round trips,
 * context compaction by relevance battery, and chunk location with and without a "none"
 * option. Writes markdown to stdout. `bun experiments/live/e6-recipes.ts > docs/live-recipes.md`
 *
 * Everything goes through a shadow-mode engine, so every answer is ledgered with a request id
 * and a `recipe:` tag. The policy only labels rows; in shadow mode it changes nothing measured.
 */
import { fmt, heading, note, pct, table } from "../../sim/lib.ts";
import { Engine } from "../../src/engine.ts";
import { rng, shuffled } from "../../src/math.ts";
import { jevViaOpenRouter } from "../../src/oracles/systemone.ts";
import type { GatePolicy } from "../../src/policy.ts";
import { pick } from "../../src/questions.ts";
import { type Item, locateWith, prune, relevance } from "../../src/recipes/screen.ts";
import { speculate } from "../../src/recipes/speculate.ts";
import { JEV_MODEL, loadBoolq, mapLimit, mean, progress, Spend } from "./lib.ts";

const spend = new Spend(0.2);
const oracle = jevViaOpenRouter();
// The engine's cap is a backstop above the experiment's own abort, which fires first.
const engine = new Engine({ oracle, mode: "shadow", budgetUsd: spend.budgetUsd + 0.05 });
const policy: GatePolicy = { actAbove: 0.9 };

console.log("# Live recipes: Jev through OpenRouter\n");
note(
  `Run on ${new Date().toISOString().slice(0, 10)} against \`${JEV_MODEL}\`. Costs are billed amounts.`,
);

// ---------------------------------------------------------------------------------------
// 1. Speculative flattening on hand-written browser steps.
// ---------------------------------------------------------------------------------------
heading("1. Speculative decision-tree flattening: one request versus two round trips");
note(
  "Twelve hand-written browser states, each with a goal, clickable elements and input fields. The root question picks an operation; a follow-up picks the target for that operation. Speculative: root plus every branch follow-up in one request. Sequential: root first, then only the chosen branch.",
);

interface Scenario {
  readonly goal: string;
  readonly page: string;
  readonly clickables: readonly string[];
  readonly inputs: readonly string[];
  readonly op: "click" | "type" | "scroll" | "done";
  readonly target?: string;
}

const scenarios: readonly Scenario[] = [
  {
    goal: "Log in with the saved credentials",
    page: "Login form. Fields: email (empty), password (empty). Buttons: sign-in, forgot-password, create-account.",
    clickables: ["sign-in", "forgot-password", "create-account"],
    inputs: ["email", "password"],
    op: "type",
    target: "email",
  },
  {
    goal: "Log in with the saved credentials",
    page: "Login form. Fields: email (filled: jo@example.com), password (filled). Buttons: sign-in, forgot-password, create-account.",
    clickables: ["sign-in", "forgot-password", "create-account"],
    inputs: ["email", "password"],
    op: "click",
    target: "sign-in",
  },
  {
    goal: "Find the cheapest flight to Lisbon on 3 November",
    page: "Flight search. Fields: from (filled: SFO), to (empty), depart-date (empty). Buttons: search, swap-airports, clear.",
    clickables: ["search", "swap-airports", "clear"],
    inputs: ["from", "to", "depart-date"],
    op: "type",
    target: "to",
  },
  {
    goal: "Find the cheapest flight to Lisbon on 3 November",
    page: "Flight search. Fields: from (filled: SFO), to (filled: LIS), depart-date (filled: 2026-11-03). Buttons: search, swap-airports, clear.",
    clickables: ["search", "swap-airports", "clear"],
    inputs: ["from", "to", "depart-date"],
    op: "click",
    target: "search",
  },
  {
    goal: "Find the cheapest flight to Lisbon on 3 November",
    page: "Results page showing 3 of 40 flights, sorted by departure time. Controls: sort-by-price, sort-by-duration, filter-nonstop, next-page. The list continues below the fold.",
    clickables: ["sort-by-price", "sort-by-duration", "filter-nonstop", "next-page"],
    inputs: [],
    op: "click",
    target: "sort-by-price",
  },
  {
    goal: "Accept the cookie banner and continue reading the article",
    page: "Article page with a cookie banner covering the bottom. Banner buttons: accept-all, reject-all, manage-preferences. Article controls: share, print.",
    clickables: ["accept-all", "reject-all", "manage-preferences", "share", "print"],
    inputs: [],
    op: "click",
    target: "accept-all",
  },
  {
    goal: "Read the terms section near the end of this long page",
    page: "Long legal page, currently showing the introduction. The terms section is far below. No relevant buttons visible.",
    clickables: ["back-to-top"],
    inputs: [],
    op: "scroll",
    target: "down",
  },
  {
    goal: "Unsubscribe from the marketing newsletter",
    page: "Email preferences. Checkboxes shown as buttons: toggle-marketing (currently on), toggle-security (on), toggle-digest (off). Buttons: save-preferences, cancel.",
    clickables: [
      "toggle-marketing",
      "toggle-security",
      "toggle-digest",
      "save-preferences",
      "cancel",
    ],
    inputs: [],
    op: "click",
    target: "toggle-marketing",
  },
  {
    goal: "Unsubscribe from the marketing newsletter",
    page: "Email preferences. toggle-marketing (now off), toggle-security (on), toggle-digest (off). Buttons: save-preferences, cancel. A note says changes are not saved until you click save.",
    clickables: [
      "toggle-marketing",
      "toggle-security",
      "toggle-digest",
      "save-preferences",
      "cancel",
    ],
    inputs: [],
    op: "click",
    target: "save-preferences",
  },
  {
    goal: "Unsubscribe from the marketing newsletter",
    page: "Confirmation page: 'Your preferences were saved. Marketing emails: off.' Buttons: back-to-account.",
    clickables: ["back-to-account"],
    inputs: [],
    op: "done",
  },
  {
    goal: "Search the documentation for 'rate limits'",
    page: "Docs home. Fields: search-box (empty). Links: getting-started, api-reference, pricing.",
    clickables: ["getting-started", "api-reference", "pricing"],
    inputs: ["search-box"],
    op: "type",
    target: "search-box",
  },
  {
    goal: "Add the blue medium t-shirt to the cart",
    page: "Product page. Options shown: color-blue (selected), color-red, size-small, size-medium, size-large (none selected). Buttons: add-to-cart (disabled until a size is chosen), wishlist.",
    clickables: [
      "color-blue",
      "color-red",
      "size-small",
      "size-medium",
      "size-large",
      "add-to-cart",
      "wishlist",
    ],
    inputs: [],
    op: "click",
    target: "size-medium",
  },
];

const ops = ["click", "type", "scroll", "done"] as const;
const opCriteria = {
  click: "Click a button, link or toggle on the page",
  type: "Type text into an input field",
  scroll: "Scroll to reveal content not currently visible",
  done: "The goal is already achieved; nothing more to do",
};

function rootFor(_s: Scenario) {
  return pick("What should the agent do next to achieve the goal?", ops, {
    id: "op",
    criteria: opCriteria,
  });
}
function branchesFor(s: Scenario) {
  const b: Partial<Record<(typeof ops)[number], ReturnType<typeof pick>>> = {};
  if (s.clickables.length >= 2)
    b.click = pick("Which element should be clicked?", s.clickables, { id: "click-target" });
  if (s.inputs.length >= 2)
    b.type = pick("Which field should be typed into?", s.inputs, { id: "type-target" });
  b.scroll = pick("Which direction to scroll?", ["down", "up"], { id: "scroll-target" });
  return b;
}
const stateFor = (s: Scenario) => `Goal: ${s.goal}\n\nPage: ${s.page}`;
// A branch with a single candidate cannot be a pick question; its target is implied.
const single = (s: Scenario, op: string): string | undefined =>
  op === "type" && s.inputs.length === 1
    ? s.inputs[0]
    : op === "click" && s.clickables.length === 1
      ? s.clickables[0]
      : undefined;

{
  let specRight = 0;
  let seqRight = 0;
  let specOpRight = 0;
  let seqOpRight = 0;
  let specCost = 0;
  let seqCost = 0;
  let specLat = 0;
  let seqLat = 0;
  const detail: (string | number)[][] = [];
  for (const s of scenarios) {
    const state = stateFor(s);
    const branches = branchesFor(s);
    // Speculative: one request.
    const sp = await speculate(engine, state, { root: rootFor(s), branches, policy });
    spend.add(sp.cost);
    specCost += sp.cost;
    specLat += sp.latencyMs;
    const spRoot = sp.root.decision.verdict;
    const spBranch = sp.branch?.decision.verdict;
    const spTarget = spBranch?.kind === "pick" ? spBranch.choice : single(s, spRoot.choice);
    const spOk = spRoot.choice === s.op && (s.op === "done" || spTarget === s.target);
    if (spRoot.choice === s.op) specOpRight++;
    if (spOk) specRight++;
    // Sequential: root, then only the chosen branch.
    const rootR = await engine.ask(state, rootFor(s), { policy, tags: ["sequential"] });
    spend.add(rootR.decision.cost);
    seqCost += rootR.decision.cost;
    seqLat += rootR.decision.latencyMs;
    const chosen = rootR.decision.verdict.choice;
    let seqTarget: string | undefined;
    const follow = branches[chosen];
    if (follow) {
      const br = await engine.ask(state, follow, { policy, tags: ["sequential"] });
      spend.add(br.decision.cost);
      seqCost += br.decision.cost;
      seqLat += br.decision.latencyMs;
      seqTarget = br.decision.verdict.choice;
    }
    const seqTargetFinal = seqTarget ?? single(s, chosen);
    const seqOk = chosen === s.op && (s.op === "done" || seqTargetFinal === s.target);
    if (chosen === s.op) seqOpRight++;
    if (seqOk) seqRight++;
    detail.push([
      s.goal.slice(0, 38),
      `${s.op}${s.target ? ` -> ${s.target}` : ""}`,
      `${spRoot.choice} (${spRoot.confidence.toFixed(2)})${spTarget ? ` -> ${spTarget}` : ""}`,
      spOk ? "ok" : "WRONG",
      seqOk ? "ok" : "WRONG",
    ]);
  }
  const n = scenarios.length;
  table(
    [
      "approach",
      "operation right",
      "operation and target right",
      "requests per step",
      "mean latency per step",
      "mean cost per step",
    ],
    [
      [
        "speculative (one request)",
        `${specOpRight}/${n}`,
        `${specRight}/${n}`,
        1,
        `${Math.round(specLat / n)} ms`,
        `$${(specCost / n).toFixed(6)}`,
      ],
      [
        "sequential (root, then branch)",
        `${seqOpRight}/${n}`,
        `${seqRight}/${n}`,
        "1 to 2",
        `${Math.round(seqLat / n)} ms`,
        `$${(seqCost / n).toFixed(6)}`,
      ],
    ],
  );
  table(["goal", "truth", "speculative answer", "spec", "seq"], detail);
  progress(`  recipes 1 done, spend $${spend.total.toFixed(4)}`);
}

// ---------------------------------------------------------------------------------------
// 2. Context compaction by relevance battery.
// ---------------------------------------------------------------------------------------
heading("2. Context compaction: which earlier tool results are still needed");
note(
  "A coding-agent transcript summarised as 40 tool calls (10 about the billing bug, 30 unrelated), judged in one request of 40 questions. The model sees only the task and one-line summaries, never the tool outputs.",
);
{
  const relevant: Item[] = [
    { id: "t03", summary: "Read tests/billing.test.ts (88 lines)" },
    {
      id: "t05",
      summary:
        "Bash: bun test tests/billing.test.ts -> 1 failed: refund rounding expected 12.35 got 12.34",
    },
    { id: "t07", summary: "Grep roundHalfEven in src/ -> 2 matches in src/billing/money.ts" },
    { id: "t09", summary: "Read src/billing/refund.ts (140 lines)" },
    { id: "t11", summary: "Read src/billing/money.ts (62 lines)" },
    { id: "t14", summary: "Grep refund( in src/ -> 6 call sites" },
    { id: "t18", summary: "Read docs/billing.md section on rounding rules" },
    { id: "t22", summary: "Bash: git log -n 5 -- src/billing/refund.ts" },
    { id: "t27", summary: "Read src/billing/currency.ts (40 lines)" },
    { id: "t33", summary: "Bash: git diff src/billing (no changes yet)" },
  ];
  const irrelevant: Item[] = [
    { id: "t01", summary: "Read README.md (200 lines)" },
    { id: "t02", summary: "Read package.json" },
    { id: "t04", summary: "Glob **/*.css -> 14 files" },
    { id: "t06", summary: "Read src/ui/theme.ts (90 lines)" },
    { id: "t08", summary: "Bash: ls -la" },
    { id: "t10", summary: "Read .gitignore" },
    { id: "t12", summary: "Read src/auth/session.ts (210 lines)" },
    { id: "t13", summary: "Grep TODO in src/ -> 31 matches" },
    { id: "t15", summary: "Read docs/deploy.md" },
    { id: "t16", summary: "Bash: bun x biome check . -> clean" },
    { id: "t17", summary: "Read src/ui/components/Button.tsx" },
    { id: "t19", summary: "Read tests/auth.test.ts (150 lines)" },
    { id: "t20", summary: "Read CHANGELOG.md" },
    { id: "t21", summary: "WebFetch docs.example.com/getting-started" },
    { id: "t23", summary: "Read src/search/index.ts (300 lines)" },
    { id: "t24", summary: "Read tsconfig.json" },
    { id: "t25", summary: "Bash: node --version -> v24.8.0" },
    { id: "t26", summary: "Read src/ui/layout.tsx" },
    { id: "t28", summary: "Glob **/*.md -> 22 files" },
    { id: "t29", summary: "Read src/telemetry/log.ts" },
    { id: "t30", summary: "Bash: git status -> clean" },
    { id: "t31", summary: "Read src/i18n/en.json (400 lines)" },
    { id: "t32", summary: "Read src/db/schema.ts (180 lines)" },
    { id: "t34", summary: "Bash: cat .env.example" },
    { id: "t35", summary: "Read scripts/build.ts" },
    { id: "t36", summary: "Grep console.log in src/ -> 12 matches" },
    { id: "t37", summary: "Read src/api/routes.ts (260 lines)" },
    { id: "t38", summary: "Read LICENSE" },
    { id: "t39", summary: "Read src/ui/icons.ts" },
    { id: "t40", summary: "Bash: bun --version -> 1.3.9" },
  ];
  const items = [...relevant, ...irrelevant].sort((a, b) => a.id.localeCompare(b.id));
  const truth = new Set(relevant.map((r) => r.id));
  const context =
    "Agent task: make tests/billing.test.ts pass. The failing test is about refund rounding. The agent has located the bug in src/billing/refund.ts and is about to edit it, then re-run the test and summarise the change. The list below summarises every tool result currently in the context window.";
  const rel = await relevance(engine, context, items, {
    prompt: (it) => `Does the agent still need the result of item \`${it.id}\` for its next steps?`,
    policy,
  });
  spend.add(rel.cost);
  const rows: (string | number)[][] = [];
  for (const bar of [0.3, 0.5, 0.7]) {
    const { keep } = prune(rel, bar);
    const tp = keep.filter((id) => truth.has(id)).length;
    rows.push([
      bar,
      keep.length,
      pct(keep.length ? tp / keep.length : 0),
      pct(tp / truth.size),
      pct(1 - keep.length / items.length),
    ]);
  }
  table(["keep above", "kept", "precision", "recall", "context removed"], rows);
  const sorted = [...rel.scores.entries()].sort((a, b) => b[1] - a[1]);
  note(
    `One request, ${rel.results.length} judgments, $${rel.cost.toFixed(6)}. Highest-scored irrelevant: ${sorted
      .filter(([id]) => !truth.has(id))
      .slice(0, 3)
      .map(([id, p]) => `${id} ${p.toFixed(2)}`)
      .join(", ")}. Lowest-scored relevant: ${sorted
      .filter(([id]) => truth.has(id))
      .slice(-3)
      .map(([id, p]) => `${id} ${p.toFixed(2)}`)
      .join(", ")}.`,
  );
  progress(`  recipes 2 done, spend $${spend.total.toFixed(4)}`);
}

// ---------------------------------------------------------------------------------------
// 3. Chunk location for tiered reading.
// ---------------------------------------------------------------------------------------
heading("3. Chunk location: which of eight passages answers the question");
note(
  "100 BoolQ questions. Each state holds the question's own passage plus seven other BoolQ passages in a seeded shuffle, labelled c1 to c8. A pick over chunk ids locates the answer; a second pass on 40 items removes the true passage and adds a 'none' option.",
);
{
  const items = loadBoolq(300);
  const rand = rng(8);
  const take = items.slice(0, 100);
  const results = await mapLimit(take, 8, async (b, i) => {
    const others = shuffled(
      items.filter((o) => o.id !== b.id),
      rng(100 + i),
    ).slice(0, 7);
    const chunks = shuffled([b, ...others], rand).map((o, j) => ({
      id: `c${j + 1}`,
      text: o.passage,
      src: o.id,
    }));
    const { result } = await locateWith(engine, chunks, b.question, { id: "where", policy });
    const d = result.decision;
    spend.add(d.cost);
    const v = d.verdict;
    const truthId = chunks.find((c) => c.src === b.id)?.id;
    return {
      ok: v.choice === truthId,
      conf: v.confidence,
      cost: d.cost,
      latencyMs: d.latencyMs,
      rank:
        Object.entries(v.probabilities)
          .sort((x, y) => y[1] - x[1])
          .findIndex(([k]) => k === truthId) + 1,
    };
  });
  const acc = mean(results.map((r) => (r.ok ? 1 : 0)));
  const top2 = mean(results.map((r) => (r.rank <= 2 ? 1 : 0)));
  const confident = results.filter((r) => r.conf >= 0.9);
  note(
    `Located the answering chunk ${pct(acc)} of the time (chance 12.5%); in the top two ${pct(top2)}. Among the ${confident.length} picks at confidence >= 0.9, ${pct(mean(confident.map((r) => (r.ok ? 1 : 0))))} were right. Mean cost $${mean(results.map((r) => r.cost)).toFixed(6)} and latency ${Math.round(mean(results.map((r) => r.latencyMs)))} ms per eight-chunk state (about ${Math.round((mean(results.map((r) => r.cost)) * 1e6) / 0.042)} input tokens).`,
  );

  const absent = await mapLimit(items.slice(100, 140), 8, async (b, i) => {
    const others = shuffled(
      items.filter((o) => o.id !== b.id),
      rng(200 + i),
    ).slice(0, 8);
    const chunks = others.map((o, j) => ({ id: `c${j + 1}`, text: o.passage }));
    const { result } = await locateWith(engine, chunks, b.question, {
      id: "where",
      none: true,
      policy,
    });
    spend.add(result.decision.cost);
    const v = result.decision.verdict;
    return { none: v.choice === "none", pNone: v.probabilities.none ?? 0, conf: v.confidence };
  });
  note(
    `With the true passage removed and a 'none' option offered (40 items): answered 'none' ${pct(mean(absent.map((r) => (r.none ? 1 : 0))))} of the time; mean p(none) ${fmt(mean(absent.map((r) => r.pNone)))}; mean confidence of the wrong chunk picks ${fmt(mean(absent.filter((r) => !r.none).map((r) => r.conf)))}.`,
  );
  progress(`  recipes 3 done, spend $${spend.total.toFixed(4)}`);
}

note(`\n**Total spend: $${spend.total.toFixed(4)} over ${spend.calls} calls.**`);
progress(`done: $${spend.total.toFixed(4)} over ${spend.calls} calls`);
