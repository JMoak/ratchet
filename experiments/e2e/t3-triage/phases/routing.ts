/**
 * Phase 2: routing and urgency on 256 Brindle tickets, one request per ticket with both
 * questions batched. The fit half is asked and labelled first; per-question bars and one global
 * bar are fitted on it and frozen into the manifest; then the validation half is asked and
 * labelled, and the frozen bars are read on it once. The claim under test: thresholds must be
 * fitted per question, because one model is under-confident on one question and over-confident
 * on another, so a single bar is wrong in both directions at once.
 */
import { join } from "node:path";
import { Engine } from "../../../../src/engine.ts";
import {
  coverageAt,
  fitThreshold,
  type Scored,
  scoredFromLedger,
} from "../../../../src/ledger/calibration.ts";
import { type DecisionRecord, hashQuestion, JsonlLedger } from "../../../../src/ledger/ledger.ts";
import { hashPolicy, policyWithBand } from "../../../../src/policy.ts";
import { shortlist } from "../../../../src/questions.ts";
import type {
  PickQuestion,
  PickVerdict,
  RateQuestion,
  RateVerdict,
} from "../../../../src/types.ts";
import type { TicketItem } from "../corpus/routing.ts";
import type { Ctx } from "../main.ts";
import {
  calib,
  clopper,
  fmt,
  labelAll,
  loadCorpus,
  mapLimit,
  num,
  pct,
  rateOf,
  reliabilityRows,
} from "../util.ts";

export const ROUTING_POLICY = policyWithBand(0.85, 0.05);
export const TARGETS = [0.9, 0.95] as const;

export interface Answered {
  readonly item: TicketItem;
  readonly route: { readonly recordId: string; readonly verdict: PickVerdict };
  readonly urgency: { readonly recordId: string; readonly verdict: RateVerdict };
}

/** Ask a set of tickets on an engine whose gates own `route` and `urgency`, then label them. */
export async function askAndLabel(
  engine: Engine,
  questions: { route: PickQuestion; urgency: RateQuestion },
  items: readonly TicketItem[],
): Promise<Answered[]> {
  const answered = await mapLimit(items, 8, async (item) => {
    const [r, u] = await engine.askAll(item.state, [questions.route, questions.urgency], {
      policy: ROUTING_POLICY,
    });
    if (!r || !u) throw new Error("engine returned too few results");
    return {
      item,
      route: { recordId: r.recordId, verdict: r.decision.verdict as PickVerdict },
      urgency: { recordId: u.recordId, verdict: u.decision.verdict as RateVerdict },
    };
  });
  await labelAll(
    engine,
    answered.flatMap((a) => [
      { recordId: a.route.recordId, verdict: a.route.verdict, label: a.item.route },
      { recordId: a.urgency.recordId, verdict: a.urgency.verdict, label: a.item.urgency },
    ]),
  );
  return answered;
}

const scoredOf = (
  rows: readonly DecisionRecord[],
  qid: string,
  ids?: ReadonlySet<string>,
): Scored[] =>
  scoredFromLedger(
    rows.filter((r) => r.questionId === qid && (ids === undefined || ids.has(r.requestId))),
  );

/** The bars a set of labelled rows supports, point estimate and conservative (Wilson lower bound). */
function bars(items: readonly Scored[], minSupport = 30) {
  return Object.fromEntries(
    TARGETS.map((t) => [
      String(t),
      {
        point: fitThreshold(items, t, minSupport)?.threshold,
        conservative: fitThreshold(items, t, minSupport, { conservative: true })?.threshold,
      },
    ]),
  );
}

export async function routing(ctx: Ctx): Promise<void> {
  const corpus = loadCorpus<{
    items: TicketItem[];
    questions: { route: PickQuestion; urgency: RateQuestion };
  }>("routing");
  const { route, urgency } = corpus.questions;
  const fitItems = corpus.items.filter((_, i) => i % 2 === 0);
  const valItems = corpus.items.filter((_, i) => i % 2 === 1);
  const byState = new Map(corpus.items.map((i) => [i.state, i]));
  const ledgerPath = join(ctx.dir, "routing.jsonl");
  // Offline: routing overconfident, urgency underconfident, so both postures exercise the wiring.
  const truth = (state: string, q: { id: string }) => {
    const it = byState.get(state);
    if (!it) return undefined;
    return q.id === "route" ? { pick: it.route.truth } : { rate: it.urgency.truth };
  };
  const engine = new Engine({
    oracle: ctx.oracle(truth, { accuracy: 0.8, temperature: 1.6 }),
    ledger: new JsonlLedger(ledgerPath),
    keepState: true,
    budgetUsd: 0.2,
    seed: 5,
  });
  engine.gate({ id: "route", question: route, policy: ROUTING_POLICY });
  engine.gate({ id: "urgency", question: urgency, policy: ROUTING_POLICY });
  ctx.manifest.set("routing", {
    policy: ROUTING_POLICY,
    policyHash: hashPolicy(ROUTING_POLICY),
    questionHashes: { route: hashQuestion(route), urgency: hashQuestion(urgency) },
    split: {
      fit: fitItems.length,
      validation: valItems.length,
      rule: "corpus order: even index fits, odd validates",
    },
  });

  await ctx.guard("routing-fit");
  const fit = await askAndLabel(engine, { route, urgency }, fitItems);
  const fitRows = await new JsonlLedger(ledgerPath).all();
  const fitIds = new Set(fitRows.map((r) => r.requestId));
  const fitRoute = scoredOf(fitRows, "route");
  const fitUrg = scoredOf(fitRows, "urgency");
  const frozen = {
    route: bars(fitRoute),
    urgency: bars(fitUrg),
    global: bars([...fitRoute, ...fitUrg]),
    minSupport: 30,
  };
  ctx.manifest.freeze("routing", frozen);
  ctx.md(`fit half: ${fit.length} tickets; bars frozen: ${JSON.stringify(frozen)}`);

  await ctx.guard("routing-validation");
  const val = await askAndLabel(engine, { route, urgency }, valItems);
  const rows = await new JsonlLedger(ledgerPath).all();
  const valIds = new Set(rows.map((r) => r.requestId).filter((id) => !fitIds.has(id)));
  const failed = rows.filter((r) => r.failedOpen).length;
  const allAnswered = [...fit, ...val];

  const out: Record<string, unknown> = { failedOpen: failed, frozen };
  ctx.md(`${allAnswered.length} tickets, ${rows.length} rows, ${failed} failed open.\n`);
  ctx.md(
    "| question | rows | accuracy | accuracy (unambiguous) | expected | posture | ECE | Brier |",
  );
  ctx.md("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const q of ["route", "urgency"] as const) {
    const s = scoredOf(rows, q);
    const c = calib(s);
    const clean = rateOf(
      allAnswered
        .filter((a) => a.item[q].ambiguous !== true)
        .map((a) =>
          q === "route"
            ? a.route.verdict.choice === a.item.route.truth
            : a.urgency.verdict.level === a.item.urgency.truth,
        ),
    );
    out[q] = { calib: c, unambiguous: clean, reliability: reliabilityRows(s) };
    ctx.md(
      `| ${q} | ${c.n} | ${fmt(c.accuracy)} | ${fmt(clean)} | ${pct(c.expected)} | ${c.posture} | ${num(c.ece)} | ${num(c.brier)} |`,
    );
  }
  for (const q of ["route", "urgency"] as const) {
    ctx.md(
      `\nreliability, ${q}: ${reliabilityRows(scoredOf(rows, q))
        .map(
          (b) =>
            `${b.lo.toFixed(1)}-${b.hi.toFixed(1)}: n ${b.n}, conf ${pct(b.meanConfidence)}, acc ${pct(b.accuracy)}`,
        )
        .join("; ")}`,
    );
  }

  // Frozen bars read once on the validation half.
  const validation: Record<string, unknown> = {};
  ctx.md(
    "\n| question | target | bar from | bar | validation coverage | validation precision (exact 95%) |",
  );
  ctx.md("| --- | --- | --- | --- | --- | --- |");
  for (const q of ["route", "urgency"] as const) {
    const s = scoredOf(rows, q, valIds);
    for (const t of TARGETS) {
      for (const [from, b] of [
        ["own, conservative", frozen[q][String(t)]?.conservative],
        ["own, point", frozen[q][String(t)]?.point],
        ["global, conservative", frozen.global[String(t)]?.conservative],
        ["global, point", frozen.global[String(t)]?.point],
      ] as const) {
        if (b === undefined) {
          ctx.md(`| ${q} | ${pct(t, 0)} | ${from} | none | - | - |`);
          continue;
        }
        const at = coverageAt(s, b);
        const prec = clopper(Math.round(at.accuracy * at.n), at.n);
        validation[`${q}:${t}:${from}`] = { bar: b, coverage: at.coverage, precision: prec };
        ctx.md(
          `| ${q} | ${pct(t, 0)} | ${from} | ${num(b)} | ${pct(at.coverage)} (${at.n}) | ${fmt(prec)}${prec.p < t ? " below promise" : ""} |`,
        );
      }
    }
  }
  out.validation = validation;

  // Shortlists: does the truth sit in the top k?
  const topk: Record<string, unknown> = {};
  for (const k of [1, 2, 3]) {
    const r = rateOf(
      allAnswered.map((a) =>
        shortlist(a.route.verdict, k).some((s) => s.option === a.item.route.truth),
      ),
    );
    const u = rateOf(
      allAnswered.map((a) => {
        const ranked = urgency.levels
          .map((l, i) => ({ l, p: a.urgency.verdict.probabilities[i] ?? 0 }))
          .sort((x, y) => y.p - x.p);
        return ranked.slice(0, k).some((x) => x.l === a.item.urgency.truth);
      }),
    );
    topk[`top${k}`] = { route: r, urgency: u };
    ctx.md(`- top-${k} coverage: route ${fmt(r)}, urgency ${fmt(u)}`);
  }
  const within = rateOf(
    allAnswered.map(
      (a) =>
        Math.abs(
          urgency.levels.indexOf(a.urgency.verdict.level) -
            urgency.levels.indexOf(a.item.urgency.truth),
        ) <= 1,
    ),
  );
  topk.urgencyWithinOne = within;
  ctx.md(`- urgency within one level: ${fmt(within)}`);
  // Shortlist mass: how much probability the top 3 carry, and how often a 0.9-mass shortlist holds the truth.
  const mass = allAnswered.map((a) => shortlist(a.route.verdict, 3).at(-1)?.cumulative ?? 0);
  topk.routeTop3MeanMass = mass.reduce((s, x) => s + x, 0) / mass.length;
  out.shortlist = topk;

  // Confusions for route, by template count.
  const conf: Record<string, number> = {};
  for (const a of allAnswered)
    if (a.route.verdict.choice !== a.item.route.truth)
      conf[`${a.item.route.truth} -> ${a.route.verdict.choice}`] =
        (conf[`${a.item.route.truth} -> ${a.route.verdict.choice}`] ?? 0) + 1;
  out.routeConfusions = conf;
  const uconf: Record<string, number> = {};
  for (const a of allAnswered)
    if (a.urgency.verdict.level !== a.item.urgency.truth)
      uconf[`${a.item.urgency.truth} -> ${a.urgency.verdict.level}`] =
        (uconf[`${a.item.urgency.truth} -> ${a.urgency.verdict.level}`] ?? 0) + 1;
  out.urgencyConfusions = uconf;
  ctx.md(`- route confusions: ${JSON.stringify(conf)}`);
  ctx.md(`- urgency confusions: ${JSON.stringify(uconf)}`);
  out.byTemplate = {
    route: templateAccuracy(allAnswered, (a) => a.route.verdict.choice === a.item.route.truth),
    urgency: templateAccuracy(allAnswered, (a) => a.urgency.verdict.level === a.item.urgency.truth),
  };
  out.engineReport = {
    route: await engine.gates.get("route")?.report({ targetAccuracy: 0.9, minSupport: 30 }),
    urgency: await engine.gates.get("urgency")?.report({ targetAccuracy: 0.9, minSupport: 30 }),
  };
  out.cost = rows.reduce((s, r) => s + r.cost, 0);
  ctx.md(`\nrouting spend: $${(out.cost as number).toFixed(5)}`);
  ctx.result("routing", out);
}

/** Accuracy by template: tickets from one template are not independent, so count templates too. */
function templateAccuracy(xs: readonly Answered[], right: (a: Answered) => boolean) {
  const by = new Map<string, boolean[]>();
  for (const a of xs) by.set(a.item.template, [...(by.get(a.item.template) ?? []), right(a)]);
  const perfect = [...by.values()].filter((v) => v.every(Boolean)).length;
  const zero = [...by.values()].filter((v) => v.every((b) => !b)).length;
  return { templates: by.size, allRight: perfect, allWrong: zero, mixed: by.size - perfect - zero };
}
