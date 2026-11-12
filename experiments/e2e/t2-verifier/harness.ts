/**
 * Wiring shared by every phase of the T2 run: the oracle (live Jev, or a simulated one that
 * exercises the same path with no spend), engines with a JSONL ledger per gate and split, and
 * readers that turn ledger rows back into scored points. Analysis reads only ledgers and the
 * corpus; nothing is carried in memory from the asking phases.
 */
import { join } from "node:path";
import { batteryFeatures } from "../../../src/compound/learned.ts";
import { Engine } from "../../../src/engine.ts";
import type { Gate, GateSpec } from "../../../src/gate.ts";
import { type DecisionRecord, decisionRows, JsonlLedger } from "../../../src/ledger/ledger.ts";
import { SimOracle } from "../../../src/oracles/sim.ts";
import type { GatePolicy } from "../../../src/policy.ts";
import type { JudgeVerdict, Oracle } from "../../../src/types.ts";
import { JEV_114, jev114, progress } from "../lib.ts";
import { BATTERY, HOLISTIC, memberId } from "./questions.ts";
import type { Point } from "./stats.ts";
import { MEMBERS, type MemberKey } from "./types.ts";

export const TRACK = "t2-verifier";
export const EVIDENCE_VERSION = "t2-verifier-v1";
export const MODEL = JEV_114;
/** Per-engine instance cap; the track cap ($1.00) is enforced by `guard` on billed usage. */
export const ENGINE_BUDGET_USD = 0.2;

/** What a state means, for the simulated oracle and for checking ledger labels. */
export interface Truths {
  readonly truth: boolean;
  readonly sub: Readonly<Record<MemberKey, boolean>>;
}

export class Ctx {
  /** State text -> truths: the simulated oracle's answer key, and the review's label lookup. */
  readonly truthByText = new Map<string, Truths>();
  constructor(
    readonly dir: string,
    readonly offline: boolean,
  ) {}

  ledgerPath(name: string): string {
    return join(this.dir, "ledgers", `${name}.jsonl`);
  }

  register(text: string, t: Truths): void {
    const prior = this.truthByText.get(text);
    if (prior && prior.truth !== t.truth) throw new Error("one state text, two labels");
    this.truthByText.set(text, t);
  }

  /** Labels keyed by exact state text, as `blindReview` looks them up. */
  labels(): Map<string, boolean> {
    return new Map([...this.truthByText].map(([k, v]) => [k, v.truth]));
  }

  oracle(): Oracle {
    if (!this.offline) return jev114();
    const memberOf = new Map(MEMBERS.map((m) => [memberId(m), m]));
    // Calibrated by construction, 85% accurate, independent across questions: enough to
    // exercise fitting, freezing, batteries and the chain with numbers that can be checked.
    return new SimOracle(
      { accuracy: 0.85, seed: 5, id: "sim@t2", costPerQuestion: 0 },
      (state, q) => {
        const t = this.truthByText.get(state);
        if (!t) return undefined;
        if (q.id === HOLISTIC.id) return { judge: t.truth };
        const m = memberOf.get(q.id);
        return m ? { judge: t.sub[m] } : undefined;
      },
    );
  }

  engine(ledger: string): Engine {
    return new Engine({
      oracle: this.oracle(),
      ledger: new JsonlLedger(this.ledgerPath(ledger)),
      keepState: true,
      budgetUsd: ENGINE_BUDGET_USD,
      seed: 1,
      timeoutMs: 30_000,
    });
  }
}

export function holisticSpec(id: string, policy: GatePolicy): GateSpec {
  return { id, question: HOLISTIC, policy, evidenceVersion: EVIDENCE_VERSION };
}

export function batterySpec(
  id: string,
  policy: GatePolicy,
  combine?: GateSpec["combine"],
): GateSpec {
  return {
    id,
    question: BATTERY,
    policy,
    evidenceVersion: EVIDENCE_VERSION,
    ...(combine !== undefined ? { combine } : {}),
  };
}

export interface AskLog {
  readonly item: string;
  readonly recordId: string;
  readonly requestId: string;
  readonly pYes: number;
  readonly failedOpen: boolean;
}

/** Ask a gate about many states in chunks, so progress is visible and a crash loses little. */
export async function askMany(
  gate: Gate,
  states: readonly { readonly id: string; readonly text: string }[],
  what: string,
): Promise<AskLog[]> {
  const out: AskLog[] = [];
  const chunk = 64;
  for (let i = 0; i < states.length; i += chunk) {
    const part = states.slice(i, i + chunk);
    const rs = await gate.askMany(
      part.map((s) => s.text),
      { concurrency: 8, baseline: "review" },
    );
    rs.forEach((r, j) => {
      const v = r.decision.verdict as JudgeVerdict;
      out.push({
        item: (part[j] as { id: string }).id,
        recordId: r.recordId,
        requestId: r.requestId,
        pYes: v.pYes,
        failedOpen: r.decision.failedOpen === true,
      });
    });
    progress(`  ${what}: ${Math.min(i + chunk, states.length)}/${states.length}`);
  }
  return out;
}

export async function readLedger(ctx: Ctx, name: string): Promise<readonly DecisionRecord[]> {
  return new JsonlLedger(ctx.ledgerPath(name)).all();
}

export interface Scored {
  readonly row: DecisionRecord;
  /** The item (or chain candidate) id the state belongs to. */
  readonly id: string;
  readonly cluster: string;
  readonly truth: boolean;
}

/** Decision rows of a gate, joined to the corpus by state hash; rows failed open are kept apart. */
export function joinRows(
  rows: readonly DecisionRecord[],
  gateId: string,
  byHash: ReadonlyMap<
    string,
    { readonly id: string; readonly cluster: string; readonly truth: boolean }
  >,
): { readonly scored: Scored[]; readonly failedOpen: number; readonly unmatched: number } {
  const scored: Scored[] = [];
  let failedOpen = 0;
  let unmatched = 0;
  for (const row of decisionRows(rows).filter((r) => r.gateId === gateId)) {
    const it = byHash.get(row.stateHash);
    if (!it) {
      unmatched++;
      continue;
    }
    if (row.failedOpen) {
      failedOpen++;
      continue;
    }
    scored.push({ row, id: it.id, cluster: it.cluster, truth: it.truth });
  }
  return { scored, failedOpen, unmatched };
}

export const pointsOf = (s: readonly Scored[]): Point[] =>
  s.map((x) => ({ p: (x.row.verdict as JudgeVerdict).pYes, truth: x.truth, cluster: x.cluster }));

/** A battery's member verdicts per request, in battery order, read back from the ledger. */
export function memberVerdicts(
  rows: readonly DecisionRecord[],
  gateId: string,
): Map<string, JudgeVerdict[]> {
  const byReq = new Map<string, Map<string, JudgeVerdict>>();
  for (const r of rows) {
    if (r.gateId !== gateId || r.combined === true || r.verdict.kind !== "judge") continue;
    const m = byReq.get(r.requestId) ?? new Map<string, JudgeVerdict>();
    m.set(r.questionId, r.verdict);
    byReq.set(r.requestId, m);
  }
  const out = new Map<string, JudgeVerdict[]>();
  for (const [req, m] of byReq) {
    const vs = BATTERY.map((q) => m.get(q.id));
    if (vs.every((v): v is JudgeVerdict => v !== undefined)) out.set(req, vs);
  }
  return out;
}

export const features = (vs: readonly JudgeVerdict[]): number[] => batteryFeatures(vs);

export const log = progress;
