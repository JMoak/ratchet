/**
 * Phase 1: the approvals desk. Each request is asked three times, once per rendering (raw,
 * digest, relative), each arm its own gate on one engine and ledger, so the arms are paired
 * by item. Labels go in through the real `ratchet review` path (a census of each gate). Floors
 * are code: an amount over the automation limit reviews, a wire transfer is a one-way door.
 */
import { join } from "node:path";
import { Engine } from "../../../../src/engine.ts";
import { type FloorRule, oneWayDoor } from "../../../../src/floors.ts";
import { decisionRows, hashQuestion, JsonlLedger } from "../../../../src/ledger/ledger.ts";
import { type GatePolicy, hashPolicy } from "../../../../src/policy.ts";
import type { JudgeQuestion, JudgeVerdict } from "../../../../src/types.ts";
import { blindReview } from "../../lib.ts";
import type { ApprovalItem } from "../corpus/approvals.ts";
import type { Ctx } from "../main.ts";
import {
  auc,
  bootstrapDiff,
  calib,
  fmt,
  fmtPaired,
  loadCorpus,
  mapLimit,
  mcnemar,
  num,
  pct,
  rateOf,
} from "../util.ts";

const ARMS = ["raw", "digest", "relative"] as const;
type Arm = (typeof ARMS)[number];

/** Items whose label turns on arithmetic near a boundary: where the live findings say Jev is weak. */
const DATE_SCENARIOS = new Set([
  "refund-fail-window",
  "refund-fail-window-vip",
  "refund-pass-vip-late",
  "late-submission",
  "refund-fail-repeat",
  "refund-fail-repeat-vip",
  "refund-pass-old-priors",
]);
const AMOUNT_SCENARIOS = new Set([
  "meal-pass",
  "meal-fail-over",
  "hotel-pass",
  "hotel-fail-over",
  "hotel-pass-high-cost",
  "hotel-fail-high-cost",
  "refund-fail-amount",
  "flight-pass-business-long",
  "flight-fail-business-short",
  "taxi-fail-no-receipt",
  "taxi-pass-small-no-receipt",
]);
const groupOf = (s: string): string =>
  DATE_SCENARIOS.has(s) ? "dates" : AMOUNT_SCENARIOS.has(s) ? "amounts" : "categorical";

export const APPROVAL_POLICY: GatePolicy = { actAbove: 0.9, refuseBelow: 0.1 };
const NOISE = /\d\.\d*0000000\d|\d\.\d*9999999\d/;

interface Row {
  readonly item: ApprovalItem;
  readonly arm: Arm;
  readonly pYes: number;
  readonly confidence: number;
  readonly correct: boolean;
  readonly soft: string;
  readonly floor?: string;
  readonly go: number;
}

export async function approvals(ctx: Ctx): Promise<void> {
  const corpus = loadCorpus<{ items: ApprovalItem[]; questions: Record<Arm, JudgeQuestion> }>(
    "approvals",
  );
  const items = corpus.items;
  const ledgerPath = join(ctx.dir, "approvals.jsonl");
  const byState = new Map<string, { item: ApprovalItem; arm: Arm }>();
  for (const item of items) for (const arm of ARMS) byState.set(item.states[arm], { item, arm });

  // Offline, a simulator that is slightly worse on the raw arm, so the wiring shows a difference.
  const engine = new Engine({
    oracle: ctx.oracle((state) => {
      const x = byState.get(state);
      return x ? { judge: x.item.label.truth === true } : undefined;
    }),
    ledger: new JsonlLedger(ledgerPath),
    keepState: true,
    budgetUsd: 0.2,
    seed: 3,
  });
  // The automation limit is a number in the request; a floor sees only the rendered text, so it
  // looks the request up by its state rather than parse three renderings (see the report).
  const overLimit: FloorRule = (state) =>
    byState.get(state)?.item.floor.overLimit ? "review" : undefined;
  const wire = oneWayDoor((state) =>
    /payout method: wire transfer|reimbursement method: wire transfer/.test(state),
  );
  const gates = Object.fromEntries(
    ARMS.map((arm) => [
      arm,
      engine.gate({
        id: `approvals.${arm}`,
        question: corpus.questions[arm],
        policy: APPROVAL_POLICY,
        floors: [overLimit, wire],
      }),
    ]),
  ) as Record<Arm, ReturnType<typeof engine.gate<JudgeQuestion>>>;
  ctx.manifest.set("approvals", {
    policy: APPROVAL_POLICY,
    policyHash: hashPolicy(APPROVAL_POLICY),
    questionHashes: Object.fromEntries(ARMS.map((a) => [a, hashQuestion(corpus.questions[a])])),
    floors: [
      "amount over automation limit ($1,000 refund, $2,000 expense) -> review",
      "wire transfer -> oneWayDoor (review)",
    ],
    items: items.length,
  });

  await ctx.guard("approvals");
  const jobs = items.flatMap((item) => ARMS.map((arm) => ({ item, arm })));
  await mapLimit(jobs, 8, ({ item, arm }) => gates[arm].ask(item.states[arm]));

  // Labels: a census of each gate through the real blind-review command.
  const review: Record<string, unknown> = {};
  for (const arm of ARMS) {
    const labels = new Map(items.map((i) => [i.states[arm], i.label.truth === true]));
    const r = await blindReview(ledgerPath, `approvals.${arm}`, labels, { sample: 1000, seed: 11 });
    review[arm] = { answered: r.answered, missing: r.missing, exitCode: r.exitCode };
    if (r.missing > 0 || r.answered !== items.length)
      throw new Error(`approvals.${arm}: review answered ${r.answered}, missed ${r.missing}`);
  }

  const all = decisionRows(await new JsonlLedger(ledgerPath).all());
  const rows: Row[] = all.flatMap((r) => {
    const x = r.state === undefined ? undefined : byState.get(r.state);
    if (!x || !r.outcome || r.failedOpen) return [];
    const v = r.verdict as JudgeVerdict;
    return [
      {
        item: x.item,
        arm: x.arm,
        pYes: v.pYes,
        confidence: r.confidence,
        correct: r.outcome.correct,
        soft: r.soft,
        go: r.go,
        ...(r.floor !== undefined ? { floor: r.floor } : {}),
      },
    ];
  });
  const failed = all.filter((r) => r.failedOpen).length;
  const by = (arm: Arm, keep: (i: ApprovalItem) => boolean = () => true) =>
    items.filter(keep).map((i) => rows.find((r) => r.item.id === i.id && r.arm === arm));
  const paired = (keep: (i: ApprovalItem) => boolean = () => true) =>
    items
      .filter(keep)
      .filter((i) => ARMS.every((a) => rows.some((r) => r.item.id === i.id && r.arm === a)));

  const out: Record<string, unknown> = { review, failedOpen: failed, arms: {} };
  ctx.md(
    `${items.length} requests x 3 renderings, ${rows.length} answered rows, ${failed} failed open.\n`,
  );
  ctx.md(
    "| arm | accuracy (all) | accuracy (unambiguous) | expected | posture | ECE | Brier | AUC | dates | amounts | categorical |",
  );
  ctx.md("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const both = paired();
  for (const arm of ARMS) {
    const rs = by(arm).filter((r): r is Row => r !== undefined);
    const c = calib(rs.map((r) => ({ confidence: r.confidence, correct: r.correct })));
    const clean = rateOf(rs.filter((r) => r.item.label.ambiguous !== true).map((r) => r.correct));
    const g = (name: string) =>
      rateOf(rs.filter((r) => groupOf(r.item.scenario) === name).map((r) => r.correct));
    const a = auc(
      rs.map((r) => r.pYes),
      rs.map((r) => r.item.label.truth === true),
    );
    (out.arms as Record<string, unknown>)[arm] = {
      calib: c,
      unambiguous: clean,
      auc: a,
      dates: g("dates"),
      amounts: g("amounts"),
      categorical: g("categorical"),
    };
    ctx.md(
      `| ${arm} | ${fmt(c.accuracy)} | ${fmt(clean)} | ${pct(c.expected)} | ${c.posture} | ${num(c.ece)} | ${num(c.brier)} | ${num(a)} | ${fmt(g("dates"))} | ${fmt(g("amounts"))} | ${fmt(g("categorical"))} |`,
    );
  }
  const correctOf = (arm: Arm, xs: readonly ApprovalItem[]) =>
    xs.map((i) => rows.find((r) => r.item.id === i.id && r.arm === arm)?.correct === true);
  const comparisons: Record<string, unknown> = {};
  ctx.md("");
  for (const [a, b] of [
    ["digest", "raw"],
    ["relative", "raw"],
    ["digest", "relative"],
  ] as const) {
    for (const [name, keep] of [
      ["all", () => true],
      ["unambiguous", (i: ApprovalItem) => i.label.ambiguous !== true],
      ["dates", (i: ApprovalItem) => groupOf(i.scenario) === "dates"],
      ["amounts", (i: ApprovalItem) => groupOf(i.scenario) === "amounts"],
    ] as const) {
      const xs = paired(keep);
      const m = mcnemar(correctOf(a, xs), correctOf(b, xs));
      comparisons[`${a}-vs-${b}:${name}`] = m;
      ctx.md(`- ${a} vs ${b} (${name}): ${fmtPaired(m, a, b)}`);
    }
  }
  // Calibration difference, paired bootstrap over items.
  const brierOf = (arm: Arm) => (xs: readonly ApprovalItem[]) =>
    calib(
      xs
        .map((i) => rows.find((r) => r.item.id === i.id && r.arm === arm))
        .filter((r): r is Row => r !== undefined)
        .map((r) => ({ confidence: r.confidence, correct: r.correct })),
    ).brier;
  const eceOf = (arm: Arm) => (xs: readonly ApprovalItem[]) =>
    calib(
      xs
        .map((i) => rows.find((r) => r.item.id === i.id && r.arm === arm))
        .filter((r): r is Row => r !== undefined)
        .map((r) => ({ confidence: r.confidence, correct: r.correct })),
    ).ece;
  const db = bootstrapDiff(both, brierOf("digest"), brierOf("raw"));
  const de = bootstrapDiff(both, eceOf("digest"), eceOf("raw"));
  comparisons.brierDigestMinusRaw = db;
  comparisons.eceDigestMinusRaw = de;
  ctx.md(
    `- Brier digest minus raw: ${num(db.diff)} [${num(db.lo)}, ${num(db.hi)}]; ECE digest minus raw: ${num(de.diff)} [${num(de.lo)}, ${num(de.hi)}] (paired bootstrap, 2000 rounds)`,
  );
  out.comparisons = comparisons;

  // Digest float noise: does a "4.200000000000003 USD" line cost accuracy?
  const noisy = rows.filter((r) => r.arm === "digest" && NOISE.test(r.item.states.digest));
  const tidy = rows.filter((r) => r.arm === "digest" && !NOISE.test(r.item.states.digest));
  out.digestNoise = {
    noisy: rateOf(noisy.map((r) => r.correct)),
    tidy: rateOf(tidy.map((r) => r.correct)),
  };
  ctx.md(
    `- digest states with floating-point noise from compare(): ${noisy.length} of ${noisy.length + tidy.length}; accuracy ${fmt(rateOf(noisy.map((r) => r.correct)))} vs ${fmt(rateOf(tidy.map((r) => r.correct)))} on the rest (not a controlled comparison)`,
  );

  // Floors: no floored request may act; count where the floor raised caution.
  const floored = rows.filter((r) => r.item.floor.overLimit || r.item.floor.wire);
  const actedFloored = floored.filter((r) => r.soft === "act");
  const raised = floored.filter((r) => r.go >= APPROVAL_POLICY.actAbove && r.soft !== "act");
  const missingFloor = floored.filter((r) => r.floor === undefined);
  out.floors = {
    floored: floored.length,
    acted: actedFloored.length,
    raisedFromAct: raised.length,
    unrecorded: missingFloor.length,
  };
  ctx.md(
    `- floors: ${floored.length} floored rows (${floored.length / 3} requests x 3 arms); ${actedFloored.length} acted (must be 0); ${raised.length} would have acted on the model's answer and were held by the floor; ${missingFloor.length} rows missing the recorded floor`,
  );

  // Per-scenario detail, for the report.
  const scen: Record<string, Record<Arm, string>> = {};
  for (const s of [...new Set(items.map((i) => i.scenario))]) {
    scen[s] = Object.fromEntries(
      ARMS.map((arm) => [
        arm,
        fmt(
          rateOf(rows.filter((r) => r.arm === arm && r.item.scenario === s).map((r) => r.correct)),
        ),
      ]),
    ) as Record<Arm, string>;
  }
  out.byScenario = scen;
  ctx.md("\n| scenario | raw | digest | relative |\n| --- | --- | --- | --- |");
  for (const [s, v] of Object.entries(scen))
    ctx.md(`| ${s} | ${v.raw} | ${v.digest} | ${v.relative} |`);

  // The engine's and the CLI's own reports, for posture and fitted bars as the product prints them.
  const reports: Record<string, unknown> = {};
  for (const arm of ARMS) reports[arm] = await gates[arm].report({ targetAccuracy: 0.95 });
  out.engineReports = reports;
  out.cost = (await new JsonlLedger(ledgerPath).all()).reduce((s, r) => s + r.cost, 0);
  ctx.md(`\napprovals spend: $${(out.cost as number).toFixed(5)}`);
  ctx.result("approvals", out);
}
