/**
 * E4. Cascade and correlation: stronger generative judges on the same BoolQ items, how often
 * they repeat the decision model's errors, and what a cheap-first cascade buys at each bar.
 */
import { join } from "node:path";
import { fmt, heading, note, pct, table } from "../../sim/lib.ts";
import { Engine } from "../../src/engine.ts";
import { brier, ece, errorCorrelation, type Scored } from "../../src/ledger/calibration.ts";
import { JsonlLedger } from "../../src/ledger/ledger.ts";
import { LlmJsonOracle } from "../../src/oracles/llm-json.ts";
import { judge } from "../../src/questions.ts";
import type { JudgeVerdict } from "../../src/types.ts";
import type { BoolqRow } from "./e2-boolq.ts";
import { stateOf } from "./e2-boolq.ts";
import {
  loadBoolq,
  mapLimit,
  mean,
  OPENROUTER_KEY,
  OUT,
  progress,
  type Spend,
  STRONG_MODELS,
  writeJsonl,
} from "./lib.ts";

interface JudgeRow {
  readonly id: string;
  readonly truth: boolean;
  readonly p: number;
  readonly failed: boolean;
  readonly cost: number;
  readonly latencyMs: number;
}

const slug = (model: string) => model.replace(/[^a-z0-9.-]/gi, "_");
const acc = (s: readonly Scored[]) => mean(s.map((x) => (x.correct ? 1 : 0)));
const scoreOf = (p: number, truth: boolean): Scored => ({
  confidence: Math.max(p, 1 - p),
  correct: p >= 0.5 === truth,
});

async function runJudge(
  model: string,
  price: { readonly input: number; readonly output: number },
  spend: Spend,
): Promise<JudgeRow[]> {
  const items = loadBoolq(300);
  const oracle = new LlmJsonOracle({
    apiKey: OPENROUTER_KEY,
    model,
    pricePerMillion: price,
    maxTokens: 200,
  });
  const ledger = new JsonlLedger(join(OUT, `boolq-${slug(model)}-ledger.jsonl`));
  const engine = new Engine({ oracle, ledger, mode: "shadow", timeoutMs: 60_000 });
  const rows = await mapLimit(items, 6, async (b, i) => {
    const r = await engine.ask(stateOf(b), judge(b.question, { id: "a" }), {
      policy: { actAbove: 0.9 },
      baseline: "review",
    });
    spend.add(r.decision.cost);
    const v = r.decision.verdict as JudgeVerdict;
    await engine.label(r.recordId, { correct: v.pYes >= 0.5 === b.answer, truth: b.answer });
    if (i % 100 === 99) {
      progress(`  e4 ${model}: ${i + 1}/${items.length}, spend $${spend.total.toFixed(4)}`);
    }
    return {
      id: b.id,
      truth: b.answer,
      p: v.pYes,
      failed: r.decision.failedOpen === true,
      cost: r.decision.cost,
      latencyMs: r.decision.latencyMs,
    };
  });
  writeJsonl(`boolq-${slug(model)}-rows.jsonl`, rows);
  return rows;
}

export async function e4(spend: Spend, jevRows: readonly BoolqRow[]): Promise<void> {
  heading("E4. Cascade to stronger judges");
  note(
    "The same 300 BoolQ items, frame a, answered by generative models forced into the decision role (strict JSON, probabilities over no/yes, temperature 0). Then: how correlated are their errors with the decision model's, and what does escalating only low-confidence items buy?",
  );
  const judges: { model: string; rows: JudgeRow[] }[] = [];
  for (const { model, price } of STRONG_MODELS) {
    judges.push({ model, rows: await runJudge(model, price, spend) });
  }

  const jevBy = new Map(jevRows.map((r) => [r.id, r]));
  const jevScored = jevRows.map((r) => scoreOf(r.p.a ?? 0.5, r.truth));
  const summary: (string | number)[][] = [
    [
      "Jev (frame a, share of a 4-question batch)",
      pct(acc(jevScored)),
      fmt(brier(jevScored)),
      fmt(ece(jevScored)),
      `$${mean(jevRows.map((r) => r.cost / 4)).toFixed(6)}`,
      `${Math.round(mean(jevRows.map((r) => r.latencyMs)))} ms`,
      0,
    ],
  ];
  for (const j of judges) {
    const live = j.rows.filter((r) => !r.failed);
    const s = live.map((r) => scoreOf(r.p, r.truth));
    summary.push([
      j.model,
      pct(acc(s)),
      fmt(brier(s)),
      fmt(ece(s)),
      `$${mean(live.map((r) => r.cost)).toFixed(6)}`,
      `${Math.round(mean(live.map((r) => r.latencyMs)))} ms`,
      j.rows.length - live.length,
    ]);
  }
  table(
    ["judge", "accuracy", "Brier", "ECE", "mean cost per item", "mean latency", "failed open"],
    summary,
  );

  // Correlation of errors with Jev, and between the generative judges.
  const corr: (string | number)[][] = [];
  for (const j of judges) {
    const paired = j.rows.flatMap((s) => {
      const jv = jevBy.get(s.id);
      if (!jv || s.failed) return [];
      const pj = jv.p.a ?? 0.5;
      return [
        { cj: pj >= 0.5 === s.truth, cs: s.p >= 0.5 === s.truth, confJ: Math.max(pj, 1 - pj) },
      ];
    });
    const phi = errorCorrelation(paired.map((p) => ({ a: p.cj, b: p.cs })));
    const jevWrong = paired.filter((p) => !p.cj);
    const jevConfWrong = jevWrong.filter((p) => p.confJ >= 0.8);
    const repeat = (xs: typeof paired) =>
      xs.length ? xs.filter((p) => !p.cs).length / xs.length : 0;
    const judgeErr = 1 - acc(paired.map((p) => ({ confidence: 1, correct: p.cs })));
    corr.push([
      j.model,
      fmt(phi, 3),
      `${pct(repeat(jevWrong))} (${jevWrong.length})`,
      `${pct(repeat(jevConfWrong))} (${jevConfWrong.length})`,
      pct(judgeErr),
    ]);
  }
  if (judges.length === 2) {
    const [a, b] = judges as [(typeof judges)[0], (typeof judges)[0]];
    const byId = new Map(b.rows.map((r) => [r.id, r]));
    const pairs = a.rows.flatMap((r) => {
      const o = byId.get(r.id);
      return o && !r.failed && !o.failed
        ? [{ a: r.p >= 0.5 === r.truth, b: o.p >= 0.5 === o.truth }]
        : [];
    });
    corr.push([`${a.model} vs ${b.model}`, fmt(errorCorrelation(pairs), 3), "", "", ""]);
  }
  table(
    [
      "pair",
      "error correlation (phi)",
      "judge also wrong when Jev wrong (n)",
      "when Jev wrong at >= 0.8 (n)",
      "judge error rate (independent expectation)",
    ],
    corr,
  );

  // Cascade per judge: settle on Jev when its confidence clears the bar, else take the judge.
  for (const j of judges) {
    const paired = j.rows.flatMap((s) => {
      const jv = jevBy.get(s.id);
      if (!jv || s.failed) return [];
      const pj = jv.p.a ?? 0.5;
      return [{ truth: s.truth, pj, ps: s.p, costJ: jv.cost / 4, costS: s.cost }];
    });
    const strongOnlyCost = mean(paired.map((p) => p.costS));
    const strongOnlyAcc = acc(paired.map((p) => scoreOf(p.ps, p.truth)));
    const rows: (string | number)[][] = [];
    for (const bar of [0.6, 0.7, 0.8, 0.9, 0.95]) {
      let right = 0;
      let escalated = 0;
      let cost = 0;
      for (const p of paired) {
        const conf = Math.max(p.pj, 1 - p.pj);
        cost += p.costJ;
        if (conf >= bar) {
          if (p.pj >= 0.5 === p.truth) right++;
        } else {
          escalated++;
          cost += p.costS;
          if (p.ps >= 0.5 === p.truth) right++;
        }
      }
      rows.push([
        bar,
        pct(right / paired.length),
        pct(escalated / paired.length),
        `$${(cost / paired.length).toFixed(6)}`,
        pct(cost / paired.length / strongOnlyCost),
      ]);
    }
    rows.push(["judge only", pct(strongOnlyAcc), "100%", `$${strongOnlyCost.toFixed(6)}`, "100%"]);
    note(`Cascade Jev -> ${j.model}:`);
    table(
      [
        "settle bar on Jev confidence",
        "accuracy",
        "escalated",
        "cost per item",
        "vs judge-only cost",
      ],
      rows,
    );
  }
}
