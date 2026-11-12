/**
 * Calibration profiles: what one model's stated confidence has meant on other gates' labelled
 * rows, so a new gate can start in shadow from a bar earned somewhere rather than from a guess
 * (a fixed 0.95 acted on nothing while the model put routine calls at 0.72 to 0.89). A profile
 * is borrowed evidence: it may set a shadow bar and never enables act, because enforce takes a
 * measured grade and nothing else.
 *
 * It reads what a fit may read and no more: labelled unselected rows (shadow rows and blind
 * audits) of trusted sources, answered by the key's exact model alone, kept as equal-width
 * confidence bins per donor gate, 100 by default (`resolution`). Calibration differs by
 * question, so the bar for a promise is the cautious end: the lowest bin edge at which every
 * donor gate with at least `minSupport` rows in its tail (every row at or above the edge)
 * clears the promise on that tail at the lower end of a 95% Wilson interval (a one-sided 97.5%
 * bound). On one gate that is the bar
 * `fitThreshold` keeps in its conservative mode, so a borrowed bar and a fitted bar mean the
 * same thing; across gates it is the strictest donor's bar, not the average, because a profile
 * is lent to a gate none of its donors is, and must hold on every gate it was read from. Each
 * gate's own bar (`gateBars`) is kept for reading. `profile-bins.ts` holds the arithmetic;
 * `borrow.ts` reads a profile from a file and decides which one a gate borrows.
 */

import type { QuestionKind } from "../types.ts";
import { isUnselected, type ReliabilityBin } from "./calibration.ts";
import { type BorrowedVia, countSources, type ProfileProvenance } from "./evidence.ts";
import { type DecisionRecord, decisionRows, hashState } from "./ledger.ts";
import {
  above,
  binsOf,
  cautiousBar,
  coarsen,
  count,
  emptyTallies,
  gateBar,
  type Tallies,
  talliesOf,
} from "./profile-bins.ts";
import {
  DEFAULT_TRUST,
  type FitClass,
  isTrustClass,
  TRUSTED_SOURCES,
  type TrustRegistry,
} from "./sources.ts";

/** Which answers a profile describes: one pinned model, one question kind, maybe one rubric. */
export interface ProfileKey {
  /** The exact model rows record. A moving alias would hide the upgrade a profile must not outlive. */
  readonly model: string;
  readonly kind: QuestionKind;
  /** Only rows asked this exact question (their `questionHash`); absent, any of the kind. */
  readonly questionHash?: string;
}

/** One donor gate's rows in one confidence bin. */
export interface ProfileBin extends ReliabilityBin {
  readonly gate: string;
}

/** The act bar a profile supports for one promise. */
export interface ProfileBar {
  readonly target: number;
  /** A bin's lower edge, on the leading answer's confidence, as every fitted bar here is. */
  readonly bar: number;
  /** The fewest tail rows at the bar among the gates that cleared it: its thinnest evidence. */
  readonly support: number;
}

export interface CalibrationProfile {
  readonly format: 1;
  readonly key: ProfileKey;
  /** The promises it was built for, ascending; `bars` lists those its bins support. */
  readonly targets: readonly number[];
  /** Rows a donor gate needs at or above its bar. */
  readonly minSupport: number;
  /** Equal-width bins across [0, 1]; a bar is one of their lower edges. */
  readonly resolution: number;
  readonly bars: readonly ProfileBar[];
  /** Every donor gate's non-empty bins, by gate and then confidence, each with its rows. */
  readonly bins: readonly ProfileBin[];
  readonly from: ProfileProvenance;
  /**
   * `profileHash` of the key, levers, bars and bins: the evidence, not where it was filed, so
   * two profiles built from the same rows are one profile whatever their ledgers were called.
   */
  readonly hash: string;
}

/** What a profile is made of; its bars and hash follow from these. */
export type ProfileParts = Pick<
  CalibrationProfile,
  "key" | "targets" | "minSupport" | "resolution" | "from"
> & {
  readonly bins: readonly ProfileBin[];
};

export interface ProfileOptions {
  /** What the rows were read from, named in every borrowed grade's donor. At least one. */
  readonly ledgers: readonly string[];
  /** Promises to state a bar for, each in (0, 1]. Default `PROFILE_TARGETS`. */
  readonly targets?: readonly number[];
  /** Rows a donor gate needs at or above its bar. Default 30. */
  readonly minSupport?: number;
  /**
   * Equal-width bins across [0, 1], at most 1000. Default 100: a bar can sit at any hundredth,
   * where decision models state their confidence, so the bar reflects the model and not the
   * binning (at ten bins the finest bar below 1 is 0.9, whose tail must keep the promise whole).
   */
  readonly resolution?: number;
  /**
   * Trust classes whose labels are read. Default `TRUSTED_SOURCES`: blind, census and
   * unsourced, the labels a bar may be fitted on. Consequence cannot be named.
   */
  readonly sources?: readonly FitClass[];
  /** How sources map to classes. Default `DEFAULT_TRUST`. */
  readonly trust?: TrustRegistry;
}

/** What a profile is matched against: a gate's model pin, question kind and rubric. */
export interface ProfileGate {
  readonly model: string;
  readonly kind: QuestionKind;
  readonly questionHash?: string;
}

/** One donor gate's own bar for a promise, before the cautious end is taken. */
export interface GateBar {
  readonly gate: string;
  readonly rows: number;
  readonly bar?: number;
  readonly support?: number;
}

const KINDS: readonly QuestionKind[] = ["judge", "pick", "rate"];

/**
 * The promises a profile states a bar for unless told otherwise: 90%, so it always reports the
 * lowest standard bar it can support, the engine's default 95%, the hook's and keywork's 98%,
 * and one stricter. Any other promise is read from the same bins (`borrowedBar`).
 */
export const PROFILE_TARGETS: readonly number[] = [0.9, 0.95, 0.98, 0.99];

/**
 * A profile of the answers `key` names in `rows`: decision rows its exact model answered alone
 * (strategy single, so neither a battery's pooled row nor a member labelled with its battery's
 * truth), not failed open, dated, labelled from a source the filter admits, and unselected.
 * A row read twice, as one ledger named twice would give, counts once. Undefined when no row
 * qualifies. Throws on a malformed key or lever.
 */
export function buildProfile(
  rows: readonly DecisionRecord[],
  key: ProfileKey,
  opts: ProfileOptions,
): CalibrationProfile | undefined {
  checkKey(key);
  const targets = opts.targets ?? PROFILE_TARGETS;
  const minSupport = opts.minSupport ?? 30;
  const resolution = opts.resolution ?? 100;
  checkLevers(targets, minSupport, resolution, opts.ledgers);
  const trust = opts.trust ?? DEFAULT_TRUST;
  const filter = { sources: profileSources(opts.sources), trust };
  const seen = new Set<string>();
  const read = decisionRows(rows).filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return (
      r.model === key.model &&
      r.kind === key.kind &&
      (key.questionHash === undefined || r.questionHash === key.questionHash) &&
      r.strategy === "single" &&
      !r.failedOpen &&
      r.outcome !== undefined &&
      typeof r.at === "string" &&
      r.at !== "" &&
      Number.isFinite(r.confidence) &&
      isUnselected(r, filter)
    );
  });
  if (read.length === 0) return undefined;
  const tallies = emptyTallies(resolution);
  for (const r of read) count(tallies, r.gateId, r.confidence, r.outcome?.correct === true);
  const ats = read.map((r) => r.at).sort();
  return assemble(key, targets, minSupport, tallies, {
    rows: read.length,
    gates: [...tallies.gates.keys()],
    ledgers: opts.ledgers,
    firstAt: ats[0] as string,
    lastAt: ats.at(-1) as string,
    sources: countSources(read, trust),
  });
}

/**
 * Two profiles of one key, `minSupport` and resolution as one: bins added, provenance joined,
 * bars recomputed for every target either was built for. A gate id in both is one gate, as it
 * is when one build reads both ledgers. Throws when the keys or levers differ, or when both name
 * a ledger, whose rows would then count twice.
 */
export function mergeProfiles(a: CalibrationProfile, b: CalibrationProfile): CalibrationProfile {
  if (keyText(a.key) !== keyText(b.key)) {
    throw new Error(`cannot merge a profile of ${keyText(a.key)} with one of ${keyText(b.key)}`);
  }
  if (a.minSupport !== b.minSupport) {
    throw new Error(
      `cannot merge profiles built with min support ${a.minSupport} and ${b.minSupport}; rebuild one`,
    );
  }
  if (a.resolution !== b.resolution) {
    throw new Error(
      `cannot merge profiles of ${a.resolution} and ${b.resolution} bins: their bars sit on different edges; rebuild one at the other's resolution`,
    );
  }
  const shared = a.from.ledgers.filter((l) => b.from.ledgers.includes(l));
  if (shared.length > 0) {
    throw new Error(
      `both profiles read ${shared.join(", ")}, so its rows would count twice; build one profile from the ledgers together`,
    );
  }
  const s = (c: FitClass): number => a.from.sources[c] + b.from.sources[c];
  return profileFrom({
    key: a.key,
    targets: [...a.targets, ...b.targets],
    minSupport: a.minSupport,
    resolution: a.resolution,
    bins: [...a.bins, ...b.bins],
    from: {
      rows: a.from.rows + b.from.rows,
      gates: [...a.from.gates, ...b.from.gates],
      ledgers: [...a.from.ledgers, ...b.from.ledgers],
      firstAt: a.from.firstAt < b.from.firstAt ? a.from.firstAt : b.from.firstAt,
      lastAt: a.from.lastAt > b.from.lastAt ? a.from.lastAt : b.from.lastAt,
      sources: {
        blind: s("blind"),
        census: s("census"),
        moment: s("moment"),
        unknown: s("unknown"),
      },
    },
  });
}

/**
 * A profile from its parts, with its bins in canonical order (one gate's bins of one edge added
 * together) and its bars and hash computed from them. Throws on a malformed key or lever; the
 * parts' consistency with each other is `parseProfile`'s to check.
 */
export function profileFrom(parts: ProfileParts): CalibrationProfile {
  checkKey(parts.key);
  checkLevers(parts.targets, parts.minSupport, parts.resolution, parts.from.ledgers);
  const tallies = talliesOf(parts.bins, parts.resolution);
  return assemble(parts.key, parts.targets, parts.minSupport, tallies, parts.from);
}

function assemble(
  key: ProfileKey,
  targets: readonly number[],
  minSupport: number,
  tallies: Tallies,
  from: ProfileProvenance,
): CalibrationProfile {
  const promises = [...new Set(targets)].sort((x, y) => x - y);
  const sorted = (xs: readonly string[]) => [...new Set(xs)].sort();
  const s = from.sources;
  const body = {
    format: 1 as const,
    key: {
      model: key.model,
      kind: key.kind,
      ...(key.questionHash !== undefined ? { questionHash: key.questionHash } : {}),
    },
    targets: promises,
    minSupport,
    resolution: tallies.resolution,
    bars: promises.flatMap((t) => cautiousBar(tallies, t, minSupport) ?? []),
    bins: binsOf(tallies),
  };
  return {
    ...body,
    from: {
      rows: from.rows,
      gates: sorted(from.gates),
      ledgers: sorted(from.ledgers),
      firstAt: from.firstAt,
      lastAt: from.lastAt,
      sources: { blind: s.blind, census: s.census, moment: s.moment, unknown: s.unknown },
    },
    hash: profileHash(body),
  };
}

/**
 * A profile's bins regrouped into `into` equal bins, for reading; its bars use every bin it
 * holds. Unchanged when its resolution is not a multiple of `into`.
 */
export const coarseBins = (profile: CalibrationProfile, into: number): ProfileBin[] =>
  coarsen(profile.bins, profile.resolution, into);

/** Each donor gate's own bar for `target`, by gate, before the cautious end is taken. */
export function gateBars(profile: CalibrationProfile, target: number): GateBar[] {
  checkTarget(target);
  return [...talliesOf(profile.bins, profile.resolution).gates].map(([gate, tallies]) => ({
    gate,
    rows: above(tallies, 0).n,
    ...(gateBar(tallies, target, profile.minSupport) ?? {}),
  }));
}

/**
 * The act bar `profile` supports for a `target` promise, by the cautious end; undefined when
 * no edge holds on every well-supported donor gate. A target the profile was not built for
 * is read the same way, from the same bins.
 */
export function borrowedBar(profile: CalibrationProfile, target: number): number | undefined {
  checkTarget(target);
  return cautiousBar(talliesOf(profile.bins, profile.resolution), target, profile.minSupport)?.bar;
}

/** The borrowed evidence a grade carries for `target`, or undefined when there is no bar. */
export function profileVia(
  profile: CalibrationProfile,
  target: number,
): Extract<BorrowedVia, { type: "profile" }> | undefined {
  const bar = borrowedBar(profile, target);
  return bar === undefined
    ? undefined
    : { type: "profile", profileHash: profile.hash, bar, donor: profile.from };
}

/** Hash of what a profile claims: format, key, levers, bars and bins, in canonical order. */
export function profileHash(
  p: Pick<
    CalibrationProfile,
    "format" | "key" | "targets" | "minSupport" | "resolution" | "bars" | "bins"
  >,
): string {
  const byNumber = (x: readonly number[], y: readonly number[]) => (x[0] ?? 0) - (y[0] ?? 0);
  return hashState(
    JSON.stringify({
      format: p.format,
      key: [p.key.model, p.key.kind, p.key.questionHash ?? null],
      targets: [...p.targets].sort((x, y) => x - y),
      minSupport: p.minSupport,
      resolution: p.resolution,
      bars: p.bars.map((b) => [b.target, b.bar, b.support]).sort(byNumber),
      bins: p.bins
        .map((b) => [b.gate, b.lo, b.hi, b.n, b.meanConfidence, b.accuracy] as const)
        .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1])),
    }),
  );
}

/**
 * True when `profile` describes the answers `gate` gets: the same exact model, the same
 * question kind, and the same rubric when the profile is keyed to one. A gate whose model pin
 * moves off the key never matches, which is how a profile expires: calibration belongs to a
 * model version, and an upgrade starts from nothing.
 */
export function profileMatches(profile: CalibrationProfile, gate: ProfileGate): boolean {
  const k = profile.key;
  return (
    k.model === gate.model &&
    k.kind === gate.kind &&
    (k.questionHash === undefined || k.questionHash === gate.questionHash)
  );
}

/** Days from the newest row a profile read to `now`: how old the calibration it lends is. */
export function profileAge(profile: CalibrationProfile, now: Date): number {
  return (now.getTime() - Date.parse(profile.from.lastAt)) / 86_400_000;
}

/** "<model> <kind> questions", and the rubric when the key names one. */
export const keyText = (k: ProfileKey): string =>
  `${k.model} ${k.kind} questions${k.questionHash !== undefined ? ` of rubric ${k.questionHash}` : ""}`;

function checkKey(key: ProfileKey): void {
  if (typeof key.model !== "string" || key.model.trim() === "") {
    throw new Error("a profile key needs the exact model pin");
  }
  if (!KINDS.includes(key.kind)) {
    throw new Error(`question kind must be judge, pick or rate, got "${String(key.kind)}"`);
  }
  const h = key.questionHash as unknown;
  if (h !== undefined && (typeof h !== "string" || h.trim() === "")) {
    throw new Error("a profile key's question hash must be non-empty");
  }
}

function checkTarget(t: unknown): void {
  if (!(typeof t === "number" && t > 0 && t <= 1)) {
    throw new Error(`a target must be in (0, 1], got ${String(t)}`);
  }
}

function checkLevers(
  targets: readonly number[],
  minSupport: number,
  resolution: number,
  ledgers: readonly string[],
): void {
  if (targets.length === 0) throw new Error("a profile needs at least one target");
  for (const t of targets) checkTarget(t);
  if (!Number.isSafeInteger(minSupport) || minSupport < 1) {
    throw new Error("minSupport must be a positive integer");
  }
  // A thousandth is finer than any decision model states its confidence.
  if (!Number.isSafeInteger(resolution) || resolution < 1 || resolution > 1000) {
    throw new Error("resolution must be a whole number of bins from 1 to 1000");
  }
  if (ledgers.length === 0) throw new Error("a profile must name the ledgers it read");
  for (const l of ledgers as readonly unknown[]) {
    if (typeof l !== "string" || l.trim() === "")
      throw new Error("a ledger name must be non-empty");
  }
}

function profileSources(sources: readonly FitClass[] | undefined): readonly FitClass[] {
  if (sources === undefined) return TRUSTED_SOURCES;
  if (sources.length === 0) throw new Error("sources must name at least one trust class");
  for (const c of sources as readonly unknown[]) {
    if (!isTrustClass(c)) throw new Error(`unknown trust class "${String(c)}"`);
    if (c === "consequence") throw new Error("consequence labels never fit a bar");
  }
  return sources;
}
