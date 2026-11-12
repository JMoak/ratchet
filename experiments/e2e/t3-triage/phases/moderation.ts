/**
 * Phase 3: a moderation battery. Four judge sub-questions about one post, asked in one
 * request, combined into "needs moderator action". The hash-match signal is a floor, never a
 * judgment. Protocol: ask the fit split, label it (blind review census), fit every combiner on
 * it and freeze them into the manifest, then ask the held-out split once and read every
 * combiner on it once. The held-out split is also asked through a second gate whose combiner
 * is the frozen logistic model, so the product path (`combine: LogisticModel`) is exercised.
 *
 * Combiners: logodds at correlation 0 (the gate default), logodds at the correlation measured
 * from the fit split's member rows, max ("any fires"), the learned logistic combiner, and an
 * isotonic recalibration of the default pool.
 */
import { join } from "node:path";
import { poolJudge } from "../../../../src/compound/aggregate.ts";
import {
  batteryFeatures,
  fitLogistic,
  type LogisticModel,
  poolLearned,
} from "../../../../src/compound/learned.ts";
import { Engine } from "../../../../src/engine.ts";
import { forQuestion, refuseIf } from "../../../../src/floors.ts";
import {
  type Calibrator,
  coverageAt,
  fitIsotonic,
  fitThreshold,
  pairwiseCorrelation,
} from "../../../../src/ledger/calibration.ts";
import { type DecisionRecord, JsonlLedger } from "../../../../src/ledger/ledger.ts";
import { type GatePolicy, hashPolicy } from "../../../../src/policy.ts";
import type { JudgeQuestion, JudgeVerdict } from "../../../../src/types.ts";
import { blindReview } from "../../lib.ts";
import {
  type ModerationItem,
  PROHIBITED_SCAN,
  SUB_QUESTIONS,
  type SubLabels,
} from "../corpus/moderation.ts";
import type { Ctx } from "../main.ts";
import {
  auc,
  bootstrapDiff,
  calib,
  clopper,
  fmt,
  fmtPaired,
  loadCorpus,
  mapLimit,
  mcnemar,
  num,
  pct,
  rateOf,
} from "../util.ts";

/** Act means publish without a moderator: go is the probability that no action is needed. */
export const MOD_POLICY: GatePolicy = { actAbove: 0.9, goIsYes: false };
const GATE = "mod.action";
const LEARNED_GATE = "mod.action.learned";
const COMBINERS = ["logodds", "logodds-rho", "max", "learned", "isotonic"] as const;
type Combiner = (typeof COMBINERS)[number];

interface Request {
  readonly item: ModerationItem;
  readonly combined: DecisionRecord;
  /** Member verdicts in battery order. */
  readonly members: readonly JudgeVerdict[];
  readonly memberRows: readonly DecisionRecord[];
}

/** Group a battery's ledger rows into requests, members in battery order. */
function requests(
  rows: readonly DecisionRecord[],
  gate: string,
  byState: ReadonlyMap<string, ModerationItem>,
): Request[] {
  const mine = rows.filter((r) => r.gateId === gate);
  return mine
    .filter((r) => r.combined === true && !r.failedOpen && r.strategy !== "floored")
    .flatMap((c) => {
      const item = c.state === undefined ? undefined : byState.get(c.state);
      const ms = SUB_QUESTIONS.map((q) =>
        mine.find((m) => m.requestId === c.requestId && m.questionId === q),
      );
      if (!item || ms.some((m) => m === undefined)) return [];
      const memberRows = ms as DecisionRecord[];
      return [
        {
          item,
          combined: c,
          members: memberRows.map((m) => m.verdict as JudgeVerdict),
          memberRows,
        },
      ];
    });
}

export async function moderation(ctx: Ctx): Promise<void> {
  const corpus = loadCorpus<{ items: ModerationItem[]; questions: { members: JudgeQuestion[] } }>(
    "moderation",
  );
  const members = corpus.questions.members;
  const byState = new Map(corpus.items.map((i) => [i.state, i]));
  const ledgerPath = join(ctx.dir, "moderation.jsonl");
  const truth = (state: string, q: { id: string }) => {
    const it = byState.get(state);
    return it ? { judge: it.sub[q.id as keyof SubLabels] } : undefined;
  };
  const engine = new Engine({
    oracle: ctx.oracle(truth, { accuracy: 0.9 }),
    ledger: new JsonlLedger(ledgerPath),
    keepState: true,
    budgetUsd: 0.2,
    seed: 7,
  });
  const floor = forQuestion(
    GATE,
    refuseIf(new RegExp(`attachment scan: ${PROHIBITED_SCAN.replace(/[()]/g, "\\$&")}`)),
  );
  const gate = engine.gate({ id: GATE, question: members, policy: MOD_POLICY, floors: [floor] });
  ctx.manifest.set("moderation", {
    policy: MOD_POLICY,
    policyHash: hashPolicy(MOD_POLICY),
    gate: GATE,
    combine: "logodds (gate default)",
    floor: "attachment scan matched a known prohibited image -> refuse (no call)",
    split: {
      fit: corpus.items.filter((i) => i.split === "fit").length,
      heldout: corpus.items.filter((i) => i.split === "heldout").length,
    },
  });
  const labelsOf = (split: "fit" | "heldout") =>
    new Map(corpus.items.filter((i) => i.split === split).map((i) => [i.state, i.label.truth]));

  // ---- fit split -----------------------------------------------------------
  await ctx.guard("moderation-fit");
  const fitItems = corpus.items.filter((i) => i.split === "fit");
  await mapLimit(fitItems, 8, (i) => gate.ask(i.state));
  const fitReview = await blindReview(ledgerPath, GATE, labelsOf("fit"), {
    sample: 1000,
    seed: 13,
  });
  const fitRows = await new JsonlLedger(ledgerPath).all();
  const fit = requests(fitRows, GATE, byState);

  // Measured correlation, the ledger's way: member correctness as inherited from the battery's truth.
  const rhoLedger = pairwiseCorrelation(
    fit.map((r) => r.memberRows.map((m) => m.outcome?.correct === true)),
  );
  // And against each member's own question, which the ledger cannot know.
  const rhoOwn = pairwiseCorrelation(
    fit.map((r) =>
      SUB_QUESTIONS.map((q, j) => (r.members[j]?.pYes ?? 0.5) >= 0.5 === r.item.sub[q]),
    ),
  );
  const model: LogisticModel = fitLogistic(
    fit.map((r) => ({ x: batteryFeatures(r.members), y: r.item.label.truth })),
  );
  const pooled0 = (vs: readonly JudgeVerdict[]) => poolJudge(vs, { method: "logodds" }).pYes;
  const iso = fitIsotonic(
    fit.map((r) => ({ confidence: pooled0(r.members), correct: r.item.label.truth })),
    30,
  );
  const pYesOf = (c: Combiner, vs: readonly JudgeVerdict[]): number => {
    switch (c) {
      case "logodds":
        return pooled0(vs);
      case "logodds-rho":
        return poolJudge(vs, { method: "logodds", correlation: Math.max(0, rhoLedger) }).pYes;
      case "max":
        return poolJudge(vs, { method: "max" }).pYes;
      case "learned":
        return poolLearned(vs, model).pYes;
      case "isotonic":
        return (iso as Calibrator).apply(pooled0(vs));
    }
  };
  // Publish bars: act (publish unmoderated) when P(no action) clears the bar; fitted on the fit split.
  const publishScored = (c: Combiner, rs: readonly Request[]) =>
    rs.map((r) => ({ confidence: 1 - pYesOf(c, r.members), correct: !r.item.label.truth }));
  const frozenBars = Object.fromEntries(
    COMBINERS.map((c) => [
      c,
      {
        point98: fitThreshold(publishScored(c, fit), 0.98, 20)?.threshold,
        conservative95: fitThreshold(publishScored(c, fit), 0.95, 20, { conservative: true })
          ?.threshold,
      },
    ]),
  );
  ctx.manifest.freeze("moderation", {
    fitRequests: fit.length,
    rhoLedger,
    rhoOwnLabels: rhoOwn,
    logistic: model,
    isotonic: iso?.blocks ?? null,
    publishBars: frozenBars,
  });
  ctx.md(
    `fit split: ${fit.length} answered requests (review answered ${fitReview.answered}, missing ${fitReview.missing}); member error correlation from the ledger (inherited truth) ${num(rhoLedger)}, against each member's own label ${num(rhoOwn)}`,
  );
  ctx.md(
    `learned weights ${model.weights.map((w) => num(w, 2)).join(", ")} bias ${num(model.bias, 2)}; frozen publish bars ${JSON.stringify(frozenBars)}`,
  );

  // ---- held-out split ------------------------------------------------------
  await ctx.guard("moderation-heldout");
  const heldItems = corpus.items.filter((i) => i.split === "heldout");
  const learnedGate = engine.gate({
    id: LEARNED_GATE,
    question: members,
    combine: model,
    policy: MOD_POLICY,
    floors: [
      forQuestion(LEARNED_GATE, refuseIf(/attachment scan: matched a known prohibited image/)),
    ],
  });
  await mapLimit(heldItems, 8, async (i) => {
    await gate.ask(i.state);
    await learnedGate.ask(i.state);
  });
  const heldReview = await blindReview(ledgerPath, GATE, labelsOf("heldout"), {
    sample: 1000,
    seed: 17,
  });
  const learnedReview = await blindReview(ledgerPath, LEARNED_GATE, labelsOf("heldout"), {
    sample: 1000,
    seed: 19,
  });
  const rows = await new JsonlLedger(ledgerPath).all();
  const held = requests(rows, GATE, byState).filter((r) => r.item.split === "heldout");
  const heldLearned = requests(rows, LEARNED_GATE, byState);

  const out: Record<string, unknown> = {
    review: {
      fit: fitReview.answered,
      heldout: heldReview.answered,
      learned: learnedReview.answered,
      missing: fitReview.missing + heldReview.missing + learnedReview.missing,
    },
    rhoLedger,
    rhoOwn,
    model,
    frozenBars,
  };
  const truthOf = (r: Request) => r.item.label.truth;
  const evalSet = (rs: readonly Request[], c: Combiner) => {
    const ps = rs.map((r) => pYesOf(c, r.members));
    const lean = rs.map((r, i) => (ps[i] ?? 0.5) >= 0.5 === truthOf(r));
    const lead = calib(
      rs.map((_, i) => ({
        confidence: Math.max(ps[i] ?? 0.5, 1 - (ps[i] ?? 0.5)),
        correct: lean[i] === true,
      })),
    );
    const yes = rs.map((r, i) => ((ps[i] ?? 0.5) - (truthOf(r) ? 1 : 0)) ** 2);
    return {
      ps,
      lean,
      lead,
      brierYes: yes.reduce((s, x) => s + x, 0) / Math.max(1, yes.length),
      auc: auc(ps, rs.map(truthOf)),
    };
  };
  ctx.md(
    `\nheld-out: ${held.length} answered requests (review answered ${heldReview.answered}).\n`,
  );
  ctx.md(
    "| combiner | accuracy (lean) | accuracy (unambiguous) | ECE | Brier (pYes) | AUC | publish bar (98% point, fit) | held-out publish coverage | held-out publish precision |",
  );
  ctx.md("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const evals: Record<string, unknown> = {};
  for (const c of COMBINERS) {
    const e = evalSet(held, c);
    const clean = rateOf(
      held
        .filter((r) => r.item.label.ambiguous !== true)
        .map((r) => pYesOf(c, r.members) >= 0.5 === truthOf(r)),
    );
    const bar = frozenBars[c]?.point98;
    const at = bar === undefined ? undefined : coverageAt(publishScored(c, held), bar);
    const prec = at === undefined ? undefined : clopper(Math.round(at.accuracy * at.n), at.n);
    evals[c] = {
      accuracy: e.lead.accuracy,
      unambiguous: clean,
      ece: e.lead.ece,
      brierYes: e.brierYes,
      auc: e.auc,
      bar,
      coverage: at?.coverage,
      precision: prec,
    };
    ctx.md(
      `| ${c} | ${fmt(e.lead.accuracy)} | ${fmt(clean)} | ${num(e.lead.ece)} | ${num(e.brierYes)} | ${num(e.auc)} | ${bar === undefined ? "none" : num(bar)} | ${at === undefined ? "-" : `${pct(at.coverage)} (${at.n})`} | ${prec === undefined ? "-" : fmt(prec)} |`,
    );
  }
  out.heldout = evals;
  const pairs: Record<string, unknown> = {};
  for (const [a, b] of [
    ["learned", "logodds"],
    ["isotonic", "logodds"],
    ["max", "logodds"],
    ["learned", "max"],
    ["logodds-rho", "logodds"],
    ["learned", "isotonic"],
  ] as const) {
    const m = mcnemar(evalSet(held, a).lean, evalSet(held, b).lean);
    const brier = (c: Combiner) => (rs: readonly Request[]) => evalSet(rs, c).brierYes;
    const bd = bootstrapDiff(held, brier(a), brier(b));
    pairs[`${a}-vs-${b}`] = { mcnemar: m, brierDiff: bd };
    ctx.md(
      `- ${a} vs ${b}: ${fmtPaired(m, a, b)}; Brier ${a} minus ${b} ${num(bd.diff)} [${num(bd.lo)}, ${num(bd.hi)}]`,
    );
  }
  out.pairs = pairs;

  // Members: scored against their own question versus the battery's truth the ledger gives them.
  const memberTable: Record<string, unknown> = {};
  ctx.md(
    "\n| member | accuracy vs its own label (all answered) | accuracy vs the battery's truth (ledger) | ledger report posture |",
  );
  ctx.md("| --- | --- | --- | --- |");
  const everything = requests(rows, GATE, byState);
  const report = await engine.report({ targetAccuracy: 0.95 });
  SUB_QUESTIONS.forEach((q, j) => {
    const own = rateOf(everything.map((r) => (r.members[j]?.pYes ?? 0.5) >= 0.5 === r.item.sub[q]));
    const ledger = rateOf(everything.map((r) => r.memberRows[j]?.outcome?.correct === true));
    const rep = report.byQuestion[q];
    memberTable[q] = { own, ledger, report: rep };
    ctx.md(
      `| ${q} | ${fmt(own)} | ${fmt(ledger)} | ${rep?.accuracy === undefined ? "-" : `${pct(rep.accuracy)} observed vs ${pct(rep.expectedAccuracy)} expected`} |`,
    );
  });
  out.members = memberTable;

  // The learned gate: the product's poolLearned on its own members must equal the offline one.
  const sameRequest = heldLearned.map((r) =>
    Math.abs((r.combined.verdict as JudgeVerdict).pYes - poolLearned(r.members, model).pYes),
  );
  const crossCall = heldLearned.flatMap((r) => {
    const twin = held.find((h) => h.item.id === r.item.id);
    return twin
      ? [
          {
            a: (r.combined.verdict as JudgeVerdict).pYes >= 0.5,
            b: poolLearned(twin.members, model).pYes >= 0.5,
          },
        ]
      : [];
  });
  const learnedLedger = rateOf(heldLearned.map((r) => r.combined.outcome?.correct === true));
  out.learnedGate = {
    requests: heldLearned.length,
    maxAbsDiffSameRequest: Math.max(0, ...sameRequest),
    leanAgreementAcrossCalls: rateOf(crossCall.map((x) => x.a === x.b)),
    ledgerAccuracy: learnedLedger,
    report: await learnedGate.report({ targetAccuracy: 0.95 }),
  };
  ctx.md(
    `\n- learned gate (combine: LogisticModel): ${heldLearned.length} requests; max |pYes - poolLearned(members)| on the same request ${num(Math.max(0, ...sameRequest), 6)}; lean agreement with the default gate's second call ${fmt(rateOf(crossCall.map((x) => x.a === x.b)))}; ledger accuracy ${fmt(learnedLedger)}`,
  );

  // Floors: floored posts were never asked and never published.
  const floored = rows.filter((r) => r.gateId === GATE && r.strategy === "floored");
  const flooredItems = corpus.items.filter((i) => i.floored);
  const flooredMembers = rows.filter(
    (r) =>
      r.gateId === GATE && r.combined !== true && floored.some((f) => f.requestId === r.requestId),
  );
  out.floors = {
    expected: flooredItems.length,
    floored: floored.length,
    refused: floored.filter((r) => r.soft === "refuse").length,
    cost: floored.reduce((s, r) => s + r.cost, 0),
    memberRows: flooredMembers.length,
  };
  ctx.md(
    `- floors: ${floored.length} of ${flooredItems.length} hash-matched posts floored, ${floored.filter((r) => r.soft === "refuse").length} refused, member rows ${flooredMembers.length}, cost $${floored.reduce((s, r) => s + r.cost, 0)}`,
  );
  out.engineReport = { gate: report.byGate[GATE], learned: report.byGate[LEARNED_GATE] };
  out.cost = rows.reduce((s, r) => s + r.cost, 0);
  ctx.md(`\nmoderation spend: $${(out.cost as number).toFixed(5)}`);
  ctx.result("moderation", out);
}
