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
 *   from other ledgers, or the disagreement of two judges from different models, which bounds
 *   the pair's error from below whatever their correlation. Shadow only.
 * - none: fewer rows than any grade needs, with the reason in words a person can act on.
 */

import {
  type AcceptancePlan,
  type AcceptanceResult,
  evaluateAcceptance,
  type ResolvedPlan,
} from "../acceptance.ts";
import { isUnselected, wilsonInterval } from "./calibration.ts";
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
       * each, so this bounds the pair's error rate from below whatever their correlation; it
       * is never an upper bound on error or a claim of accuracy.
       */
      readonly rate: number;
      readonly pairs: number;
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
    }
  | {
      readonly kind: "borrowed";
      readonly via: BorrowedVia;
      readonly at: string;
      /**
       * Set when the gate declared this profile as its bar's source and no longer matches its
       * key: the bar was earned by another model, question kind or rubric than the one now
       * answering, so it describes nothing the gate does.
       */
      readonly stale?: true;
    }
  | {
      readonly kind: "none";
      readonly reason: string;
      readonly labelled: number;
      readonly unselected: number;
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
   * its key (`borrowFor` says which), so the grade is marked stale.
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
 * Estimated needs `minEstimated` labelled unselected rows whose sources pass the filter.
 * Borrowed is the caller's `borrowed`, used only when neither exists, since it is not this
 * gate's labels. Throws on an out-of-range lever or malformed borrowed evidence.
 */
export function gradeOf(rows: readonly DecisionRecord[], opts: GradeOptions = {}): EvidenceGrade {
  const minEstimated = opts.minEstimated ?? 30;
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

  const labelled = rows.filter(
    (r) =>
      r.outcome !== undefined &&
      !r.failedOpen &&
      !settledWithoutAnswer(r) &&
      admits(filter, r.outcome.source),
  );
  const unselected = labelled.filter((r) => isUnselected(r, filter));
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
    };
  }
  const via = opts.borrowed;
  if (via !== undefined) {
    const at = opts.borrowedAt ?? (via.type === "profile" ? via.donor.lastAt : now());
    return { kind: "borrowed", via, at, ...(opts.stale === true ? { stale: true as const } : {}) };
  }
  return {
    kind: "none",
    reason: noneReason(labelled.length, n, minEstimated),
    labelled: labelled.length,
    unselected: n,
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
  const scoped = decisions.filter(
    (r) =>
      r.gateId === newest.gateId &&
      r.policyHash === newest.policyHash &&
      r.questionHash === newest.questionHash &&
      r.evidenceVersion === newest.evidenceVersion &&
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

/** Labelled rows by the trust class of their label's source; consequence has no column here. */
export function countSources(rows: readonly DecisionRecord[], trust: TrustRegistry): SourceCounts {
  const counts: Record<FitClass, number> = { blind: 0, census: 0, moment: 0, unknown: 0 };
  for (const r of rows) {
    const c = trustOf(r.outcome?.source, trust);
    if (c !== "consequence") counts[c]++;
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
    // Two paraphrases of one model are not two opinions.
    if (via.models[0] === via.models[1]) throw new Error("disagreement needs two different models");
    return;
  }
  throw new Error(`unknown borrowed evidence "${String((via as { type?: unknown }).type)}"`);
}

const pct = (x: number, places = 1): string => `${(100 * x).toFixed(places)}%`;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
/** The evidence's age to the day; the time of day adds nothing a reader acts on. */
const asOf = (at: string): string => `as of ${at.slice(0, 10)}`;
const day = (at: string): string => at.slice(0, 10);

function noneReason(labelled: number, unselected: number, minEstimated: number): string {
  const short = `${plural(unselected, "labelled unselected row")}; estimated needs ${minEstimated}`;
  const selected = labelled - unselected;
  if (selected === 0) return short;
  const were = selected === 1 ? "row was" : "rows were";
  return `${short}, and the other ${selected} labelled ${were} chosen by the oracle's own confidence: label shadow rows or blind audits`;
}

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
 * off its key; disagreement says "at least N% wrong on this slice", never a claim of accuracy.
 */
export function describeGrade(g: EvidenceGrade): string {
  switch (g.kind) {
    case "measured":
      return `measured ${asOf(g.at)}: exact ${pct(g.plan.confidence, 0)} lower bound ${pct(g.lowerBound, 2)} >= promised ${pct(g.plan.target)} on a planned sample of ${plural(g.sampleSize, "act")}, ${g.errors} wrong (labels: ${describeSources(g.sources)})`;
    case "estimated": {
      const width = (100 * (g.upper - g.lower)).toFixed(1);
      return `estimated ${asOf(g.at)}: ${pct(g.accuracy)} right on ${plural(g.n, "labelled unselected row")} (labels: ${describeSources(g.sources)}), ${pct(g.confidence, 0)} interval ${pct(g.lower)} to ${pct(g.upper)}, ${width} points wide, not a planned sample`;
    }
    case "borrowed": {
      const v = g.via;
      if (v.type === "profile") {
        const stale = g.stale === true ? ", which no longer matches the gate's model" : "";
        return `${gradeWord(g)} ${asOf(g.at)}: bar ${v.bar.toFixed(3)} from profile ${v.profileHash.slice(0, 8)}${stale}, donor ${describeDonor(v.donor)}, 0 rows here`;
      }
      return `borrowed ${asOf(g.at)}: at least ${pct(v.rate)} wrong on this slice, ${plural(v.pairs, "pair")}, from the disagreement of ${v.models[0]} and ${v.models[1]}`;
    }
    case "none":
      return `none: ${g.reason}`;
  }
}
