/**
 * E2. BoolQ through the engine: calibration of a yes/no decision model on reading
 * comprehension, what re-asking and re-framing buy, whether batched answers equal single
 * answers, and what a fitted threshold delivers. Everything goes through Engine + ledger.
 */
import { join } from "node:path";
import { fmt, heading, note, pct, table } from "../../sim/lib.ts";
import { poolJudge } from "../../src/compound/aggregate.ts";
import { Engine } from "../../src/engine.ts";
import {
  brier,
  ece,
  fitThreshold,
  pairwiseCorrelation,
  reliability,
  riskCoverage,
  type Scored,
} from "../../src/ledger/calibration.ts";
import { JsonlLedger } from "../../src/ledger/ledger.ts";
import { jevViaOpenRouter } from "../../src/oracles/systemone.ts";
import { judge } from "../../src/questions.ts";
import type { JudgeVerdict } from "../../src/types.ts";
import {
  type BoolqItem,
  ensureOut,
  loadBoolq,
  mapLimit,
  mean,
  OUT,
  progress,
  type Spend,
  writeJsonl,
} from "./lib.ts";

export interface BoolqRow {
  readonly id: string;
  readonly truth: boolean;
  /** pYes per frame; frame d is the negated phrasing, already flipped back. */
  readonly p: Record<string, number>;
  readonly cost: number;
  readonly latencyMs: number;
}

const FRAMES = {
  a: (q: string) => q,
  b: (q: string) => `Based only on the passage, is the answer to this question yes: ${q}`,
  c: (q: string) => `According to the passage, ${q.charAt(0).toLowerCase()}${q.slice(1)}`,
  d: (q: string) => `Is the answer to the question "${q}" no?`,
} as const;

export const stateOf = (b: BoolqItem): string => `Passage:\n${b.passage}`;

export async function e2(spend: Spend): Promise<BoolqRow[]> {
  heading("E2. BoolQ: calibration, re-asking, re-framing, batching");
  note(
    "300 validation items from BoolQ (Wikipedia passage + yes/no question, 62% yes). Each item is one request with four questions on the same state: a) the question as written, b) a yes-framed paraphrase, c) a paraphrase, d) the negated question. Correctness is judged at 0.5; frame d is flipped back before scoring.",
  );
  ensureOut();
  const items = loadBoolq(300);
  const ledger = new JsonlLedger(join(OUT, "boolq-ledger.jsonl"));
  const engine = new Engine({
    oracle: jevViaOpenRouter(),
    ledger,
    mode: "shadow",
    keepState: false,
  });

  const rows = await mapLimit(items, 8, async (b, i) => {
    const qs = (Object.keys(FRAMES) as (keyof typeof FRAMES)[]).map((k) =>
      judge(FRAMES[k](b.question), { id: k }),
    );
    const results = await engine.askAll(stateOf(b), qs, {
      policy: { actAbove: 0.9 },
      baseline: "review",
    });
    const p: Record<string, number> = {};
    let cost = 0;
    let latencyMs = 0;
    for (const r of results) {
      const v = r.decision.verdict as JudgeVerdict;
      const k = v.questionId;
      const pYes = k === "d" ? 1 - v.pYes : v.pYes;
      p[k] = pYes;
      cost += r.decision.cost;
      latencyMs = Math.max(latencyMs, r.decision.latencyMs);
      await engine.label(r.recordId, { correct: pYes >= 0.5 === b.answer, truth: b.answer });
    }
    spend.add(cost);
    if (i % 50 === 49) progress(`  e2: ${i + 1}/${items.length}, spend $${spend.total.toFixed(4)}`);
    return { id: b.id, truth: b.answer, p, cost, latencyMs } satisfies BoolqRow;
  });
  writeJsonl("boolq-rows.jsonl", rows);

  const scoredFor = (k: string): Scored[] =>
    rows.map((r) => {
      const p = r.p[k] ?? 0.5;
      return { confidence: Math.max(p, 1 - p), correct: p >= 0.5 === r.truth };
    });
  const acc = (s: Scored[]) => mean(s.map((x) => (x.correct ? 1 : 0)));

  const frameRows: (string | number)[][] = [];
  for (const k of Object.keys(FRAMES)) {
    const s = scoredFor(k);
    frameRows.push([
      k,
      pct(acc(s)),
      fmt(brier(s)),
      fmt(ece(s)),
      fmt(mean(rows.map((r) => r.p[k] ?? 0.5)), 3),
      pct(mean(rows.map((r) => ((r.p[k] ?? 0.5) >= 0.5 ? 1 : 0)))),
    ]);
  }
  table(
    ["frame", "accuracy", "Brier", "ECE", "mean p(yes)", "predicted yes rate (truth 62%)"],
    frameRows,
  );

  // Agreement and error correlation between frames.
  const correctMatrix = rows.map((r) =>
    Object.keys(FRAMES).map((k) => (r.p[k] ?? 0.5) >= 0.5 === r.truth),
  );
  const rho = pairwiseCorrelation(correctMatrix);
  const allAgree = rows.filter((r) => {
    const labels = Object.keys(FRAMES).map((k) => (r.p[k] ?? 0.5) >= 0.5);
    return labels.every((l) => l === labels[0]);
  }).length;
  const spreadAC = mean(rows.map((r) => Math.abs((r.p.a ?? 0.5) - (r.p.c ?? 0.5))));
  const spreadAD = mean(rows.map((r) => Math.abs((r.p.a ?? 0.5) - (r.p.d ?? 0.5))));
  note(
    `All four frames agree on ${allAgree}/${rows.length} items. Mean pairwise error correlation (phi) across frames: ${fmt(rho, 3)}. Mean |p_a - p_c| = ${fmt(spreadAC, 3)} (plain paraphrase); mean |p_a - p_d| = ${fmt(spreadAD, 3)} (negated phrasing, flipped back).`,
  );

  // Pooling frames a, b, c (d is a different beast) in log-odds with the measured correlation.
  const pooled: Scored[] = rows.map((r) => {
    const vs = (["a", "b", "c"] as const).map(
      (k): JudgeVerdict => ({
        kind: "judge",
        questionId: "x",
        pYes: r.p[k] ?? 0.5,
        confidence: Math.max(r.p[k] ?? 0.5, 1 - (r.p[k] ?? 0.5)),
      }),
    );
    const v = poolJudge(vs, { correlation: Math.max(0, rho) });
    return { confidence: v.confidence, correct: v.pYes >= 0.5 === r.truth };
  });
  const pooledNaive: Scored[] = rows.map((r) => {
    const vs = (["a", "b", "c"] as const).map(
      (k): JudgeVerdict => ({
        kind: "judge",
        questionId: "x",
        pYes: r.p[k] ?? 0.5,
        confidence: Math.max(r.p[k] ?? 0.5, 1 - (r.p[k] ?? 0.5)),
      }),
    );
    const v = poolJudge(vs);
    return { confidence: v.confidence, correct: v.pYes >= 0.5 === r.truth };
  });
  table(
    ["judgment", "accuracy", "Brier", "ECE"],
    [
      [
        "frame a alone",
        pct(acc(scoredFor("a"))),
        fmt(brier(scoredFor("a"))),
        fmt(ece(scoredFor("a"))),
      ],
      [
        "a+b+c pooled, rho assumed 0",
        pct(acc(pooledNaive)),
        fmt(brier(pooledNaive)),
        fmt(ece(pooledNaive)),
      ],
      [
        `a+b+c pooled, rho measured ${fmt(rho, 2)}`,
        pct(acc(pooled)),
        fmt(brier(pooled)),
        fmt(ece(pooled)),
      ],
    ],
  );

  // Reliability and selective prediction on frame a.
  const sa = scoredFor("a");
  table(
    ["confidence bin", "n", "mean confidence", "accuracy"],
    reliability(sa, 5)
      .filter((b) => b.n > 0)
      .map((b) => [
        `${b.lo.toFixed(1)} to ${b.hi.toFixed(1)}`,
        b.n,
        fmt(b.meanConfidence),
        pct(b.accuracy),
      ]),
  );
  const rc = riskCoverage(sa);
  const at = (cov: number) => rc.find((p) => p.coverage >= cov);
  table(
    ["act on the most confident", "threshold", "accuracy on that slice"],
    [0.25, 0.5, 0.75, 1].map((c) => {
      const p = at(c);
      return [pct(c, 0), p ? fmt(p.threshold) : "", p ? pct(p.accuracy) : ""];
    }),
  );
  for (const target of [0.9, 0.95, 0.98]) {
    const f = fitThreshold(sa, target, 30);
    note(
      f
        ? `Bar for ${pct(target, 0)} accuracy on frame a: act above ${fmt(f.threshold)}, covering ${pct(f.coverage)} of items (${f.n} of ${rows.length}).`
        : `No bar reaches ${pct(target, 0)} accuracy with at least 30 items on frame a.`,
    );
  }

  // Run-to-run: re-ask 40 items.
  const again = await mapLimit(items.slice(0, 40), 8, async (b) => {
    const r = await engine.ask(stateOf(b), judge(FRAMES.a(b.question), { id: "a-repeat" }), {
      policy: { actAbove: 0.9 },
      baseline: "review",
    });
    spend.add(r.decision.cost);
    return (r.decision.verdict as JudgeVerdict).pYes;
  });
  const deltasRepeat = again.map((p, i) => Math.abs(p - (rows[i]?.p.a ?? 0.5)));
  note(
    `Run-to-run on 40 items (same question, asked alone a second time): max |delta p| ${fmt(Math.max(...deltasRepeat), 3)}, mean ${fmt(mean(deltasRepeat), 4)}, label flips ${deltasRepeat.filter((_d, i) => (again[i] ?? 0.5) >= 0.5 !== (rows[i]?.p.a ?? 0.5) >= 0.5).length}. The first value came from a four-question batch and the second from a single-question request, so this also tests whether batching changes answers.`,
  );

  // What the ledger says, via the engine's own report.
  const rep = await engine.report({ targetAccuracy: 0.95, minSupport: 30 });
  const qa = rep.byQuestion.a;
  note(
    `Engine report over the ledger: ${rep.records} rows, ${rep.labelled} labelled, cost $${rep.cost.toFixed(4)}, mean latency ${Math.round(rep.meanLatencyMs)} ms. Frame a: observed accuracy ${pct(qa?.accuracy ?? 0)}, expected from confidence ${pct(qa?.expectedAccuracy ?? 0)}, ECE ${fmt(qa?.ece ?? 0)}${qa?.fitted ? `, fitted 95% bar ${fmt(qa.fitted.threshold)} at ${pct(qa.fitted.coverage)} coverage (${qa.fittedFrom})` : ", no 95% bar with enough support"}.`,
  );
  return rows;
}
