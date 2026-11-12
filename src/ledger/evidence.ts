/**
 * The evidence grade: what kind of evidence stands behind a gate's numbers. There is one
 * producer, `gradeOf`, and every consumer (Rollout, the engine's reports, `ratchet report`,
 * `check` and `trail`) reads its result, so no two surfaces can disagree about what a gate
 * has earned.
 *
 * - measured: an exact one-sided (Clopper-Pearson) lower bound on a planned sample fixed
 *   before any of its labels was read (`acceptance.ts`). The only grade with a promise
 *   attached, and the only one that promotes a gate.
 * - estimated: a Wilson interval on labelled unselected rows of trusted sources. Those rows
 *   are read again at every look, so the interval's nominal coverage is not its real one
 *   (optional stopping). It may raise a bar, widen a band, demote or schedule a plan; it never
 *   enables act.
 * - borrowed: evidence that is not this gate's labels, supplied by the caller: a profile built
 *   from other ledgers, or the disagreement of two judges from different model families
 *   (`disagreement`), which bounds from below the share of rows on which at least one of the
 *   two is wrong, whatever their correlation; never the gate's own error. Shadow only.
 * - none: fewer rows than any grade needs, with the reason in words a person can act on.
 */

import {
  type AcceptancePlan,
  type AcceptanceResult,
  evaluateAcceptance,
  type ResolvedPlan,
} from "../acceptance.ts";
import { isUnselected, modelFamily, wilsonInterval } from "./calibration.ts";
import { type DecisionRecord, decisionRows, settledWithoutAnswer } from "./ledger.ts";
import {
  admits,
  DEFAULT_TRUST,
  type FitClass,
  isTrustClass,
  TRUSTED_SOURCES,
  type TrustFilter,
  type TrustRegistry,
  trustOf,
} from "./sources.ts";

/** Labelled rows a grade read, by the trust class of their label's source. */
export type SourceCounts = Readonly<Record<FitClass, number>>;

/**
 * The levers a gate's bar and grade are read with. One set, so `Gate.report()`,
 * `Engine.report()` and `ratchet report`, `check` and `trail` read one ledger the same way:
 * before this, the engine read a 95% promise with 20 rows of support and the CLI 98% with 30,
 * and one ledger graded measured in one and estimated in the other.
 */
export interface ReportLevers {
  /**
   * The promise: what acting above the bar must deliver, and what a planned sample is read
   * against for a measured grade (exact 95% bound, no wrong act).
   */
  readonly target: number;
  /** Labelled rows a bar needs at or above it. */
  readonly minSupport: number;
  /** Labelled unselected rows of the current configuration an estimated grade needs. */
  readonly minEstimated: number;
}

/**
 * The default levers. 98% is the promise the hook and keywork make and the stricter of the
 * two the surfaces used; 30 rows is the support a profile asks of each donor gate.
 */
export const REPORT_DEFAULTS: ReportLevers = Object.freeze({
  target: 0.98,
  minSupport: 30,
  minEstimated: 30,
});

/** What makes rows one configuration: the policy, the rubric and the caller's evidence version. */
export interface Configuration {
  readonly policyHash?: string;
  readonly questionHash: string;
  readonly evidenceVersion?: string;
}

/** The configuration a row was recorded under. */
export const configurationOf = (r: DecisionRecord): Configuration => ({
  ...(r.policyHash !== undefined ? { policyHash: r.policyHash } : {}),
  questionHash: r.questionHash,
  ...(r.evidenceVersion !== undefined ? { evidenceVersion: r.evidenceVersion } : {}),
});

const sameConfiguration = (r: DecisionRecord, c: Configuration): boolean =>
  r.policyHash === c.policyHash &&
  r.questionHash === c.questionHash &&
  r.evidenceVersion === c.evidenceVersion;

/** The request a row belongs to; a row written before request ids is a request of its own. */
const requestOf = (r: DecisionRecord): string =>
  typeof r.requestId === "string" && r.requestId !== "" ? r.requestId : r.id;

/**
 * `rows` split into the current configuration and the rest. A row is current when (a) it was
 * recorded under the newest decision row's evidence version, gate-wide; (b) its policy is one
 * the gate's newest request used (every row sharing the newest row's request id); and (c) its
 * policy and rubric are the newest recorded for its own question id. Labels earned under an
 * older rubric, a looser policy or another evidence version say nothing about the configuration
 * now answering, so an estimate, a fitted bar, `check` and a report's calibration figures read
 * only `current`.
 *
 * Policy and rubric are matched per question because a gate can ask many: one used as an
 * `Asker` (a `relevance` pass asks one question per item, each with its own id), or one whose
 * questions each carry their own policy, records many question ids in its slice, and matching
 * every row to the newest row would grade the gate on its last-asked question alone. The
 * newest request's policies retire a policy the gate no longer uses even on questions asked
 * once each: a relevance gate loosened from actAbove 0.95 to 0.1 would otherwise keep grading
 * on the 0.95 labels. A rubric edit that keeps its question id changes its hash, so it leaves
 * the old rows behind; a rename is a new question, whose old rows stay current until the
 * gate's `evidenceVersion` moves, so bump it when you rename (`strayQuestions` names them).
 * Keep one evidence version per gate: a version given per question retires every question but
 * the one asked last, and versions interleaved request by request make the grade flip with
 * each request, as two policies alternating on one question do. Rows written before policies
 * were hashed share one configuration, so an old ledger reads as it always has.
 * `configuration` is the newest decision row's. (A planned sample is scoped more narrowly, to
 * the newest row's own policy and rubric, as a rollout reads it.)
 */
export function currentConfiguration(rows: readonly DecisionRecord[]): {
  readonly current: DecisionRecord[];
  readonly older: DecisionRecord[];
  readonly configuration?: Configuration;
} {
  const newest = decisionRows(rows).at(-1);
  if (newest === undefined) return { current: [], older: rows.slice() };
  const configuration = configurationOf(newest);
  const request = requestOf(newest);
  const policies = new Set(rows.filter((r) => requestOf(r) === request).map((r) => r.policyHash));
  const latest = new Map<string, DecisionRecord>();
  for (const r of rows) latest.set(r.questionId, r);
  const current: DecisionRecord[] = [];
  const older: DecisionRecord[] = [];
  for (const r of rows) {
    const mine = latest.get(r.questionId);
    const now =
      r.evidenceVersion === configuration.evidenceVersion &&
      policies.has(r.policyHash) &&
      r.policyHash === mine?.policyHash &&
      r.questionHash === mine?.questionHash;
    (now ? current : older).push(r);
  }
  return { current, older, configuration };
}

/** A question whose rows still read as current though the gate's newest request did not ask it. */
export interface StrayQuestion {
  readonly questionId: string;
  /** Its current decision rows. */
  readonly rows: number;
  /** Of those, the labelled ones. */
  readonly labels: number;
  /** When it was last asked. */
  readonly lastAt: string;
}

/**
 * The questions a single-question gate's estimate still reads though its newest request did not
 * ask them: what a rubric edit that also renamed the question leaves behind (`safe.v1` still
 * grading a gate that now asks `safe.v2`) until the evidence version moves. Only a gate whose
 * newest request asked exactly one question is read, so a gate asking many (a `relevance` pass,
 * per-question policies) stays quiet. Empty when there is nothing to say.
 */
export function strayQuestions(rows: readonly DecisionRecord[]): StrayQuestion[] {
  const decisions = decisionRows(rows);
  const newest = decisions.at(-1);
  if (newest === undefined) return [];
  const request = requestOf(newest);
  const asked = new Set(decisions.filter((r) => requestOf(r) === request).map((r) => r.questionId));
  if (asked.size !== 1) return [];
  const byQuestion = new Map<string, { rows: number; labels: number; lastAt: string }>();
  for (const r of currentConfiguration(decisions).current) {
    if (asked.has(r.questionId)) continue;
    const q = byQuestion.get(r.questionId) ?? { rows: 0, labels: 0, lastAt: "" };
    q.rows++;
    if (r.outcome !== undefined) q.labels++;
    if (typeof r.at === "string" && r.at > q.lastAt) q.lastAt = r.at;
    byQuestion.set(r.questionId, q);
  }
  return [...byQuestion].map(([questionId, q]) => ({ questionId, ...q }));
}

/** One clause for a stray question, saying what to do about it. */
export const describeStray = (q: StrayQuestion): string =>
  `question \`${q.questionId}\`: ${plural(q.labels, "label")}, last asked ${q.lastAt.slice(0, 10) || "on no recorded date"}, not in the newest request; bump evidenceVersion to retire it`;

/** The donor a borrowed bar names: which rows, gates and ledgers it was read from, and when. */
export interface ProfileProvenance {
  /** Labelled unselected rows of trusted sources the profile was built from. */
  readonly rows: number;
  readonly gates: readonly string[];
  readonly ledgers: readonly string[];
  /** The oldest and newest row read, ISO. */
  readonly firstAt: string;
  readonly lastAt: string;
  readonly sources: SourceCounts;
}

/** Evidence that is not this gate's labels. */
export type BorrowedVia =
  | {
      readonly type: "profile";
      readonly profileHash: string;
      /** The act bar the profile's calibration supports for the gate's promise. */
      readonly bar: number;
      readonly donor: ProfileProvenance;
    }
  | {
      readonly type: "disagreement";
      /**
       * Share of paired rows whose two leading answers differ. At least one judge is wrong on
       * each, so this bounds from below the share of rows on which at least one of the two is
       * wrong, whatever their correlation. It is not the gate's error rate (the gate may follow
       * the better judge, or pool both), never an upper bound on error, and never a claim of
       * accuracy.
       */
      readonly rate: number;
      readonly pairs: number;
      /** Two different model families (`modelFamily`): two pins of one model are refused. */
      readonly models: readonly [string, string];
    };

/**
 * Every grade with evidence behind it carries `at`: how old that evidence is, not when it was
 * read. For measured, the label that completed the planned sample; for estimated, the newest
 * label the estimate read; for borrowed, the date the evidence came with. A measured grade
 * decays as traffic, model and rubric move away from the sample it rests on, and the
 * human-factors review found that "measured" is read as permanent unless the date says
 * otherwise, so the date a reader needs is the evidence's age.
 */
export type EvidenceGrade =
  | {
      readonly kind: "measured";
      readonly plan: ResolvedPlan;
      readonly lowerBound: number;
      readonly errors: number;
      readonly sampleSize: number;
      readonly sources: SourceCounts;
      readonly at: string;
    }
  | {
      readonly kind: "estimated";
      readonly accuracy: number;
      readonly lower: number;
      readonly upper: number;
      readonly n: number;
      readonly confidence: number;
      readonly sources: SourceCounts;
      readonly at: string;
      /**
       * Labelled unselected rows of trusted sources recorded under an older configuration
       * (policy, rubric or evidence version), which the estimate did not read. Absent when none.
       */
      readonly older?: number;
    }
  | {
      readonly kind: "borrowed";
      readonly via: BorrowedVia;
      readonly at: string;
      /**
       * Set when the gate declared this profile as its bar's source and no longer matches its
       * key, or when the profile was matched to the gate's pinned model and the gate's newest
       * answer came from another: the bar was earned by another model, question kind or rubric
       * than the one now answering, so it describes nothing the gate does.
       */
      readonly stale?: true;
    }
  | {
      readonly kind: "none";
      readonly reason: string;
      /** Labelled rows of the current configuration whose source the filter admits. */
      readonly labelled: number;
      /** Of those, the unselected ones. */
      readonly unselected: number;
      /** Labelled unselected rows under older configurations, not read. Absent when none. */
      readonly older?: number;
    };

/** The one variant that promotes a gate. Promotion takes this type and nothing wider. */
export type MeasuredGrade = Extract<EvidenceGrade, { kind: "measured" }>;

export type GradeKind = EvidenceGrade["kind"];

/** Strongest first: the order `gradeOf` prefers and `ratchet check --require` compares in. */
export const GRADE_KINDS: readonly GradeKind[] = ["measured", "estimated", "borrowed", "none"];

/** True when `grade` is at least as strong as `kind`. */
export const atLeast = (grade: EvidenceGrade, kind: GradeKind): boolean =>
  GRADE_KINDS.indexOf(grade.kind) <= GRADE_KINDS.indexOf(kind);

/** The word a surface prints for a grade before any number: its kind, and "(stale)" if so. */
export const gradeWord = (grade: EvidenceGrade): string =>
  grade.kind === "borrowed" && grade.stale === true ? "borrowed (stale)" : grade.kind;

/**
 * Which labelled rows a fitted bar or a calibration figure read: the unselected ones (shadow
 * rows and blind audits) when there were enough of them, else all of them. The oracle's own
 * confidence chose some of those, so a figure read from "all" is a biased fallback.
 */
export type FittedFrom = "unselected" | "all";

export interface GradeOptions extends TrustFilter {
  /**
   * A planned sample already evaluated, as a rollout evaluates its own phase. Its sample must
   * be among `rows`. Wins over `plan`.
   */
  readonly acceptance?: AcceptanceResult;
  /**
   * Evaluate this plan on the rows' current phase (see `gradeOf`) when no `acceptance` is
   * given. Without either, the best grade is estimated.
   */
  readonly plan?: AcceptancePlan | ResolvedPlan;
  /** With `plan`: only rows this model answered enter the sample, as a pinned rollout reads them. */
  readonly model?: string;
  /** Labelled unselected rows an estimated grade needs. Default 30. */
  readonly minEstimated?: number;
  /** Confidence of the estimated grade's Wilson interval. Default 0.95. */
  readonly confidence?: number;
  /**
   * Trust classes whose labels an estimate reads. Default `TRUSTED_SOURCES`: blind, census and
   * unsourced labels. Consequence cannot be named: what happened next depends on what the gate
   * let happen, so it cannot grade the gate.
   */
  readonly sources?: readonly FitClass[];
  /** Evidence that is not this gate's labels, used only when nothing stronger exists. */
  readonly borrowed?: BorrowedVia;
  /**
   * When the borrowed evidence dates from. Default a profile's `donor.lastAt`; disagreement
   * carries no date of its own, so pass the newest paired row's `at`.
   */
  readonly borrowedAt?: string;
  /**
   * With a borrowed profile: the gate declared it as its bar's source and no longer matches
   * its key, or its newest answer is off the pin the profile was matched to (`borrowFor` says
   * which), so the grade is marked stale.
   */
  readonly stale?: boolean;
  /**
   * The clock for evidence nothing else can date: a disagreement without `borrowedAt`, or labels
   * written without a date. Default the system clock.
   */
  readonly now?: () => string;
}

/**
 * The best grade `rows` support, in order of preference: measured, estimated, borrowed, none.
 * Rows are one gate's (or one question's), in ledger order.
 *
 * Measured needs an accepted planned sample: `acceptance` as a rollout evaluated it, or `plan`
 * evaluated here on the rows' current phase. That phase is the decision rows recorded under
 * the newest row's configuration (gate, policy, rubric and evidence version, and `model` when
 * given, the scope a rollout reads), and of those the shadow rows since the last enforce row,
 * or for a gate now enforcing the shadow rows that preceded it. A run of enforce rows ends a
 * phase as a promotion or a demotion does, so a demoted gate is graded on its fresh sample.
 * Without a rollout checkpoint nothing else marks a phase; a rollout's own status is the
 * authority for its gate. The sample is the first acts of that phase whatever came after
 * them, so a measured grade is never read off a moving window.
 *
 * Estimated needs `minEstimated` labelled unselected rows whose sources pass the filter, of the
 * current configuration (`currentConfiguration`): after a rubric, policy or evidence-version
 * change the old configuration's labels describe a gate that no longer answers, so they are
 * counted as `older` and never read. Borrowed is the caller's `borrowed`, used only when
 * neither exists, since it is not this gate's labels. Throws on an out-of-range lever or
 * malformed borrowed evidence.
 */
export function gradeOf(rows: readonly DecisionRecord[], opts: GradeOptions = {}): EvidenceGrade {
  const minEstimated = opts.minEstimated ?? REPORT_DEFAULTS.minEstimated;
  const confidence = opts.confidence ?? 0.95;
  if (!Number.isSafeInteger(minEstimated) || minEstimated < 1) {
    throw new Error("minEstimated must be a positive integer");
  }
  if (!(confidence > 0 && confidence < 1)) {
    throw new Error("confidence must be strictly between 0 and 1");
  }
  if (opts.borrowed !== undefined) checkBorrowed(opts.borrowed);
  if (opts.stale === true && opts.borrowed?.type !== "profile") {
    throw new Error("only a borrowed profile can be stale");
  }
  const trust = opts.trust ?? DEFAULT_TRUST;
  const filter: TrustFilter = { sources: gradeSources(opts.sources), trust };
  const now = opts.now ?? (() => new Date().toISOString());
  const dated = (read: readonly DecisionRecord[]): string => newestLabel(read) ?? now();

  const acceptance =
    opts.acceptance ??
    (opts.plan === undefined
      ? undefined
      : evaluateAcceptance(plannedPhase(rows, opts.model), opts.plan, trust));
  if (acceptance?.status === "accepted") {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const sample = acceptance.sample.map((id) => {
      const r = byId.get(id);
      if (r === undefined) throw new Error(`planned act ${id} is not among the rows graded`);
      return r;
    });
    return {
      kind: "measured",
      plan: acceptance.plan,
      lowerBound: acceptance.lowerBound,
      errors: acceptance.errors,
      sampleSize: sample.length,
      sources: countSources(sample, trust),
      at: dated(sample),
    };
  }

  const readable = (r: DecisionRecord): boolean =>
    r.outcome !== undefined &&
    !r.failedOpen &&
    !settledWithoutAnswer(r) &&
    admits(filter, r.outcome.source);
  const { current, older } = currentConfiguration(rows);
  const labelled = current.filter(readable);
  const unselected = labelled.filter((r) => isUnselected(r, filter));
  const stale = older.filter((r) => readable(r) && isUnselected(r, filter)).length;
  const olderCount = stale > 0 ? { older: stale } : {};
  const n = unselected.length;
  if (n >= minEstimated) {
    const accuracy = unselected.filter((r) => r.outcome?.correct === true).length / n;
    const { lower, upper } = wilsonInterval(accuracy, n, confidence);
    return {
      kind: "estimated",
      accuracy,
      lower,
      upper,
      n,
      confidence,
      sources: countSources(unselected, trust),
      at: dated(unselected),
      ...olderCount,
    };
  }
  const via = opts.borrowed;
  if (via !== undefined) {
    const at = opts.borrowedAt ?? (via.type === "profile" ? via.donor.lastAt : now());
    return { kind: "borrowed", via, at, ...(opts.stale === true ? { stale: true as const } : {}) };
  }
  return {
    kind: "none",
    reason: noneReason(labelled.length, n, minEstimated, stale),
    labelled: labelled.length,
    unselected: n,
    ...olderCount,
  };
}

/** The current phase's shadow rows, as `gradeOf` describes it. */
function plannedPhase(
  rows: readonly DecisionRecord[],
  model: string | undefined,
): DecisionRecord[] {
  const decisions = decisionRows(rows);
  const newest = decisions.at(-1);
  if (newest === undefined) return [];
  const configuration = configurationOf(newest);
  const scoped = decisions.filter(
    (r) =>
      r.gateId === newest.gateId &&
      sameConfiguration(r, configuration) &&
      (model === undefined || r.model === model),
  );
  let end = scoped.length;
  while (end > 0 && scoped[end - 1]?.mode === "enforce") end--;
  let start = end;
  while (start > 0 && scoped[start - 1]?.mode !== "enforce") start--;
  return scoped.slice(start, end).filter((r) => r.mode === "shadow");
}

/** The newest label date among `rows`, which is when the evidence they hold was complete. */
function newestLabel(rows: readonly DecisionRecord[]): string | undefined {
  let newest: string | undefined;
  for (const r of rows) {
    const at = r.outcome?.at;
    if (typeof at === "string" && at !== "" && (newest === undefined || at > newest)) newest = at;
  }
  return newest;
}

/**
 * Labelled rows by the trust class of their label's source. Consequence and unregistered labels
 * have no column here: neither fits a bar or grades a gate, so no grade ever reads one.
 */
export function countSources(rows: readonly DecisionRecord[], trust: TrustRegistry): SourceCounts {
  const counts: Record<FitClass, number> = { blind: 0, census: 0, moment: 0, unknown: 0 };
  for (const r of rows) {
    const c: string = trustOf(r.outcome?.source, trust);
    if (c === "blind" || c === "census" || c === "moment" || c === "unknown") counts[c]++;
  }
  return counts;
}

function gradeSources(sources: readonly FitClass[] | undefined): readonly FitClass[] {
  if (sources === undefined) return TRUSTED_SOURCES;
  if (sources.length === 0) throw new Error("sources must name at least one trust class");
  for (const c of sources as readonly unknown[]) {
    if (!isTrustClass(c)) throw new Error(`unknown trust class "${String(c)}"`);
    if (c === "consequence") throw new Error("consequence labels never grade a gate");
  }
  return sources;
}

/** Borrowed evidence arrives as data from outside the ledger, so its shape is checked. */
function checkBorrowed(via: BorrowedVia): void {
  if (via.type === "profile") {
    if (via.profileHash.trim() === "") throw new Error("a borrowed profile needs its hash");
    if (!(via.bar > 0 && via.bar <= 1)) throw new Error("a borrowed bar must be in (0, 1]");
    if (!Number.isSafeInteger(via.donor.rows) || via.donor.rows < 1) {
      throw new Error("a borrowed profile must name the rows it was built from");
    }
    return;
  }
  if (via.type === "disagreement") {
    if (!(via.rate >= 0 && via.rate <= 1)) throw new Error("a disagreement rate must be in [0, 1]");
    if (!Number.isSafeInteger(via.pairs) || via.pairs < 1) {
      throw new Error("disagreement needs at least one pair");
    }
    // Two paraphrases of one model are not two opinions, and nor are two pins of one family:
    // jev-1.13 and jev-1.14 shared 89% of their errors, so their disagreement bounds little.
    const [a, b] = via.models;
    if (a === b) throw new Error("disagreement needs two different models");
    if (modelFamily(a) === modelFamily(b)) {
      throw new Error(
        `disagreement needs two model families; ${a} and ${b} are both ${modelFamily(a)}`,
      );
    }
    return;
  }
  throw new Error(`unknown borrowed evidence "${String((via as { type?: unknown }).type)}"`);
}

const pct = (x: number, places = 1): string => `${(100 * x).toFixed(places)}%`;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
/** The evidence's age to the day; the time of day adds nothing a reader acts on. */
const asOf = (at: string): string => `as of ${at.slice(0, 10)}`;
const day = (at: string): string => at.slice(0, 10);

function noneReason(
  labelled: number,
  unselected: number,
  minEstimated: number,
  older: number,
): string {
  const short = `${plural(unselected, "labelled unselected row")}${older > 0 ? " of the current configuration" : ""}; estimated needs ${minEstimated}`;
  const selected = labelled - unselected;
  const chosen =
    selected === 0
      ? ""
      : `, and the other ${selected} labelled ${selected === 1 ? "row was" : "rows were"} chosen by the oracle's own confidence: label shadow rows or blind audits`;
  return `${short}${chosen}${olderNote(older)}`;
}

/** Why labels under an older configuration were not read, when there were any. */
const olderNote = (older: number): string =>
  older === 0
    ? ""
    : `; ${plural(older, "labelled unselected row")} under an older policy, rubric or evidence version ${older === 1 ? "was" : "were"} not read`;

/**
 * The labels a grade read, by class, the empty classes left out. The `unknown` class is what
 * every label written without a source falls into, so it is printed as what it means to a
 * reader, "unsourced", rather than as a word that reads like a defect.
 */
export function describeSources(s: SourceCounts): string {
  const read = (Object.entries(s) as [FitClass, number][]).filter(([, n]) => n > 0);
  return read.map(([c, n]) => `${c === "unknown" ? "unsourced" : c} ${n}`).join(", ");
}

/** A profile's donor in words: its rows, gates, ledgers and dates. */
export function describeDonor(d: ProfileProvenance): string {
  const named = (word: string, xs: readonly string[]) =>
    `${word}${xs.length === 1 ? "" : "s"} ${xs.join(", ")}`;
  return `${plural(d.rows, "row")} of ${named("gate", d.gates)} in ${named("ledger", d.ledgers)}, ${day(d.firstAt)} to ${day(d.lastAt)}`;
}

/**
 * One sentence for a grade, by the human-factors rules: it opens with the grade's word, so no
 * number is read before its kind, then says "as of" its evidence's date; measured gives its
 * sample size; estimated its interval, its width and that it is not a planned sample; a
 * profile names its donor and says "0 rows here", and "borrowed (stale)" once the gate has moved
 * off its key; disagreement says how often the two judges disagree and that at least one of
 * them is wrong that often, and says outright that it is not this gate's error rate: read on a
 * gate, "at least 30% wrong" was taken for the gate's error where the gate was never wrong and
 * the second opinion was wrong on every disagreement. Labels under an older configuration that
 * an estimate or a none did not read are counted at the end.
 */
export function describeGrade(g: EvidenceGrade): string {
  switch (g.kind) {
    case "measured":
      return `measured ${asOf(g.at)}: exact ${pct(g.plan.confidence, 0)} lower bound ${pct(g.lowerBound, 2)} >= promised ${pct(g.plan.target)} on a planned sample of ${plural(g.sampleSize, "act")}, ${g.errors} wrong (labels: ${describeSources(g.sources)})`;
    case "estimated": {
      const width = (100 * (g.upper - g.lower)).toFixed(1);
      return `estimated ${asOf(g.at)}: ${pct(g.accuracy)} right on ${plural(g.n, "labelled unselected row")} (labels: ${describeSources(g.sources)}), ${pct(g.confidence, 0)} interval ${pct(g.lower)} to ${pct(g.upper)}, ${width} points wide, not a planned sample${olderNote(g.older ?? 0)}`;
    }
    case "borrowed": {
      const v = g.via;
      if (v.type === "profile") {
        const stale = g.stale === true ? ", which no longer matches the gate's model" : "";
        return `${gradeWord(g)} ${asOf(g.at)}: bar ${v.bar.toFixed(3)} from profile ${v.profileHash.slice(0, 8)}${stale}, donor ${describeDonor(v.donor)}, 0 rows here`;
      }
      return `borrowed ${asOf(g.at)}: ${v.models[0]} and ${v.models[1]} disagree on ${pct(v.rate)} of ${plural(v.pairs, "pair")}, so at least one of the two judges is wrong on at least ${pct(v.rate)} of them; this is not this gate's error rate`;
    }
    case "none":
      return `none: ${g.reason}`;
  }
}
