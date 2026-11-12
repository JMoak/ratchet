/**
 * An independent scorer for wave 3 (V2): reads a JSONL ledger and recomputes the act bar, the
 * point bar, coverage, the evidence grade and the battery saturation readout from the raw rows,
 * written from the documented semantics alone. It imports nothing from `src/`, so a defect in
 * the code under test cannot leak into the numbers it is checked against.
 */
import { readFileSync } from "node:fs";

export type Kind = "judge" | "pick" | "rate";

export interface Row {
  id: string;
  at: string;
  gateId: string;
  requestId: string;
  combined: boolean;
  questionId: string;
  kind: Kind;
  questionHash: string;
  policyHash: string | undefined;
  evidenceVersion: string | undefined;
  stateHash: string;
  model: string | undefined;
  strategy: string;
  pYes: number | undefined;
  choice: string | undefined;
  level: string | undefined;
  go: number;
  confidence: number;
  soft: string;
  action: string;
  mode: string;
  failedOpen: boolean;
  tags: string[];
  detail: Record<string, unknown> | undefined;
  members: { key: string; model: string | undefined; failedOpen: boolean; verdict: Verdict }[];
  outcome: Outcome | undefined;
}

export interface Verdict {
  kind: Kind;
  pYes?: number;
  choice?: string;
  level?: string;
  confidence?: number;
}

export interface Outcome {
  correct: boolean;
  truth: boolean | string | undefined;
  source: string | undefined;
  at: string | undefined;
}

const obj = (x: unknown): Record<string, unknown> | undefined =>
  typeof x === "object" && x !== null && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : undefined;
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);
const num = (x: unknown, d: number): number => (typeof x === "number" ? x : d);

function toVerdict(v: Record<string, unknown>): Verdict {
  const kind = (str(v.kind) ?? "judge") as Kind;
  return {
    kind,
    ...(typeof v.pYes === "number" ? { pYes: v.pYes } : {}),
    ...(typeof v.choice === "string" ? { choice: v.choice } : {}),
    ...(typeof v.level === "string" ? { level: v.level } : {}),
    ...(typeof v.confidence === "number" ? { confidence: v.confidence } : {}),
  };
}

function toOutcome(o: Record<string, unknown>): Outcome {
  const t = o.truth;
  return {
    correct: o.correct === true,
    truth: typeof t === "boolean" || typeof t === "string" ? t : undefined,
    source: str(o.source),
    at: str(o.at),
  };
}

function toRow(r: Record<string, unknown>): Row | undefined {
  const v = obj(r.verdict);
  if (typeof r.id !== "string" || typeof r.questionId !== "string" || v === undefined) {
    return undefined;
  }
  const verdict = toVerdict(v);
  const members = Array.isArray(r.members)
    ? r.members.flatMap((m) => {
        const mm = obj(m);
        const mv = mm === undefined ? undefined : obj(mm.verdict);
        if (mm === undefined || mv === undefined) return [];
        return [
          {
            key: str(mm.key) ?? "",
            model: str(mm.model),
            failedOpen: mm.failedOpen === true,
            verdict: toVerdict(mv),
          },
        ];
      })
    : [];
  const confidence = num(r.confidence, num(verdict.confidence, 0));
  return {
    id: r.id,
    at: str(r.at) ?? "",
    gateId: str(r.gateId) || r.questionId,
    requestId: str(r.requestId) || r.id,
    combined: r.combined === true,
    questionId: r.questionId,
    kind: verdict.kind,
    questionHash: str(r.questionHash) ?? "",
    policyHash: str(r.policyHash),
    evidenceVersion: str(r.evidenceVersion),
    stateHash: str(r.stateHash) ?? "",
    model: str(r.model),
    strategy: str(r.strategy) ?? "single",
    pYes: verdict.pYes,
    choice: verdict.choice,
    level: verdict.level,
    go: num(r.go, confidence),
    confidence,
    soft: str(r.soft) ?? "review",
    action: str(r.action) ?? "review",
    mode: str(r.mode) ?? "shadow",
    failedOpen: r.failedOpen === true,
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [],
    detail: obj(r.detail),
    members,
    outcome: undefined,
  };
}

/** Decision lines (first id wins) with their latest outcome line joined, in file order. */
export function readLedger(path: string): Row[] {
  const byId = new Map<string, Row>();
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    const l = obj(line);
    if (l === undefined) continue;
    if (l.type === "outcome") {
      const id = str(l.id);
      const o = obj(l.outcome);
      const row = id === undefined ? undefined : byId.get(id);
      if (row !== undefined && o !== undefined) row.outcome = toOutcome(o);
      continue;
    }
    const rec = l.type === "decision" ? obj(l.record) : l;
    const row = rec === undefined ? undefined : toRow(rec);
    if (row !== undefined && !byId.has(row.id)) byId.set(row.id, row);
  }
  return [...byId.values()];
}

/** Write rows back as a ledger a CLI can read (decision lines, then outcome lines). */
export function ledgerLines(path: string, keep: (r: Record<string, unknown>) => boolean): string {
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  const kept = new Set<string>();
  const out: string[] = [];
  const outcomes: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    const l = obj(JSON.parse(raw));
    if (l === undefined) continue;
    if (l.type === "outcome") {
      outcomes.push(raw);
      continue;
    }
    const rec = obj(l.record);
    if (rec !== undefined && keep(rec)) {
      kept.add(String(rec.id));
      out.push(raw);
    }
  }
  for (const raw of outcomes) {
    const l = obj(JSON.parse(raw));
    if (l !== undefined && kept.has(String(l.id))) out.push(raw);
  }
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Trust: the documented default registry, re-implemented.
// ---------------------------------------------------------------------------

export type Trust = "blind" | "census" | "moment" | "consequence" | "unknown" | "unregistered";

const REGISTRY: Record<string, Trust> = {
  "review:blind": "blind",
  "keywork:person": "census",
  "claude-code:person": "census",
  "codex:person": "census",
  "desk:assisted": "moment",
  "accepted:*": "consequence",
  "reverted:*": "consequence",
  "silence:*": "consequence",
};

export function trustOf(source: string | undefined): Trust {
  if (source === undefined) return "unknown";
  const parts = source.split(":");
  const channel = parts[0] ?? "";
  const kind = parts[1] ?? "";
  if (channel === "" || kind === "" || parts.length < 2) return "unregistered";
  if (parts.length >= 3 && parts.slice(2).join(":") === "") return "unregistered";
  return REGISTRY[`${channel}:${kind}`] ?? REGISTRY[`${channel}:*`] ?? "unregistered";
}

const FIT: readonly Trust[] = ["blind", "census", "unknown"];
export const fitTrusted = (r: Row): boolean =>
  r.outcome !== undefined && FIT.includes(trustOf(r.outcome.source));

// ---------------------------------------------------------------------------
// Row classes
// ---------------------------------------------------------------------------

export const settled = (r: Row): boolean => r.strategy === "floored" || r.strategy === "bypass";

export function attemptOf(r: Row): number | undefined {
  for (const t of r.tags) {
    const m = /^chain:attempt:(\d+)$/.exec(t);
    if (m) return Number(m[1]);
  }
  return undefined;
}

export const unselected = (r: Row): boolean =>
  (r.mode === "shadow" || r.tags.includes("audit")) && (attemptOf(r) ?? 1) < 2;

/** Rows that are decisions: battery members (rows sharing gate and request with a combined row) excluded. */
export function decisions(rows: readonly Row[]): Row[] {
  const key = (r: Row) => `${r.gateId}\u0000${r.requestId}`;
  const batteries = new Set(rows.filter((r) => r.combined).map(key));
  return rows.filter((r) => r.combined || !batteries.has(key(r)));
}

/** Battery member rows, by `<gate>/<question>`. */
export function members(rows: readonly Row[]): Map<string, Row[]> {
  const key = (r: Row) => `${r.gateId}\u0000${r.requestId}`;
  const batteries = new Set(rows.filter((r) => r.combined).map(key));
  const out = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.combined || !batteries.has(key(r))) continue;
    const k = `${r.gateId}/${r.questionId}`;
    const list = out.get(k) ?? [];
    list.push(r);
    out.set(k, list);
  }
  return out;
}

/**
 * The current configuration (round 2 rule): the newest decision row's evidence version,
 * gate-wide; per question id, the newest policy and rubric recorded for it.
 */
export function current(rows: readonly Row[]): { now: Row[]; older: Row[] } {
  const newest = decisions(rows).at(-1);
  if (newest === undefined) return { now: [], older: rows.slice() };
  const latest = new Map<string, Row>();
  for (const r of rows) latest.set(r.questionId, r);
  const now: Row[] = [];
  const older: Row[] = [];
  for (const r of rows) {
    const mine = latest.get(r.questionId);
    const ok =
      r.evidenceVersion === newest.evidenceVersion &&
      r.policyHash === mine?.policyHash &&
      r.questionHash === mine?.questionHash;
    (ok ? now : older).push(r);
  }
  return { now, older };
}

// ---------------------------------------------------------------------------
// The act side
// ---------------------------------------------------------------------------

/** Which side was go on this row, read from its own `go`; undefined when it cannot tell. */
export function rowGoIsYes(r: Row): boolean | undefined {
  if (r.kind !== "judge" || r.failedOpen || r.pYes === undefined) return undefined;
  if (Math.abs(r.pYes - 0.5) < 1e-9) return undefined;
  if (Math.abs(r.go - r.pYes) < 1e-9) return true;
  if (Math.abs(r.go - (1 - r.pYes)) < 1e-9) return false;
  return undefined;
}

export function majorityGoIsYes(rows: readonly Row[]): boolean {
  let yes = 0;
  let no = 0;
  for (const r of rows) {
    const g = rowGoIsYes(r);
    if (g === true) yes++;
    else if (g === false) no++;
  }
  return yes >= no;
}

/** Would acting on this labelled row have been right? */
export function actRight(r: Row, goIsYes: boolean): boolean | undefined {
  const o = r.outcome;
  if (o === undefined) return undefined;
  if (r.kind !== "judge") return o.correct;
  if (typeof o.truth === "boolean") return o.truth === goIsYes;
  const goLeads = (r.pYes ?? 0.5) >= 0.5 === goIsYes;
  return goLeads ? o.correct : !o.correct;
}

/** The probability that acting is right, as the policy read it. */
export function goProb(r: Row, goIsYes: boolean): number {
  if (r.kind === "judge") return goIsYes ? (r.pYes ?? 0.5) : 1 - (r.pYes ?? 0.5);
  return r.confidence;
}

export interface Item {
  p: number;
  right: boolean;
}

/** Labelled, answered, trusted rows scored on the act side. */
export function actItems(rows: readonly Row[], onlyUnselected: boolean, fallback: boolean): Item[] {
  const out: Item[] = [];
  for (const r of rows) {
    if (r.outcome === undefined || r.failedOpen || settled(r) || !fitTrusted(r)) continue;
    if (onlyUnselected && !unselected(r)) continue;
    const g = rowGoIsYes(r) ?? fallback;
    const right = actRight(r, g);
    if (right === undefined) continue;
    const p = goProb(r, g);
    if (Number.isFinite(p)) out.push({ p, right });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export function wilson(p: number, n: number, z = 1.96): { lower: number; upper: number } {
  if (n === 0) return { lower: 0, upper: 1 };
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denom = 1 + z2 / n;
  return {
    lower: Math.max(0, (centre - spread) / denom),
    upper: Math.min(1, (centre + spread) / denom),
  };
}

function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/** P(X >= k) for X ~ Binomial(n, p). */
function upperTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let s = 0;
  for (let i = k; i <= n; i++) {
    s += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.min(1, s);
}

/** Exact one-sided (Clopper-Pearson) lower bound on a proportion, by bisection. */
export function exactLower(successes: number, n: number, confidence = 0.95): number {
  if (n === 0 || successes === 0) return 0;
  const alpha = 1 - confidence;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (upperTail(successes, n, mid) < alpha) lo = mid;
    else hi = mid;
  }
  return lo;
}

export interface Bar {
  threshold: number;
  n: number;
  right: number;
  accuracy: number;
  coverage: number;
}

/** Every distinct threshold, highest first, with the rows at or above it. */
export function curve(items: readonly Item[]): Bar[] {
  const sorted = items.slice().sort((a, b) => b.p - a.p);
  const out: Bar[] = [];
  let right = 0;
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i] as Item;
    if (s.right) right++;
    const next = sorted[i + 1];
    if (next !== undefined && next.p === s.p) continue;
    out.push({
      threshold: s.p,
      n: i + 1,
      right,
      accuracy: right / (i + 1),
      coverage: (i + 1) / sorted.length,
    });
  }
  return out;
}

/** The lowest threshold whose rows at or above it clear the target (point or Wilson lower), with support. */
export function lowestBar(
  items: readonly Item[],
  target: number,
  minSupport: number,
  conservative: boolean,
): Bar | undefined {
  let best: Bar | undefined;
  for (const b of curve(items)) {
    const score = conservative ? wilson(b.accuracy, b.n).lower : b.accuracy;
    if (b.n >= minSupport && score >= target) best = b;
  }
  return best;
}

/** What acting at `bar` delivers on `items`. */
export function deliveredAt(items: readonly Item[], bar: number): { n: number; right: number } {
  const above = items.filter((i) => i.p >= bar);
  return { n: above.length, right: above.filter((i) => i.right).length };
}

// ---------------------------------------------------------------------------
// The whole readout for one group of rows (one gate's decisions, or one member's rows)
// ---------------------------------------------------------------------------

export interface Levers {
  target: number;
  minSupport: number;
  minEstimated: number;
}

export interface Readout {
  fittedFrom?: "unselected" | "all";
  fitRows?: number;
  fitted?: Bar;
  point?: Bar;
  grade:
    | { kind: "measured"; sample: number; lowerBound: number }
    | {
        kind: "estimated";
        n: number;
        accuracy: number;
        lower: number;
        upper: number;
        older: number;
      }
    | { kind: "none"; labelled: number; unselected: number; older: number }
    | { kind: "rejected-or-collecting"; note: string };
  battery?: { verdicts: number; saturated: number };
  labelledAll: number;
  unselectedAll: number;
  /** Rows of an older configuration, and observed accuracy on the current one's counted labels. */
  olderRows: number;
  observed?: number;
}

/** Smallest zero-error sample whose exact lower bound reaches the target. */
export function plannedActs(target: number, confidence = 0.95): number {
  return Math.ceil(Math.log(1 - confidence) / Math.log(target) - 1e-12);
}

export function readout(rows: readonly Row[], lv: Levers, measurable: boolean): Readout {
  const { now, older } = current(rows);
  const fallback = majorityGoIsYes(now);
  const trusted = actItems(now, false, fallback);
  const unsel = actItems(now, true, fallback);
  const out: Readout = {
    grade: { kind: "none", labelled: 0, unselected: 0, older: 0 },
    labelledAll: 0,
    unselectedAll: 0,
    olderRows: older.length,
  };
  // Round 2: the report's columns read the current configuration.
  const answered = now.filter((r) => r.outcome !== undefined && !r.failedOpen && !settled(r));
  const counted = (r: Row) => {
    const t = trustOf(r.outcome?.source);
    return t === "blind" || t === "census" || t === "moment" || t === "unknown";
  };
  out.labelledAll = answered.filter(counted).length;
  out.unselectedAll = answered.filter((r) => fitTrusted(r) && unselected(r)).length;
  const counts = answered.filter(counted);
  if (counts.length > 0)
    out.observed = counts.filter((r) => r.outcome?.correct === true).length / counts.length;
  if (trusted.length > 0) {
    const onUnsel = unsel.length >= lv.minSupport;
    const set = onUnsel ? unsel : trusted;
    out.fittedFrom = onUnsel ? "unselected" : "all";
    out.fitRows = set.length;
    const f = lowestBar(set, lv.target, lv.minSupport, true);
    const p = lowestBar(set, lv.target, lv.minSupport, false);
    if (f !== undefined) out.fitted = f;
    if (p !== undefined) out.point = p;
  }
  // Measured: the first acts of the current shadow phase, zero wrong, exact bound.
  let measured: Readout["grade"] | undefined;
  if (measurable && lv.target < 1) {
    const dec = decisions(rows);
    const newest = dec.at(-1);
    if (newest !== undefined) {
      const scoped = dec.filter(
        (r) =>
          r.gateId === newest.gateId &&
          r.policyHash === newest.policyHash &&
          r.questionHash === newest.questionHash &&
          r.evidenceVersion === newest.evidenceVersion,
      );
      let end = scoped.length;
      while (end > 0 && scoped[end - 1]?.mode === "enforce") end--;
      let start = end;
      while (start > 0 && scoped[start - 1]?.mode !== "enforce") start--;
      const phase = scoped.slice(start, end).filter((r) => r.mode === "shadow");
      const size = plannedActs(lv.target);
      const seen = new Set<string>();
      const sample: Row[] = [];
      for (const r of phase) {
        if (sample.length === size) break;
        if (r.soft !== "act" || r.failedOpen || settled(r)) continue;
        const k = `${r.gateId}\u0000${r.questionHash}\u0000${r.stateHash}`;
        if (seen.has(k)) continue;
        seen.add(k);
        sample.push(r);
      }
      if (sample.length === size && sample.every((r) => fitTrusted(r))) {
        const wrong = sample.filter((r) => {
          const g = rowGoIsYes(r);
          if (r.kind === "judge" && g === undefined) return true;
          return actRight(r, g ?? true) !== true;
        }).length;
        const lb = exactLower(size - wrong, size);
        if (wrong === 0 && lb >= lv.target) {
          measured = { kind: "measured", sample: size, lowerBound: lb };
        }
      }
    }
  }
  const readable = (r: Row) =>
    r.outcome !== undefined && !r.failedOpen && !settled(r) && fitTrusted(r);
  const lab = now.filter(readable);
  const uns = lab.filter(unselected);
  const olderUns = older.filter((r) => readable(r) && unselected(r)).length;
  if (measured !== undefined) out.grade = measured;
  else if (uns.length >= lv.minEstimated) {
    const acc = uns.filter((r) => r.outcome?.correct === true).length / uns.length;
    const w = wilson(acc, uns.length);
    out.grade = {
      kind: "estimated",
      n: uns.length,
      accuracy: acc,
      lower: w.lower,
      upper: w.upper,
      older: olderUns,
    };
  } else {
    out.grade = { kind: "none", labelled: lab.length, unselected: uns.length, older: olderUns };
  }
  const combined = now.filter(
    (r) =>
      r.combined &&
      !r.failedOpen &&
      !settled(r) &&
      r.kind === "judge" &&
      r.pYes !== undefined &&
      Number.isFinite(r.pYes),
  );
  if (combined.length > 0) {
    out.battery = {
      verdicts: combined.length,
      saturated: combined.filter((r) => Math.min(r.pYes ?? 0.5, 1 - (r.pYes ?? 0.5)) < 0.001)
        .length,
    };
  }
  return out;
}

export const pct = (x: number, d = 1): string => `${(100 * x).toFixed(d)}%`;
