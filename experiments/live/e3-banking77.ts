/**
 * E3. Banking77 through the engine: 77-way routing with a Choice question, the effect of
 * option order on the answer and on the probabilities, pooling across orders by name, and
 * what a shortlist (top 3) buys for an escalate-to-human pattern.
 */
import { join } from "node:path";
import { fmt, heading, note, pct, table } from "../../sim/lib.ts";
import { poolPick } from "../../src/compound/aggregate.ts";
import { Engine } from "../../src/engine.ts";
import { ece, type Scored } from "../../src/ledger/calibration.ts";
import { JsonlLedger } from "../../src/ledger/ledger.ts";
import { rng, shuffled } from "../../src/math.ts";
import { jevViaOpenRouter } from "../../src/oracles/systemone.ts";
import { pick } from "../../src/questions.ts";
import type { PickVerdict } from "../../src/types.ts";
import {
  ensureOut,
  loadBanking77,
  mapLimit,
  mean,
  OUT,
  progress,
  type Spend,
  writeJsonl,
} from "./lib.ts";

export async function e3(spend: Spend): Promise<void> {
  heading("E3. Banking77: 77-way routing, option order, shortlists");
  const { items, labels } = loadBanking77(150);
  if (items.length === 0 || labels.length < 70) {
    note(`Banking77 data unavailable (${items.length} items, ${labels.length} labels); skipped.`);
    return;
  }
  note(
    `${items.length} test utterances, ${labels.length} intents given as option names only (no descriptions). Each item is one request with three Choice questions over the same state, differing only in option order: canonical, reversed, and a seeded shuffle.`,
  );
  ensureOut();
  const ledger = new JsonlLedger(join(OUT, "banking77-ledger.jsonl"));
  const engine = new Engine({ oracle: jevViaOpenRouter(), ledger, mode: "shadow" });
  const orders = {
    canonical: labels,
    reversed: labels.slice().reverse(),
    shuffled: shuffled(labels, rng(77)),
  } as const;
  const prompt = "Which banking intent does the customer message express?";

  interface Row {
    readonly id: string;
    readonly truth: string;
    readonly choice: Record<string, string>;
    readonly pTruth: Record<string, number>;
    readonly pMax: Record<string, number>;
    readonly firstIndexChosen: Record<string, boolean>;
    readonly rankOfTruth: Record<string, number>;
    readonly probabilities: Record<string, Record<string, number>>;
    cost: number;
  }

  const rows = await mapLimit(items, 6, async (it, i) => {
    const qs = (Object.keys(orders) as (keyof typeof orders)[]).map((k) =>
      pick(prompt, orders[k], { id: k }),
    );
    const results = await engine.askAll(`Customer message: ${it.text}`, qs, {
      policy: { actAbove: 0.7 },
      baseline: "review",
    });
    const row: Row = {
      id: it.id,
      truth: it.label,
      choice: {},
      pTruth: {},
      pMax: {},
      firstIndexChosen: {},
      rankOfTruth: {},
      probabilities: {},
      cost: 0,
    };
    for (const r of results) {
      const v = r.decision.verdict as PickVerdict;
      const k = v.questionId as keyof typeof orders;
      row.choice[k] = v.choice;
      row.pTruth[k] = v.probabilities[it.label] ?? 0;
      row.pMax[k] = v.confidence;
      row.firstIndexChosen[k] = v.choice === orders[k][0];
      const ranked = Object.entries(v.probabilities)
        .sort((a, b) => b[1] - a[1])
        .map((e) => e[0]);
      row.rankOfTruth[k] = ranked.indexOf(it.label) + 1;
      row.probabilities[k] = v.probabilities as Record<string, number>;
      row.cost += r.decision.cost;
      await engine.label(r.recordId, { correct: v.choice === it.label, truth: it.label });
    }
    spend.add(row.cost);
    if (i % 50 === 49) progress(`  e3: ${i + 1}/${items.length}, spend $${spend.total.toFixed(4)}`);
    return row;
  });
  writeJsonl("banking77-rows.jsonl", rows);

  const orderRows: (string | number)[][] = [];
  for (const k of Object.keys(orders) as (keyof typeof orders)[]) {
    const s: Scored[] = rows.map((r) => ({
      confidence: r.pMax[k] ?? 0,
      correct: r.choice[k] === r.truth,
    }));
    orderRows.push([
      k,
      pct(mean(s.map((x) => (x.correct ? 1 : 0)))),
      pct(mean(rows.map((r) => ((r.rankOfTruth[k] ?? 99) <= 3 ? 1 : 0)))),
      fmt(mean(rows.map((r) => r.pMax[k] ?? 0))),
      fmt(ece(s)),
      pct(mean(rows.map((r) => (r.firstIndexChosen[k] ? 1 : 0)))),
    ]);
  }
  table(
    [
      "option order",
      "top-1 accuracy",
      "truth in top 3",
      "mean p(choice)",
      "ECE",
      "chose first-listed option (chance 1.3%)",
    ],
    orderRows,
  );

  const flips = rows.filter((r) => new Set(Object.values(r.choice)).size > 1).length;
  const drift = mean(
    rows.map(
      (r) =>
        Math.max(...(Object.keys(orders) as (keyof typeof orders)[]).map((k) => r.pTruth[k] ?? 0)) -
        Math.min(...(Object.keys(orders) as (keyof typeof orders)[]).map((k) => r.pTruth[k] ?? 0)),
    ),
  );
  note(
    `Items where the chosen intent changed with option order: ${flips}/${rows.length}. Mean spread of p(true intent) across the three orders: ${fmt(drift, 3)}.`,
  );

  // Pool the three orders by option name.
  const q = pick(prompt, labels, { id: "pooled" });
  let pooledRight = 0;
  const pooledScored: Scored[] = [];
  for (const r of rows) {
    const vs = (Object.keys(orders) as (keyof typeof orders)[]).map((k): PickVerdict => {
      const probs = r.probabilities[k] ?? {};
      return {
        kind: "pick",
        questionId: "pooled",
        choice: r.choice[k] ?? "",
        probabilities: probs,
        confidence: r.pMax[k] ?? 0,
      };
    });
    const v = poolPick(q, vs, { correlation: 0.5 });
    const ok = v.choice === r.truth;
    if (ok) pooledRight++;
    pooledScored.push({ confidence: v.confidence, correct: ok });
  }
  note(
    `Pooling the three orders by option name (log-odds, rho assumed 0.5): accuracy ${pct(pooledRight / rows.length)}, ECE ${fmt(ece(pooledScored))}.`,
  );
  const costPerItem = mean(rows.map((r) => r.cost));
  note(
    `Cost: $${costPerItem.toFixed(6)} per item for three 77-option questions, i.e. $${(costPerItem * 1000).toFixed(3)} per thousand utterances routed three ways; a single order would be about a third of that.`,
  );
}
