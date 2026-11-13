/**
 * The thesis, run. Every table below is produced by the engine's own code against a
 * simulated oracle whose accuracy, calibration and error correlation are known. Run with
 * `bun run sim`. Nothing here needs a network or a key.
 */
import { cascade } from "../src/compound/cascade.ts";
import {
  runChain,
  type SecondOpinionMode,
  type Step,
  summarizeChain,
} from "../src/compound/chain.ts";
import { ensemble, replicate } from "../src/compound/ensemble.ts";
import {
  completionInterval,
  frailtyFromRates,
  independentFrailty,
  predictChain,
} from "../src/compound/frailty.ts";
import { sequential } from "../src/compound/sequential.ts";
import { ece, type Scored } from "../src/ledger/calibration.ts";
import { majorityAccuracy, mean, randBeta, randNormal, rng, sigmoid } from "../src/math.ts";
import { SimOracle } from "../src/oracles/sim.ts";
import { judge } from "../src/questions.ts";
import type { Decision } from "../src/types.ts";
import { anytimeTables } from "./anytime.ts";
import { barTables } from "./bars.ts";
import { labelTables } from "./labels.ts";
import { fmt, heading, judgeItems, note, pct, table } from "./lib.ts";
import { poolingTables } from "./pooling.ts";
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
  "Unverified, success is 0.8^n. The ratchet verifies each step with an independent judge, resamples on a reject, and commits only verified work. That does not remove the dependence on n; it changes the base. With catch rate t and false-alarm rate f, a committed step is good with probability q = p(1-f) / (p(1-f) + (1-p)(1-t)): a 90% verifier lifts the base from 0.80 to 0.97, a 99% verifier to 0.9975. q is the precision of commits, so it says how often a chain that finishes is right, not how often it finishes; the retry cap and the act bar trim it a little. 'Claimed' counts chains the verifier passed; 'true' counts chains whose final state is actually good.",
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

  // Whether a chain finishes is not q. A verifier whose dislike follows the step instance makes
  // retries correlated; the beta frailty below is fitted to the live verifier track's two rates.
  const LIVE = { first: 0.15, again: 0.559 };
  const frail = frailtyFromRates(LIVE.first, LIVE.again);
  const ruled = (pYes: number): Decision => ({
    verdict: { kind: "judge", questionId: check.id, pYes, confidence: Math.max(pYes, 1 - pYes) },
    oracle: "verifier",
    latencyMs: 0,
    cost: 0,
    at: "2026-11-12T00:00:00.000Z",
  });
  const span = (iv: { readonly pessimistic: number; readonly optimistic: number }) =>
    `[${pct(iv.pessimistic)}, ${pct(iv.optimistic)}]`;

  {
    const p = 0.8;
    const t = 0.95;
    const m = 3;
    const f = LIVE.first;
    note(
      `Correlated false alarms. Whether a chain finishes is a different number from q. One attempt is accepted with probability a = p(1-f) + (1-p)(1-t), and (1 - (1-a)^m)^n would be the completion rate if attempts were independent, but a verifier that dislikes a step instance tends to dislike every fresh correct answer to it (coincident failure). Live (T2), a held-back correct candidate was followed by another held-back one ${pct(LIVE.again)} of the time against a ${pct(LIVE.first)} base rate, and chains finished 48% to 62% of the time where independence at that base rate said 76.6% to 97.3% (the evaluation's own 74% to 99.8% took the held-out 16.7% false-alarm rate and counted replayed candidates as fresh ones). Below, each step instance's false-alarm propensity theta is drawn from the beta those two rates fit (a = ${fmt(frail.a)}, b = ${fmt(frail.b)}, intraclass correlation ${fmt(frail.rho)}, mean f = ${pct(f, 0)} as in the independent columns). Each step is an independent task right with p = ${p} (a wrong commit does not spoil later steps), the verifier catches ${pct(t, 0)} of wrong attempts, and each step gets ${m} attempts; 2,000 seeded chains per cell. "Predicted" is \`predictChain\`. "Two rates alone" is \`completionInterval\`, every completion a law with those two moments allows; its optimistic end is the two-point law this table used to show as the correlated case. Commit precision barely moves; completion falls well below the independent formula, where the beta puts it.`,
    );
    interface Task {
      /** Every committed step so far was right. */
      readonly good: boolean;
      /** This attempt is right. */
      readonly ok: boolean;
      readonly token: number;
    }
    const rows: (string | number)[][] = [];
    for (const n of [1, 3, 5, 8, 10, 20]) {
      const simulated: { finished: number; precision: number }[] = [];
      for (const correlated of [false, true]) {
        const rand = rng(70 + n + (correlated ? 1000 : 0));
        let theta: number[] = [];
        const steps: Step<Task>[] = Array.from({ length: n }, (_, i) => ({
          name: `s${i}`,
          propose: async (st) => {
            const ok = rand() < p;
            return { good: st.good && ok, ok, token: rand() };
          },
          // A correct attempt is held back with the instance's theta, or with f when independent.
          verify: async (_b, a) => {
            const falseAlarm = correlated ? (theta[i] as number) : f;
            return ruled((a.ok ? rand() >= falseAlarm : rand() >= t) ? 0.9 : 0.1);
          },
          maxAttempts: m,
        }));
        const runs = 2000;
        let finished = 0;
        let committedSteps = 0;
        let rightSteps = 0;
        for (let r = 0; r < runs; r++) {
          theta = Array.from({ length: n }, () => randBeta(frail.a, frail.b, rand));
          const res = await runChain({ good: true, ok: true, token: 0 }, steps, { actAbove: 0.7 });
          if (res.ok) finished++;
          for (const state of res.checkpoints.slice(1)) {
            committedSteps++;
            if (state.ok) rightSteps++;
          }
        }
        simulated.push({
          finished: finished / runs,
          precision: committedSteps ? rightSteps / committedSteps : 0,
        });
      }
      const [independent, beta] = simulated as [
        { finished: number; precision: number },
        { finished: number; precision: number },
      ];
      const model = { p, t, attempts: m, steps: n };
      const predicted = predictChain(frail, model);
      rows.push([
        n,
        pct(predictChain(independentFrailty(f), model).completion),
        pct(independent.finished),
        pct(independent.precision),
        pct(predicted.completion),
        pct(beta.finished),
        span(completionInterval(LIVE, model)),
        `${pct(predicted.precision)} / ${pct(beta.precision)}`,
      ]);
    }
    table(
      [
        "steps",
        "(1-(1-a)^m)^n",
        "independent f: finished",
        "independent f: q",
        "beta frailty: predicted",
        "beta frailty: finished",
        "two rates alone",
        "beta frailty: q predicted / simulated",
      ],
      rows,
    );
  }

  // The live chains, reproduced from the two rates.
  {
    const chains = 4000;
    interface Candidate {
      readonly key: string;
      readonly correct: boolean;
    }
    /** T2's proposer: correct candidates cycle three styles, wrong ones are all distinct. */
    const simulate = async (p: number, m: number, seed: number): Promise<number> => {
      const rand = rng(seed);
      let theta: number[] = [];
      let styles: number[][] = [];
      let correctSoFar = 0;
      const steps: Step<Candidate>[] = Array.from({ length: 8 }, (_, i) => ({
        name: `s${i}`,
        maxAttempts: m,
        propose: async (_st, attempt) => {
          if (attempt === 1) correctSoFar = 0;
          if (rand() >= p) return { key: `s${i}:wrong${attempt}`, correct: false };
          return { key: `s${i}:style${correctSoFar++ % 3}`, correct: true };
        },
        // t = 1: a wrong candidate is always held. A correct style is held when its own draw
        // falls under the instance's theta; keyOf means a repeated style is never asked again.
        verify: async (_b, a) => {
          if (!a.correct) return ruled(0.1);
          const style = Number(a.key.slice(a.key.lastIndexOf("style") + 5));
          return ruled((styles[i]?.[style] as number) < (theta[i] as number) ? 0.1 : 0.9);
        },
      }));
      let finished = 0;
      for (let c = 0; c < chains; c++) {
        theta = Array.from({ length: 8 }, () => randBeta(frail.a, frail.b, rand));
        styles = Array.from({ length: 8 }, () => [rand(), rand(), rand()]);
        const res = await runChain<Candidate>(
          { key: "start", correct: true },
          steps,
          { actAbove: 0.5 },
          { keyOf: (s) => s.key },
        );
        if (res.ok) finished++;
      }
      return finished / chains;
    };
    const fresh6 = predictChain(frail, { p: 0.8, t: 1, attempts: 6, steps: 8 }).completion;
    const limit = completionInterval(LIVE, { p: 0.8, t: 1, attempts: 3, steps: 8 }).limit;
    note(
      `Reproducing the live completion (verifier track T2): eight steps; catch rate t = 1 (the verifier held back 270 of 270 wrong held-out candidates); three distinct correct candidates per step, which the six-attempt arm repeated, replaying their cached verdicts, so it tested three candidates, not six. Every column but the last two is exact. "Simulated" runs \`runChain\` with \`keyOf\` over ${chains.toLocaleString("en-US")} seeded chains per row: the proposer cycles three correct styles, so a fourth correct proposal repeats the first and \`runChain\` skips it instead of replaying a verdict, which is the same thing for completion. "Observed live" is the live run's (100 chains each, Wilson 95% intervals). The independent formula is far off; the two-point law is the most optimistic reading of the two rates, not a prediction; the beta lands inside every observed interval. With six fresh candidates the beta predicts ${pct(fresh6)} at p = 0.8. As attempts grow, the two rates alone cannot certify completion above ${pct(limit.pessimistic)} (the pessimistic law's limit); only deeper moments can.`,
    );
    const observed: Record<string, string> = {
      "0.8,3": "48% [38.5, 57.7]",
      "0.9,3": "53% [43.3, 62.5]",
      "0.8,6": "62% [52.2, 70.9]",
      "0.9,6": "58% [48.2, 67.2]",
    };
    const rows: (string | number)[][] = [];
    for (const [i, [p, m]] of (
      [
        [0.8, 3],
        [0.9, 3],
        [0.8, 6],
        [0.9, 6],
      ] as const
    ).entries()) {
      const model = { p, t: 1, attempts: m, steps: 8, distinctCorrect: 3 };
      const iv = completionInterval(LIVE, model);
      rows.push([
        p,
        m,
        pct(predictChain(independentFrailty(LIVE.first), model).completion),
        pct(iv.optimistic),
        pct(predictChain(frail, model).completion),
        span(iv),
        pct(await simulate(p, m, 80 + i)),
        observed[`${p},${m}`] ?? "",
      ]);
    }
    table(
      [
        "p",
        "attempts",
        "independent at f = 15%",
        "two-point {0, 0.559}: optimistic end",
        "beta frailty",
        "two rates alone",
        "simulated (runChain)",
        "observed live",
      ],
      rows,
    );
  }

  // Common random numbers: every budget below sees the same chains, steps and attempt draws.
  const CHAINS = 4000;
  interface Draw {
    readonly correct: boolean;
    readonly u: number;
  }
  const world = (() => {
    const rand = rng(5151);
    return Array.from({ length: CHAINS }, () =>
      Array.from({ length: 8 }, () => ({
        theta: randBeta(frail.a, frail.b, rand),
        draws: Array.from({ length: 48 }, (): Draw => ({ correct: rand() < 0.8, u: rand() })),
      })),
    );
  })();
  interface Fresh {
    readonly key: string;
    readonly draw?: Draw;
  }
  const runWorld = async (budget: {
    readonly maxAttempts?: number;
    readonly attemptPool?: number;
  }) => {
    let finished = 0;
    let proposals = 0;
    let stepsRun = 0;
    let exhausted = 0;
    for (const chain of world) {
      const steps: Step<Fresh>[] = chain.map((s, i) => ({
        name: `s${i}`,
        ...(budget.maxAttempts !== undefined ? { maxAttempts: budget.maxAttempts } : {}),
        propose: async (_st, attempt) => ({
          key: `s${i}:${attempt}`,
          draw: s.draws[attempt - 1] as Draw,
        }),
        // t = 1: only a correct candidate whose draw clears the instance's theta passes.
        verify: async (_b, a) => ruled(a.draw?.correct === true && a.draw.u >= s.theta ? 0.9 : 0.1),
      }));
      const res = await runChain<Fresh>(
        { key: "start" },
        steps,
        { actAbove: 0.5 },
        {
          keyOf: (x) => x.key,
          ...(budget.attemptPool !== undefined ? { attemptPool: budget.attemptPool } : {}),
        },
      );
      if (res.ok) finished++;
      proposals += summarizeChain(res).proposals;
      stepsRun += res.trace.length;
      exhausted += res.trace.filter((tr) => !tr.committed).length;
    }
    return {
      completion: finished / CHAINS,
      proposals: proposals / CHAINS,
      exhausted: exhausted / stepsRun,
    };
  };

  {
    note(
      `Exhaustion against the attempt budget, fresh candidates (\`keyOf\` on, no repeats), p = 0.8, t = 1, eight steps, the beta above. Independently, a step would exhaust geometrically, (1-a)^m; under the frailty exhaustion falls as a power law, about m^-b with b = ${fmt(frail.b)}, so doubling the budget roughly halves it instead of squaring it, and with b <= 1 the expected number of attempts to commit is infinite: open-ended retrying has unbounded expected cost. Simulated through \`runChain\` on ${CHAINS.toLocaleString("en-US")} chains of common random numbers.`,
    );
    const rows: (string | number)[][] = [];
    for (const m of [3, 6, 12, 24]) {
      const model = { p: 0.8, t: 1, attempts: m, steps: 8 };
      const predicted = predictChain(frail, model);
      const sim = await runWorld({ maxAttempts: m });
      rows.push([
        m,
        (0.32 ** m).toExponential(2),
        fmt(predicted.step.exhausts),
        fmt(sim.exhausted),
        pct(predicted.completion),
        pct(sim.completion),
        span(completionInterval(LIVE, model)),
      ]);
    }
    table(
      [
        "attempts m",
        "independent (1-a)^m",
        "step exhausts: beta",
        "step exhausts: simulated",
        "8-step completion: beta",
        "8-step completion: simulated",
        "two rates alone",
      ],
      rows,
    );
  }

  {
    note(
      `A shared attempt budget against per-step caps at the same worst-case spend (the same ${CHAINS.toLocaleString("en-US")} chains as above). \`attemptPool\` lets a step keep trying while the pool lasts but leaves one attempt for each step still to come; that reservation is lossless (a step that dipped into it would leave a later step with nothing). Per-step caps spend the budget on easy steps and starve hard ones.`,
    );
    const rows: (string | number)[][] = [];
    for (const [label, worst, budget] of [
      ["3 per step (the default)", 24, { maxAttempts: 3 }],
      ["pool of 24", 24, { attemptPool: 24 }],
      ["pool of 24, at most 6 per step", 24, { attemptPool: 24, maxAttempts: 6 }],
      ["6 per step", 48, { maxAttempts: 6 }],
      ["pool of 48", 48, { attemptPool: 48 }],
    ] as const) {
      const sim = await runWorld(budget);
      rows.push([label, worst, pct(sim.completion), fmt(sim.proposals, 1)]);
    }
    table(["budget", "worst-case attempts", "chain completes", "attempts used per chain"], rows);
  }

  {
    // The research's latent probit world: one step factor shared by correct and wrong candidates.
    const r = 0.746; // probit-scale step ICC fitted to the two live rates
    const d1 = 4.07; // primary verifier: binormal AUC 0.998 (T2 held-out)
    const b1 = 3.034; // its bar: f1 = 15.0%, t1 = 99.88%
    const d2 = 2.66; // second opinion of another family: AUC 0.97 (assumed)
    const b2 = 1.623; // its lenient bar: f2 = 15.0%, t2 = 94.8%
    const R = 0.0895; // candidate-level latent correlation giving phi 0.04 between their holds
    const person = { correct: 0.98, wrong: 0.01 };
    const N = 5000;
    note(
      `A second opinion on held candidates, and a person. The world is the research's latent probit model: a candidate's score is u + e, plus ${d1} when it is correct, held below ${b1}; u ~ N(0, ${r}) is the step instance's factor, shared by correct and wrong candidates, and e ~ N(0, ${fmt(1 - r)}) is candidate noise. That primary verifier has AUC 0.998 (T2 held-out), false alarm 15.0% and catch rate 99.88%. The second opinion, of another family, is assumed to have AUC 0.97 (separation ${d2}), its own step factor of the same size, a lenient bar ${b2} (false alarm 15.0%, catch rate 94.8%), and a latent correlation of ${R} with the primary (phi 0.04 between their holds on correct candidates, as low as the least correlated pair of models measured in e2e T5). The person is assumed to pass ${pct(person.correct, 0)} of correct and ${pct(person.wrong, 0)} of wrong candidates, independently of both models. p = 0.8, eight steps, three fresh proposals per step, ${N.toLocaleString("en-US")} seeded chains per row. The chain never treats the person's verdict: the application puts \`held\` (or \`pending\`) before them and resumes from the last checkpoint with what they pass; on a rejected route the step resumes with the attempts it had left. "Order" asks the second opinion after every hold, so it calls it more often than ordering only at exhaustion would, for the same outcome. Releasing on the second opinion is shown as the warning it is.`,
    );
    interface Cand {
      readonly id: number;
      readonly correct: boolean;
    }
    const policies: readonly {
      readonly label: string;
      readonly second?: SecondOpinionMode;
      readonly personOnExhaustion?: boolean;
    }[] = [
      { label: "resample, 3 attempts (no person)" },
      { label: "a person reviews the held candidates on exhaustion", personOnExhaustion: true },
      {
        label: "the second opinion orders that person's queue (order, the default)",
        second: "order",
        personOnExhaustion: true,
      },
      { label: "the second opinion's pass goes to a person at once (route)", second: "route" },
      { label: "the second opinion's pass commits (commit; a warning)", second: "commit" },
    ];
    const rows: (string | number)[][] = [];
    const wrongShare: number[] = [];
    for (const [k, pol] of policies.entries()) {
      const rand = rng(9000 + k);
      let completed = 0;
      let allRight = 0;
      let commits = 0;
      let right = 0;
      let reviews = 0;
      let secondCalls = 0;
      for (let c = 0; c < N; c++) {
        const u = Array.from({ length: 8 }, () => Math.sqrt(r) * randNormal(rand));
        const v = Array.from({ length: 8 }, () => Math.sqrt(r) * randNormal(rand));
        const latent = new Map<number, number>();
        let next = 0;
        let wrongCommit = false;
        const commit = (cand: Cand) => {
          commits++;
          if (cand.correct) right++;
          else wrongCommit = true;
        };
        const approves = (cand: Cand) => {
          reviews++;
          return rand() < (cand.correct ? person.correct : person.wrong);
        };
        const makeStep = (i: number): Step<Cand> => ({
          name: `s${i}`,
          maxAttempts: 3,
          propose: async () => ({ id: ++next, correct: rand() < 0.8 }),
          verify: async (_b, a) => {
            const x1 = (u[i] as number) + Math.sqrt(1 - r) * randNormal(rand);
            latent.set(a.id, x1);
            return ruled(sigmoid(x1 + (a.correct ? d1 : 0) - b1));
          },
          ...(pol.second !== undefined
            ? {
                secondOpinion: async (_b: Cand, a: Cand) => {
                  secondCalls++;
                  const own = (v[i] as number) + Math.sqrt(1 - r) * randNormal(rand);
                  const x2 = R * (latent.get(a.id) as number) + Math.sqrt(1 - R * R) * own;
                  return ruled(sigmoid(x2 + (a.correct ? d2 : 0) - b2));
                },
              }
            : {}),
        });
        let state: Cand = { id: 0, correct: true };
        let queue = Array.from({ length: 8 }, (_, i) => makeStep(i));
        let ok = false;
        for (;;) {
          const res = await runChain(
            state,
            queue,
            { actAbove: 0.5 },
            {
              ...(pol.second !== undefined ? { secondOpinion: pol.second } : {}),
              ...(pol.personOnExhaustion === true ? { keepHeld: true } : {}),
            },
          );
          for (const cand of res.checkpoints.slice(1)) commit(cand);
          if (res.ok) {
            ok = true;
            break;
          }
          const at = res.trace.length - 1;
          const stopped = queue[at] as Step<Cand>;
          let approved: Cand | undefined;
          if (res.stopReason === "exhausted" && pol.personOnExhaustion === true) {
            approved = (res.held ?? []).find((h) => approves(h.candidate))?.candidate;
          } else if (res.stopReason === "review" && res.pending !== undefined) {
            if (approves(res.pending.candidate)) approved = res.pending.candidate;
            else {
              const left =
                (stopped.maxAttempts ?? 3) - (summarizeChain(res).steps[at]?.proposals ?? 0);
              if (left > 0) {
                state = res.state;
                queue = [{ ...stopped, maxAttempts: left }, ...queue.slice(at + 1)];
                continue;
              }
            }
          }
          if (approved === undefined) break;
          commit(approved);
          state = approved;
          queue = queue.slice(at + 1);
          if (queue.length === 0) {
            ok = true;
            break;
          }
        }
        if (ok) completed++;
        if (ok && !wrongCommit) allRight++;
      }
      wrongShare.push(commits ? 1 - right / commits : 0);
      rows.push([
        pol.label,
        pct(completed / N),
        pct(commits ? right / commits : 0, 2),
        pct(allRight / N),
        fmt(secondCalls / N, 2),
        fmt(reviews / N, 2),
      ]);
    }
    table(
      [
        "policy",
        "chain completes",
        "commit precision",
        "completes, every commit right",
        "second-opinion calls per chain",
        "person reviews per chain",
      ],
      rows,
    );
    const [resample, , , , release] = wrongShare as [number, number, number, number, number];
    note(
      `Releasing on the second opinion trades the primary's catch rate for the second's: ${pct(release, 2)} of its commits were wrong against ${pct(resample, 2)} resampling alone, ${fmt(release / resample, 0)} times as many (about forty in the research's 20,000-chain run; the resampling baseline has few wrong commits to count). Ordering the queue releases nothing: the person still decides, and seeing the likeliest candidate first, reviews fewer for the same completion.`,
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
anytimeTables();
barTables();
poolingTables();
labelTables();

note(
  "Takeaways: independence and calibration are the two properties that make 80% compound; verification is what makes chains survive; the ledger is where all three are measured instead of assumed.",
);
