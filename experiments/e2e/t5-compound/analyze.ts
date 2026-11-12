/**
 * Track T5 analysis: everything is read back from the run's JSONL ledgers with the engine's
 * own readers (memberCorrelation, fitThreshold, coverageAt, ece, brier, pool, gradeOf), as a
 * user would. The corpus is read only for each item's split, domain and ambiguity flag; the
 * truth comes from the labels on the rows.
 *
 *   bun experiments/e2e/t5-compound/analyze.ts <run dir>    -> <run dir>/results.md and .json
 *
 * Held-out numbers are the evaluation. Fit-split numbers are in-sample for anything fitted
 * (the cascade bars, the thresholds, the best rho) and are reported only as such.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../../../src/compound/aggregate.ts";
import {
  brier,
  coverageAt,
  ece,
  fitThreshold,
  memberCorrelation,
  type Scored,
} from "../../../src/ledger/calibration.ts";
import { describeGrade, gradeOf } from "../../../src/ledger/evidence.ts";
import { type DecisionRecord, JsonlLedger } from "../../../src/ledger/ledger.ts";
import type { Verdict } from "../../../src/types.ts";
import type { CorpusFile, CorpusItem } from "./corpus-gen.ts";
import { DOMAINS, type Domain, questionOf } from "./gates.ts";
import { bootstrap, mcnemarExact, money, num, pct, phi, quantile, table, wilson } from "./stats.ts";
import { STRATEGIES } from "./strategies.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: analyze.ts <run dir>");
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
  corpus: { file: string; hash: string };
  frozen?: { cascadeHaikuBar: number; cascadeLunaBar: number };
};
const corpus = JSON.parse(
  readFileSync(new URL(manifest.corpus.file, new URL("./", import.meta.url)), "utf8"),
) as CorpusFile;
const itemsById = new Map(corpus.items.map((i) => [i.id, i] as const));

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface Answer {
  readonly item: CorpusItem;
  readonly rec: DecisionRecord;
  readonly correct: boolean;
  readonly confidence: number;
}

const itemOf = (r: DecisionRecord): CorpusItem | undefined =>
  itemsById.get(r.tags.find((t) => t.startsWith("item:"))?.slice(5) ?? "");

async function load(
  name: string,
): Promise<{ rows: DecisionRecord[]; byItem: Map<string, Answer> } | undefined> {
  const path = join(dir as string, `${name}.jsonl`);
  if (!existsSync(path)) return undefined;
  const rows = [...(await new JsonlLedger(path).all())];
  const byItem = new Map<string, Answer>();
  for (const rec of rows) {
    const item = itemOf(rec);
    if (!item || !rec.outcome) continue;
    // A failed-open answer is the neutral placeholder: scored as answered, it is wrong half the
    // time by construction. It is counted (as the user's ledger would show it) and flagged.
    byItem.set(item.id, { item, rec, correct: rec.outcome.correct, confidence: rec.confidence });
  }
  return { rows, byItem };
}

const ledgers = new Map<string, { rows: DecisionRecord[]; byItem: Map<string, Answer> }>();
for (const s of STRATEGIES) {
  const l = await load(s.name);
  if (l) ledgers.set(s.name, l);
}
const names = [...ledgers.keys()];
const BASE = "single-jev113";

type Slice = "held" | "fit" | "all";
const inSlice = (it: CorpusItem, s: Slice, withAmbiguous = true): boolean =>
  (s === "all" || it.split === s) && (withAmbiguous || it.ambiguous !== true);

/** Items every loaded strategy answered, so every comparison is paired. */
function commonItems(slice: Slice, withAmbiguous = true): CorpusItem[] {
  return corpus.items.filter(
    (it) =>
      inSlice(it, slice, withAmbiguous) && names.every((n) => ledgers.get(n)?.byItem.has(it.id)),
  );
}

const answersOf = (name: string, items: readonly CorpusItem[]): Answer[] =>
  items.map((it) => ledgers.get(name)?.byItem.get(it.id) as Answer);

const scored = (as: readonly Answer[]): Scored[] =>
  as.map((a) => ({ confidence: a.confidence, correct: a.correct }));

const out: string[] = [];
const json: Record<string, unknown> = {};
const h = (title: string) => out.push("", `## ${title}`, "");

// ---------------------------------------------------------------------------
// 1. Per-strategy accuracy, calibration, cost, latency, coverage at fixed precision
// ---------------------------------------------------------------------------

function summary(name: string, items: readonly CorpusItem[], fitItems: readonly CorpusItem[]) {
  const as = answersOf(name, items);
  const k = as.filter((a) => a.correct).length;
  const ci = wilson(k, as.length);
  const sc = scored(as);
  const fitSc = scored(answersOf(name, fitItems));
  const cov = (target: number, conservative: boolean) => {
    const bar = fitThreshold(fitSc, target, 20, { conservative })?.threshold;
    if (bar === undefined) return { bar: undefined, coverage: 0, precision: Number.NaN, n: 0 };
    const c = coverageAt(sc, bar);
    return { bar, coverage: c.coverage, precision: c.accuracy, n: c.n };
  };
  const lat = as.map((a) => a.rec.latencyMs);
  return {
    name,
    n: as.length,
    accuracy: k / as.length,
    ci,
    ece: ece(sc),
    brier: brier(sc),
    meanConfidence: sc.reduce((s, x) => s + x.confidence, 0) / Math.max(1, sc.length),
    cost: as.reduce((s, a) => s + a.rec.cost, 0) / Math.max(1, as.length),
    latencyMean: lat.reduce((s, x) => s + x, 0) / Math.max(1, lat.length),
    latencyP50: quantile(lat, 0.5),
    latencyP95: quantile(lat, 0.95),
    failedOpen: as.filter((a) => a.rec.failedOpen).length,
    at95: cov(0.95, false),
    at98: cov(0.98, false),
    at95c: cov(0.95, true),
    at98c: cov(0.98, true),
  };
}

const held = commonItems("held");
const heldNoAmb = commonItems("held", false);
const fit = commonItems("fit");

function covCell(c: {
  bar: number | undefined;
  coverage: number;
  precision: number;
  n: number;
}): string {
  if (c.bar === undefined) return "no bar";
  return `${pct(c.coverage)} @ ${pct(c.precision)} (bar ${num(c.bar, 2)}, n ${c.n})`;
}

function strategyTable(items: readonly CorpusItem[], title: string) {
  h(title);
  const rows = names.map((n) => summary(n, items, fit));
  json[title] = rows;
  out.push(
    table(
      [
        "strategy",
        "n",
        "accuracy (95% CI)",
        "mean conf",
        "ECE",
        "Brier",
        "cost/decision",
        "latency p50 / p95 ms",
        "fail-open",
      ],
      rows.map((r) => [
        r.name,
        String(r.n),
        `${pct(r.accuracy)} (${pct(r.ci.lo)} to ${pct(r.ci.hi)})`,
        num(r.meanConfidence),
        num(r.ece),
        num(r.brier),
        money(r.cost),
        `${Math.round(r.latencyP50)} / ${Math.round(r.latencyP95)}`,
        String(r.failedOpen),
      ]),
    ),
  );
  out.push(
    "",
    "Coverage at fixed precision: the bar is fitted on the fit split (fitThreshold, minSupport 20; point estimate, then the Wilson-conservative mode) and applied once to these items. Cells: coverage @ realised precision.",
    "",
    table(
      ["strategy", "target 0.95", "target 0.98", "0.95 conservative", "0.98 conservative"],
      rows.map((r) => [
        r.name,
        covCell(r.at95),
        covCell(r.at98),
        covCell(r.at95c),
        covCell(r.at98c),
      ]),
    ),
  );
  return rows;
}

out.push(
  `# T5 compounding results`,
  "",
  `Run: \`${dir}\``,
  "",
  `Corpus ${manifest.corpus.file} (hash ${manifest.corpus.hash.slice(0, 12)}): ${corpus.items.length} items; paired held-out n = ${held.length}, fit n = ${fit.length}.`,
);
strategyTable(held, "Held-out: every strategy on the same items");
strategyTable(heldNoAmb, "Held-out without ambiguous items");
strategyTable(fit, "Fit split (in-sample for anything fitted)");

// ---------------------------------------------------------------------------
// 2. Paired comparisons against single jev-1.13 on held-out
// ---------------------------------------------------------------------------

/** One paired comparison of strategy `a` against `base` on the same items. */
function pairOf(items: readonly CorpusItem[], a: string, baseName: string) {
  const base = answersOf(baseName, items);
  const other = answersOf(a, items);
  let b = 0;
  let c = 0;
  other.forEach((x, i) => {
    const y = base[i] as Answer;
    if (x.correct && !y.correct) b++;
    if (!x.correct && y.correct) c++;
  });
  const dAcc = (idx: readonly number[]) =>
    idx.reduce(
      (s, i) => s + ((other[i] as Answer).correct ? 1 : 0) - ((base[i] as Answer).correct ? 1 : 0),
      0,
    ) / idx.length;
  const dEce = (idx: readonly number[]) =>
    ece(scored(idx.map((i) => other[i] as Answer))) -
    ece(scored(idx.map((i) => base[i] as Answer)));
  const dBrier = (idx: readonly number[]) =>
    brier(scored(idx.map((i) => other[i] as Answer))) -
    brier(scored(idx.map((i) => base[i] as Answer)));
  const ix = items.map((_, i) => i);
  const accCi = bootstrap(items.length, dAcc);
  const eceCi = bootstrap(items.length, dEce);
  const brCi = bootstrap(items.length, dBrier);
  const p = mcnemarExact(b, c);
  const rec = {
    name: a,
    base: baseName,
    b,
    c,
    p,
    dAcc: dAcc(ix),
    accCi,
    dEce: dEce(ix),
    eceCi,
    dBrier: dBrier(ix),
    brCi,
  };
  const row = [
    baseName === BASE ? a : `${a} vs ${baseName}`,
    `${b} / ${c}`,
    num(p, 4),
    `${(100 * rec.dAcc).toFixed(1)} (${(100 * accCi.lo).toFixed(1)} to ${(100 * accCi.hi).toFixed(1)})`,
    `${num(rec.dEce)} (${num(eceCi.lo)} to ${num(eceCi.hi)})`,
    `${num(rec.dBrier)} (${num(brCi.lo)} to ${num(brCi.hi)})`,
  ];
  return { rec, row };
}

const PAIRED_HEADER = [
  "strategy",
  "b / c",
  "McNemar p",
  "delta accuracy, points",
  "delta ECE",
  "delta Brier",
];

function paired(items: readonly CorpusItem[], title: string) {
  h(title);
  if (!ledgers.has(BASE)) return;
  const results = names.filter((n) => n !== BASE).map((n) => pairOf(items, n, BASE));
  json[title] = results.map((r) => r.rec);
  out.push(
    `Each strategy against ${BASE} on the same items. Discordant pairs: b = this strategy right where ${BASE} was wrong, c = the reverse; exact McNemar p. Differences are this strategy minus ${BASE} with 95% paired bootstrap intervals (2,000 resamples, seed 17).`,
    "",
    table(
      PAIRED_HEADER,
      results.map((r) => r.row),
    ),
  );
}
paired(held, "Paired against single jev-1.13 (held-out)");
paired(heldNoAmb, "Paired against single jev-1.13 (held-out, ambiguous excluded)");

// The comparisons the claims turn on: a strategy against the cheaper or simpler thing it must beat.
h("Selected paired comparisons (held-out)");
{
  const pairs: [string, string][] = [
    ["rep3-jev113", "single-jev113"],
    ["diverse2", "single-jev114"],
    ["seq-bar", "diverse3"],
    ["seq-lead", "diverse3"],
    ["seq-lead", "seq-bar"],
    ["diverse3", "single-haiku"],
    ["cascade-haiku", "single-haiku"],
    ["cascade-haiku", "diverse3"],
    ["cascade-luna", "single-luna"],
    ["cascade-haiku", "single-luna"],
    ["cascade-haiku", "cascade-luna"],
  ];
  const results = pairs
    .filter(([x, y]) => ledgers.has(x) && ledgers.has(y))
    .map(([x, y]) => pairOf(held, x, y));
  json.selectedPairs = results.map((r) => r.rec);
  out.push(
    "Rows read 'A vs B': b = A right where B was wrong, c = the reverse; differences are A minus B.",
    "",
    table(
      PAIRED_HEADER,
      results.map((r) => r.row),
    ),
  );
}

// ---------------------------------------------------------------------------
// 3. Per-domain accuracy of every strategy on held-out
// ---------------------------------------------------------------------------

h("Held-out accuracy by domain");
{
  const rows = names.map((n) => [
    n,
    ...DOMAINS.map((d) => {
      const as = answersOf(
        n,
        held.filter((i) => i.domain === d),
      );
      const k = as.filter((a) => a.correct).length;
      return `${pct(k / Math.max(1, as.length))} (${as.length})`;
    }),
  ]);
  out.push(table(["strategy", ...DOMAINS], rows));
}

// Where the errors come from: the item's fact format (raw numbers or digested) and wording.
h("Held-out accuracy by fact format and rule wording (single models)");
{
  const keyOf = (i: CorpusItem): string => {
    if (i.domain === "entail" || i.domain === "multihop") return `${i.domain} (no numbers)`;
    const [wording, fmt] = (i.form ?? "plain").split("/");
    return `${fmt === "raw" ? "raw numbers" : fmt === "digested" ? "digested numbers" : "no numbers"}, ${wording} wording`;
  };
  const keys = [...new Set(held.map(keyOf))].sort();
  const rows = keys.map((k) => {
    const its = held.filter((i) => keyOf(i) === k);
    return [
      k,
      String(its.length),
      ...singlesFor().map((n) => {
        const as = answersOf(n, its);
        return pct(as.filter((a) => a.correct).length / Math.max(1, as.length));
      }),
    ];
  });
  out.push(table(["items", "n", ...singlesFor()], rows));
}

function singlesFor(): string[] {
  return ["single-jev113", "single-jev114", "single-haiku", "single-luna"].filter((n) =>
    ledgers.has(n),
  );
}

// Replicas: how alike three "independent" asks of one model are, and against a separate run.
h("Replicas of one model (rep3-jev113, held-out)");
{
  const l = ledgers.get("rep3-jev113");
  if (l) {
    const heldRows = l.rows.filter((r) => itemOf(r)?.split === "held");
    let allSameLead = 0;
    let allSameProb = 0;
    let spread = 0;
    let n = 0;
    let vsSingle = 0;
    let vsSingleN = 0;
    for (const r of heldRows) {
      const ms = (r.members ?? []).filter((m) => !m.failedOpen);
      if (ms.length < 2) continue;
      n++;
      const lead = ms.map((m) =>
        m.verdict.kind === "judge"
          ? String(m.verdict.pYes >= 0.5)
          : m.verdict.kind === "pick"
            ? m.verdict.choice
            : "",
      );
      const top = ms.map((m) =>
        m.verdict.kind === "judge" ? m.verdict.pYes : m.verdict.confidence,
      );
      if (new Set(lead).size === 1) allSameLead++;
      if (new Set(top.map((x) => x.toFixed(6))).size === 1) allSameProb++;
      spread += Math.max(...top) - Math.min(...top);
      const it = itemOf(r);
      const single = it ? ledgers.get(BASE)?.byItem.get(it.id) : undefined;
      if (single && ms[0]) {
        vsSingleN++;
        const a = single.rec.verdict;
        const b = ms[0].verdict;
        const same =
          a.kind === "judge" && b.kind === "judge"
            ? a.pYes >= 0.5 === b.pYes >= 0.5
            : a.kind === "pick" && b.kind === "pick"
              ? a.choice === b.choice
              : false;
        if (same) vsSingle++;
      }
    }
    json.replicas = {
      n,
      allSameLead,
      allSameProb,
      meanSpread: spread / Math.max(1, n),
      vsSingle,
      vsSingleN,
    };
    out.push(
      `On ${n} held-out rows: all replicas gave the same leading answer on ${allSameLead} (${pct(allSameLead / Math.max(1, n))}) and exactly the same probability on ${allSameProb} (${pct(allSameProb / Math.max(1, n))}); mean max-min spread of the leading probability ${num(spread / Math.max(1, n), 4)}. Replica 1 matched the separate single-jev113 run's leading answer on ${vsSingle} of ${vsSingleN} (${pct(vsSingle / Math.max(1, vsSingleN))}). Judge replicas are identical requests (shuffleOptions only reorders pick options).`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Error correlation between the single models (all items), and member correlation as the
//    engine measures it from each compound ledger
// ---------------------------------------------------------------------------

h("Error correlation between single models (phi of correctness, held-out)");
const singles = ["single-jev113", "single-jev114", "single-haiku", "single-luna"].filter((n) =>
  ledgers.has(n),
);
const singlePhi: Record<string, unknown> = {};
{
  const rows: string[][] = [];
  for (const [i, a] of singles.entries()) {
    for (const b of singles.slice(i + 1)) {
      const A = answersOf(a, held);
      const B = answersOf(b, held);
      const pairs = A.map((x, k) => [x.correct, (B[k] as Answer).correct] as const);
      const p = phi(pairs);
      const aWrong = pairs.filter(([x]) => !x).length;
      const bothWrong = pairs.filter(([x, y]) => !x && !y).length;
      const bWrong = pairs.filter(([, y]) => !y).length;
      singlePhi[`${a}|${b}`] = { phi: p, n: pairs.length, aWrong, bWrong, bothWrong };
      rows.push([
        `${a} vs ${b}`,
        String(pairs.length),
        p === undefined ? "undefined" : num(p),
        `${aWrong} / ${bWrong} / ${bothWrong}`,
        pct(bothWrong / Math.max(1, aWrong)),
        pct(bWrong / Math.max(1, pairs.length)),
      ]);
    }
  }
  json.singlePhi = singlePhi;
  out.push(
    table(
      ["pair", "n", "phi", "A wrong / B wrong / both", "P(B wrong | A wrong)", "P(B wrong)"],
      rows,
    ),
  );
}

h("memberCorrelation from each compound ledger (engine reader, judge rows only)");
const measuredRho: Record<string, number | undefined> = {};
{
  const rows: string[][] = [];
  for (const n of names) {
    const l = ledgers.get(n);
    if (!l?.rows.some((r) => r.members !== undefined)) continue;
    const fitRows = l.rows.filter((r) => itemOf(r)?.split === "fit");
    const heldRows = l.rows.filter((r) => itemOf(r)?.split === "held");
    const mcFit = memberCorrelation(fitRows);
    const mcHeld = memberCorrelation(heldRows);
    const mcPick = memberCorrelation(l.rows.filter((r) => r.gateId === "t5.multihop"));
    measuredRho[n] = mcFit.mean;
    const pairsText = (m: typeof mcFit) =>
      m.pairs
        .map(
          (p) =>
            `${p.keys.join("~")} ${p.correlation === undefined ? "none" : num(p.correlation, 2)} (n ${p.n})`,
        )
        .join("; ") || "none";
    rows.push([
      n,
      `${mcFit.mean === undefined ? "absent" : num(mcFit.mean)} (rows ${mcFit.n})`,
      pairsText(mcFit),
      `${mcHeld.mean === undefined ? "absent" : num(mcHeld.mean)} (rows ${mcHeld.n})`,
      `${mcPick.mean === undefined ? "absent" : num(mcPick.mean)} (rows ${mcPick.n})`,
    ]);
  }
  json.measuredRho = measuredRho;
  out.push(
    "Fit-split value is the rho a user would feed back into pooling. The multihop gate is a pick question; its column shows what memberCorrelation returns for pick rows.",
    "",
    table(
      ["ledger", "mean phi, fit", "pairs, fit", "mean phi, held", "multihop (pick) rows"],
      rows,
    ),
  );
}

// Pick-question member phi, computed here because the engine's reader skips pick rows.
h("Member phi on the pick gate (track-computed; memberCorrelation skips pick rows)");
{
  const rows: string[][] = [];
  for (const n of names) {
    const l = ledgers.get(n);
    if (!l?.rows.some((r) => r.members !== undefined)) continue;
    const pickRows = l.rows.filter((r) => r.gateId === "t5.multihop" && r.outcome);
    const keys = [...new Set(pickRows.flatMap((r) => (r.members ?? []).map((m) => m.key)))].sort();
    const cells: string[] = [];
    for (const [i, a] of keys.entries()) {
      for (const b of keys.slice(i + 1)) {
        const pairs: [boolean, boolean][] = [];
        for (const r of pickRows) {
          const ma = r.members?.find((m) => m.key === a);
          const mb = r.members?.find((m) => m.key === b);
          if (!ma || !mb || ma.failedOpen || mb.failedOpen) continue;
          if (ma.verdict.kind !== "pick" || mb.verdict.kind !== "pick") continue;
          const t = r.outcome?.truth;
          pairs.push([ma.verdict.choice === t, mb.verdict.choice === t]);
        }
        const p = phi(pairs);
        cells.push(`${a}~${b} ${p === undefined ? "undefined" : num(p, 2)} (n ${pairs.length})`);
      }
    }
    rows.push([n, cells.join("; ") || "none"]);
  }
  out.push(table(["ledger", "pairs"], rows));
}

// ---------------------------------------------------------------------------
// 5. Re-pooling with rho = 0, 0.75, measured (fit), best-fit (fit) on held-out
// ---------------------------------------------------------------------------

function pTrue(v: Verdict, truth: boolean | string): number {
  if (v.kind === "judge") return truth === true ? v.pYes : 1 - v.pYes;
  if (v.kind === "pick") return v.probabilities[String(truth)] ?? 0;
  return 0;
}

function leadRight(v: Verdict, truth: boolean | string): boolean {
  if (v.kind === "judge") return v.pYes >= 0.5 === truth;
  if (v.kind === "pick") return v.choice === truth;
  return false;
}

function repool(rec: DecisionRecord, rho: number): Verdict | undefined {
  const live = (rec.members ?? []).filter((m) => !m.failedOpen);
  if (live.length === 0) return undefined;
  const d = rec.gateId.replace("t5.", "") as Domain;
  return pool(
    questionOf(d),
    live.map((m) => m.verdict),
    { correlation: rho },
  );
}

h("Re-pooling ensemble members at different correlations (held-out)");
{
  const ens = ["rep3-jev113", "framing3-jev113", "diverse2", "diverse3"].filter((n) =>
    ledgers.has(n),
  );
  const rows: string[][] = [];
  const recs: unknown[] = [];
  for (const n of ens) {
    const l = ledgers.get(n);
    if (!l) continue;
    const fitAns = answersOf(n, fit);
    const heldAns = answersOf(n, held);
    const nll = (as: readonly Answer[], rho: number) =>
      as.reduce((s, a) => {
        const v = repool(a.rec, rho);
        const p = v ? Math.min(1 - 1e-6, Math.max(1e-6, pTrue(v, a.item.truth))) : 0.5;
        return s - Math.log(p);
      }, 0) / Math.max(1, as.length);
    let bestRho = 0;
    let bestNll = Number.POSITIVE_INFINITY;
    for (let k = 0; k <= 20; k++) {
      const rho = k / 20;
      const v = nll(fitAns, rho);
      if (v < bestNll - 1e-12) {
        bestNll = v;
        bestRho = rho;
      }
    }
    const measured = measuredRho[n];
    const variants: [string, number][] = [
      ["rho 0", 0],
      ["rho 0.75", 0.75],
      ...(measured !== undefined
        ? ([[`measured ${num(measured, 2)}`, Math.max(0, Math.min(1, measured))]] as [
            string,
            number,
          ][])
        : []),
      [`best-fit ${num(bestRho, 2)}`, bestRho],
    ];
    const at0 = heldAns.map((a) => repool(a.rec, 0));
    for (const [label, rho] of variants) {
      const sc: Scored[] = [];
      let winnersChanged = 0;
      heldAns.forEach((a, i) => {
        const v = repool(a.rec, rho);
        if (!v) return;
        const v0 = at0[i];
        if (v0 && leadRight(v, a.item.truth) !== leadRight(v0, a.item.truth)) winnersChanged++;
        sc.push({ confidence: v.confidence, correct: leadRight(v, a.item.truth) });
      });
      const k = sc.filter((s) => s.correct).length;
      const r = {
        ledger: n,
        variant: label,
        rho,
        n: sc.length,
        accuracy: k / sc.length,
        ece: ece(sc),
        brier: brier(sc),
        nll: nll(heldAns, rho),
        winnersChanged,
      };
      recs.push(r);
      rows.push([
        n,
        label,
        pct(r.accuracy),
        num(r.ece),
        num(r.brier),
        num(r.nll),
        String(winnersChanged),
      ]);
    }
  }
  json.repool = recs;
  out.push(
    "Each held-out ensemble row's member verdicts pooled again in log-odds at a stated correlation (pool(), design effect). 'measured' is memberCorrelation on the fit split; 'best-fit' minimises log loss on the fit split over a 0.05 grid (in-sample on fit, evaluated here on held-out). Winners changed counts items whose leading answer differs from the rho-0 pool.",
    "",
    table(["ensemble", "pooling", "accuracy", "ECE", "Brier", "log loss", "winners changed"], rows),
  );
}

// ---------------------------------------------------------------------------
// 6. Cascades
// ---------------------------------------------------------------------------

h("Cascades: what the upper tier did on the items it was given (held-out)");
{
  const rows: string[][] = [];
  const recs: unknown[] = [];
  for (const [n, upperSingle] of [
    ["cascade-haiku", "single-haiku"],
    ["cascade-luna", "single-luna"],
  ] as const) {
    const l = ledgers.get(n);
    if (!l) continue;
    const as = answersOf(n, held);
    const esc = as.filter((a) => (a.rec.members?.length ?? 0) > 1);
    const t1Right = esc.filter((a) => {
      const m = a.rec.members?.[0];
      return m ? leadRight(m.verdict, a.item.truth) : false;
    }).length;
    const t2Right = esc.filter((a) => {
      const m = a.rec.members?.[1];
      return m && !m.failedOpen ? leadRight(m.verdict, a.item.truth) : false;
    }).length;
    const mcEsc = memberCorrelation(l.rows.filter((r) => itemOf(r)?.split === "held"));
    const j = answersOf("single-jev113", held);
    const u = ledgers.has(upperSingle) ? answersOf(upperSingle, held) : [];
    const allPairs = u.length
      ? j.map((x, i) => [x.correct, (u[i] as Answer).correct] as const)
      : [];
    const phiAll = phi(allPairs);
    const escIds = new Set(esc.map((a) => a.item.id));
    const phiEscSingles = phi(allPairs.filter((_, i) => escIds.has((held[i] as CorpusItem).id)));
    const accCascade = as.filter((a) => a.correct).length / as.length;
    const r = {
      cascade: n,
      bar:
        n === "cascade-haiku" ? manifest.frozen?.cascadeHaikuBar : manifest.frozen?.cascadeLunaBar,
      escalated: esc.length,
      escalationRate: esc.length / as.length,
      tier1OnEscalated: t1Right / Math.max(1, esc.length),
      tier2OnEscalated: t2Right / Math.max(1, esc.length),
      upperOverall: u.length ? u.filter((a) => a.correct).length / u.length : Number.NaN,
      cascadeAccuracy: accCascade,
      phiFromCascadeLedger: mcEsc.mean,
      phiCascadeRows: mcEsc.n,
      phiAllItemsFromSingles: phiAll,
      phiEscalatedFromSingles: phiEscSingles,
    };
    recs.push(r);
    rows.push([
      n,
      num(r.bar ?? Number.NaN, 3),
      `${esc.length} (${pct(r.escalationRate)})`,
      `${pct(r.tier1OnEscalated)} / ${pct(r.tier2OnEscalated)}`,
      pct(r.upperOverall),
      pct(accCascade),
      `${r.phiFromCascadeLedger === undefined ? "absent" : num(r.phiFromCascadeLedger)} (escalated rows only)`,
      `${phiAll === undefined ? "undefined" : num(phiAll)} all / ${phiEscSingles === undefined ? "undefined" : num(phiEscSingles)} escalated`,
    ]);
  }
  json.cascades = recs;
  out.push(
    "Tier accuracy is on the escalated items only. 'phi, cascade ledger' is memberCorrelation over the cascade's held-out rows, which pairs the tiers only where both answered, i.e. on items chosen by tier 1's low confidence. The singles column measures the same pair from the single-model ledgers, on all held-out items and on the escalated subset.",
    "",
    table(
      [
        "cascade",
        "tier-1 bar",
        "escalated",
        "tier 1 / tier 2 right on escalated",
        "upper tier alone, all items",
        "cascade accuracy",
        "phi, cascade ledger",
        "phi, singles",
      ],
      rows,
    ),
  );
}

h("Cascade bar sweep from the single ledgers (held-out, no new calls)");
{
  const rows: string[][] = [];
  for (const upper of ["single-haiku", "single-luna"]) {
    if (!ledgers.has(upper)) continue;
    const j = answersOf("single-jev113", held);
    const u = answersOf(upper, held);
    for (const bar of [0.5, 0.7, 0.8, 0.9, 0.95, 0.99, 1.01]) {
      let right = 0;
      let up = 0;
      j.forEach((a, i) => {
        if (a.confidence >= bar) right += a.correct ? 1 : 0;
        else {
          up++;
          right += (u[i] as Answer).correct ? 1 : 0;
        }
      });
      rows.push([
        upper.replace("single-", ""),
        num(bar, 2),
        pct(up / j.length),
        pct(right / j.length),
      ]);
    }
  }
  out.push(table(["upper tier", "tier-1 bar", "escalated", "cascade accuracy"], rows));
}

// ---------------------------------------------------------------------------
// 7. Sequential
// ---------------------------------------------------------------------------

h("Sequential: samples used against accuracy (held-out)");
{
  const rows: string[][] = [];
  const recs: unknown[] = [];
  for (const n of ["seq-bar", "seq-lead", "diverse3", "single-jev113"]) {
    if (!ledgers.has(n)) continue;
    const as = answersOf(n, held);
    const samples = as.map((a) =>
      typeof a.rec.detail?.samples === "number"
        ? (a.rec.detail.samples as number)
        : (a.rec.members?.length ?? 1),
    );
    const dist = [1, 2, 3].map((k) => samples.filter((s) => s === k).length);
    const settled = as.filter((a) => a.rec.detail?.settled === true).length;
    const acc = as.filter((a) => a.correct).length / as.length;
    const meanS = samples.reduce((s, x) => s + x, 0) / samples.length;
    const cost = as.reduce((s, a) => s + a.rec.cost, 0) / as.length;
    const haikuCalls = as.reduce(
      (s, a) => s + (a.rec.members ?? []).filter((m) => m.key.startsWith("haiku")).length,
      0,
    );
    recs.push({ name: n, meanSamples: meanS, dist, settled, accuracy: acc, cost, haikuCalls });
    rows.push([
      n,
      num(meanS, 2),
      dist.join(" / "),
      String(settled),
      pct(acc),
      money(cost),
      String(haikuCalls),
    ]);
  }
  json.sequential = recs;
  out.push(
    table(
      [
        "strategy",
        "mean samples",
        "1 / 2 / 3 samples",
        "settled",
        "accuracy",
        "cost/decision",
        "haiku calls",
      ],
      rows,
    ),
  );
}

// ---------------------------------------------------------------------------
// 8. Disagreement as a label-free bound
// ---------------------------------------------------------------------------

h("Disagreement as a label-free error bound (held-out)");
{
  const rows: string[][] = [];
  const recs: unknown[] = [];
  const sentences: string[] = [];
  const pairsFrom: [string, string, string][] = [
    ["diverse2", "jev113", "jev114"],
    ["diverse3", "jev113", "jev114"],
    ["diverse3", "jev113", "haiku55"],
    ["diverse3", "jev114", "haiku55"],
  ];
  for (const [n, ka, kb] of pairsFrom) {
    const l = ledgers.get(n);
    if (!l) continue;
    const heldRows = l.rows.filter((r) => itemOf(r)?.split === "held");
    let pairs = 0;
    let disagree = 0;
    let aWrong = 0;
    let bWrong = 0;
    let both = 0;
    let pooledWrong = 0;
    const models = new Set<string>();
    for (const r of heldRows) {
      const it = itemOf(r);
      const ma = r.members?.find((m) => m.key === ka);
      const mb = r.members?.find((m) => m.key === kb);
      if (!it || !ma || !mb || ma.failedOpen || mb.failedOpen) continue;
      pairs++;
      if (ma.model) models.add(`a:${ma.model}`);
      if (mb.model) models.add(`b:${mb.model}`);
      const la = leadRight(ma.verdict, it.truth);
      const lb = leadRight(mb.verdict, it.truth);
      const sameLead =
        ma.verdict.kind === "judge" && mb.verdict.kind === "judge"
          ? ma.verdict.pYes >= 0.5 === mb.verdict.pYes >= 0.5
          : ma.verdict.kind === "pick" && mb.verdict.kind === "pick"
            ? ma.verdict.choice === mb.verdict.choice
            : false;
      if (!sameLead) disagree++;
      if (!la) aWrong++;
      if (!lb) bWrong++;
      if (!la && !lb) both++;
      if (r.outcome && !r.outcome.correct) pooledWrong++;
    }
    const d = disagree / Math.max(1, pairs);
    const union = (aWrong + bWrong - both) / Math.max(1, pairs);
    const ea = aWrong / Math.max(1, pairs);
    const eb = bWrong / Math.max(1, pairs);
    const ci = wilson(disagree, pairs);
    const modelA = [...models].find((m) => m.startsWith("a:"))?.slice(2) ?? ka;
    const modelB = [...models].find((m) => m.startsWith("b:"))?.slice(2) ?? kb;
    const unlabelled = heldRows.map((r) => {
      const { outcome: _drop, ...rest } = r;
      return rest as DecisionRecord;
    });
    let sentence = "";
    try {
      const g = gradeOf(unlabelled, {
        borrowed: { type: "disagreement", rate: d, pairs, models: [modelA, modelB] },
        borrowedAt: heldRows[heldRows.length - 1]?.at ?? new Date().toISOString(),
      });
      sentence = describeGrade(g);
    } catch (e) {
      sentence = `gradeOf threw: ${(e as Error).message}`;
    }
    sentences.push(`- ${n} ${ka} vs ${kb}: "${sentence}"`);
    const r = {
      ledger: n,
      a: ka,
      b: kb,
      models: [modelA, modelB],
      pairs,
      disagree: d,
      ci,
      errA: ea,
      errB: eb,
      errUnion: union,
      bothWrong: both / Math.max(1, pairs),
      pooledErr: pooledWrong / Math.max(1, pairs),
    };
    recs.push(r);
    rows.push([
      `${n}: ${ka} vs ${kb}`,
      String(pairs),
      `${pct(d)} (${pct(ci.lo)} to ${pct(ci.hi)})`,
      `${pct(ea)} / ${pct(eb)}`,
      pct(union),
      pct(both / Math.max(1, pairs)),
      pct(r.pooledErr),
      `${num(d / Math.max(1e-9, union), 2)} / ${num(d / Math.max(1e-9, ea), 2)}`,
    ]);
  }
  // Three judges, label-free: under conditional independence of errors, agreement rates
  // identify each judge's error (s_i = 1 - 2 e_i, 2 a_ij - 1 = s_i s_j).
  const l3 = ledgers.get("diverse3");
  const est: string[] = [];
  if (l3) {
    const keys = ["jev113", "jev114", "haiku55"] as const;
    const heldRows = l3.rows.filter((r) => itemOf(r)?.split === "held");
    const lead = (r: DecisionRecord, k: string): string | undefined => {
      const m = r.members?.find((x) => x.key === k);
      if (!m || m.failedOpen) return undefined;
      return m.verdict.kind === "judge"
        ? String(m.verdict.pYes >= 0.5)
        : m.verdict.kind === "pick"
          ? m.verdict.choice
          : undefined;
    };
    const agree = (a: string, b: string) => {
      let n = 0;
      let s = 0;
      for (const r of heldRows) {
        const x = lead(r, a);
        const y = lead(r, b);
        if (x === undefined || y === undefined || r.gateId === "t5.multihop") continue;
        n++;
        if (x === y) s++;
      }
      return s / Math.max(1, n);
    };
    const [k0, k1, k2] = keys;
    const c01 = 2 * agree(k0, k1) - 1;
    const c02 = 2 * agree(k0, k2) - 1;
    const c12 = 2 * agree(k1, k2) - 1;
    const s = {
      [k0]: Math.sqrt(Math.max(0, (c01 * c02) / c12)),
      [k1]: Math.sqrt(Math.max(0, (c01 * c12) / c02)),
      [k2]: Math.sqrt(Math.max(0, (c02 * c12) / c01)),
    } as Record<string, number>;
    for (const k of keys) {
      const judgeRows = heldRows.filter((r) => r.gateId !== "t5.multihop");
      let wrong = 0;
      let n = 0;
      for (const r of judgeRows) {
        const it = itemOf(r);
        const m = r.members?.find((x) => x.key === k);
        if (!it || !m || m.failedOpen) continue;
        n++;
        if (!leadRight(m.verdict, it.truth)) wrong++;
      }
      est.push(
        `${k}: label-free ${pct((1 - (s[k] ?? 0)) / 2)} vs true ${pct(wrong / Math.max(1, n))} (judge rows, n ${n})`,
      );
    }
  }
  json.disagreement = recs;
  out.push(
    "Disagreement d is the share of paired rows whose two leading answers differ. On each such row exactly one of a yes/no pair is wrong, so d is a lower bound on the share of rows where at least one judge is wrong (the union). It is not a bound on either judge's own error, nor on the pooled verdict's. Last column: d / union error and d / judge-A error.",
    "",
    table(
      [
        "pair",
        "pairs",
        "disagreement (95% CI)",
        "error A / B",
        "union error",
        "both wrong",
        "pooled verdict error",
        "d / union, d / err A",
      ],
      rows,
    ),
    "",
    "What `describeGrade` prints for the same evidence on the unlabelled rows:",
    "",
    ...sentences,
    "",
    "Three-judge agreement estimate (conditional-independence assumption, judge gates only):",
    "",
    ...est.map((e) => `- ${e}`),
  );
}

// ---------------------------------------------------------------------------

writeFileSync(join(dir, "results.md"), `${out.join("\n")}\n`);
writeFileSync(join(dir, "results.json"), `${JSON.stringify(json, null, 2)}\n`);
process.stdout.write(`${out.join("\n")}\n`);
