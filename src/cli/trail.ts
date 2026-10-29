import type { DecisionRecord, Mode } from "../ledger/ledger.ts";
import type { Action, QuestionKind, Verdict } from "../types.ts";
import { CliError, ledgerPath, numberFlag, parseArgs } from "./args.ts";
import {
  byTime,
  type CommandResult,
  dec,
  findGate,
  gateIdOf,
  groupGates,
  isCombined,
  isFixed,
  loadLedger,
  msec,
  requestIdOf,
  runCommand,
  table,
  usd,
} from "./common.ts";

export const TRAIL_USAGE = `Usage: ratchet trail <ledger> [--gate <id>] [--request <id>] [--last <n>] [--json]

How was each decision reached? One section per request, oldest first: the question, the
strategy, every member answer it bought (an ensemble's votes, a cascade's tiers, a
sequential run's samples, a battery's rows), the pooled verdict, the ruling and the floor
that bounded it, what the application did, and the label when one has arrived.

  --gate <id>        Only this gate. Default: every gate, interleaved by time.
  --request <id>     One request, by request id or decision id (a prefix of at least 6
                     characters will do). Overrides --last.
  --last <n>         The newest n requests. Default 10.
  --json             JSON instead of text.

Member answers exist on rows written since members were recorded; older compound rows show
the pooled verdict alone. The act bar printed per gate is inferred from the recorded rulings
(between the highest go that was not acted on and the lowest that was), never from the
policy itself, which the ledger stores only as a hash.
`;

export interface TrailMember {
  /** 1-based position in the order the answers were bought. */
  readonly index: number;
  /** A battery member's question id; a compound member's oracle id. */
  readonly name: string;
  readonly oracle: string;
  readonly model?: string;
  /** The leading answer: yes or no, the chosen option, the most probable level. */
  readonly answer: string;
  /** p(yes) for a judge answer, so judge members can sit on one scale. */
  readonly pYes?: number;
  readonly confidence: number;
  readonly failedOpen: boolean;
  readonly error?: string;
  readonly cost: number;
  readonly latencyMs: number;
  /** What this answer did to the run: "settled", "escalated", "dropped". */
  readonly role?: string;
  /** A battery member's own inherited label. */
  readonly correct?: boolean;
}

export interface TrailOutcome {
  readonly at: string;
  readonly correct: boolean;
  readonly truth?: string | boolean;
  readonly source?: string;
  readonly note?: string;
}

/** One decision as the ledger lets it be read back: the ruling row plus the answers behind it. */
export interface TrailEntry {
  readonly id: string;
  readonly requestId: string;
  readonly at: string;
  readonly gate: string;
  readonly question: string;
  readonly kind: QuestionKind;
  readonly strategy: string;
  readonly oracle: string;
  readonly model?: string;
  readonly answer: string;
  readonly pYes?: number;
  readonly go: number;
  readonly confidence: number;
  readonly agreement: number;
  readonly soft: Action;
  readonly action: Action;
  readonly mode: Mode;
  readonly floor?: Action;
  /** Decided by a floor or an allowlist without an answer. */
  readonly fixed: boolean;
  readonly failedOpen: boolean;
  readonly error?: string;
  /** An act diverted to review as a blind audit. */
  readonly audited: boolean;
  /** The request's spend: the ruling row's cost plus its members' when they are rows. */
  readonly cost: number;
  readonly latencyMs: number;
  readonly tags: readonly string[];
  readonly stateHash: string;
  readonly trustedHash: string;
  readonly untrusted: readonly string[];
  readonly policyHash?: string;
  readonly evidenceVersion?: string;
  readonly members: readonly TrailMember[];
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly outcome?: TrailOutcome;
}

/** Where a gate's act bar must lie, read off the rulings it recorded under one policy hash. */
export interface InferredBar {
  readonly gate: string;
  readonly policyHash?: string;
  /** Answered, unfloored rows the inference used. */
  readonly rows: number;
  /** The highest go that was not acted on; the bar is above it. */
  readonly above?: number;
  /** The lowest go that was acted on; the bar is at or below it. */
  readonly atOrBelow?: number;
  /** False when some non-act row sits above an act row: the rulings do not fit one bar. */
  readonly consistent: boolean;
}

export interface Trail {
  readonly ledger: string;
  /** Decisions in the ledger (battery members not counted) before any filter. */
  readonly total: number;
  readonly gate?: string;
  readonly bars: readonly InferredBar[];
  readonly entries: readonly TrailEntry[];
}

export interface TrailOptions {
  readonly gate?: string;
  readonly request?: string;
  readonly last?: number;
}

const leading = (v: Verdict): string =>
  v.kind === "judge" ? (v.pYes >= 0.5 ? "yes" : "no") : v.kind === "pick" ? v.choice : v.level;

const pYesOf = (v: Verdict): { pYes: number } | Record<never, never> =>
  v.kind === "judge" ? { pYes: v.pYes } : {};

const extra = (r: DecisionRecord, key: string): unknown =>
  (r as unknown as Record<string, unknown>)[key];

function memberOfRow(index: number, r: DecisionRecord): TrailMember {
  return {
    index,
    name: r.questionId,
    oracle: r.oracle,
    ...(r.model !== undefined ? { model: r.model } : {}),
    answer: r.failedOpen ? "failed open" : leading(r.verdict),
    ...pYesOf(r.verdict),
    confidence: r.confidence,
    failedOpen: r.failedOpen,
    ...(r.error !== undefined ? { error: r.error } : {}),
    cost: r.cost,
    latencyMs: r.latencyMs,
    ...(r.outcome ? { correct: r.outcome.correct } : {}),
  };
}

/** Member answers recorded on a compound row, read loosely so hand-written rows cannot crash it. */
function membersOf(r: DecisionRecord): TrailMember[] {
  const raw = extra(r, "members");
  if (!Array.isArray(raw)) return [];
  const detail = (extra(r, "detail") ?? {}) as Record<string, unknown>;
  const settledTier = r.strategy === "cascade" ? detail.tier : undefined;
  const settledSample =
    r.strategy === "sequential" && detail.settled === true ? raw.length - 1 : undefined;
  const out: TrailMember[] = [];
  raw.forEach((m: unknown, i: number) => {
    if (typeof m !== "object" || m === null) return;
    const o = m as Record<string, unknown>;
    const v = o.verdict as Verdict | undefined;
    if (!v || typeof v !== "object") return;
    const failedOpen = o.failedOpen === true;
    const role = failedOpen
      ? "dropped"
      : settledTier === i
        ? "settled"
        : settledTier !== undefined && i < (settledTier as number)
          ? "escalated"
          : settledSample === i
            ? "settled"
            : undefined;
    out.push({
      index: i + 1,
      name: typeof o.oracle === "string" ? o.oracle : "?",
      oracle: typeof o.oracle === "string" ? o.oracle : "?",
      ...(typeof o.model === "string" ? { model: o.model } : {}),
      answer: failedOpen ? "failed open" : leading(v),
      ...pYesOf(v),
      confidence: typeof v.confidence === "number" ? v.confidence : 0,
      failedOpen,
      ...(typeof o.error === "string" ? { error: o.error } : {}),
      cost: typeof o.cost === "number" ? o.cost : 0,
      latencyMs: typeof o.latencyMs === "number" ? o.latencyMs : 0,
      ...(role !== undefined ? { role } : {}),
    });
  });
  return out;
}

function entryOf(r: DecisionRecord, memberRows: readonly DecisionRecord[]): TrailEntry {
  const members =
    memberRows.length > 0 ? byTime(memberRows).map((m, i) => memberOfRow(i + 1, m)) : membersOf(r);
  const detail = extra(r, "detail");
  const o = r.outcome;
  return {
    id: r.id,
    requestId: requestIdOf(r),
    at: r.at,
    gate: gateIdOf(r),
    question: r.prompt,
    kind: r.kind,
    strategy: r.strategy,
    oracle: r.oracle,
    ...(r.model !== undefined ? { model: r.model } : {}),
    answer: r.failedOpen ? "failed open" : isFixed(r) ? "no answer bought" : leading(r.verdict),
    ...pYesOf(r.verdict),
    go: r.go,
    confidence: r.confidence,
    agreement: r.agreement,
    soft: r.soft,
    action: r.action,
    mode: r.mode === "enforce" ? "enforce" : "shadow",
    ...(r.floor !== undefined ? { floor: r.floor } : {}),
    fixed: isFixed(r),
    failedOpen: r.failedOpen,
    ...(r.error !== undefined ? { error: r.error } : {}),
    audited: r.tags.includes("audit"),
    cost: r.cost + memberRows.reduce((s, m) => s + m.cost, 0),
    latencyMs: r.latencyMs,
    tags: r.tags,
    stateHash: r.stateHash,
    trustedHash: r.trustedHash,
    untrusted: r.untrusted,
    ...(r.policyHash !== undefined ? { policyHash: r.policyHash } : {}),
    ...(r.evidenceVersion !== undefined ? { evidenceVersion: r.evidenceVersion } : {}),
    members,
    ...(detail && typeof detail === "object" && Object.keys(detail as object).length > 0
      ? { detail: detail as Record<string, unknown> }
      : {}),
    ...(o
      ? {
          outcome: {
            at: o.at,
            correct: o.correct,
            ...(o.truth !== undefined ? { truth: o.truth } : {}),
            ...(o.source !== undefined ? { source: o.source } : {}),
            ...(o.note !== undefined ? { note: o.note } : {}),
          },
        }
      : {}),
  };
}

/**
 * Every decision in the ledger as a trail entry, oldest first. A battery's combined row is
 * the entry and its member rows become its members; every other row is an entry of its own.
 */
export function buildTrail(rows: readonly DecisionRecord[]): TrailEntry[] {
  const key = (r: DecisionRecord) => `${gateIdOf(r)}\u0000${requestIdOf(r)}`;
  const combined = new Map<string, DecisionRecord>();
  for (const r of rows) if (isCombined(r)) combined.set(key(r), r);
  const members = new Map<string, DecisionRecord[]>();
  const decisions: DecisionRecord[] = [];
  for (const r of rows) {
    const k = key(r);
    if (!isCombined(r) && combined.has(k)) {
      const list = members.get(k);
      if (list) list.push(r);
      else members.set(k, [r]);
    } else decisions.push(r);
  }
  return byTime(decisions).map((r) => entryOf(r, members.get(key(r)) ?? []));
}

/**
 * The act bar each gate must have been using, from its rulings alone: above the highest go
 * the policy did not act on and at or below the lowest it did. Only answered rows with no
 * floor count, since a floor can move a ruling without the bar moving. One bar per policy
 * hash, so a changed policy shows as two bars rather than one inconsistent one.
 */
export function inferBars(entries: readonly TrailEntry[]): InferredBar[] {
  const groups = new Map<
    string,
    { gate: string; policyHash?: string; acts: number[]; held: number[] }
  >();
  for (const e of entries) {
    if (e.fixed || e.failedOpen || e.floor !== undefined) continue;
    const k = `${e.gate}\u0000${e.policyHash ?? ""}`;
    let g = groups.get(k);
    if (!g) {
      g = {
        gate: e.gate,
        ...(e.policyHash !== undefined ? { policyHash: e.policyHash } : {}),
        acts: [],
        held: [],
      };
      groups.set(k, g);
    }
    (e.soft === "act" ? g.acts : g.held).push(e.go);
  }
  return [...groups.values()].map((g) => {
    const above = g.held.length > 0 ? Math.max(...g.held) : undefined;
    const atOrBelow = g.acts.length > 0 ? Math.min(...g.acts) : undefined;
    return {
      gate: g.gate,
      ...(g.policyHash !== undefined ? { policyHash: g.policyHash } : {}),
      rows: g.acts.length + g.held.length,
      ...(above !== undefined ? { above } : {}),
      ...(atOrBelow !== undefined ? { atOrBelow } : {}),
      consistent: above === undefined || atOrBelow === undefined || above < atOrBelow,
    };
  });
}

/** Select and order the entries a command line asked for. Pure. */
export function selectTrail(
  ledger: string,
  rows: readonly DecisionRecord[],
  opts: TrailOptions,
): Trail {
  let scoped = rows;
  if (opts.gate !== undefined) {
    // A gate id keeps its battery members (they share the id); a member key "<gate>/<q>" or an
    // unknown name goes through findGate, which lists the gates there are.
    const gate = opts.gate;
    scoped = rows.filter((r) => gateIdOf(r) === gate);
    if (scoped.length === 0) scoped = findGate(groupGates(rows), gate, "trail").rows;
  }
  const all = buildTrail(scoped);
  let entries = all;
  if (opts.request !== undefined) {
    const needle = opts.request;
    if (needle.length < 6) throw new CliError("--request needs at least 6 characters", "trail");
    entries = all.filter((e) => e.requestId.startsWith(needle) || e.id.startsWith(needle));
    if (entries.length === 0)
      throw new CliError(`no request or decision starts with "${needle}"`, "trail");
  } else if (opts.last !== undefined && entries.length > opts.last) {
    entries = entries.slice(entries.length - opts.last);
  }
  return {
    ledger,
    total: all.length,
    ...(opts.gate !== undefined ? { gate: opts.gate } : {}),
    bars: inferBars(all),
    entries,
  };
}

const short = (id: string): string => id.slice(0, 8);

const answerWith = (answer: string, pYes: number | undefined, confidence: number): string =>
  pYes !== undefined ? `${answer} (${dec(pYes, 2)})` : `${answer} (${dec(confidence, 2)})`;

function describeBar(b: InferredBar): string {
  const where =
    b.above !== undefined && b.atOrBelow !== undefined
      ? `above ${dec(b.above)} and at or below ${dec(b.atOrBelow)}`
      : b.atOrBelow !== undefined
        ? `at or below ${dec(b.atOrBelow)} (nothing was held)`
        : b.above !== undefined
          ? `above ${dec(b.above)} (nothing was acted on)`
          : "unknown (no answered rows)";
  const policy = b.policyHash !== undefined ? ` under policy ${short(b.policyHash)}` : "";
  const warn = b.consistent ? "" : "; the rulings do not fit one bar";
  return `${b.gate}: act bar ${where}${policy}, from ${b.rows} rows${warn}`;
}

function describeDetail(e: TrailEntry): string | undefined {
  const d = e.detail;
  if (!d) return undefined;
  if (e.strategy === "cascade") {
    const tier = typeof d.tier === "number" ? d.tier + 1 : undefined;
    const label = typeof d.tierLabel === "string" ? ` "${d.tierLabel}"` : "";
    const esc = typeof d.escalations === "number" ? d.escalations : 0;
    return `settled at tier ${tier ?? "?"}${label} after ${esc} escalation${esc === 1 ? "" : "s"}, ${d.pooled === true ? "tiers pooled" : "settling tier's answer kept"}`;
  }
  if (e.strategy === "sequential") {
    const traj = Array.isArray(d.trajectory)
      ? (d.trajectory as number[]).map((x) => dec(x, 2))
      : [];
    return `${d.samples ?? "?"} samples, ${d.settled === true ? "settled" : "ran out of samples"}; confidence ${traj.join(" > ")}`;
  }
  if (e.strategy === "ensemble") {
    return `${d.pooled ?? "?"} answers pooled, ${d.dropped ?? 0} dropped, correlation ${dec(typeof d.correlation === "number" ? d.correlation : 0, 2)}`;
  }
  if (e.strategy === "battery") {
    return `${d.members ?? e.members.length} members combined by ${d.combine ?? "?"}`;
  }
  return Object.entries(d)
    .map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(", ");
}

function renderEntry(e: TrailEntry): string[] {
  const out: string[] = [];
  const applied = e.action === e.soft ? `${e.soft}` : `soft ${e.soft}, applied ${e.action}`;
  const audit = e.audited ? ", blind audit" : "";
  out.push(`## ${e.at} · ${e.gate} · ${applied} (${e.mode}${audit})`, "");
  out.push(e.question);
  const head = [
    e.strategy === "single" || e.oracle.startsWith(`${e.strategy}(`)
      ? e.oracle
      : `${e.strategy} · ${e.oracle}`,
    ...(e.model !== undefined && e.model !== e.oracle ? [e.model] : []),
    answerWith(e.answer, e.pYes, e.confidence),
    `go ${dec(e.go)}`,
    ...(e.members.length > 1 ? [`agreement ${dec(e.agreement, 2)}`] : []),
    usd(e.cost),
    msec(e.latencyMs),
  ];
  out.push(head.join(" · "));
  const detail = describeDetail(e);
  if (detail) out.push(detail);
  if (e.fixed)
    out.push(
      `fixed by ${e.strategy === "bypass" ? "an allowlist" : "a floor"}: no answer was bought`,
    );
  else if (e.floor !== undefined) out.push(`floor ${e.floor} bounded the ruling`);
  if (e.failedOpen) out.push(`failed open${e.error !== undefined ? `: ${e.error}` : ""}`);
  if (e.members.length > 0) {
    out.push("");
    out.push(
      table(
        ["#", "member", "answer", "confidence", "cost", "latency", "note"],
        e.members.map((m) => [
          String(m.index),
          m.model !== undefined && m.model !== m.name ? `${m.name} (${m.model})` : m.name,
          m.failedOpen ? "failed open" : answerWith(m.answer, m.pYes, m.confidence),
          m.failedOpen ? "-" : dec(m.confidence, 2),
          usd(m.cost),
          msec(m.latencyMs),
          [
            ...(m.role !== undefined ? [m.role] : []),
            ...(m.correct === true ? ["right"] : m.correct === false ? ["wrong"] : []),
            ...(m.error !== undefined ? [m.error] : []),
          ].join(", ") || "-",
        ]),
      ),
    );
  }
  out.push("");
  const prov = [
    `state ${short(e.stateHash)}`,
    ...(e.trustedHash !== e.stateHash ? [`trusted ${short(e.trustedHash)}`] : []),
    ...(e.untrusted.length > 0 ? [`untrusted ${e.untrusted.join(", ")}`] : []),
    `request ${short(e.requestId)}`,
    `decision ${short(e.id)}`,
    ...(e.evidenceVersion !== undefined ? [`evidence ${e.evidenceVersion}`] : []),
    ...(e.tags.length > 0 ? [`tags ${e.tags.join(", ")}`] : []),
  ];
  out.push(prov.join(" · "));
  if (e.outcome) {
    const o = e.outcome;
    const truth = o.truth !== undefined ? `, truth ${String(o.truth)}` : "";
    const source = o.source !== undefined ? ` (${o.source})` : "";
    const note = o.note !== undefined ? `: ${o.note}` : "";
    out.push(`label ${o.correct ? "right" : "wrong"}${truth}${source} at ${o.at}${note}`);
  } else out.push("unlabelled");
  out.push("");
  return out;
}

export function renderTrail(t: Trail): string {
  const out: string[] = [];
  out.push(`# ratchet trail: ${t.ledger}`, "");
  const scope = t.gate !== undefined ? ` of gate ${t.gate}` : "";
  const shown =
    t.entries.length === t.total
      ? `All ${t.total} decisions${scope}`
      : `${t.entries.length} of ${t.total} decisions${scope}`;
  out.push(
    `${shown}, oldest first. Judge answers show p(yes); pick and rate answers show the leading probability.`,
  );
  const bars = t.gate !== undefined ? t.bars.filter((b) => b.gate === t.gate) : t.bars;
  if (bars.length > 0) {
    out.push("");
    for (const b of bars) out.push(`- ${describeBar(b)}`);
  }
  out.push("");
  for (const e of t.entries) out.push(...renderEntry(e));
  return `${out.join("\n").trimEnd()}\n`;
}

export function trail(argv: readonly string[]): Promise<CommandResult> {
  return runCommand("trail", async () => {
    const p = parseArgs(
      argv,
      { values: ["gate", "request", "last"], booleans: ["json", "help"] },
      "trail",
    );
    if (p.booleans.has("help")) return { exitCode: 0, output: TRAIL_USAGE };
    const path = ledgerPath(p, "trail");
    const gate = p.values.get("gate");
    const request = p.values.get("request");
    const last = numberFlag(p, "last", { min: 1, integer: true }, "trail") ?? 10;
    const rows = await loadLedger(path, "trail");
    const t = selectTrail(path, rows, {
      ...(gate !== undefined ? { gate } : {}),
      ...(request !== undefined ? { request } : {}),
      last,
    });
    const output = p.booleans.has("json") ? `${JSON.stringify(t, null, 2)}\n` : renderTrail(t);
    return { exitCode: 0, output };
  });
}
