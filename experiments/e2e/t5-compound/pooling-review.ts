/**
 * T5 follow-up, two questions on the same real rows.
 *
 * 1. Does the fitted pool (`fitted-pool.ts`: within-class logit correlation shrunk toward the
 *    family prior, member strengths, centres, the prior offset) beat the pool the engine ships
 *    (generalised least squares on `memberCorrelation`'s phi matrix)? It did not, so it is not
 *    shipped; this keeps that result reproducible. Only `PoolOptions.priorYes` shipped.
 * 2. On the act side, the scale a gate's bar is set on, does "two keys" (act only when the most
 *    cautious member would) make fewer wrong acts than one model, the pooled log-odds and the
 *    cascade at comparable coverage?
 *
 * Reads the diverse3 ledger (jev-1.13, jev-1.14 and haiku-5.5 asked every item) and the recorded
 * cascade, fits on the fit split and scores the held-out split of the four judge gates once.
 * Offline: no network, no API key, no calls. The ledgers are untrusted data, read as JSON only
 * by `JsonlLedger`.
 *
 *   bun experiments/e2e/t5-compound/pooling-review.ts <run dir>
 *
 * The run directory is gitignored; the evaluated one is
 * experiments/out/e2e/t5-compound/2026-11-12T10-35-57-202Z-main-live.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { exactLowerBound } from "../../../src/acceptance.ts";
import { type PoolOptions, poolJudge, poolWeights } from "../../../src/compound/aggregate.ts";
import {
  brier,
  coverageAt,
  ece,
  fitThreshold,
  inferGoIsYes,
  memberCorrelation,
  type Scored,
} from "../../../src/ledger/calibration.ts";
import {
  allWrongCeiling,
  panelCeiling,
  panelFromLedger,
  withinClassCorrelation,
} from "../../../src/ledger/dependence.ts";
import { type DecisionRecord, JsonlLedger } from "../../../src/ledger/ledger.ts";
import { logit } from "../../../src/math.ts";
import type { JudgeVerdict } from "../../../src/types.ts";
import { fitPool, pooledYes } from "./fitted-pool.ts";
import { bootstrap, mcnemarExact, num, pct, table } from "./stats.ts";

const dir = process.argv[2];
const need = ["diverse3.jsonl", "cascade-haiku.jsonl"];
if (dir === undefined || !existsSync(dir) || !statSync(dir).isDirectory()) {
  process.stderr.write(
    `usage: bun experiments/e2e/t5-compound/pooling-review.ts <run dir>\n${
      dir === undefined ? "No run directory given." : `No directory at ${dir}.`
    } The T5 runs live under experiments/out/e2e/t5-compound/ (gitignored), so a fresh clone has none.\n`,
  );
  process.exit(1);
}
const missing = need.filter((f) => !existsSync(join(dir, f)));
if (missing.length > 0) {
  process.stderr.write(`${dir} has no ${missing.join(" or ")}: not a T5 main run directory.\n`);
  process.exit(1);
}

const KEYS = ["jev113", "jev114", "haiku55"] as const;
const tagged = (r: DecisionRecord, prefix: string) =>
  r.tags.find((t) => t.startsWith(prefix))?.slice(prefix.length);
const load = async (name: string) => [...(await new JsonlLedger(join(dir, name)).all())];

/** A labelled judge row on which every panel member answered. */
interface Item {
  readonly id: string;
  readonly truth: boolean;
  readonly members: readonly JudgeVerdict[];
}

function items(rows: readonly DecisionRecord[], split: string): Item[] {
  return rows.flatMap((r): Item[] => {
    const truth = r.outcome?.truth;
    if (tagged(r, "split:") !== split || typeof truth !== "boolean") return [];
    if (r.verdict.kind !== "judge" || r.failedOpen) return [];
    const ms = KEYS.map((k) => r.members?.find((m) => m.key === k && m.failedOpen !== true));
    if (ms.some((m) => m === undefined || m.verdict.kind !== "judge")) return [];
    const id = tagged(r, "item:") ?? r.id;
    return [{ id, truth, members: ms.map((m) => m?.verdict as JudgeVerdict) }];
  });
}

const diverse = await load("diverse3.jsonl");
const judgeRows = diverse.filter((r) => r.verdict.kind === "judge");
const fitRows = judgeRows.filter((r) => tagged(r, "split:") === "fit");
const fit = items(diverse, "fit");
const held = items(diverse, "held");

// The fitted pool, on the fit split's judge rows only; its keys are KEYS, in order.
const sample = panelFromLedger(fitRows, { keys: [...KEYS] });
const panel = fitPool(sample);
const prior = panel.baseRate ?? 0.5;
const fitted =
  (form: "weights" | "prior" | "full"): Method =>
  (it) =>
    pooledYes(
      panel,
      it.members.map((m) => logit(m.pYes)),
      form,
    );
// The shipped estimator, as a user would read it from the same rows.
const mc = memberCorrelation(fitRows);
const shipped: PoolOptions = { correlations: mc.matrix ?? {}, memberKeys: [...KEYS] };

const cascadeRows = await load("cascade-haiku.jsonl");
const cascadeByItem = new Map<string, number>();
for (const r of cascadeRows) {
  const id = tagged(r, "item:");
  if (id !== undefined && r.verdict.kind === "judge" && !r.failedOpen) {
    cascadeByItem.set(id, r.verdict.pYes);
  }
}

type Method = (it: Item) => number | undefined;
const pooled =
  (o: PoolOptions): Method =>
  (it) =>
    poolJudge(it.members, o).pYes;
const methods: readonly (readonly [string, Method])[] = [
  ["jev-1.13 alone", (it) => it.members[0]?.pYes],
  ["jev-1.14 alone", (it) => it.members[1]?.pYes],
  ["haiku-5.5 alone", (it) => it.members[2]?.pYes],
  ["log-odds, rho 0 (engine default for these members)", pooled({ correlation: 0 })],
  ["log-odds, rho 0, priorYes", pooled({ correlation: 0, priorYes: prior })],
  ["shipped matrix (phi, GLS)", pooled(shipped)],
  ["shipped matrix, priorYes", pooled({ ...shipped, priorYes: prior })],
  ["fitted weights, no offset", fitted("weights")],
  ["fitted weights, priorYes", fitted("prior")],
  ["full fit (weights, centres, priorYes)", fitted("full")],
  ["two keys (most cautious member)", (it) => Math.min(...it.members.map((m) => m.pYes))],
  ["recorded cascade jev-1.13 then haiku-5.5", (it) => cascadeByItem.get(it.id)],
];

interface Scores {
  readonly n: number;
  readonly right: readonly boolean[];
  readonly logLoss: readonly number[];
  readonly scored: readonly Scored[];
}

function score(its: readonly Item[], m: Method): Scores {
  const right: boolean[] = [];
  const logLoss: number[] = [];
  const scored: Scored[] = [];
  for (const it of its) {
    const p = m(it);
    if (p === undefined) continue;
    const ok = p >= 0.5 === it.truth;
    right.push(ok);
    const pt = Math.min(1 - 1e-6, Math.max(1e-6, it.truth ? p : 1 - p));
    logLoss.push(-Math.log(pt));
    scored.push({ confidence: Math.max(p, 1 - p), correct: ok });
  }
  return { n: right.length, right, logLoss, scored };
}

const avg = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);

function coverage(fitScored: readonly Scored[], heldScored: readonly Scored[], target: number) {
  const bar = fitThreshold(fitScored, target, 20)?.threshold;
  if (bar === undefined) return "no bar";
  const c = coverageAt(heldScored, bar);
  const missed = c.n > 0 && c.accuracy < target ? ", missed" : "";
  return `${pct(c.coverage)} at ${pct(c.accuracy)} (bar ${num(bar, 2)}${missed})`;
}

const results = methods.map(([name, m]) => ({ name, held: score(held, m), fit: score(fit, m) }));
const out: string[] = [];
out.push(
  "# Pooling review: T5 judge gates, fitted on the fit split, scored once on held-out",
  "",
  `Run \`${dir}\`. Judge gates (contract, eligibility, policy, entail); rows where jev-1.13, jev-1.14 and haiku-5.5 all answered: fit ${fit.length}, held-out ${held.length}. Bars: \`fitThreshold(fit rows, target, 20)\` on the leading answer's confidence, applied once to held-out; cells are coverage at realised precision.`,
  "",
  table(
    [
      "pool",
      "n",
      "accuracy",
      "mean conf",
      "log loss",
      "Brier",
      "ECE",
      "target 0.95",
      "target 0.98",
    ],
    results.map((r) => [
      r.name,
      String(r.held.n),
      pct(r.held.right.filter(Boolean).length / Math.max(1, r.held.n)),
      num(avg(r.held.scored.map((s) => s.confidence))),
      num(avg(r.held.logLoss)),
      num(brier(r.held.scored)),
      num(ece(r.held.scored)),
      coverage(r.fit.scored, r.held.scored, 0.95),
      coverage(r.fit.scored, r.held.scored, 0.98),
    ]),
  ),
);

/** Paired: log loss difference A - B with a percentile bootstrap, and McNemar on accuracy. */
function paired(a: string, b: string): string[] {
  const x = results.find((r) => r.name === a)?.held;
  const y = results.find((r) => r.name === b)?.held;
  if (!x || !y || x.n !== y.n) return [a, b, "not paired", "", ""];
  const d = x.logLoss.map((v, i) => v - (y.logLoss[i] ?? 0));
  const ci = bootstrap(d.length, (idx) => avg(idx.map((i) => d[i] ?? 0)));
  let fixed = 0;
  let broken = 0;
  x.right.forEach((ok, i) => {
    if (ok && !y.right[i]) fixed++;
    if (!ok && y.right[i]) broken++;
  });
  return [
    a,
    b,
    `${num(avg(d))} (${num(ci.lo)} to ${num(ci.hi)})`,
    `${fixed} / ${broken}`,
    num(mcnemarExact(fixed, broken), 2),
  ];
}
out.push(
  "",
  "Paired on the same held-out items: log loss A minus B (negative favours A) with a 95% percentile bootstrap (2,000 resamples, seed 17), and items A got right that B did not / the reverse, with an exact McNemar p.",
  "",
  table(
    ["A", "B", "log loss A - B (95% CI)", "A fixed / broken", "McNemar p"],
    [
      paired("full fit (weights, centres, priorYes)", "shipped matrix (phi, GLS)"),
      paired("fitted weights, priorYes", "shipped matrix (phi, GLS)"),
      paired("shipped matrix, priorYes", "shipped matrix (phi, GLS)"),
      paired("full fit (weights, centres, priorYes)", "fitted weights, priorYes"),
      paired("full fit (weights, centres, priorYes)", "recorded cascade jev-1.13 then haiku-5.5"),
      paired("shipped matrix (phi, GLS)", "recorded cascade jev-1.13 then haiku-5.5"),
    ],
  ),
);

// What each estimator read from the fit split.
const g = poolWeights(KEYS.length, shipped).weights;
out.push(
  "",
  "## What was fitted",
  "",
  `Base rate of yes on the fit split: ${num(prior)} (add-one smoothed, ${panel.rows} rows, read from ${sample.fittedFrom ?? "no"} rows); strengths ${panel.strength}.`,
  "",
  table(
    ["member", "fitted weight", "centre", "gap", "variance (measured)", "shipped GLS weight"],
    KEYS.map((k, i) => {
      const s = panel.strengths[i];
      return [
        k,
        num(panel.weights[i] ?? Number.NaN),
        num(panel.centres?.[i] ?? Number.NaN),
        num(s?.gap ?? Number.NaN),
        num(s?.variance ?? Number.NaN),
        num(g[i] ?? Number.NaN),
      ];
    }),
  ),
  "",
  table(
    ["pair", "phi (shipped)", "within-class r", "family prior", "shrunk r used", "n"],
    panel.pairs.map((p) => {
      const phi = mc.pairs.find((m) => m.keys.includes(p.keys[0]) && m.keys.includes(p.keys[1]));
      return [
        p.keys.join(" ~ "),
        phi?.correlation === undefined ? "none" : num(phi.correlation),
        p.estimate === undefined ? "none" : num(p.estimate),
        num(p.prior, 2),
        num(p.correlation),
        String(p.n),
      ];
    }),
  ),
);

// Post hoc: read after the table above, on the same held-out rows, so diagnosis, not evidence.
// Every member's gap exceeds its variance, so the floor (variance at least the gap) reads each
// as at most calibrated. The research's script clamped after the solve instead, unfloored.
const strengths = panel.strengths;
const rUsed = (a: string, b: string) =>
  Math.min(
    0.99,
    Math.max(
      0,
      panel.pairs.find((p) => p.keys.includes(a) && p.keys.includes(b))?.correlation ?? 0,
    ),
  );
const sigma = KEYS.map((a, i) =>
  KEYS.map((b, j) =>
    i === j
      ? (strengths[i]?.variance ?? 1)
      : rUsed(a, b) * Math.sqrt((strengths[i]?.variance ?? 1) * (strengths[j]?.variance ?? 1)),
  ),
);
const gap = strengths.map((s) => s?.gap ?? 0);
const m = sigma.map((row, i) => [...row, gap[i] ?? 0]);
for (let c = 0; c < m.length; c++) {
  for (let r = 0; r < m.length; r++) {
    if (r === c) continue;
    const f = (m[r]?.[c] ?? 0) / (m[c]?.[c] ?? 1);
    for (let k = c; k <= m.length; k++) {
      (m[r] as number[])[k] = (m[r]?.[k] ?? 0) - f * (m[c]?.[k] ?? 0);
    }
  }
}
const raw = m.map((row, i) => (row[m.length] ?? 0) / (row[i] ?? 1));
const unfloored = score(
  held,
  pooled({ weights: raw.map((w) => Math.min(1, Math.max(0, w))), correlation: 0 }),
);
const bothRight = (a: number, b: number) =>
  sample.rows.filter((row) => {
    const x = row.logits[a];
    const y = row.logits[b];
    return x !== undefined && y !== undefined && x >= 0 === row.truth && y >= 0 === row.truth;
  });
const rightR = (a: number, b: number) =>
  withinClassCorrelation(
    bothRight(a, b).map((row) => ({
      truth: row.truth,
      a: row.logits[a] ?? 0,
      b: row.logits[b] ?? 0,
    })),
  ).correlation;
out.push(
  "",
  "## Post hoc diagnosis (read after the table above, on the same held-out rows: not evidence)",
  "",
  `- Each member's gap exceeds its within-class variance (${KEYS.map((k, i) => `${k} ${num(gap[i] ?? 0, 2)} against ${num(strengths[i]?.variance ?? Number.NaN, 2)}`).join("; ")}), so the variance floor reads every member as at most calibrated, and the full fit's mean confidence sits below its accuracy.`,
  `- The research script's form, the same correlations and strengths without the floor, clamped to [0, 1] after the solve: raw weights ${raw.map((w) => num(w, 2)).join(", ")}; held-out accuracy ${pct(unfloored.right.filter(Boolean).length / Math.max(1, unfloored.n))}, mean confidence ${num(avg(unfloored.scored.map((s) => s.confidence)))}, log loss ${num(avg(unfloored.logLoss))}, Brier ${num(brier(unfloored.scored))}, ECE ${num(ece(unfloored.scored))}.`,
  `- The cross-family within-class correlation is shared confidence, not shared error: on fit rows where both members were right it is ${num(rightR(0, 2) ?? Number.NaN, 2)} (jev-1.13 ~ haiku-5.5) and ${num(rightR(1, 2) ?? Number.NaN, 2)} (jev-1.14 ~ haiku-5.5), while phi of their correctness is ${KEYS.slice(
    0,
    2,
  )
    .map((k) => {
      const p = mc.pairs.find((x) => x.keys.includes(k) && x.keys.includes("haiku55"));
      return num(p?.correlation ?? Number.NaN, 2);
    })
    .join(" and ")}.`,
);

// The unanimity ceiling.
const heldSample = panelFromLedger(
  judgeRows.filter((r) => tagged(r, "split:") === "held"),
  { keys: [...KEYS] },
);
const ceilingCell = (c: ReturnType<typeof allWrongCeiling>) =>
  `${c.allWrong} of ${c.n} all wrong: ceiling ${pct(c.ceiling)} (exact 95% ${pct(c.lower)} to ${pct(c.upper)})`;
const ceilings: string[][] = [
  ["jev-1.13, jev-1.14, haiku-5.5 (diverse3 members)", ceilingCell(panelCeiling(heldSample))],
  [
    "jev-1.13, haiku-5.5 (diverse3 members)",
    ceilingCell(
      panelCeiling(
        panelFromLedger(
          judgeRows.filter((r) => tagged(r, "split:") === "held"),
          { keys: ["jev113", "haiku55"] },
        ),
      ),
    ),
  ],
];
// The research note's figure: the single-model ledgers, every held-out item (pick gate too).
if (existsSync(join(dir, "single-jev113.jsonl")) && existsSync(join(dir, "single-haiku.jsonl"))) {
  const byItem = async (name: string) => {
    const m = new Map<string, boolean>();
    for (const r of await load(name)) {
      const id = tagged(r, "item:");
      if (id !== undefined && tagged(r, "split:") === "held" && r.outcome && !r.failedOpen) {
        m.set(id, r.outcome.correct);
      }
    }
    return m;
  };
  const jev = await byItem("single-jev113.jsonl");
  const haiku = await byItem("single-haiku.jsonl");
  const rows = [...jev].flatMap(([id, a]) => {
    const b = haiku.get(id);
    return b === undefined ? [] : [[a, b]];
  });
  ceilings.push([
    "jev-1.13, haiku-5.5 (single ledgers, every held-out item)",
    ceilingCell(allWrongCeiling(rows)),
  ]);
}
out.push(
  "",
  "## The unanimity ceiling",
  "",
  "No combiner that follows a unanimous panel can be right where every member is wrong.",
  "",
  table(["panel (held-out)", "ceiling"], ceilings),
);

// The act side: the probability that acting is right, against whether it was, which is the
// scale a gate's bar is set on. "Two keys" is asymmetric (cautious on the go side, its lean
// pessimistic), so the leading-answer table above says little about it.
const side = inferGoIsYes(judgeRows);
const goIsYes = side.goIsYes;
const goOf = (p: number) => (goIsYes ? p : 1 - p);
const leansGo = (p: number) => (goIsYes ? p >= 0.5 : p < 0.5);
type Go = (it: Item) => number | undefined;
const goPooled =
  (o: PoolOptions): Go =>
  (it) =>
    goOf(poolJudge(it.members, o).pYes);
const member = (it: Item, i: number) => (it.members[i] as JudgeVerdict).pYes;
const keysHeld =
  (idx: readonly number[]): Go =>
  (it) =>
    Math.min(...idx.map((i) => goOf(member(it, i))));
const actStrategies: readonly (readonly [string, Go])[] = [
  ["jev-1.13 alone", (it) => goOf(member(it, 0))],
  ["haiku-5.5 alone", (it) => goOf(member(it, 2))],
  ["log-odds, rho 0", goPooled({ correlation: 0 })],
  ["shipped matrix (phi, GLS)", goPooled(shipped)],
  ["two keys: jev-1.13 and haiku-5.5", keysHeld([0, 2])],
  ["two keys: all three members", keysHeld([0, 1, 2])],
  [
    "unanimous lean: all three members",
    (it) =>
      it.members.every((m) => leansGo(m.pYes))
        ? Math.min(...it.members.map((m) => goOf(m.pYes)))
        : 0,
  ],
  [
    "recorded cascade jev-1.13 then haiku-5.5",
    (it) => {
      const p = cascadeByItem.get(it.id);
      return p === undefined ? undefined : goOf(p);
    },
  ],
];
const actScored = (its: readonly Item[], g: Go): Scored[] =>
  its.flatMap((it) => {
    const go = g(it);
    return go === undefined ? [] : [{ confidence: go, correct: it.truth === goIsYes }];
  });
/** Held-out acts at a bar: share acted, wrong acts, precision and its exact one-sided 95% bound. */
function actCell(sc: readonly Scored[], bar: number | undefined, showBar: boolean): string {
  if (bar === undefined) return "no bar";
  const acted = sc.filter((s) => s.confidence >= bar);
  const right = acted.filter((s) => s.correct).length;
  const lead = showBar ? `bar ${num(bar, 2)}: ` : "";
  if (acted.length === 0) return `${lead}no acts`;
  return `${lead}${pct(acted.length / sc.length)} acted (${acted.length}), ${acted.length - right} wrong, ${pct(right / acted.length)} (lower ${pct(exactLowerBound(right, acted.length, 0.95))})`;
}
const acts = actStrategies.map(([name, g]) => ({
  name,
  fit: actScored(fit, g),
  held: actScored(held, g),
}));
const fitted95 = (sc: readonly Scored[], target: number, conservative: boolean) =>
  fitThreshold(sc, target, 20, { conservative })?.threshold;
const goItems = held.filter((it) => it.truth === goIsYes).length;
out.push(
  "",
  "## The act side",
  "",
  `The T5 judge gates act on yes: the policy is \`{ actAbove: 0.95 }\` with no \`goIsYes\` (main.ts), and the rows' own \`go\` says the same (\`inferGoIsYes\` over ${side.evidence} judge rows: go is ${goIsYes ? "yes" : "no"}). Each strategy's go probability is p(yes) for one member or pool; "two keys" is the smaller go of the members named; "unanimous lean" acts only when every member leans go, at the smallest go, else never. Acting is right when the truth is the go side: ${goItems} of ${held.length} held-out items, so ${pct(goItems / held.length)} is the most any strategy can act on without a wrong act. Cells: share of held-out items acted on (count), wrong acts, act precision and its exact one-sided 95% lower bound (\`exactLowerBound\`).`,
  "",
  "Bars fitted on the fit split with `fitThreshold(act-side rows, target, 20)`, point estimate and conservative (Wilson) mode, applied once to held-out:",
  "",
  table(
    ["strategy", "target 0.95", "0.95 conservative", "target 0.98", "0.98 conservative"],
    acts.map((a) => [
      a.name,
      actCell(a.held, fitted95(a.fit, 0.95, false), true),
      actCell(a.held, fitted95(a.fit, 0.95, true), true),
      actCell(a.held, fitted95(a.fit, 0.98, false), true),
      actCell(a.held, fitted95(a.fit, 0.98, true), true),
    ]),
  ),
  "",
  "Fixed bars, no fitting noise:",
  "",
  table(
    ["strategy", "bar 0.7", "bar 0.8", "bar 0.9"],
    acts.map((a) => [
      a.name,
      actCell(a.held, 0.7, false),
      actCell(a.held, 0.8, false),
      actCell(a.held, 0.9, false),
    ]),
  ),
);
process.stdout.write(`${out.join("\n")}\n`);
