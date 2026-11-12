/**
 * A calibration profile on its way to a gate: read from data that claims to be one and checked,
 * then matched to the gate's own rows to say what it borrows and whether that is stale.
 * Borrowed evidence arrives from outside the ledger, so nothing about it is taken on trust: a
 * profile whose bars or hash are not what its bins give is refused rather than lent.
 */

import type { BorrowedVia, ProfileProvenance } from "./evidence.ts";
import { type DecisionRecord, decisionRows, settledWithoutAnswer } from "./ledger.ts";
import {
  type CalibrationProfile,
  type ProfileBin,
  type ProfileGate,
  type ProfileKey,
  profileFrom,
  profileMatches,
  profileVia,
} from "./profile.ts";

/**
 * Read a profile from data that claims to be one (a parsed file, or an object built in code)
 * and return it in canonical form. Its shape is checked, its provenance must count what its
 * bins hold, and its bars and hash must be what its bins give: a profile edited by hand, or
 * cut short, is refused. Throws, saying what is wrong.
 */
export function parseProfile(data: unknown): CalibrationProfile {
  const o = record(data, "a profile");
  if (o.format !== 1) throw new Error(`profile format ${String(o.format)} is not format 1`);
  const k = record(o.key, "key");
  const key = {
    model: k.model,
    kind: k.kind,
    ...(k.questionHash !== undefined ? { questionHash: k.questionHash } : {}),
  } as ProfileKey;
  const resolution = o.resolution;
  if (!Number.isSafeInteger(resolution) || (resolution as number) < 1) {
    throw new Error("a profile must say its resolution, the number of equal bins it holds");
  }
  const bins = list(o.bins, "bins").map((b) => readBin(b, resolution as number));
  if (new Set(bins.map((b) => `${b.gate}\u0000${b.lo}`)).size !== bins.length) {
    throw new Error("a profile lists one gate's bin twice");
  }
  const from = readFrom(o.from);
  const rows = bins.reduce((s, b) => s + b.n, 0);
  if (from.rows !== rows) throw new Error(`a profile's provenance must count its ${rows} rows`);
  if (Object.values(from.sources).reduce((s, c) => s + c, 0) !== rows) {
    throw new Error("a profile's label sources must add up to its rows");
  }
  const gates = [...new Set(bins.map((b) => b.gate))].sort();
  if ([...new Set(from.gates)].sort().join("\u0000") !== gates.join("\u0000")) {
    throw new Error("a profile's provenance must name the gates its bins hold");
  }
  const p = profileFrom({
    key,
    targets: list(o.targets, "targets") as number[],
    minSupport: o.minSupport as number,
    resolution: resolution as number,
    bins,
    from,
  });
  const bars = list(o.bars, "bars").map((b) => record(b, "a bar"));
  const same =
    bars.length === p.bars.length &&
    p.bars.every((b, i) => {
      const x = bars[i];
      return x?.target === b.target && x.bar === b.bar && x.support === b.support;
    });
  if (!same || o.hash !== p.hash) {
    throw new Error("a profile's bars and hash must be what its bins give; rebuild it");
  }
  return p;
}

function readBin(raw: unknown, resolution: number): ProfileBin {
  const b = record(raw, "a bin");
  const at = Math.round(Number(b.lo) * resolution);
  const fraction = (x: unknown) => typeof x === "number" && x >= 0 && x <= 1;
  const edges =
    at >= 0 && at < resolution && b.lo === at / resolution && b.hi === (at + 1) / resolution;
  if (typeof b.gate !== "string" || b.gate === "" || !edges) {
    throw new Error(`a profile bin must name its gate and one of the ${resolution} equal bins`);
  }
  if (!Number.isSafeInteger(b.n) || (b.n as number) < 1) {
    throw new Error("a profile bin must hold at least one row");
  }
  if (!fraction(b.meanConfidence) || !fraction(b.accuracy)) {
    throw new Error("a profile bin's mean confidence and accuracy must be in [0, 1]");
  }
  return {
    gate: b.gate,
    lo: b.lo as number,
    hi: b.hi as number,
    n: b.n as number,
    meanConfidence: b.meanConfidence as number,
    accuracy: b.accuracy as number,
  };
}

function readFrom(raw: unknown): ProfileProvenance {
  const f = record(raw, "from");
  const s = record(f.sources, "from.sources");
  const strings = (x: unknown, what: string): string[] => {
    const xs = list(x, what);
    if (xs.some((v) => typeof v !== "string" || v === "")) throw new Error(`${what} must be names`);
    return xs as string[];
  };
  if (
    ![s.blind, s.census, s.moment, s.unknown].every(
      (c) => Number.isSafeInteger(c) && (c as number) >= 0,
    )
  ) {
    throw new Error("a profile's label sources must be counts");
  }
  const firstAt = f.firstAt;
  const lastAt = f.lastAt;
  if (
    typeof firstAt !== "string" ||
    typeof lastAt !== "string" ||
    !(Date.parse(firstAt) <= Date.parse(lastAt))
  ) {
    throw new Error("a profile must be dated by its oldest and newest rows, in order");
  }
  return {
    rows: f.rows as number,
    gates: strings(f.gates, "from.gates"),
    ledgers: strings(f.ledgers, "from.ledgers"),
    firstAt,
    lastAt,
    sources: {
      blind: s.blind as number,
      census: s.census as number,
      moment: s.moment as number,
      unknown: s.unknown as number,
    },
  };
}

const record = (x: unknown, what: string): Record<string, unknown> => {
  if (typeof x !== "object" || x === null || Array.isArray(x)) {
    throw new Error(`${what} must be an object`);
  }
  return x as Record<string, unknown>;
};

const list = (x: unknown, what: string): unknown[] => {
  if (!Array.isArray(x)) throw new Error(`${what} must be a list`);
  return x;
};

export interface Borrowing {
  readonly via: Extract<BorrowedVia, { type: "profile" }>;
  /** The gate declared this profile as its bar's source and has since moved off its key. */
  readonly stale: boolean;
}

export interface BorrowOptions {
  /** The promise the bar is read for. */
  readonly target: number;
  /** The gate's declared model pin. Default the model its newest answered row recorded. */
  readonly model?: string;
}

/**
 * What a gate borrows, read from its rows in ledger order. The gate is described by its newest
 * answered decision row: its model (or the declared pin), question kind and rubric; a row that
 * pooled answers describes nothing a profile of single answers can match. A gate whose newest
 * row records a `barSource` borrows only that profile, when it is among `profiles`, and reads
 * it as stale once the gate no longer matches its key. Any other gate borrows from the first
 * profile that matches it, one keyed to its rubric before one keyed to its kind alone, and
 * never shops past that one for a profile with a bar. With a pin (`model`), a profile is
 * matched against the pin, and the borrowing is stale once the newest answered row reports
 * another model: the oracle has moved off the pin, so the bar describes a model that no longer
 * answers and rows the pinned rollout will never read. Undefined when nothing matches or the
 * profile has no bar for the target. Whether to borrow at all (until the gate's own labels
 * grade it estimated) is the caller's question.
 */
export function borrowFor(
  rows: readonly DecisionRecord[],
  profiles: readonly CalibrationProfile[],
  opts: BorrowOptions,
): Borrowing | undefined {
  const decisions = decisionRows(rows);
  const answered = decisions.filter((r) => !r.failedOpen && !settledWithoutAnswer(r)).at(-1);
  const model = opts.model ?? answered?.model;
  const gate: ProfileGate | undefined =
    answered === undefined || answered.strategy !== "single" || model === undefined
      ? undefined
      : {
          model,
          kind: answered.kind,
          ...(typeof answered.questionHash === "string"
            ? { questionHash: answered.questionHash }
            : {}),
        };
  const offPin =
    opts.model !== undefined && answered?.model !== undefined && answered.model !== opts.model;
  const declared = barSourceOf(decisions.at(-1));
  if (declared !== undefined) {
    const p = profiles.find((x) => x.hash === declared);
    const via = p === undefined ? undefined : profileVia(p, opts.target);
    if (p === undefined || via === undefined) return undefined;
    const moved = answered !== undefined && (gate === undefined || !profileMatches(p, gate));
    return { via, stale: moved || offPin };
  }
  if (gate === undefined) return undefined;
  const keyed = (p: CalibrationProfile) => p.key.questionHash !== undefined;
  const chosen = [...profiles.filter(keyed), ...profiles.filter((p) => !keyed(p))].find((p) =>
    profileMatches(p, gate),
  );
  const via = chosen === undefined ? undefined : profileVia(chosen, opts.target);
  return via === undefined ? undefined : { via, stale: offPin };
}

/** The profile hash a row's `detail.barSource` names, read loosely, since rows are data. */
function barSourceOf(r: DecisionRecord | undefined): string | undefined {
  const source = r?.detail?.barSource;
  if (typeof source !== "object" || source === null) return undefined;
  const hash = (source as Record<string, unknown>).profileHash;
  return typeof hash === "string" && hash !== "" ? hash : undefined;
}
