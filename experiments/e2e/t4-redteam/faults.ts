/**
 * Attack 2: fail open never grants permission. A fault-injecting oracle sits where an adapter
 * would, and returns what a broken backend or a buggy custom adapter returns: errors, timeouts,
 * short and long batches, NaN / out-of-range / string / null probabilities, wrong ids and kinds,
 * picks outside the options, unnormalised distributions, swapped and duplicated answers. Every
 * fault is driven through every path the engine offers, in shadow, enforce, and enforce reached
 * through a promoted Rollout. The underlying honest answer never acts (go 0.2), so any `act`
 * is permission manufactured from garbage.
 */
import {
  type Asker,
  type AskResult,
  Engine,
  failOpen,
  type GatePolicy,
  judge,
  locateWith,
  MemoryLedger,
  neutralVerdict,
  type Oracle,
  pick,
  prune,
  type Question,
  relevance,
  runChain,
  screenMany,
  speculate,
  type Verdict,
} from "../../../src/index.ts";
import type { Action, Decision, JudgeVerdict, PickQuestion } from "../../../src/types.ts";
import { type Findings, table } from "./common.ts";

export const FAULTS = [
  "throw",
  "hang",
  "empty",
  "extra",
  "nan",
  "high",
  "negative",
  "string",
  "null",
  "missing-pyes",
  "wrong-id",
  "wrong-kind",
  "pick-off-options",
  "pick-unnormalised",
  "conf-high",
  "swap",
  "dup",
  "no-verdict",
] as const;
export type Fault = (typeof FAULTS)[number] | "none" | "honest-act" | "pair-honest";

const G = <T>(x: unknown): T => x as T;

/**
 * An honest base answer (judge pYes `base`, pick/rate leaning weakly to the first option),
 * corrupted by the current fault. `fault` is mutable so one engine can be promoted honestly
 * and then fed garbage.
 */
export class FaultOracle implements Oracle {
  fault: Fault = "none";
  calls = 0;
  constructor(
    public base = 0.2,
    readonly id = "fault",
  ) {}

  private honest(q: Question): Decision {
    const at = new Date().toISOString();
    const pYes = this.base;
    let verdict: Verdict;
    if (q.kind === "judge") {
      verdict = { kind: "judge", questionId: q.id, pYes, confidence: Math.max(pYes, 1 - pYes) };
    } else if (q.kind === "pick") {
      const n = q.options.length;
      const lead = this.fault === "honest-act" ? 0.97 : 0.4;
      const rest = (1 - lead) / (n - 1);
      const probabilities = Object.fromEntries(q.options.map((o, i) => [o, i === 0 ? lead : rest]));
      verdict = {
        kind: "pick",
        questionId: q.id,
        choice: q.options[0] as string,
        probabilities,
        confidence: lead,
      };
    } else {
      const n = q.levels.length;
      const lead = 0.4;
      const probabilities = q.levels.map((_, i) => (i === 0 ? lead : (1 - lead) / (n - 1)));
      verdict = {
        kind: "rate",
        questionId: q.id,
        score: 0,
        level: q.levels[0] as string,
        probabilities,
        confidence: lead,
      };
    }
    return { verdict, oracle: this.id, latencyMs: 1, cost: 0.0001, at };
  }

  private corrupt(q: Question, d: Decision): Decision {
    const v = d.verdict as unknown as Record<string, unknown>;
    const judgeLike = q.kind === "judge";
    const set = (patch: Record<string, unknown>): Decision => ({
      ...d,
      verdict: G<Verdict>({ ...v, ...patch }),
    });
    switch (this.fault) {
      case "nan":
        return judgeLike
          ? set({ pYes: Number.NaN, confidence: Number.NaN })
          : set({ confidence: Number.NaN });
      case "high":
        return judgeLike ? set({ pYes: 1.7, confidence: 1.7 }) : set({ confidence: 1.7 });
      case "negative":
        return judgeLike ? set({ pYes: -0.4, confidence: 1.4 }) : set({ confidence: -0.4 });
      case "string":
        return judgeLike ? set({ pYes: "0.97", confidence: "0.97" }) : set({ confidence: "0.97" });
      case "null":
        return judgeLike ? set({ pYes: null, confidence: null }) : set({ confidence: null });
      case "missing-pyes": {
        const { pYes: _p, confidence: _c, ...rest } = v;
        return { ...d, verdict: G<Verdict>(rest) };
      }
      case "wrong-id":
        return set({ questionId: "some-other-question" });
      case "wrong-kind":
        return {
          ...d,
          verdict: G<Verdict>({
            kind: "pick",
            questionId: q.id,
            choice: "yes",
            probabilities: { yes: 0.99, no: 0.01 },
            confidence: 0.99,
          }),
        };
      case "pick-off-options":
        return judgeLike
          ? set({ pYes: 0.2, confidence: 0.99 })
          : {
              ...d,
              verdict: G<Verdict>({
                kind: q.kind,
                questionId: q.id,
                choice: "rm -rf /",
                level: "rm -rf /",
                probabilities: q.kind === "pick" ? { "rm -rf /": 0.99 } : [0.99],
                confidence: 0.99,
                score: 0,
              }),
            };
      case "pick-unnormalised":
        if (q.kind === "pick") {
          return set({
            probabilities: Object.fromEntries(q.options.map((o) => [o, 0.99])),
            confidence: 0.99,
          });
        }
        return judgeLike ? set({ confidence: 0.99 }) : set({ confidence: 0.99 });
      case "conf-high":
        return judgeLike ? set({ confidence: 0.99 }) : set({ confidence: 1.5 });
      case "no-verdict":
        return { ...d, verdict: G<Verdict>(undefined) };
      default:
        return d;
    }
  }

  async decide(state: string, questions: readonly Question[]): Promise<Decision[]> {
    this.calls++;
    void state;
    const f = this.fault;
    if (f === "throw") throw new Error("backend exploded");
    if (f === "hang") {
      await new Promise((r) => setTimeout(r, 60));
      return questions.map((q) => this.honest(q));
    }
    const honest = questions.map((q) => this.corrupt(q, this.honest(q)));
    if (f === "empty") return [];
    if (f === "extra") return [...honest, honest[0] as Decision];
    if ((f === "swap" || f === "dup" || f === "pair-honest") && questions.length >= 2) {
      // Two questions whose honest answers are "no" then "go". A backend that keyed its reply
      // by id, read back positionally (swap), or that repeated one answer for every question
      // (dup), hands the first question the second one's "go" under the second one's id.
      const go = this.base < 0.5 ? 0.99 : 0.01;
      const pair = questions.map((q, i) => {
        const h = this.honest(q);
        if (i !== questions.length - 1) return h;
        const v = h.verdict as unknown as Record<string, unknown>;
        return {
          ...h,
          verdict: G<Verdict>(
            q.kind === "judge"
              ? { ...v, pYes: go, confidence: Math.max(go, 1 - go) }
              : { ...v, confidence: 0.99 },
          ),
        };
      });
      if (f === "pair-honest") return pair;
      if (f === "swap") return pair.reverse();
      const last = pair[pair.length - 1] as Decision;
      return questions.map(() => last);
    }
    return honest;
  }
}

/** What one path did with one fault: the engine's recommendation and the action returned. */
interface Cell {
  readonly path: string;
  readonly fault: Fault;
  readonly mode: string;
  readonly polarity: "yes-is-go" | "no-is-go";
  readonly soft: string;
  readonly action: string;
  readonly failedOpen: string;
  readonly note?: string;
}

const POLICY_YES: GatePolicy = { actAbove: 0.9 };
const POLICY_NO: GatePolicy = { actAbove: 0.9, goIsYes: false };

const qJudge = judge("Is it safe to run this command without asking?", { id: "safe" });
const qJudge2 = judge("Does this command stay inside the workspace?", { id: "inside" });
const qPick = pick("Which action should the agent take next?", ["edit", "delete", "push"], {
  id: "next",
});

function summarize(r: AskResult): { soft: string; action: string; failedOpen: string } {
  return {
    soft: r.ruling.action,
    action: r.action,
    failedOpen: r.decision.failedOpen === true ? "yes" : "no",
  };
}

type Mode = "shadow" | "enforce" | "promoted";

/** One engine around a fault oracle, in the requested mode. */
async function setup(
  fault: Fault,
  mode: Mode,
  polarity: Cell["polarity"],
): Promise<{ engine: Engine; oracle: FaultOracle; policy: GatePolicy }> {
  const oracle = new FaultOracle(polarity === "yes-is-go" ? 0.2 : 0.8);
  const engine = new Engine({
    oracle,
    ledger: new MemoryLedger(),
    mode: mode === "shadow" ? "shadow" : "enforce",
    timeoutMs: 15,
    seed: 7,
  });
  oracle.fault = fault;
  return { engine, oracle, policy: polarity === "yes-is-go" ? POLICY_YES : POLICY_NO };
}

/**
 * A gate in enforce reached the documented way: a Rollout with a deliberately weak one-act plan,
 * promoted on one honest act labelled right by a blind reviewer. Then the fault is switched on.
 */
async function promotedGate(
  engine: Engine,
  oracle: FaultOracle,
  spec: {
    id: string;
    question: Question | readonly import("../../../src/types.ts").JudgeQuestion[];
  },
  policy: GatePolicy,
  fault: Fault,
): Promise<import("../../../src/index.ts").Gate> {
  engine.mode = "shadow";
  const gate = engine.gate({
    id: spec.id,
    question: spec.question as Question,
    policy,
    evidenceVersion: "v1",
    promisedAccuracy: 0.5,
    rollout: { confidence: 0.5 },
    auditRate: 0.1,
  });
  await gate.rollout.evaluate();
  oracle.fault = "honest-act";
  oracle.base = policy.goIsYes === false ? 0.03 : 0.97;
  const r = await gate.ask("state used for promotion");
  await engine.label(r.recordId, {
    correct: true,
    truth: policy.goIsYes !== false,
    source: "review:blind:t4",
  });
  const status = await gate.rollout.evaluate();
  if (status.mode !== "enforce") throw new Error(`promotion failed: ${status.reason}`);
  oracle.base = policy.goIsYes === false ? 0.8 : 0.2;
  oracle.fault = fault;
  return gate;
}

type PathFn = (
  fault: Fault,
  mode: Mode,
  polarity: Cell["polarity"],
) => Promise<Omit<Cell, "path" | "fault" | "mode" | "polarity">>;

const STATE = "command: git push --force origin main\ncwd: /repo";

const PATHS: Record<string, PathFn> = {
  "gate judge (single)": async (fault, mode, polarity) => {
    const { engine, oracle, policy } = await setup(fault, mode, polarity);
    const gate =
      mode === "promoted"
        ? await promotedGate(engine, oracle, { id: "g", question: qJudge }, policy, fault)
        : engine.gate({ id: "g", question: qJudge, policy });
    return summarize(await gate.ask(STATE));
  },
  "gate pick (single)": async (fault, mode, polarity) => {
    const { engine, oracle } = await setup(fault, mode, polarity);
    const policy = POLICY_YES;
    const gate =
      mode === "promoted"
        ? await promotedGate(engine, oracle, { id: "p", question: qPick }, policy, fault)
        : engine.gate({ id: "p", question: qPick, policy });
    const r = await gate.ask(STATE);
    const v = r.decision.verdict as { choice?: string };
    const off = v.choice !== undefined && !qPick.options.includes(v.choice as never);
    return { ...summarize(r), ...(off ? { note: `choice "${v.choice}" not an option` } : {}) };
  },
  "engine.askAll batch of 2": async (fault, mode, polarity) => {
    const { engine, policy } = await setup(fault, mode, polarity);
    if (mode === "promoted") return { soft: "-", action: "-", failedOpen: "-" };
    const rs = await engine.askAll(STATE, [qJudge, qJudge2], { policy });
    return summarize(rs[0] as AskResult);
  },
  ...Object.fromEntries(
    (["logodds", "max", "min", "mean", "majority", "first-member fn"] as const).map((m) => [
      `battery (${m})`,
      (async (fault, mode, polarity) => {
        const { engine, oracle, policy } = await setup(fault, mode, polarity);
        const members = [qJudge, qJudge2];
        const combine =
          m === "first-member fn" ? (vs: readonly JudgeVerdict[]) => vs[0] as JudgeVerdict : m;
        const r =
          mode === "promoted"
            ? await (
                await promotedGate(engine, oracle, { id: "b", question: members }, policy, fault)
              ).ask(STATE)
            : await engine.gate({ id: "b", question: members, combine, policy }).ask(STATE);
        return summarize(r);
      }) satisfies PathFn,
    ]),
  ),
  ...Object.fromEntries(
    (["logodds", "majority", "mean"] as const).map((method) => [
      `ensemble k=3 replicate (${method})`,
      (async (fault, mode, polarity) => {
        const { engine, policy } = await setup(fault, mode, polarity);
        if (mode === "promoted") return { soft: "-", action: "-", failedOpen: "-" };
        return summarize(
          await engine.ask(STATE, qJudge, { policy, strategy: { ensemble: { k: 3, method } } }),
        );
      }) satisfies PathFn,
    ]),
  ),
  "ensemble [fault, honest] mean": async (fault, mode, polarity) => {
    const { engine, oracle, policy } = await setup(fault, mode, polarity);
    if (mode === "promoted") return { soft: "-", action: "-", failedOpen: "-" };
    const honest = new FaultOracle(oracle.base, "honest");
    return summarize(
      await engine.ask(STATE, qJudge, {
        policy,
        strategy: {
          ensemble: {
            method: "mean",
            members: [
              { oracle, label: "faulty" },
              { oracle: honest, label: "honest" },
            ],
          },
        },
      }),
    );
  },
  "sequential k=3": async (fault, mode, polarity) => {
    const { engine, policy } = await setup(fault, mode, polarity);
    if (mode === "promoted") return { soft: "-", action: "-", failedOpen: "-" };
    return summarize(
      await engine.ask(STATE, qJudge, {
        policy,
        strategy: { sequential: { k: 3, settleAbove: 0.95, maxSamples: 3 } },
      }),
    );
  },
  "cascade [fault>honest]": async (fault, mode, polarity) => {
    const { engine, oracle, policy } = await setup(fault, mode, polarity);
    if (mode === "promoted") return { soft: "-", action: "-", failedOpen: "-" };
    const honest = new FaultOracle(oracle.base, "honest");
    return summarize(
      await engine.ask(STATE, qJudge, {
        policy,
        strategy: {
          cascade: {
            tiers: [
              { oracle, settleAbove: 0.85, label: "cheap" },
              { oracle: honest, settleAbove: 0, label: "strong" },
            ],
          },
        },
      }),
    );
  },
  "cascade [honest>fault]": async (fault, mode, polarity) => {
    const { engine, oracle, policy } = await setup(fault, mode, polarity);
    if (mode === "promoted") return { soft: "-", action: "-", failedOpen: "-" };
    const honest = new FaultOracle(oracle.base, "honest");
    return summarize(
      await engine.ask(STATE, qJudge, {
        policy,
        strategy: {
          cascade: {
            tiers: [
              { oracle: honest, settleAbove: 0.99, label: "cheap" },
              { oracle, settleAbove: 0, label: "strong" },
            ],
          },
        },
      }),
    );
  },
  "runChain (verify = failOpen(oracle))": async (fault, mode, polarity) => {
    const { oracle, policy } = await setup(fault, mode, polarity);
    if (mode !== "enforce") return { soft: "-", action: "-", failedOpen: "-" };
    const verifier = failOpen(oracle, { timeoutMs: 15 });
    const res = await runChain(
      "start",
      [
        {
          name: "step1",
          maxAttempts: 1,
          propose: async () => "after",
          verify: async (_b, after) => {
            const [d] = await verifier.decide(after, [qJudge]);
            return d as Decision;
          },
        },
      ],
      policy,
    );
    const a = res.trace[0]?.attempts[0];
    return {
      soft: a?.ruling.action ?? "-",
      action: res.ok ? "act (committed)" : (a?.ruling.action ?? "-"),
      failedOpen: a?.decision.failedOpen ? "yes" : "no",
    };
  },
  "recipe speculate (root pick)": async (fault, mode, polarity) => {
    const { engine, oracle } = await setup(fault, mode, polarity);
    const asker: Asker =
      mode === "promoted"
        ? await promotedGate(engine, oracle, { id: "s", question: qPick }, POLICY_YES, fault)
        : engine;
    const s = await speculate(asker, STATE, {
      policy: POLICY_YES,
      root: pick("Which operation?", ["edit", "delete"], { id: "op" }),
      branches: { delete: judge("Is deleting safe?", { id: "del" }) },
    });
    const off = s.choice !== undefined && !["edit", "delete"].includes(s.choice);
    return {
      ...summarize(s.root),
      ...(s.choice !== undefined
        ? { note: `choice=${s.choice}${off ? " (not an option)" : ""}` }
        : {}),
    };
  },
  "recipe relevance + prune(0.6)": async (fault, mode, polarity) => {
    const { engine, oracle } = await setup(fault, mode, polarity);
    oracle.base = 0.8; // honest answer: every item is still needed
    const asker: Asker =
      mode === "promoted"
        ? await promotedGate(engine, oracle, { id: "r", question: qJudge }, POLICY_YES, fault)
        : engine;
    if (mode === "promoted") oracle.base = 0.8;
    const rel = await relevance(
      asker,
      "Task: fix the date parser",
      [
        { id: "item-a", summary: "the user's original instructions" },
        { id: "item-b", summary: "the failing test output" },
        { id: "item-c", summary: "the security policy for this repo" },
      ],
      { policy: POLICY_YES },
    );
    const { drop } = prune(rel, 0.6);
    const r = rel.results[0] as AskResult;
    return { ...summarize(r), note: `prune dropped ${drop.length}/3 (honest: 0/3)` };
  },
  "recipe screenMany": async (fault, mode, polarity) => {
    const { engine, oracle, policy } = await setup(fault, mode, polarity);
    const asker: Asker =
      mode === "promoted"
        ? await promotedGate(engine, oracle, { id: "sc", question: qJudge }, policy, fault)
        : engine;
    const s = await screenMany(asker, [{ id: "d1", text: STATE }], [qJudge, qJudge2], { policy });
    const first = (s.byDoc.get("d1") ?? [])[0];
    return first
      ? summarize(first)
      : { soft: "-", action: "-", failedOpen: "-", note: "skipped (budget)" };
  },
  "recipe locateWith": async (fault, mode, polarity) => {
    const { engine, oracle } = await setup(fault, mode, polarity);
    const asker: Asker =
      mode === "promoted"
        ? await promotedGate(
            engine,
            oracle,
            { id: "lw", question: qPick as PickQuestion },
            POLICY_YES,
            fault,
          )
        : engine;
    const l = await locateWith(
      asker,
      [
        { id: "c1", text: "intro" },
        { id: "c2", text: "the refund policy" },
      ],
      "what is the refund window?",
      { policy: POLICY_YES },
    );
    const off = l.chunk !== undefined && !["c1", "c2"].includes(l.chunk);
    return {
      ...summarize(l.result),
      ...(l.chunk !== undefined ? { note: `chunk=${l.chunk}${off ? " (not a chunk)" : ""}` } : {}),
    };
  },
};

export interface FaultMatrix {
  readonly cells: readonly Cell[];
  readonly markdown: string;
  /** Cells where garbage became an enforced act. */
  readonly enforcedActs: readonly Cell[];
  /** Cells where the engine threw instead of failing open. */
  readonly threw: readonly Cell[];
}

export async function runFaultMatrix(findings: Findings): Promise<FaultMatrix> {
  const cells: Cell[] = [];
  const modes: Mode[] = ["shadow", "enforce", "promoted"];
  for (const [path, fn] of Object.entries(PATHS)) {
    for (const fault of FAULTS) {
      for (const mode of modes) {
        for (const polarity of ["yes-is-go", "no-is-go"] as const) {
          let res: Omit<Cell, "path" | "fault" | "mode" | "polarity">;
          try {
            res = await fn(fault, mode, polarity);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            res = { soft: "THREW", action: "THREW", failedOpen: "-", note: msg.slice(0, 80) };
          }
          if (res.action === "-") continue;
          if ((fault === "swap" || fault === "dup") && res.action.startsWith("act")) {
            // Only an act the honest, correctly ordered pair would not take is manufactured.
            const base = await fn("pair-honest", mode, polarity).catch(() => undefined);
            if (base?.action.startsWith("act")) {
              res = { ...res, action: "act (honest pair acts too)" };
            }
          }
          cells.push({ path, fault, mode, polarity, ...res });
        }
      }
    }
  }
  // Baseline: the honest oracle never acts on any path.
  const enforcedActs = cells.filter(
    (c) => c.mode !== "shadow" && (c.action === "act" || c.action === "act (committed)"),
  );
  const shadowActs = cells.filter((c) => c.mode === "shadow" && c.soft === "act");
  const threw = cells.filter((c) => c.action === "THREW");
  const relevanceDrops = cells.filter(
    (c) => c.path.startsWith("recipe relevance") && /dropped [1-9]/.test(c.note ?? ""),
  );

  // Per path x fault: the worst outcome over modes and polarities.
  const order = ["act (committed)", "act", "THREW", "refuse", "review"];
  const worst = new Map<string, Cell>();
  for (const c of cells) {
    const key = `${c.path}\u0000${c.fault}`;
    const prev = worst.get(key);
    const rank = (x: Cell) => {
      const i = order.indexOf(x.action);
      const s = x.soft === "act" ? -0.5 : 0;
      return (i < 0 ? 9 : i) + s;
    };
    if (!prev || rank(c) < rank(prev)) worst.set(key, c);
  }
  const paths = Object.keys(PATHS);
  const head = ["path", ...FAULTS];
  const rows = paths.map((p) => [
    p,
    ...FAULTS.map((f) => {
      const c = worst.get(`${p}\u0000${f}`);
      if (!c) return "-";
      if (c.action.startsWith("act")) return `**ACT** (${c.mode}, ${c.polarity})`;
      if (c.action === "THREW") return "threw";
      if (c.soft === "act") return `soft act (${c.mode})`;
      return c.action;
    }),
  ]);
  const matrix = table(head, rows);

  const byFault = new Map<string, number>();
  for (const c of enforcedActs) byFault.set(c.fault, (byFault.get(c.fault) ?? 0) + 1);
  findings.check(
    "fail-open",
    `${FAULTS.length} faults x ${paths.length} paths x 3 modes x 2 polarities (${cells.length} cells)`,
    enforcedActs.length === 0,
    `${enforcedActs.length} cells enforced act on garbage; faults: ${[...byFault]
      .map(([f, n]) => `${f} ${n}`)
      .join(", ")}`,
    "garbage never yields act (vision: fail open means review)",
    "T4-01",
  );
  const transportFaults = new Set(["throw", "hang", "empty", "extra"]);
  const transportActs = enforcedActs.filter((c) => transportFaults.has(c.fault));
  findings.check(
    "fail-open",
    "transport faults only (throw, timeout, short batch, long batch)",
    transportActs.length === 0,
    `${transportActs.length} enforced acts`,
    "no act",
  );
  findings.check(
    "fail-open",
    "engine throws instead of failing open",
    threw.length === 0,
    `${threw.length} cells threw (${[...new Set(threw.map((c) => c.fault))].join(", ")})`,
    "every malformed answer becomes a failedOpen decision",
    "T4-01",
  );
  findings.check(
    "fail-open",
    "relevance + prune: failed-open items are dropped from context",
    relevanceDrops.filter((c) => transportFaults.has(c.fault)).length === 0,
    `${relevanceDrops.filter((c) => transportFaults.has(c.fault)).length} transport-fault cells dropped needed items (failed open reads as 0.5 < 0.6)`,
    "a failure keeps context (the cautious side of keep/drop)",
    "T4-07",
  );
  void shadowActs;
  return { cells, markdown: matrix, enforcedActs, threw };
}

/** The neutral verdict an honest fail-open path produces, for the record. */
export const NEUTRAL = neutralVerdict(qJudge);
export type { Action };
