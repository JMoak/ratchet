/**
 * The thesis, run. Every table below is produced by the engine's own code against a
 * simulated oracle whose accuracy, calibration and error correlation are known. Run with
 * `bun run sim`. Nothing here needs a network or a key.
 */
import { cascade } from "../src/compound/cascade.ts";
import { runChain, type Step } from "../src/compound/chain.ts";
import { ensemble, replicate } from "../src/compound/ensemble.ts";
import { sequential } from "../src/compound/sequential.ts";
import { ece, type Scored } from "../src/ledger/calibration.ts";
import { majorityAccuracy, mean, rng } from "../src/math.ts";
import { SimOracle } from "../src/oracles/sim.ts";
import { judge } from "../src/questions.ts";
import type { Decision } from "../src/types.ts";
import { fmt, heading, judgeItems, note, pct, table } from "./lib.ts";
import { rolloutTables } from "./rollout.ts";

const N = 3000;
const q = judge("Is the claim true?", { id: "claim" });
const items = judgeItems(N);
const right = (s: string, d: Decision) =>
  d.verdict.kind === "judge" && d.verdict.pYes >= 0.5 === items.truths.get(s)?.judge;

console.log("# Compounding 80% decisions: what the arithmetic says\n");
note(
  `Simulated oracle, ${N} items per cell, seeded. p = per-call accuracy, rho = pairwise error correlation.`,
);

// 1. Condorcet, analytic -----------------------------------------------------------------
heading("1. Independent majority vote (Condorcet), exact");
note(
  "Probability a simple majority of n independent voters is right. At p = 0.8, fifteen voters reach 99.6%. Below 0.5 it runs the other way.",
);
table(
  ["n", "p=0.6", "p=0.7", "p=0.8", "p=0.9"],
  [1, 3, 5, 9, 15, 25].map((n) => [
    n,
    ...[0.6, 0.7, 0.8, 0.9].map((p) => pct(majorityAccuracy(n, p), 2)),
  ]),
);

// 2. Correlation kills the gain ---------------------------------------------------------
heading("2. Five voters at p = 0.8, pooled in log-odds, as error correlation rises");
note(
  "Correlation does not change which answer wins (scaling a log-odds sum keeps its sign), it changes how sure you are entitled to be. Uncorrected confidence becomes overconfident; the design-effect correction restores calibration. This is why the ledger must measure rho rather than assume it.",
);
{
  const rows: (string | number)[][] = [];
  for (const rho of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
    const o = new SimOracle({ accuracy: 0.8, seed: 20, correlation: rho }, items.truthOf);
    const members = replicate(o, 5);
    let hits = 0;
    const raw: Scored[] = [];
    const fixed: Scored[] = [];
    for (const s of items.states) {
      const a = await ensemble(s, q, { members });
      const b = await ensemble(s, q, { members, correlation: rho });
      o.resetItems();
      const ok = right(s, a);
      if (ok) hits++;
      raw.push({ confidence: a.verdict.confidence, correct: ok });
      fixed.push({ confidence: b.verdict.confidence, correct: right(s, b) });
    }
    rows.push([
      rho,
      pct(hits / N),
      fmt(mean(raw.map((x) => x.confidence))),
      fmt(ece(raw)),
      fmt(ece(fixed)),
    ]);
  }
  table(["rho", "accuracy", "mean conf (uncorrected)", "ECE uncorrected", "ECE corrected"], rows);
}

// 3. Cascade economics ----------------------------------------------------------------
heading(
  "3. Cascade: cheap oracle (p = 0.8, cost 1) escalates to a strong one (p = 0.95, cost 400) when unsure",
);
note(
  "Cost ratio of roughly 400x mirrors a decision model against a frontier model. The bar decides how much traffic escalates.",
);
{
  const rows: (string | number)[][] = [];
  for (const bar of [0.6, 0.7, 0.8, 0.9, 0.95, 0.99]) {
    const cheap = new SimOracle(
      { accuracy: 0.8, seed: 30, costPerQuestion: 1, id: "cheap" },
      items.truthOf,
    );
    const strong = new SimOracle(
      { accuracy: 0.95, seed: 31, costPerQuestion: 400, id: "strong" },
      items.truthOf,
    );
    let hits = 0;
    let cost = 0;
    let esc = 0;
    for (const s of items.states) {
      const d = await cascade(s, q, {
        tiers: [
          { oracle: cheap, settleAbove: bar },
          { oracle: strong, settleAbove: 0 },
        ],
      });
      if (right(s, d)) hits++;
      cost += d.cost;
      if (d.detail.escalations > 0) esc++;
    }
    rows.push([bar, pct(hits / N), pct(esc / N), fmt(cost / N, 1), pct(cost / N / 400)]);
  }
  rows.push(["strong only", pct(0.95, 1), "100%", "400.0", "100%"]);
  table(["settle bar", "accuracy", "escalated", "cost / item", "vs strong-only cost"], rows);
}

// 4. Sequential sampling --------------------------------------------------------------
heading("4. Sequential: keep sampling the 80% oracle until pooled confidence clears the bar");
note(
  "Easy items settle in one call; hard items buy more. Compare against a fixed-size ensemble of the same mean size.",
);
{
  const rows: (string | number)[][] = [];
  for (const bar of [0.8, 0.9, 0.95, 0.99]) {
    const o = new SimOracle({ accuracy: 0.8, seed: 40 }, items.truthOf);
    const members = replicate(o, 11);
    let hits = 0;
    const used: number[] = [];
    for (const s of items.states) {
      const d = await sequential(s, q, { members, settleAbove: bar, maxSamples: 11 });
      if (right(s, d)) hits++;
      used.push(d.detail.samples);
    }
    const k = Math.max(1, Math.round(mean(used)));
    rows.push([
      bar,
      pct(hits / N),
      fmt(mean(used), 2),
      pct(used.filter((u) => u === 1).length / N),
      `${k}: ${pct(majorityAccuracy(k % 2 ? k : k + 1, 0.8))}`,
    ]);
  }
  table(
    ["settle bar", "accuracy", "mean samples", "settled in 1", "fixed majority of same size"],
    rows,
  );
}

// 5. Chains and the ratchet -----------------------------------------------------------
heading("5. Chains: n dependent steps at p = 0.8 each, with and without verified commits");
note(
  "Unverified, success is 0.8^n. The ratchet verifies each step with an independent judge, resamples on a reject, and commits only verified work. That does not remove the dependence on n; it changes the base. With catch rate t and false-alarm rate f, a committed step is good with probability q = p(1-f) / (p(1-f) + (1-p)(1-t)): a 90% verifier lifts the base from 0.80 to 0.97, a 99% verifier to 0.9975. The retry cap and the act bar trim that a little. 'Claimed' counts chains the verifier passed; 'true' counts chains whose final state is actually good.",
);
{
  interface S {
    readonly good: boolean;
    readonly token: number;
  }
  const check = judge("Did this step succeed?", { id: "v" });
  for (const [verifierAccuracy, maxAttempts] of [
    [0.9, 3],
    [0.99, 3],
    [0.99, 6],
  ] as const) {
    const t = verifierAccuracy;
    const f = 1 - verifierAccuracy;
    const qStep = (0.8 * (1 - f)) / (0.8 * (1 - f) + 0.2 * (1 - t));
    note(
      `Verifier accuracy ${pct(verifierAccuracy, 0)}, up to ${maxAttempts} attempts per step. Analytic per-step base with unbounded retries: q = ${fmt(qStep, 4)}.`,
    );
    const rows: (string | number)[][] = [];
    for (const n of [1, 3, 5, 10, 20, 50]) {
      const rand = rng(50 + n);
      const verifier = new SimOracle(
        { accuracy: verifierAccuracy, seed: 51, costPerQuestion: 1 },
        (st) => ({ judge: (JSON.parse(st) as S).good }),
      );
      const steps: Step<S>[] = Array.from({ length: n }, (_, i) => ({
        name: `s${i}`,
        propose: async (st) => ({ good: st.good && rand() < 0.8, token: rand() }),
        verify: async (_b, a) => (await verifier.decide(JSON.stringify(a), [check]))[0] as Decision,
        maxAttempts,
      }));
      const runs = 400;
      let claimed = 0;
      let truly = 0;
      let attempts = 0;
      let committed = 0;
      for (let r = 0; r < runs; r++) {
        const res = await runChain({ good: true, token: 0 }, steps, { actAbove: 0.7 });
        for (const tr of res.trace) {
          attempts += tr.attempts.length;
          if (tr.committed) committed++;
        }
        if (res.ok) claimed++;
        if (res.ok && res.state.good) truly++;
      }
      rows.push([
        n,
        pct(0.8 ** n),
        pct(qStep ** n),
        pct(claimed / runs),
        pct(truly / runs),
        fmt(committed ? attempts / committed : 0, 2),
      ]);
    }
    table(
      [
        "steps",
        "unverified 0.8^n",
        "analytic q^n",
        "ratchet claimed",
        "ratchet true",
        "attempts per committed step",
      ],
      rows,
    );
  }
}

// 6. Calibration is the load-bearing wall ---------------------------------------------
heading("6. Same 80% oracle, same cascade bar (0.9), different calibration");
note(
  "An overconfident cheap tier settles cases it should have escalated. Accuracy among settled items is what a threshold promises; miscalibration breaks the promise silently.",
);
{
  const rows: (string | number)[][] = [];
  for (const [label, temperature] of [
    ["underconfident (t=0.6)", 0.6],
    ["calibrated (t=1)", 1],
    ["overconfident (t=1.8)", 1.8],
    ["very overconfident (t=3)", 3],
  ] as const) {
    const cheap = new SimOracle(
      { accuracy: 0.8, seed: 60, temperature, costPerQuestion: 1 },
      items.truthOf,
    );
    const strong = new SimOracle({ accuracy: 0.95, seed: 61, costPerQuestion: 400 }, items.truthOf);
    let settledRight = 0;
    let settled = 0;
    let hits = 0;
    const scored: Scored[] = [];
    for (const s of items.states) {
      const d = await cascade(s, q, {
        tiers: [
          { oracle: cheap, settleAbove: 0.9 },
          { oracle: strong, settleAbove: 0 },
        ],
      });
      const ok = right(s, d);
      if (ok) hits++;
      if (d.detail.escalations === 0) {
        settled++;
        if (ok) settledRight++;
        scored.push({ confidence: d.verdict.confidence, correct: ok });
      }
    }
    rows.push([
      label,
      fmt(ece(scored)),
      pct(settled / N),
      pct(settled ? settledRight / settled : 0),
      pct(hits / N),
    ]);
  }
  table(
    [
      "cheap tier",
      "ECE (settled)",
      "settled by cheap",
      "accuracy when settled",
      "overall accuracy",
    ],
    rows,
  );
}

rolloutTables();

note(
  "Takeaways: independence and calibration are the two properties that make 80% compound; verification is what makes chains survive; the ledger is where all three are measured instead of assumed.",
);
