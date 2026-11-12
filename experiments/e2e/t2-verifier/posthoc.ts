/**
 * Post-hoc analysis of a finished run, kept apart from the pre-registered analysis in
 * analysis.ts. Everything here was decided after the held-out and chain results were read, so
 * it explains results; it never refits the frozen bar or changes a label.
 *
 *   bun experiments/e2e/t2-verifier/posthoc.ts <run dir>
 *
 * 1. Where chain steps exhaust, by task family, and the prediction once each family's own
 *    false-alarm rate is used (heterogeneity) versus the pooled one (the vision's formula).
 * 2. Whether a step's attempts fail together: after one correct candidate is held back, how
 *    often is the next correct candidate in the same step held back too?
 * 3. Run-to-run drift: the same state asked twice (battery re-asks, shared chain candidates).
 * 4. Pooled-verdict calibration per combiner, and how often log-odds pooling saturates.
 * 5. Results with and without the family flagged ambiguous after the fact (corrections.json).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { poolJudge } from "../../../src/compound/aggregate.ts";
import { type LogisticModel, predictLogistic } from "../../../src/compound/learned.ts";
import { ece } from "../../../src/ledger/calibration.ts";
import { decisionRows, JsonlLedger } from "../../../src/ledger/ledger.ts";
import type { JudgeVerdict } from "../../../src/types.ts";
import { CHAIN, type ChainLog } from "./chain.ts";
import { buildCorpus, renderItem } from "./corpus.ts";
import { features, memberVerdicts } from "./harness.ts";
import { GATES } from "./questions.ts";
import { actAt, auc, fmtRate, type Point, rate } from "./stats.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: posthoc.ts <run dir>");
const read = <T>(f: string): T => JSON.parse(readFileSync(join(dir, f), "utf8")) as T;
const ledger = (name: string) => new JsonlLedger(join(dir, "ledgers", `${name}.jsonl`)).all();
const frozen = read<{ chainBar: number; correlation: number; learned: LogisticModel }>(
  "frozen.json",
);
const items = buildCorpus();
const byHash = new Map(items.map((i) => [renderItem(i).hash, i]));
const out: string[] = [];
const say = (s = ""): void => {
  out.push(s);
};

// ---------------------------------------------------------------- 1. exhaustion by family
const chains = [
  ...read<ChainLog[]>("chain-runs.json"),
  ...(() => {
    try {
      return read<ChainLog[]>("chain-runs-strict.json");
    } catch {
      return [];
    }
  })(),
];
const famOf = (id: string): string => {
  // Ids are chain.p<p>.<c>.<s>.<a>, and p itself has a dot (p0.8), so c and s are the 4th and
  // 5th fields. The family is fixed by (c + s) mod 6 over the held-out families (chain.ts).
  const [, , , cs, ss] = id.split(".");
  const c = Number(cs);
  const s = Number(ss);
  const held = [
    "json.shipping",
    "summary.incident",
    "convert.dimensions",
    "code.expiry",
    "email.warranty",
    "sql.hr",
  ];
  return held[(c + s) % held.length] as string;
};
const hol = decisionRows(await ledger("heldout-holistic")).filter(
  (r) => r.gateId === GATES.holistic,
);
const heldPts = hol.flatMap((r) => {
  const it = byHash.get(r.stateHash);
  return it
    ? [
        {
          p: (r.verdict as JudgeVerdict).pYes,
          truth: it.truth,
          cluster: it.instance,
          family: it.family,
        },
      ]
    : [];
});
say("## Post-hoc 1: where chain steps exhaust");
say();
for (const [label, mode, bar] of [
  ["chain bar, 3 attempts", "verified", frozen.chainBar],
  ["strict bar 0.9, 3 attempts", "strict", 0.9],
] as const) {
  for (const p of CHAIN.ps) {
    const runs = chains.filter((c) => c.mode === mode && c.p === p);
    if (runs.length === 0) continue;
    const byFam = new Map<string, { steps: number; exhausted: number }>();
    for (const c of runs) {
      for (const s of c.steps) {
        const fam = famOf(s.attempts[0]?.id ?? "");
        const e = byFam.get(fam) ?? { steps: 0, exhausted: 0 };
        e.steps++;
        if (!s.committed) e.exhausted++;
        byFam.set(fam, e);
      }
    }
    // Heterogeneity-aware prediction: each step's acceptance from its own family's t and f.
    const famStats = new Map<string, { t: number; f: number }>();
    for (const fam of new Set(heldPts.map((x) => x.family))) {
      const s = actAt(
        heldPts.filter((x) => x.family === fam),
        bar,
      );
      famStats.set(fam, { t: s.catchRate.p, f: s.falseAlarm.p });
    }
    const pooled = actAt(heldPts, bar);
    let predHet = 0;
    let predPool = 0;
    const m = CHAIN.maxAttempts;
    for (let c = 0; c < CHAIN.chains; c++) {
      let het = 1;
      let pool = 1;
      for (let s = 0; s < CHAIN.steps; s++) {
        const fam = famOf(`chain.p${p}.${c}.${s}.1`);
        const fs = famStats.get(fam) as { t: number; f: number };
        const a = p * (1 - fs.f) + (1 - p) * (1 - fs.t);
        het *= 1 - (1 - a) ** m;
        const ap = p * (1 - pooled.falseAlarm.p) + (1 - p) * (1 - pooled.catchRate.p);
        pool *= 1 - (1 - ap) ** m;
      }
      predHet += het / CHAIN.chains;
      predPool += pool / CHAIN.chains;
    }
    const ok = rate(runs.filter((c) => c.ok).length, runs.length);
    say(`### ${label}, p=${p}`);
    say();
    say(
      `Chain completes: observed ${fmtRate(ok)}; predicted ${predPool.toFixed(3)} with pooled t, f; ${predHet.toFixed(3)} with each family's own t, f.`,
    );
    say();
    say("| family | steps | exhausted | held-out f at this bar |");
    say("| --- | --- | --- | --- |");
    for (const [fam, e] of [...byFam].sort()) {
      say(
        `| ${fam} | ${e.steps} | ${fmtRate(rate(e.exhausted, e.steps))} | ${(famStats.get(fam)?.f ?? Number.NaN).toFixed(3)} |`,
      );
    }
    say();
  }
}

// ---------------------------------------------------------------- 2. correlated retries
say("## Post-hoc 2: do a step's correct candidates fail together?");
say();
for (const mode of ["verified", "strict"] as const) {
  const attempts = chains
    .filter((c) => c.mode === mode)
    .flatMap((c) => c.steps.map((s) => s.attempts));
  let firstHeld = 0;
  let nextHeldGivenHeld = 0;
  let nextCorrectAfterHeld = 0;
  let correctFirst = 0;
  for (const as of attempts) {
    const correct = as.filter((a) => a.truth);
    if (correct.length === 0) continue;
    correctFirst++;
    const c0 = correct[0];
    if (!c0 || c0.action === "act") continue;
    firstHeld++;
    const c1 = correct[1];
    if (!c1) continue;
    nextCorrectAfterHeld++;
    if (c1.action !== "act") nextHeldGivenHeld++;
  }
  say(
    `${mode}: the first correct candidate of a step was held back in ${fmtRate(rate(firstHeld, correctFirst))}; when it was and the step produced another correct candidate, that one was held back too in ${fmtRate(rate(nextHeldGivenHeld, nextCorrectAfterHeld))}. Independence would make the second rate equal the first.`,
  );
  say();
}

// ---------------------------------------------------------------- 3. drift
say("## Post-hoc 3: the same state asked twice");
say();
const bat = await ledger("heldout-battery");
const corrL = await ledger("heldout-battery-corr");
const learnL = await ledger("heldout-battery-learned");
const memberKey = (r: { stateHash: string; questionId: string }) =>
  `${r.stateHash}|${r.questionId}`;
const first = new Map(
  bat
    .filter((r) => r.combined !== true)
    .map((r) => [memberKey(r), (r.verdict as JudgeVerdict).pYes]),
);
for (const [name, rows] of [
  ["battery re-ask (rho gate)", corrL],
  ["battery re-ask (learned gate)", learnL],
] as const) {
  const ds: number[] = [];
  let flips = 0;
  for (const r of rows) {
    if (r.combined === true) continue;
    const a = first.get(memberKey(r));
    if (a === undefined) continue;
    const b = (r.verdict as JudgeVerdict).pYes;
    ds.push(Math.abs(a - b));
    if (a >= 0.5 !== b >= 0.5) flips++;
  }
  ds.sort((x, y) => x - y);
  const q = (u: number) => ds[Math.min(ds.length - 1, Math.floor(u * ds.length))] ?? Number.NaN;
  say(
    `${name}: ${ds.length} member answers paired with the first ask; |delta p| median ${q(0.5).toFixed(3)}, 90th percentile ${q(0.9).toFixed(3)}, 99th ${q(0.99).toFixed(3)}, max ${q(1).toFixed(3)}; ${flips} lean flips (${((100 * flips) / Math.max(1, ds.length)).toFixed(2)}%).`,
  );
  say();
}
const chainRows = decisionRows(await ledger("chain")).filter((r) => r.gateId === GATES.chain);
const byState = new Map<string, number[]>();
for (const r of chainRows)
  byState.set(r.stateHash, [...(byState.get(r.stateHash) ?? []), (r.verdict as JudgeVerdict).pYes]);
const twice = [...byState.values()].filter((v) => v.length >= 2);
const dd = twice.map((v) => Math.max(...v) - Math.min(...v)).sort((a, b) => a - b);
const flipsH = twice.filter((v) => v.some((x) => x >= 0.5) && v.some((x) => x < 0.5)).length;
say(
  `holistic question, chain candidates asked more than once: ${twice.length} states; spread median ${(dd[Math.floor(dd.length / 2)] ?? Number.NaN).toFixed(3)}, max ${(dd.at(-1) ?? Number.NaN).toFixed(3)}; ${flipsH} lean flips.`,
);
say();

// ---------------------------------------------------------------- 4. pooled calibration
say("## Post-hoc 4: calibration of the pooled battery verdicts (held-out)");
say();
const members = memberVerdicts(bat, GATES.battery);
const combined = decisionRows(bat).filter((r) => r.gateId === GATES.battery && !r.failedOpen);
const rowsJ = combined.flatMap((r) => {
  const it = byHash.get(r.stateHash);
  const vs = members.get(r.requestId);
  return it && vs ? [{ it, vs }] : [];
});
say(
  "| combiner | ECE of p(pass) | share with p(pass) > 1 - 1e-6 | share with p(pass) < 1e-6 | AUC |",
);
say("| --- | --- | --- | --- | --- |");
for (const [name, f] of [
  ["logodds (default)", (vs: JudgeVerdict[]) => poolJudge(vs).pYes],
  [
    `logodds rho=${frozen.correlation.toFixed(2)}`,
    (vs: JudgeVerdict[]) => poolJudge(vs, { correlation: frozen.correlation }).pYes,
  ],
  ["min", (vs: JudgeVerdict[]) => poolJudge(vs, { method: "min" }).pYes],
  ["mean", (vs: JudgeVerdict[]) => poolJudge(vs, { method: "mean" }).pYes],
  ["learned", (vs: JudgeVerdict[]) => predictLogistic(frozen.learned, features(vs))],
] as const) {
  const pts: Point[] = rowsJ.map(({ it, vs }) => ({
    p: f(vs),
    truth: it.truth,
    cluster: it.instance,
  }));
  const e = ece(pts.map((x) => ({ confidence: x.p, correct: x.truth })));
  const hi = pts.filter((x) => x.p > 1 - 1e-6).length / pts.length;
  const lo = pts.filter((x) => x.p < 1e-6).length / pts.length;
  say(
    `| ${name} | ${e.toFixed(3)} | ${(100 * hi).toFixed(1)}% | ${(100 * lo).toFixed(1)}% | ${auc(pts).toFixed(3)} |`,
  );
}
const holPts = heldPts.map((x) => ({ confidence: x.p, correct: x.truth }));
say(`| holistic (for reference) | ${ece(holPts).toFixed(3)} |  |  | ${auc(heldPts).toFixed(3)} |`);
say();

// ---------------------------------------------------------------- 5. without the ambiguous family
say("## Post-hoc 5: with and without the items flagged ambiguous after the fact");
say();
const corr = JSON.parse(readFileSync(new URL("./corrections.json", import.meta.url), "utf8")) as {
  postHocAmbiguity: { ids: string[] }[];
};
const flaggedIds = new Set(corr.postHocAmbiguity.flatMap((a) => a.ids));
const heldWithIds = hol.flatMap((r) => {
  const it = byHash.get(r.stateHash);
  return it
    ? [
        {
          p: (r.verdict as JudgeVerdict).pYes,
          truth: it.truth,
          cluster: it.instance,
          id: it.id,
          family: it.family,
        },
      ]
    : [];
});
for (const [label, pts] of [
  ["all held-out", heldWithIds],
  [
    `without the ${flaggedIds.size} flagged items`,
    heldWithIds.filter((x) => !flaggedIds.has(x.id)),
  ],
  [
    "without the whole email.warranty family",
    heldWithIds.filter((x) => x.family !== "email.warranty"),
  ],
] as const) {
  const s = actAt(pts, frozen.chainBar);
  say(
    `- ${label} (n=${pts.length}): AUC ${auc(pts).toFixed(3)}, lean accuracy ${fmtRate(rate(pts.filter((x) => x.p >= 0.5 === x.truth).length, pts.length))}, at the chain bar: catch ${fmtRate(s.catchRate)}, false alarm ${fmtRate(s.falseAlarm)}, precision ${fmtRate(s.precision)}.`,
  );
}
say();
console.log(out.join("\n"));
