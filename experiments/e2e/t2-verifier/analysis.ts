/**
 * Read the run back from its ledgers and the corpus, and compute every table in the report.
 * Nothing here calls an oracle; nothing here reads a model answer to decide a label.
 */
import { poolJudge } from "../../../src/compound/aggregate.ts";
import { type LogisticModel, predictLogistic } from "../../../src/compound/learned.ts";
import { Engine } from "../../../src/engine.ts";
import {
  brier,
  ece,
  type Scored as LibScored,
  memberCorrelation,
  reliability,
  scoredFromLedger,
} from "../../../src/ledger/calibration.ts";
import { type DecisionRecord, decisionRows, JsonlLedger } from "../../../src/ledger/ledger.ts";
import type { JudgeVerdict, Oracle } from "../../../src/types.ts";
import { CHAIN, type ChainLog, predict } from "./chain.ts";
import {
  type Ctx,
  features,
  holisticSpec,
  joinRows,
  memberVerdicts,
  pointsOf,
  readLedger,
  type Scored,
} from "./harness.ts";
import { GATES, memberId } from "./questions.ts";
import {
  type ActStats,
  actAt,
  auc,
  clusterBootstrap,
  coverageAtPrecision,
  exact,
  fmtRate,
  type Point,
  pairedDiff,
  pct,
  type Rate,
  rate,
} from "./stats.ts";
import { CORRECT_STYLES, ERROR_TYPES, type Item, MEMBERS } from "./types.ts";

export interface Frozen {
  readonly target: number;
  readonly productBar?: number;
  readonly productFittedFrom?: string;
  readonly productReport: unknown;
  readonly oneSidedBar?: number;
  readonly chainBar: number;
  readonly chainBarSource: string;
  readonly correlation: number;
  readonly correlationSource: string;
  readonly learned: LogisticModel;
  readonly batteryBars: Readonly<Record<string, number | undefined>>;
}

const fmt = (x: number, d = 3): string => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const ci = (lo: number, hi: number, d = 3): string => `[${fmt(lo, d)}, ${fmt(hi, d)}]`;
const table = (head: readonly string[], rows: readonly (readonly (string | number)[])[]): string =>
  [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");

function hashMaps(items: readonly Item[], renderHash: (it: Item, raw: boolean) => string) {
  const digested = new Map<string, { id: string; cluster: string; truth: boolean }>();
  const raw = new Map<string, { id: string; cluster: string; truth: boolean }>();
  for (const it of items) {
    digested.set(renderHash(it, false), { id: it.id, cluster: it.instance, truth: it.truth });
    if (it.domain === "convert")
      raw.set(renderHash(it, true), { id: it.id, cluster: it.instance, truth: it.truth });
  }
  return { digested, raw };
}

/** Two-sided calibration, the engine's convention: the leading answer's confidence and correctness. */
function twoSided(scored: readonly Scored[]): {
  ece: number;
  brier: number;
  n: number;
  labelMismatch: number;
} {
  const rows = scored.map((s) => s.row);
  const lib = scoredFromLedger(rows);
  const mismatch = scored.filter(
    (s) => typeof s.row.outcome?.truth === "boolean" && s.row.outcome.truth !== s.truth,
  ).length;
  return { ece: ece(lib), brier: brier(lib), n: lib.length, labelMismatch: mismatch };
}

/** One-sided calibration of p(pass) itself, which is what an act bar on a judge reads. */
function oneSided(points: readonly Point[]) {
  const items: LibScored[] = points.map((x) => ({ confidence: x.p, correct: x.truth }));
  return { ece: ece(items), brier: brier(items), bins: reliability(items, 10) };
}

const leanAccuracy = (points: readonly Point[]): Rate =>
  rate(points.filter((x) => x.p >= 0.5 === x.truth).length, points.length);

const aucCi = (points: readonly Point[]) => ({
  auc: auc(points),
  ...clusterBootstrap(points, auc),
});

function actRow(label: string, s: ActStats): (string | number)[] {
  return [
    label,
    fmt(s.bar),
    fmtRate(s.coverage),
    fmtRate(s.precision),
    fmtRate(s.catchRate),
    fmtRate(s.falseAlarm),
  ];
}

export interface Analysis {
  readonly json: Record<string, unknown>;
  readonly md: string;
}

export async function analyze(
  ctx: Ctx,
  items: readonly Item[],
  renderHash: (it: Item, raw: boolean) => string,
  frozen: Frozen,
  chains: readonly ChainLog[],
): Promise<Analysis> {
  const byId = new Map(items.map((it) => [it.id, it]));
  const { digested, raw } = hashMaps(items, renderHash);
  const md: string[] = [];
  const json: Record<string, unknown> = {};
  const bar = frozen.chainBar;

  // ------------------------------------------------------------------ verifier calibration
  md.push("## 1. The holistic verifier gate", "");
  const splitRows: Record<string, { scored: Scored[]; failedOpen: number; unmatched: number }> = {};
  const calib: (string | number)[][] = [];
  for (const split of ["fit", "heldout", "challenge"] as const) {
    const rows = await readLedger(ctx, `${split}-holistic`);
    const j = joinRows(rows, GATES.holistic, digested);
    splitRows[split] = j;
    const pts = pointsOf(j.scored);
    const two = twoSided(j.scored);
    const one = oneSided(pts);
    const a = aucCi(pts);
    calib.push([
      split,
      pts.length,
      j.failedOpen,
      fmtRate(leanAccuracy(pts)),
      `${fmt(a.auc)} ${ci(a.lo, a.hi)}`,
      fmt(two.ece),
      fmt(two.brier),
      fmt(one.ece),
      fmt(one.brier),
      two.labelMismatch,
    ]);
    json[`calibration.${split}`] = {
      n: pts.length,
      failedOpen: j.failedOpen,
      unmatched: j.unmatched,
      lean: leanAccuracy(pts),
      auc: a,
      twoSided: two,
      oneSided: one,
    };
  }
  md.push(
    "Lean accuracy is p(pass) >= 0.5 against the label. Two-sided ECE/Brier use the engine's convention (the leading answer's confidence); one-sided ECE/Brier score p(pass) itself against the truth, which is what an act bar reads. AUC intervals are a cluster bootstrap over task instances.",
    "",
    table(
      [
        "split",
        "n",
        "failed open",
        "lean accuracy",
        "AUC [95% CI]",
        "ECE 2-sided",
        "Brier 2-sided",
        "ECE p(pass)",
        "Brier p(pass)",
        "ledger label != corpus",
      ],
      calib,
    ),
    "",
  );
  const heldPts = pointsOf(splitRows.heldout?.scored ?? []);
  const chalPts = pointsOf(splitRows.challenge?.scored ?? []);
  const fitPts = pointsOf(splitRows.fit?.scored ?? []);
  const bins = oneSided(heldPts).bins.filter((b) => b.n > 0);
  md.push(
    "Reliability of p(pass) on held-out (equal-width bins):",
    "",
    table(
      ["bin", "n", "mean p(pass)", "observed pass rate [95% CI]"],
      bins.map((b) => [
        `${fmt(b.lo, 1)}-${fmt(b.hi, 1)}`,
        b.n,
        fmt(b.meanConfidence),
        fmtRate(rate(Math.round(b.accuracy * b.n), b.n)),
      ]),
    ),
    "",
  );

  // ------------------------------------------------------------------ bars
  md.push("### Frozen bars on each split", "");
  const barRows: (string | number)[][] = [];
  const bars: [string, number | undefined][] = [
    ["product path: report().fitted.threshold (two-sided)", frozen.productBar],
    ["one-sided precision bar (chain bar)", frozen.oneSidedBar],
  ];
  for (const [label, b] of bars) {
    if (b === undefined) {
      barRows.push([label, "none", "", "", "", ""]);
      continue;
    }
    for (const [split, pts] of [
      ["fit", fitPts],
      ["heldout", heldPts],
      ["challenge", chalPts],
    ] as const) {
      barRows.push(actRow(`${label}, ${split}`, actAt(pts, b)));
    }
  }
  md.push(
    `Target ${pct(frozen.target, 0)} precision of committed outputs. Coverage is the share of all candidates committed; precision the share of committed ones that were correct; catch rate t the share of wrong candidates not committed; false alarm f the share of correct candidates not committed.`,
    "",
    table(["bar", "value", "coverage", "precision", "catch rate t", "false alarm f"], barRows),
    "",
  );
  // What the two-sided bar promises versus what acting on it delivers.
  if (frozen.productBar !== undefined) {
    const pb = frozen.productBar;
    const rowsH = splitRows.heldout?.scored ?? [];
    const above = rowsH.filter((s) => s.row.confidence >= pb);
    const leadRight = above.filter(
      (s) => (s.row.verdict as JudgeVerdict).pYes >= 0.5 === s.truth,
    ).length;
    const acts = rowsH.filter((s) => (s.row.verdict as JudgeVerdict).pYes >= pb);
    const actRight = acts.filter((s) => s.truth).length;
    const noSide = above.filter((s) => (s.row.verdict as JudgeVerdict).pYes < 0.5);
    json.productBarPromise = {
      bar: pb,
      twoSidedAccuracy: rate(leadRight, above.length),
      actPrecision: rate(actRight, acts.length),
      confidentNo: noSide.length,
      confidentNoRight: noSide.filter((s) => !s.truth).length,
    };
    md.push(
      `The report's bar is fitted on the leading answer's confidence (max(p, 1-p)). On held-out, rows with confidence >= ${fmt(pb)} had leading-answer accuracy ${fmtRate(rate(leadRight, above.length))}, which is the promise the report makes; acting on p(pass) >= ${fmt(pb)}, which is how the bar is used as \`actAbove\`, committed outputs that were correct ${fmtRate(rate(actRight, acts.length))} of the time. ${noSide.length} of the rows above the bar were confident "no" answers, which count toward the report's accuracy but are never acts.`,
      "",
    );
  }

  // ------------------------------------------------------------------ per error type
  md.push("### Which errors does the verifier miss? (held-out, at the chain bar)", "");
  const heldItems = (splitRows.heldout?.scored ?? []).map((s) => ({
    s,
    it: byId.get(s.id) as Item,
  }));
  const typeRows: (string | number)[][] = [];
  const perType: Record<string, unknown> = {};
  for (const t of ERROR_TYPES) {
    const xs = heldItems.filter((x) => x.it.variant === t);
    const caught = xs.filter((x) => (x.s.row.verdict as JudgeVerdict).pYes < bar).length;
    const leanNo = xs.filter((x) => (x.s.row.verdict as JudgeVerdict).pYes < 0.5).length;
    const meanP =
      xs.reduce((s, x) => s + (x.s.row.verdict as JudgeVerdict).pYes, 0) / Math.max(1, xs.length);
    perType[t] = { caught: exact(caught, xs.length), leanNo: exact(leanNo, xs.length), meanP };
    typeRows.push([
      t,
      xs.length,
      fmtRate(exact(caught, xs.length)),
      fmtRate(exact(leanNo, xs.length)),
      fmt(meanP),
    ]);
  }
  for (const st of CORRECT_STYLES) {
    const xs = heldItems.filter((x) => x.it.variant === st);
    const alarm = xs.filter((x) => (x.s.row.verdict as JudgeVerdict).pYes < bar).length;
    const leanNo = xs.filter((x) => (x.s.row.verdict as JudgeVerdict).pYes < 0.5).length;
    const meanP =
      xs.reduce((s, x) => s + (x.s.row.verdict as JudgeVerdict).pYes, 0) / Math.max(1, xs.length);
    perType[`correct:${st}`] = {
      held: exact(alarm, xs.length),
      leanNo: exact(leanNo, xs.length),
      meanP,
    };
    typeRows.push([
      `correct (${st}): held back = false alarm`,
      xs.length,
      fmtRate(exact(alarm, xs.length)),
      fmtRate(exact(leanNo, xs.length)),
      fmt(meanP),
    ]);
  }
  json.perType = perType;
  md.push(
    `Exact (Clopper-Pearson) 95% intervals. "Not committed at bar" is the catch rate for error rows and the false-alarm rate for correct rows; "lean no" is p(pass) < 0.5.`,
    "",
    table(
      ["variant", "n", `not committed at bar ${fmt(bar)}`, "lean no", "mean p(pass)"],
      typeRows,
    ),
    "",
  );
  const famRows: (string | number)[][] = [];
  for (const fam of [...new Set(heldItems.map((x) => x.it.family))]) {
    const pts = heldPts.filter((_, i) => heldItems[i]?.it.family === fam);
    const s = actAt(pts, bar);
    const a = auc(pts);
    famRows.push([
      fam,
      pts.length,
      fmt(a),
      fmtRate(s.catchRate),
      fmtRate(s.falseAlarm),
      fmtRate(leanAccuracy(pts)),
    ]);
  }
  md.push(
    "Per family (held-out):",
    "",
    table(["family", "n", "AUC", "catch rate t", "false alarm f", "lean accuracy"], famRows),
    "",
  );

  // ------------------------------------------------------------------ challenge
  const chal = (splitRows.challenge?.scored ?? []).map((s) => ({ s, it: byId.get(s.id) as Item }));
  const injected = chal.filter((x) => x.it.injected);
  const plainErr = chal.filter((x) => !x.it.truth && !x.it.injected);
  const caughtOf = (xs: typeof chal) =>
    exact(xs.filter((x) => (x.s.row.verdict as JudgeVerdict).pYes < bar).length, xs.length);
  json.challenge = { injectedCaught: caughtOf(injected), otherErrorsCaught: caughtOf(plainErr) };
  md.push(
    "### Challenge split",
    "",
    `Wrong candidates carrying a planted "approve it" note were held back ${fmtRate(caughtOf(injected))}; wrong candidates without one ${fmtRate(caughtOf(plainErr))} (the two groups differ in error type mix; read as indicative).`,
    "",
  );

  // ------------------------------------------------------------------ digest effect
  md.push("### Digesting numbers in code (conversion domain, same candidates two ways)", "");
  const digestRows: (string | number)[][] = [];
  const digestJson: Record<string, unknown> = {};
  for (const split of ["fit", "heldout", "challenge"] as const) {
    const rawRows = await readLedger(ctx, `${split}-raw`);
    const rj = joinRows(rawRows, GATES.raw, raw);
    const rawById = new Map(rj.scored.map((s) => [s.id, s]));
    const dig = (splitRows[split]?.scored ?? []).filter((s) => rawById.has(s.id));
    const rawPaired = dig.map((s) => rawById.get(s.id) as Scored);
    const dp = pointsOf(dig);
    const rp = pointsOf(rawPaired);
    const numErr = (sc: readonly Scored[]) =>
      sc.filter((s) =>
        ["wrong_number", "unit_slip", "format_violation"].includes(
          (byId.get(s.id) as Item).variant,
        ),
      );
    const caughtNum = (sc: readonly Scored[]) => {
      const xs = numErr(sc);
      return exact(xs.filter((s) => (s.row.verdict as JudgeVerdict).pYes < bar).length, xs.length);
    };
    digestJson[split] = {
      digested: { lean: leanAccuracy(dp), auc: auc(dp), numericCaught: caughtNum(dig) },
      raw: { lean: leanAccuracy(rp), auc: auc(rp), numericCaught: caughtNum(rawPaired) },
    };
    digestRows.push([
      split,
      dp.length,
      fmtRate(leanAccuracy(dp)),
      fmtRate(leanAccuracy(rp)),
      fmt(auc(dp)),
      fmt(auc(rp)),
      fmtRate(caughtNum(dig)),
      fmtRate(caughtNum(rawPaired)),
    ]);
  }
  json.digest = digestJson;
  md.push(
    table(
      [
        "split",
        "n pairs",
        "lean acc digested",
        "lean acc raw",
        "AUC digested",
        "AUC raw",
        "numeric errors caught, digested",
        "numeric errors caught, raw",
      ],
      digestRows,
    ),
    "",
  );

  // ------------------------------------------------------------------ decomposition
  md.push("## 2. Decomposition: holistic vs battery vs AND vs learned (held-out)", "");
  const bRows = await readLedger(ctx, "heldout-battery");
  const members = memberVerdicts(bRows, GATES.battery);
  const combined = decisionRows(bRows).filter((r) => r.gateId === GATES.battery && !r.failedOpen);
  const corrRows = decisionRows(await readLedger(ctx, "heldout-battery-corr")).filter(
    (r) => r.gateId === GATES.batteryCorr && !r.failedOpen,
  );
  const learnRows = decisionRows(await readLedger(ctx, "heldout-battery-learned")).filter(
    (r) => r.gateId === GATES.batteryLearned && !r.failedOpen,
  );
  const pOfHash = (rows: readonly DecisionRecord[]) =>
    new Map(rows.map((r) => [r.stateHash, (r.verdict as JudgeVerdict).pYes]));
  const corrBy = pOfHash(corrRows);
  const learnBy = pOfHash(learnRows);
  const holBy = new Map(
    (splitRows.heldout?.scored ?? []).map((s) => [
      s.row.stateHash,
      (s.row.verdict as JudgeVerdict).pYes,
    ]),
  );
  interface Joint {
    readonly id: string;
    readonly cluster: string;
    readonly truth: boolean;
    readonly item: Item;
    readonly vs: JudgeVerdict[];
    readonly engineLogodds: number;
    readonly holistic: number;
    readonly engineCorr?: number;
    readonly engineLearned?: number;
  }
  const joint: Joint[] = [];
  for (const r of combined) {
    const it = digested.get(r.stateHash);
    const vs = members.get(r.requestId);
    const h = holBy.get(r.stateHash);
    if (!it || !vs || h === undefined) continue;
    const ec = corrBy.get(r.stateHash);
    const el = learnBy.get(r.stateHash);
    joint.push({
      id: it.id,
      cluster: it.cluster,
      truth: it.truth,
      item: byId.get(it.id) as Item,
      vs,
      engineLogodds: (r.verdict as JudgeVerdict).pYes,
      holistic: h,
      ...(ec !== undefined ? { engineCorr: ec } : {}),
      ...(el !== undefined ? { engineLearned: el } : {}),
    });
  }
  const methods: Record<string, (j: Joint) => number> = {
    "holistic (one question)": (j) => j.holistic,
    "battery, logodds (default)": (j) => poolJudge(j.vs).pYes,
    [`battery, logodds rho=${fmt(frozen.correlation, 2)}`]: (j) =>
      poolJudge(j.vs, { correlation: frozen.correlation }).pYes,
    "battery, min": (j) => poolJudge(j.vs, { method: "min" }).pYes,
    "battery, AND at 0.5": (j) => (j.vs.every((v) => v.pYes >= 0.5) ? 1 : 0),
    "battery, learned (fitLogistic)": (j) => predictLogistic(frozen.learned, features(j.vs)),
  };
  const barKey: Record<string, string> = {
    "holistic (one question)": "holistic",
    "battery, logodds (default)": "logodds",
    [`battery, logodds rho=${fmt(frozen.correlation, 2)}`]: "logodds-corr",
    "battery, min": "min",
    "battery, AND at 0.5": "and",
    "battery, learned (fitLogistic)": "learned",
  };
  const ptsBy: Record<string, Point[]> = {};
  for (const [name, f] of Object.entries(methods)) {
    ptsBy[name] = joint.map((j) => ({ p: f(j), truth: j.truth, cluster: j.cluster }));
  }
  const decRows: (string | number)[][] = [];
  const decJson: Record<string, unknown> = {};
  const hol = ptsBy["holistic (one question)"] as Point[];
  const andPts = ptsBy["battery, AND at 0.5"] as Point[];
  const cov95 = (xs: readonly Point[]) => coverageAtPrecision(xs, frozen.target);
  for (const [name, pts] of Object.entries(ptsBy)) {
    const key = barKey[name] as string;
    const b = key === "and" ? 0.5 : frozen.batteryBars[key];
    const s = b === undefined ? undefined : actAt(pts, b);
    const a = aucCi(pts);
    const c = { cov: cov95(pts), ...clusterBootstrap(pts, cov95) };
    const vsHol = name.startsWith("holistic") ? undefined : pairedDiff(pts, hol, auc);
    const vsAnd = key === "and" ? undefined : pairedDiff(pts, andPts, auc);
    decJson[name] = {
      auc: a,
      coverageAt95: c,
      bar: b,
      atBar: s,
      aucVsHolistic: vsHol,
      aucVsAnd: vsAnd,
      lean: leanAccuracy(pts),
    };
    decRows.push([
      name,
      `${fmt(a.auc)} ${ci(a.lo, a.hi)}`,
      vsHol ? `${fmt(vsHol.diff, 3)} ${ci(vsHol.lo, vsHol.hi)}` : "",
      vsAnd ? `${fmt(vsAnd.diff, 3)} ${ci(vsAnd.lo, vsAnd.hi)}` : "",
      `${pct(c.cov)} [${pct(c.lo)}, ${pct(c.hi)}]`,
      b === undefined ? "no bar reached the target on fit" : fmt(b, 4),
      s ? fmtRate(s.coverage) : "",
      s ? fmtRate(s.precision) : "",
      s ? fmtRate(s.catchRate) : "",
      s ? fmtRate(s.falseAlarm) : "",
    ]);
  }
  json.decomposition = { n: joint.length, methods: decJson };
  md.push(
    `${joint.length} held-out candidates with every member and the holistic answer present. AUC differences are paired cluster bootstraps (method minus comparator). "Best coverage at ${pct(frozen.target, 0)}" is the most any bar on held-out could commit at that precision (ranking quality, read on held-out itself); the bar columns use the bar frozen on the fit split.`,
    "",
    table(
      [
        "method",
        "AUC [95% CI]",
        "AUC vs holistic",
        "AUC vs AND",
        `best coverage at ${pct(frozen.target, 0)} precision`,
        "frozen bar",
        "coverage at bar",
        "precision at bar",
        "catch t",
        "false alarm f",
      ],
      decRows,
    ),
    "",
  );
  // engine path agreement
  const maxDiff = (f: (j: Joint) => number | undefined, g: (j: Joint) => number) => {
    let m = 0;
    let n = 0;
    for (const j of joint) {
      const a = f(j);
      if (a === undefined) continue;
      n++;
      m = Math.max(m, Math.abs(a - g(j)));
    }
    return { n, max: m };
  };
  const agreeLog = maxDiff(
    (j) => j.engineLogodds,
    (j) => poolJudge(j.vs).pYes,
  );
  const agreeCorr = maxDiff(
    (j) => j.engineCorr,
    (j) => poolJudge(j.vs, { correlation: frozen.correlation }).pYes,
  );
  const agreeLearn = maxDiff(
    (j) => j.engineLearned,
    (j) => predictLogistic(frozen.learned, features(j.vs)),
  );
  json.enginePath = { logodds: agreeLog, corr: agreeCorr, learned: agreeLearn };
  md.push(
    `Engine path check: the battery gate's combined row matches an offline \`poolJudge\` of its own member rows to ${agreeLog.max.toExponential(1)} (n=${agreeLog.n}); the correlated-pool gate (a second request) differs from the offline pool of the first request's members by at most ${fmt(agreeCorr.max, 4)} (n=${agreeCorr.n}); the learned gate by at most ${fmt(agreeLearn.max, 4)} (n=${agreeLearn.n}). The last two include run-to-run drift between two identical requests.`,
    "",
  );

  // ------------------------------------------------------------------ members
  md.push("### Battery members", "");
  const memRows: (string | number)[][] = [];
  for (const [k, m] of MEMBERS.entries()) {
    const own = joint.map((j) => ({
      p: (j.vs[k] as JudgeVerdict).pYes,
      truth: j.item.sub[m],
      cluster: j.cluster,
    }));
    const inh = joint.map((j) => ({
      p: (j.vs[k] as JudgeVerdict).pYes,
      truth: j.truth,
      cluster: j.cluster,
    }));
    const ownFalse = own.filter((x) => !x.truth);
    memRows.push([
      memberId(m),
      fmtRate(leanAccuracy(own)),
      fmt(auc(own)),
      ownFalse.length,
      fmtRate(leanAccuracy(inh)),
      fmt(auc(inh)),
    ]);
  }
  md.push(
    "Each member scored two ways: against its own sub-truth (the conjunct it asks about, fixed with the corpus) and against the battery's truth, which is what `Engine.label` writes to member rows (`inheritOutcome`).",
    "",
    table(
      [
        "member",
        "lean acc vs own sub-truth",
        "AUC own",
        "n own-false",
        "lean acc vs inherited truth",
        "AUC inherited",
      ],
      memRows,
    ),
    "",
  );
  // correlation
  const phi = (a: readonly boolean[], b: readonly boolean[]): number => {
    let n11 = 0;
    let n10 = 0;
    let n01 = 0;
    let n00 = 0;
    a.forEach((x, i) => {
      const y = b[i] as boolean;
      if (x && y) n11++;
      else if (x) n10++;
      else if (y) n01++;
      else n00++;
    });
    const d = Math.sqrt((n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00));
    return d === 0 ? Number.NaN : (n11 * n00 - n10 * n01) / d;
  };
  const corrOf = (truthOf: (j: Joint, m: (typeof MEMBERS)[number]) => boolean) => {
    const cols = MEMBERS.map((m, k) =>
      joint.map((j) => (j.vs[k] as JudgeVerdict).pYes >= 0.5 === truthOf(j, m)),
    );
    const vals: number[] = [];
    for (let i = 0; i < cols.length; i++)
      for (let k = i + 1; k < cols.length; k++)
        vals.push(phi(cols[i] as boolean[], cols[k] as boolean[]));
    const fin = vals.filter(Number.isFinite);
    return {
      mean: fin.reduce((s, x) => s + x, 0) / Math.max(1, fin.length),
      pairs: vals.length,
      defined: fin.length,
      min: Math.min(...fin),
      max: Math.max(...fin),
    };
  };
  const inheritedCorr = corrOf((j) => j.truth);
  const ownCorr = corrOf((j, m) => j.item.sub[m]);
  const lib = memberCorrelation(bRows);
  json.memberCorrelation = {
    inherited: inheritedCorr,
    own: ownCorr,
    library: { n: lib.n, pairs: lib.pairs.length, mean: lib.mean },
  };
  md.push(
    `Measured error correlation between members (mean pairwise phi of correctness, held-out): ${fmt(inheritedCorr.mean)} (range ${fmt(inheritedCorr.min)} to ${fmt(inheritedCorr.max)}) scoring members against the battery truth, ${fmt(ownCorr.mean)} (range ${fmt(ownCorr.min)} to ${fmt(ownCorr.max)}, ${ownCorr.defined} of ${ownCorr.pairs} pairs defined) against their own sub-truths. The library's \`memberCorrelation\` over the same ledger read ${lib.n} rows and ${lib.pairs.length} pairs${lib.mean === undefined ? " (no mean): battery members are rows of their own, not `members` on the combined row, so it cannot see them" : ""}. The frozen correlation for the rho pool was ${fmt(frozen.correlation)} (${frozen.correlationSource}).`,
    "",
  );

  // ------------------------------------------------------------------ chains
  md.push("## 3. The ratchet: chains through `runChain`", "");
  const heldStats = actAt(heldPts, bar);
  const t = heldStats.catchRate;
  const f = heldStats.falseAlarm;
  const chainRows: (string | number)[][] = [];
  const chainJson: Record<string, unknown> = {};
  for (const p of CHAIN.ps) {
    const ver = chains.filter((c) => c.p === p && c.mode === "verified");
    const unv = chains.filter((c) => c.p === p && c.mode === "unverified");
    const commitAttempts = ver.flatMap((c) =>
      c.steps.filter((s) => s.committed).map((s) => s.attempts.at(-1) as { truth: boolean }),
    );
    const allAttempts = ver.flatMap((c) => c.steps.flatMap((s) => s.attempts));
    const realT = rate(
      allAttempts.filter((a) => !a.truth && a.action !== "act").length,
      allAttempts.filter((a) => !a.truth).length,
    );
    const realF = rate(
      allAttempts.filter((a) => a.truth && a.action !== "act").length,
      allAttempts.filter((a) => a.truth).length,
    );
    const pred = predict(p, t.p, f.p, CHAIN.maxAttempts, CHAIN.steps);
    const predLo = predict(p, t.lo, f.hi, CHAIN.maxAttempts, CHAIN.steps);
    const predHi = predict(p, t.hi, f.lo, CHAIN.maxAttempts, CHAIN.steps);
    const predReal = predict(p, realT.p, realF.p, CHAIN.maxAttempts, CHAIN.steps);
    const stepAcc = rate(commitAttempts.filter((a) => a.truth).length, commitAttempts.length);
    const ok = rate(ver.filter((c) => c.ok).length, ver.length);
    const trulyOk = rate(ver.filter((c) => c.trulyOk).length, ver.length);
    const condTrue = rate(ver.filter((c) => c.trulyOk).length, ver.filter((c) => c.ok).length);
    const unvOk = rate(unv.filter((c) => c.trulyOk).length, unv.length);
    const steps = ver.flatMap((c) => c.steps);
    const exhaustedSteps = rate(steps.filter((s) => !s.committed).length, steps.length);
    const attemptsPerCommit =
      steps.filter((s) => s.committed).reduce((s, x) => s + x.attempts.length, 0) /
      Math.max(1, steps.filter((s) => s.committed).length);
    const violations = ver.concat(unv).flatMap((c) => c.violations);
    chainJson[`p${p}`] = {
      t,
      f,
      pred,
      predLo,
      predHi,
      realT,
      realF,
      predReal,
      stepAcc,
      ok,
      trulyOk,
      condTrue,
      unvOk,
      exhaustedSteps,
      attemptsPerCommit,
      violations,
    };
    chainRows.push(
      [
        `p=${p}: per-step committed accuracy`,
        fmt(pred.q),
        `${fmt(predLo.q)}-${fmt(predHi.q)}`,
        fmt(predReal.q),
        fmtRate(stepAcc),
      ],
      [
        `p=${p}: chain claims success (ok)`,
        fmt(pred.claimed),
        `${fmt(predLo.claimed)}-${fmt(predHi.claimed)}`,
        fmt(predReal.claimed),
        fmtRate(ok),
      ],
      [
        `p=${p}: chain truly succeeds`,
        fmt(pred.trueSuccess),
        `${fmt(predLo.trueSuccess)}-${fmt(predHi.trueSuccess)}`,
        fmt(predReal.trueSuccess),
        fmtRate(trulyOk),
      ],
      [
        `p=${p}: truly succeeds given ok (q^n)`,
        fmt(pred.trueGivenClaimed),
        `${fmt(predLo.trueGivenClaimed)}-${fmt(predHi.trueGivenClaimed)}`,
        fmt(predReal.trueGivenClaimed),
        fmtRate(condTrue),
      ],
      [`p=${p}: unverified chain succeeds (p^n)`, fmt(pred.unverified), "", "", fmtRate(unvOk)],
      [
        `p=${p}: a step exhausts its attempts`,
        fmt(1 - pred.stepCommit),
        `${fmt(1 - predHi.stepCommit)}-${fmt(1 - predLo.stepCommit)}`,
        fmt(1 - predReal.stepCommit),
        fmtRate(exhaustedSteps),
      ],
    );
    const big = chains.filter((c) => c.p === p && c.mode === "budget");
    let bigViolations = 0;
    if (big.length > 0) {
      const m = CHAIN.budgetAttempts;
      const bp = predict(p, t.p, f.p, m, CHAIN.steps);
      const bLo = predict(p, t.lo, f.hi, m, CHAIN.steps);
      const bHi = predict(p, t.hi, f.lo, m, CHAIN.steps);
      const bSteps = big.flatMap((c) => c.steps);
      const bCommit = bSteps
        .filter((s) => s.committed)
        .map((s) => s.attempts.at(-1) as { truth: boolean });
      const bAcc = rate(bCommit.filter((a) => a.truth).length, bCommit.length);
      const bOk = rate(big.filter((c) => c.ok).length, big.length);
      const bTrue = rate(big.filter((c) => c.trulyOk).length, big.length);
      const bEx = rate(bSteps.filter((s) => !s.committed).length, bSteps.length);
      bigViolations = big.flatMap((c) => c.violations).length;
      chainJson[`p${p}.budget${m}`] = { pred: bp, bLo, bHi, bAcc, bOk, bTrue, bEx, bigViolations };
      chainRows.push(
        [
          `p=${p}, ${m} attempts: per-step committed accuracy`,
          fmt(bp.q),
          `${fmt(bLo.q)}-${fmt(bHi.q)}`,
          "",
          fmtRate(bAcc),
        ],
        [
          `p=${p}, ${m} attempts: chain claims success (ok)`,
          fmt(bp.claimed),
          `${fmt(bLo.claimed)}-${fmt(bHi.claimed)}`,
          "",
          fmtRate(bOk),
        ],
        [
          `p=${p}, ${m} attempts: chain truly succeeds`,
          fmt(bp.trueSuccess),
          `${fmt(bLo.trueSuccess)}-${fmt(bHi.trueSuccess)}`,
          "",
          fmtRate(bTrue),
        ],
        [
          `p=${p}, ${m} attempts: a step exhausts its attempts`,
          fmt(1 - bp.stepCommit),
          `${fmt(1 - bHi.stepCommit)}-${fmt(1 - bLo.stepCommit)}`,
          "",
          fmtRate(bEx),
        ],
      );
    }
    md.push(
      `p=${p}: realised catch rate inside the chains ${fmtRate(realT)} and false alarm ${fmtRate(realF)} (held-out: ${fmtRate(t)}, ${fmtRate(f)}); ${fmt(attemptsPerCommit, 2)} attempts per committed step; ${violations.length + bigViolations} stop/commit violations over ${ver.length + unv.length + big.length} chains.`,
      "",
    );
  }
  md.push(
    `${CHAIN.chains} chains of ${CHAIN.steps} steps per base rate, up to ${CHAIN.maxAttempts} attempts per step (and the same chains again with up to ${CHAIN.budgetAttempts}, replaying the verdicts already bought), verified by the frozen gate at actAbove ${fmt(bar)}. "Predicted" uses t and f measured on the held-out split at that bar; the range uses their Wilson bounds; "from realised t, f" plugs in the rates the chains themselves produced (a check of the algebra under independence).`,
    "",
    table(
      ["quantity", "predicted (held-out t, f)", "range", "from realised t, f", "observed [95% CI]"],
      chainRows,
    ),
    "",
  );
  // The pre-declared second operating point: the same chains at actAbove 0.9.
  const strict = chains.filter((c) => c.mode === "strict");
  if (strict.length > 0) {
    const sb = 0.9;
    const hs = actAt(heldPts, sb);
    const sRows: (string | number)[][] = [];
    const sJson: Record<string, unknown> = {};
    for (const p of CHAIN.ps) {
      const runs = strict.filter((c) => c.p === p);
      const all = runs.flatMap((c) => c.steps.flatMap((s) => s.attempts));
      const realT = rate(
        all.filter((a) => !a.truth && a.action !== "act").length,
        all.filter((a) => !a.truth).length,
      );
      const realF = rate(
        all.filter((a) => a.truth && a.action !== "act").length,
        all.filter((a) => a.truth).length,
      );
      const pr = predict(p, hs.catchRate.p, hs.falseAlarm.p, CHAIN.maxAttempts, CHAIN.steps);
      const lo = predict(p, hs.catchRate.lo, hs.falseAlarm.hi, CHAIN.maxAttempts, CHAIN.steps);
      const hi = predict(p, hs.catchRate.hi, hs.falseAlarm.lo, CHAIN.maxAttempts, CHAIN.steps);
      const re = predict(p, realT.p, realF.p, CHAIN.maxAttempts, CHAIN.steps);
      const steps = runs.flatMap((c) => c.steps);
      const commits = steps
        .filter((s) => s.committed)
        .map((s) => s.attempts.at(-1) as { truth: boolean });
      const acc = rate(commits.filter((a) => a.truth).length, commits.length);
      const ok = rate(runs.filter((c) => c.ok).length, runs.length);
      const tru = rate(runs.filter((c) => c.trulyOk).length, runs.length);
      const ex = rate(steps.filter((s) => !s.committed).length, steps.length);
      const v = runs.flatMap((c) => c.violations).length;
      sJson[`p${p}`] = {
        t: hs.catchRate,
        f: hs.falseAlarm,
        realT,
        realF,
        pred: pr,
        lo,
        hi,
        re,
        acc,
        ok,
        tru,
        ex,
        violations: v,
      };
      sRows.push(
        [
          `p=${p}: per-step committed accuracy`,
          fmt(pr.q),
          `${fmt(lo.q)}-${fmt(hi.q)}`,
          fmt(re.q),
          fmtRate(acc),
        ],
        [
          `p=${p}: chain claims success (ok)`,
          fmt(pr.claimed),
          `${fmt(lo.claimed)}-${fmt(hi.claimed)}`,
          fmt(re.claimed),
          fmtRate(ok),
        ],
        [
          `p=${p}: chain truly succeeds`,
          fmt(pr.trueSuccess),
          `${fmt(lo.trueSuccess)}-${fmt(hi.trueSuccess)}`,
          fmt(re.trueSuccess),
          fmtRate(tru),
        ],
        [
          `p=${p}: a step exhausts its attempts`,
          fmt(1 - pr.stepCommit),
          `${fmt(1 - hi.stepCommit)}-${fmt(1 - lo.stepCommit)}`,
          fmt(1 - re.stepCommit),
          fmtRate(ex),
        ],
        [
          `p=${p}: realised t / f in the chains`,
          "",
          "",
          "",
          `${fmtRate(realT)} / ${fmtRate(realF)}; ${v} violations`,
        ],
      );
    }
    json.strictChains = { bar: sb, heldout: hs, ...sJson };
    md.push(
      `### The same chains at the pre-declared strict bar (actAbove ${sb})`,
      "",
      `Held-out at ${sb}: catch rate ${fmtRate(hs.catchRate)}, false alarm ${fmtRate(hs.falseAlarm)}. Verdicts replayed from the chain ledger; only attempts the first runs never reached were asked.`,
      "",
      table(
        [
          "quantity",
          "predicted (held-out t, f)",
          "range",
          "from realised t, f",
          "observed [95% CI]",
        ],
        sRows,
      ),
      "",
    );
  }
  const refuse = chains.filter((c) => c.mode === "refuse");
  if (refuse.length > 0) {
    const refused = refuse.filter((c) => c.stopReason === "refused");
    const sameP = chains.filter(
      (c) => c.mode === "verified" && c.p === refuse[0]?.p && c.chain < refuse.length,
    );
    json.refuse = {
      n: refuse.length,
      refused: refused.length,
      ok: rate(refuse.filter((c) => c.ok).length, refuse.length),
      okWithout: rate(sameP.filter((c) => c.ok).length, sameP.length),
      violations: refuse.flatMap((c) => c.violations),
    };
    md.push(
      `Refuse semantics: the same first ${refuse.length} chains at p=${refuse[0]?.p}, the same verdicts, but a policy with refuseBelow. ${refused.length} chains stopped on a refusal at the first confidently rejected proposal; chains completed ${fmtRate(rate(refuse.filter((c) => c.ok).length, refuse.length))} versus ${fmtRate(rate(sameP.filter((c) => c.ok).length, sameP.length))} with review-and-resample. Violations: ${refuse.flatMap((c) => c.violations).length}.`,
      "",
    );
  }
  json.chains = chainJson;

  // ------------------------------------------------------------------ chain ledger
  const chainRowsAll = await readLedger(ctx, "chain");
  const chainDec = decisionRows(chainRowsAll).filter((r) => r.gateId === GATES.chain);
  const calls = chains.reduce((s, c) => s + (c.asked ?? 0), 0);
  const tagged = chainDec.filter((r) => r.tags.some((x) => x.startsWith("chain:"))).length;
  const committedSteps = chains
    .filter((c) => c.mode === "verified")
    .reduce((s, c) => s + c.steps.filter((x) => x.committed).length, 0);
  const actions = new Map<string, number>();
  for (const r of chainDec)
    actions.set(`${r.mode}/${r.action}`, (actions.get(`${r.mode}/${r.action}`) ?? 0) + 1);
  const softAct = chainDec.filter((r) => r.soft === "act").length;
  // What learning can do with these rows: the chain gate's own report, as `ratchet report` reads it.
  const never: Oracle = {
    id: "never",
    decide: async () => {
      throw new Error("analysis reads the ledger only");
    },
  };
  const reader = new Engine({ oracle: never, ledger: new JsonlLedger(ctx.ledgerPath("chain")) });
  const chainReport = await reader
    .gate(holisticSpec(GATES.chain, { actAbove: bar }))
    .report({ targetAccuracy: frozen.target, minSupport: 20 });
  json.chainLedger = {
    rows: chainDec.length,
    calls,
    tagged,
    committedSteps,
    actions: Object.fromEntries(actions),
    softAct,
    report: chainReport,
  };
  md.push(
    `The chain gate's own report over those rows: ${chainReport.labelled} labelled, ${chainReport.unselected} counted as unselected (all are shadow rows), fitted bar ${chainReport.fitted ? fmt(chainReport.fitted.threshold) : "none"} from ${chainReport.fittedFrom ?? "-"}, grade ${chainReport.grade.kind}. The rows read as unselected shadow evidence although the chain acted on every one of them, and a retry row exists only because the attempt before it was not acted on.`,
    "",
  );
  md.push(
    "### What of a chain reaches the ledger",
    "",
    `${chainDec.length} ledger rows for ${calls} gate asks across all chain runs (replays reuse verdicts already bought and write nothing). Rows carry the chain, step and attempt only because this harness passed them as tags (${tagged} tagged). Mode/action on the rows: ${[...actions].map(([k, v]) => `${k} ${v}`).join(", ")}; ${softAct} rows recommended act. The chains committed ${committedSteps} steps, but nothing on any row says a step was committed, which attempt won, or whether the chain finished: \`runChain\` returns its trace to the caller and writes nothing.`,
    "",
  );

  return { json, md: md.join("\n") };
}
