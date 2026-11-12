/**
 * Phase 4: invariant 9. The same 60 tickets in English, Spanish, German and Japanese, each
 * non-English rendering asked twice: with the English rubric (the invariant) and with the
 * rubric translated into the ticket's language (prompt, option names, criteria, levels). The
 * state is identical within a pair, so the comparison isolates the question's language.
 */
import { join } from "node:path";
import { Engine } from "../../../../src/engine.ts";
import { JsonlLedger } from "../../../../src/ledger/ledger.ts";
import type {
  PickQuestion,
  PickVerdict,
  RateQuestion,
  RateVerdict,
} from "../../../../src/types.ts";
import { LANGS, type MultilingualItem, RUBRICS } from "../corpus/multilingual.ts";
import { BRINDLE_QUEUES, type BrindleQueue, URGENCY_LEVELS } from "../corpus/routing.ts";
import type { Ctx } from "../main.ts";
import {
  calib,
  fmt,
  fmtPaired,
  labelAll,
  loadCorpus,
  mapLimit,
  mcnemar,
  num,
  pct,
} from "../util.ts";
import { ROUTING_POLICY } from "./routing.ts";

type Lang = "en" | (typeof LANGS)[number];
type Arm = "en-rubric" | "translated";
const CELLS: readonly { lang: Lang; arm: Arm }[] = [
  { lang: "en", arm: "en-rubric" },
  ...LANGS.flatMap((lang) => (["en-rubric", "translated"] as const).map((arm) => ({ lang, arm }))),
];

interface Cell {
  readonly lang: Lang;
  readonly arm: Arm;
  readonly route: PickQuestion;
  readonly urgency: RateQuestion;
}

interface Answer {
  readonly item: MultilingualItem;
  readonly cell: Cell;
  readonly routeRight: boolean;
  readonly urgencyRight: boolean;
  readonly routeConf: number;
  readonly urgencyConf: number;
}

export async function multilingual(ctx: Ctx): Promise<void> {
  const corpus = loadCorpus<{
    items: MultilingualItem[];
    questions: Record<string, { route: PickQuestion; urgency: RateQuestion }>;
  }>("multilingual");
  const cells: Cell[] = CELLS.map(({ lang, arm }) => {
    const q = corpus.questions[`${lang}.${arm}`];
    if (!q) throw new Error(`no questions for ${lang}.${arm}`);
    return { lang, arm, ...q };
  });
  // The option and level each question calls the decider's answer, in that question's language.
  const optionOf = (cell: Cell, q: BrindleQueue) =>
    RUBRICS[cell.arm === "en-rubric" ? "en" : cell.lang].options[q];
  const levelOf = (cell: Cell, u: (typeof URGENCY_LEVELS)[number]) =>
    cell.urgency.levels[URGENCY_LEVELS.indexOf(u)] as string;
  const byState = new Map<string, MultilingualItem>();
  for (const it of corpus.items)
    for (const l of ["en", ...LANGS] as const) byState.set(it.states[l], it);
  const cellOf = new Map(
    cells.flatMap(
      (c) =>
        [
          [c.route.id, c],
          [c.urgency.id, c],
        ] as const,
    ),
  );
  const truth = (state: string, q: { id: string }) => {
    const it = byState.get(state);
    const cell = cellOf.get(q.id);
    if (!it || !cell) return undefined;
    return q.id === cell.route.id
      ? { pick: optionOf(cell, it.route.truth as BrindleQueue) }
      : { rate: levelOf(cell, it.urgency.truth) };
  };
  const ledgerPath = join(ctx.dir, "multilingual.jsonl");
  const engine = new Engine({
    oracle: ctx.oracle(truth),
    ledger: new JsonlLedger(ledgerPath),
    keepState: true,
    budgetUsd: 0.2,
    seed: 9,
  });
  for (const c of cells) {
    engine.gate({ id: c.route.id, question: c.route, policy: ROUTING_POLICY });
    engine.gate({ id: c.urgency.id, question: c.urgency, policy: ROUTING_POLICY });
  }
  ctx.manifest.set("multilingual", {
    cells: cells.map((c) => `${c.lang}.${c.arm}`),
    items: corpus.items.length,
  });

  await ctx.guard("multilingual");
  const jobs = corpus.items.flatMap((item) => cells.map((cell) => ({ item, cell })));
  const asked = await mapLimit(jobs, 8, async ({ item, cell }) => {
    const [r, u] = await engine.askAll(item.states[cell.lang], [cell.route, cell.urgency], {
      policy: ROUTING_POLICY,
    });
    if (!r || !u) throw new Error("too few results");
    return { item, cell, r, u };
  });
  await labelAll(
    engine,
    asked.flatMap(({ item, cell, r, u }) => [
      {
        recordId: r.recordId,
        verdict: r.decision.verdict,
        label: {
          truth: optionOf(cell, item.route.truth as BrindleQueue),
          why: item.route.why,
          ...(item.route.ambiguous ? { ambiguous: true } : {}),
        },
      },
      {
        recordId: u.recordId,
        verdict: u.decision.verdict,
        label: {
          truth: levelOf(cell, item.urgency.truth),
          why: item.urgency.why,
          ...(item.urgency.ambiguous ? { ambiguous: true } : {}),
        },
      },
    ]),
  );
  const answers: Answer[] = asked
    .filter(({ r, u }) => r.decision.failedOpen !== true && u.decision.failedOpen !== true)
    .map(({ item, cell, r, u }) => {
      const rv = r.decision.verdict as PickVerdict;
      const uv = u.decision.verdict as RateVerdict;
      return {
        item,
        cell,
        routeRight: rv.choice === optionOf(cell, item.route.truth as BrindleQueue),
        urgencyRight: uv.level === levelOf(cell, item.urgency.truth),
        routeConf: rv.confidence,
        urgencyConf: uv.confidence,
      };
    });
  const failed = asked.length - answers.length;
  const out: Record<string, unknown> = { failedOpen: failed, cells: {} };
  ctx.md(
    `${corpus.items.length} tickets x ${cells.length} cells, ${failed} requests failed open.\n`,
  );
  ctx.md(
    "| language | rubric | route accuracy | route ECE | route posture | urgency accuracy | urgency ECE | urgency posture |",
  );
  ctx.md("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const c of cells) {
    const xs = answers.filter((a) => a.cell === c);
    const rc = calib(xs.map((a) => ({ confidence: a.routeConf, correct: a.routeRight })));
    const uc = calib(xs.map((a) => ({ confidence: a.urgencyConf, correct: a.urgencyRight })));
    (out.cells as Record<string, unknown>)[`${c.lang}.${c.arm}`] = { route: rc, urgency: uc };
    ctx.md(
      `| ${c.lang} | ${c.arm} | ${fmt(rc.accuracy)} | ${num(rc.ece)} | ${rc.posture} | ${fmt(uc.accuracy)} | ${num(uc.ece)} | ${uc.posture} |`,
    );
  }
  // Paired: English rubric vs translated rubric on the same state; and each language vs English.
  const pick = (lang: Lang, arm: Arm, q: "routeRight" | "urgencyRight", ids: readonly string[]) =>
    ids.map(
      (id) =>
        answers.find((a) => a.item.id === id && a.cell.lang === lang && a.cell.arm === arm)?.[q] ===
        true,
    );
  const complete = (cellsNeeded: readonly [Lang, Arm][]) =>
    corpus.items
      .map((i) => i.id)
      .filter((id) =>
        cellsNeeded.every(([l, a]) =>
          answers.some((x) => x.item.id === id && x.cell.lang === l && x.cell.arm === a),
        ),
      );
  const paired: Record<string, unknown> = {};
  ctx.md("");
  for (const q of ["routeRight", "urgencyRight"] as const) {
    const pooledA: boolean[] = [];
    const pooledB: boolean[] = [];
    for (const lang of LANGS) {
      const ids = complete([
        [lang, "en-rubric"],
        [lang, "translated"],
      ]);
      const a = pick(lang, "en-rubric", q, ids);
      const b = pick(lang, "translated", q, ids);
      pooledA.push(...a);
      pooledB.push(...b);
      const m = mcnemar(a, b);
      paired[`${q}:${lang}:en-vs-translated`] = m;
      ctx.md(
        `- ${q === "routeRight" ? "route" : "urgency"}, ${lang}: ${fmtPaired(m, "English rubric", "translated")}`,
      );
      const ids2 = complete([
        ["en", "en-rubric"],
        [lang, "en-rubric"],
      ]);
      const m2 = mcnemar(pick("en", "en-rubric", q, ids2), pick(lang, "en-rubric", q, ids2));
      paired[`${q}:${lang}:english-ticket-vs-${lang}-ticket`] = m2;
      ctx.md(
        `  - English ticket vs ${lang} ticket, both English rubric: ${fmtPaired(m2, "en", lang)}`,
      );
    }
    const m = mcnemar(pooledA, pooledB);
    paired[`${q}:pooled:en-vs-translated`] = m;
    ctx.md(
      `- ${q === "routeRight" ? "route" : "urgency"}, three languages pooled (${pooledA.length} pairs, 3 per ticket, not independent): ${fmtPaired(m, "English rubric", "translated")}`,
    );
  }
  out.paired = paired;
  // Which tickets moved, by template, for the report.
  const moved: Record<string, number> = {};
  for (const lang of LANGS) {
    for (const it of corpus.items) {
      const a = answers.find(
        (x) => x.item.id === it.id && x.cell.lang === lang && x.cell.arm === "en-rubric",
      );
      const b = answers.find(
        (x) => x.item.id === it.id && x.cell.lang === lang && x.cell.arm === "translated",
      );
      if (a && b && a.routeRight !== b.routeRight)
        moved[`${lang}:${it.template}:${a.routeRight ? "en-only" : "translated-only"}`] =
          (moved[`${lang}:${it.template}:${a.routeRight ? "en-only" : "translated-only"}`] ?? 0) +
          1;
    }
  }
  out.routeDiscordant = moved;
  ctx.md(`- route discordant pairs by template: ${JSON.stringify(moved)}`);
  const rows = await new JsonlLedger(ledgerPath).all();
  out.cost = rows.reduce((s, r) => s + r.cost, 0);
  out.levels = Object.fromEntries(
    cells.map((c) => [
      `${c.lang}.${c.arm}`,
      { options: BRINDLE_QUEUES.map((q) => optionOf(c, q)), levels: c.urgency.levels },
    ]),
  );
  ctx.md(
    `\nmultilingual spend: $${(out.cost as number).toFixed(5)} (${pct(answers.length / asked.length)} of requests answered)`,
  );
  ctx.result("multilingual", out);
}
