/**
 * Wave 2, package A: garbage answers fail open, never act (T4-01), and a timeout cancels the
 * call it stops waiting for and never records its unknown cost as zero spend (T4-05).
 *
 * The fault oracle mirrors the red team's (experiments/e2e/t4-redteam/faults.ts): an honest
 * answer that never acts (go 0.2), corrupted the ways a broken backend or a buggy custom
 * adapter corrupts it, driven through every path the engine offers. Before the fix 128 of the
 * red team's 1,908 enforce cells acted on garbage and 241 threw with no ledger row.
 */
import { describe, expect, it } from "vitest";
import { runChain } from "../src/compound/chain.ts";
import { Engine } from "../src/engine.ts";
import {
  type Asker,
  type AskResult,
  checkDecisions,
  failOpen,
  type GatePolicy,
  judge,
  locateWith,
  MemoryLedger,
  type Oracle,
  pick,
  prune,
  type Question,
  rate,
  relevance,
  rule,
  screenMany,
  speculate,
  validateVerdict,
} from "../src/index.ts";
import {
  judgeVerdictFrom,
  neutralVerdict,
  pickVerdictFrom,
  rateVerdictFrom,
} from "../src/questions.ts";
import type { Decision, JudgeVerdict, Verdict } from "../src/types.ts";

const FAULTS = [
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
  "nan-cost",
  "negative-latency",
] as const;
type Fault = (typeof FAULTS)[number] | "none";

const G = <T>(x: unknown): T => x as T;

/** An honest answer that never acts (judge go 0.2, pick lead 0.4), corrupted by `fault`. */
class FaultOracle implements Oracle {
  calls = 0;
  constructor(
    public fault: Fault,
    public base = 0.2,
    readonly id = "fault",
  ) {}

  private honest(q: Question): Decision {
    let verdict: Verdict;
    if (q.kind === "judge") verdict = judgeVerdictFrom(q, this.base);
    else if (q.kind === "pick") {
      const rest = 0.6 / (q.options.length - 1);
      verdict = pickVerdictFrom(
        q,
        q.options.map((_, i) => (i === 0 ? 0.4 : rest)),
      );
    } else {
      const rest = 0.6 / (q.levels.length - 1);
      verdict = rateVerdictFrom(
        q,
        q.levels.map((_, i) => (i === 0 ? 0.4 : rest)),
      );
    }
    return { verdict, oracle: this.id, latencyMs: 1, cost: 0.0001, at: "2026-11-12T00:00:00Z" };
  }

  private corrupt(q: Question, d: Decision): Decision {
    const v = d.verdict as unknown as Record<string, unknown>;
    const j = q.kind === "judge";
    const set = (patch: Record<string, unknown>): Decision => ({
      ...d,
      verdict: G<Verdict>({ ...v, ...patch }),
    });
    switch (this.fault) {
      case "nan":
        return j
          ? set({ pYes: Number.NaN, confidence: Number.NaN })
          : set({ confidence: Number.NaN });
      case "high":
        return j ? set({ pYes: 1.7, confidence: 1.7 }) : set({ confidence: 1.7 });
      case "negative":
        return j ? set({ pYes: -0.4, confidence: 1.4 }) : set({ confidence: -0.4 });
      case "string":
        return j ? set({ pYes: "0.97", confidence: "0.97" }) : set({ confidence: "0.97" });
      case "null":
        return j ? set({ pYes: null, confidence: null }) : set({ confidence: null });
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
            kind: q.kind === "pick" ? "judge" : "pick",
            questionId: q.id,
            choice: "yes",
            pYes: 0.99,
            probabilities: { yes: 0.99, no: 0.01 },
            confidence: 0.99,
          }),
        };
      case "pick-off-options":
        return j
          ? set({ pYes: 0.2, confidence: 0.99 })
          : set({
              choice: "rm -rf /",
              level: "rm -rf /",
              probabilities: q.kind === "pick" ? { "rm -rf /": 0.99 } : [0.99],
              confidence: 0.99,
            });
      case "pick-unnormalised":
        return q.kind === "pick"
          ? set({
              probabilities: Object.fromEntries(q.options.map((o) => [o, 0.99])),
              confidence: 0.99,
            })
          : set({ confidence: 0.99 });
      case "conf-high":
        return j ? set({ confidence: 0.99 }) : set({ confidence: 1.5 });
      case "no-verdict":
        return { ...d, verdict: G<Verdict>(undefined) };
      case "nan-cost":
        return { ...d, cost: Number.NaN };
      case "negative-latency":
        return { ...d, latencyMs: -5 };
      default:
        return d;
    }
  }

  async decide(_state: string, questions: readonly Question[]): Promise<Decision[]> {
    this.calls++;
    const f = this.fault;
    if (f === "throw") throw new Error("backend exploded");
    if (f === "hang") {
      await new Promise((r) => setTimeout(r, 60));
      return questions.map((q) => this.honest(q));
    }
    if (f === "empty") return [];
    const honest = questions.map((q) => this.corrupt(q, this.honest(q)));
    if (f === "extra") return [...honest, honest[0] as Decision];
    if ((f === "swap" || f === "dup") && questions.length >= 2) {
      // The last question's honest answer is "go"; a swapped or repeated reply hands it to the
      // first question under the last one's id.
      const go = this.base < 0.5 ? 0.99 : 0.01;
      const pair = questions.map((q, i) => {
        const h = this.honest(q);
        if (i !== questions.length - 1 || q.kind !== "judge") return h;
        return { ...h, verdict: judgeVerdictFrom(q, go) };
      });
      if (f === "swap") return pair.reverse();
      return questions.map(() => pair[pair.length - 1] as Decision);
    }
    return honest;
  }
}

const POLICY_YES: GatePolicy = { actAbove: 0.9 };
const POLICY_NO: GatePolicy = { actAbove: 0.9, goIsYes: false };
const qJudge = judge("Is it safe to run this command without asking?", { id: "safe" });
const qJudge2 = judge("Does this command stay inside the workspace?", { id: "inside" });
const qPick = pick("Which action should the agent take next?", ["edit", "delete", "push"], {
  id: "next",
});
const STATE = "command: git push --force origin main\ncwd: /repo";

type Polarity = "yes-is-go" | "no-is-go";
interface Outcome {
  readonly soft: string;
  readonly action: string;
  /** Ledger rows the engine wrote; undefined for a path with no engine (runChain). */
  readonly rows?: number;
}

function setup(fault: Fault, polarity: Polarity) {
  const oracle = new FaultOracle(fault, polarity === "yes-is-go" ? 0.2 : 0.8);
  const engine = new Engine({
    oracle,
    ledger: new MemoryLedger(),
    mode: "enforce",
    timeoutMs: 15,
    seed: 7,
  });
  return { engine, oracle, policy: polarity === "yes-is-go" ? POLICY_YES : POLICY_NO };
}

const rowsOf = async (e: Engine) => (await e.ledger.all()).length;
const outcome = async (r: AskResult, e: Engine): Promise<Outcome> => ({
  soft: r.ruling.action,
  action: r.action,
  rows: await rowsOf(e),
});

/** The red team's 21 paths: everything that turns an oracle's answer into an action. */
const PATHS: Record<string, (fault: Fault, polarity: Polarity) => Promise<Outcome>> = {
  "gate judge (single)": async (fault, polarity) => {
    const { engine, policy } = setup(fault, polarity);
    return outcome(await engine.gate({ id: "g", question: qJudge, policy }).ask(STATE), engine);
  },
  "gate pick (single)": async (fault, polarity) => {
    const { engine } = setup(fault, polarity);
    const gate = engine.gate({ id: "p", question: qPick, policy: POLICY_YES });
    return outcome(await gate.ask(STATE), engine);
  },
  "engine.askAll batch of 2": async (fault, polarity) => {
    const { engine, policy } = setup(fault, polarity);
    const rs = await engine.askAll(STATE, [qJudge, qJudge2], { policy });
    const acted = rs.find((r) => r.action === "act" || r.ruling.action === "act") ?? rs[0];
    return outcome(acted as AskResult, engine);
  },
  ...Object.fromEntries(
    (["logodds", "max", "min", "mean", "majority", "first-member fn"] as const).map((m) => [
      `battery (${m})`,
      async (fault: Fault, polarity: Polarity) => {
        const { engine, policy } = setup(fault, polarity);
        const combine =
          m === "first-member fn" ? (vs: readonly JudgeVerdict[]) => vs[0] as JudgeVerdict : m;
        const gate = engine.gate({ id: "b", question: [qJudge, qJudge2], combine, policy });
        return outcome(await gate.ask(STATE), engine);
      },
    ]),
  ),
  ...Object.fromEntries(
    (["logodds", "majority", "mean"] as const).map((method) => [
      `ensemble k=3 replicate (${method})`,
      async (fault: Fault, polarity: Polarity) => {
        const { engine, policy } = setup(fault, polarity);
        const strategy = { ensemble: { k: 3, method } };
        return outcome(await engine.ask(STATE, qJudge, { policy, strategy }), engine);
      },
    ]),
  ),
  "ensemble [fault, honest] mean": async (fault, polarity) => {
    const { engine, oracle, policy } = setup(fault, polarity);
    const honest = new FaultOracle("none", oracle.base, "honest");
    const members = [
      { oracle, label: "faulty" },
      { oracle: honest, label: "honest" },
    ];
    const strategy = { ensemble: { method: "mean" as const, members } };
    return outcome(await engine.ask(STATE, qJudge, { policy, strategy }), engine);
  },
  "sequential k=3": async (fault, polarity) => {
    const { engine, policy } = setup(fault, polarity);
    const strategy = { sequential: { k: 3, settleAbove: 0.95, maxSamples: 3 } };
    return outcome(await engine.ask(STATE, qJudge, { policy, strategy }), engine);
  },
  "cascade [fault>honest]": async (fault, polarity) => {
    const { engine, oracle, policy } = setup(fault, polarity);
    const honest = new FaultOracle("none", oracle.base, "honest");
    const tiers = [
      { oracle, settleAbove: 0.85, label: "cheap" },
      { oracle: honest, settleAbove: 0, label: "strong" },
    ];
    return outcome(
      await engine.ask(STATE, qJudge, { policy, strategy: { cascade: { tiers } } }),
      engine,
    );
  },
  "cascade [honest>fault]": async (fault, polarity) => {
    const { engine, oracle, policy } = setup(fault, polarity);
    const honest = new FaultOracle("none", oracle.base, "honest");
    const tiers = [
      { oracle: honest, settleAbove: 0.99, label: "cheap" },
      { oracle, settleAbove: 0, label: "strong" },
    ];
    return outcome(
      await engine.ask(STATE, qJudge, { policy, strategy: { cascade: { tiers } } }),
      engine,
    );
  },
  "runChain (verify = failOpen(oracle))": async (fault, polarity) => {
    const { oracle, policy } = setup(fault, polarity);
    const verifier = failOpen(oracle, { timeoutMs: 15 });
    const res = await runChain(
      "start",
      [
        {
          name: "step1",
          maxAttempts: 1,
          propose: async () => "after",
          verify: async (_b, after) => (await verifier.decide(after, [qJudge]))[0] as Decision,
        },
      ],
      policy,
    );
    const soft = res.trace[0]?.attempts[0]?.ruling.action ?? "-";
    return { soft, action: res.ok ? "act" : soft };
  },
  "recipe speculate (root pick)": async (fault, polarity) => {
    const { engine } = setup(fault, polarity);
    const s = await speculate(engine as Asker, STATE, {
      policy: POLICY_YES,
      root: pick("Which operation?", ["edit", "delete"], { id: "op" }),
      branches: { delete: judge("Is deleting safe?", { id: "del" }) },
    });
    return outcome(s.root, engine);
  },
  "recipe relevance + prune(0.6)": async (fault, polarity) => {
    const { engine, oracle } = setup(fault, polarity);
    oracle.base = 0.8;
    const rel = await relevance(
      engine,
      "Task: fix the date parser",
      [
        { id: "item-a", summary: "the user's original instructions" },
        { id: "item-b", summary: "the failing test output" },
      ],
      { policy: POLICY_YES },
    );
    prune(rel, 0.6);
    const acted = rel.results.find((r) => r.action === "act") ?? rel.results[0];
    return outcome(acted as AskResult, engine);
  },
  "recipe screenMany": async (fault, polarity) => {
    const { engine, policy } = setup(fault, polarity);
    const s = await screenMany(engine, [{ id: "d1", text: STATE }], [qJudge, qJudge2], { policy });
    const rs = s.byDoc.get("d1") ?? [];
    const acted = rs.find((r) => r.action === "act") ?? rs[0];
    return acted ? outcome(acted, engine) : { soft: "-", action: "-", rows: await rowsOf(engine) };
  },
  "recipe locateWith": async (fault, polarity) => {
    const { engine } = setup(fault, polarity);
    const l = await locateWith(
      engine,
      [
        { id: "c1", text: "intro" },
        { id: "c2", text: "the refund policy" },
      ],
      "what is the refund window?",
      { policy: POLICY_YES },
    );
    return outcome(l.result, engine);
  },
};

describe("T4-01: garbage never acts on any path, and never throws without a ledger row", () => {
  it("covers the red team's 21 paths", () => {
    expect(Object.keys(PATHS)).toHaveLength(21);
  });
  for (const [path, run] of Object.entries(PATHS)) {
    it(path, async () => {
      const acted: string[] = [];
      for (const fault of FAULTS) {
        for (const polarity of ["yes-is-go", "no-is-go"] as const) {
          // A throw fails the test with the fault named in the stack; no act is tolerated.
          const o = await run(fault, polarity);
          if (o.action === "act" || o.soft === "act") acted.push(`${fault} (${polarity})`);
          if (o.rows !== undefined) expect(o.rows, `${fault} ${polarity}`).toBeGreaterThan(0);
        }
      }
      expect(acted).toEqual([]);
    });
  }
  it("the honest oracle still acts when its answer clears the bar (the guard is not a blanket review)", async () => {
    const oracle = new FaultOracle("none", 0.97);
    const engine = new Engine({ oracle, mode: "enforce" });
    const r = await engine.gate({ id: "g", question: qJudge, policy: POLICY_YES }).ask(STATE);
    expect(r.action).toBe("act");
    expect(r.decision.failedOpen).toBeUndefined();
  });
});

describe("T4-01: validateVerdict is strict", () => {
  const j = judge("q", { id: "j" });
  const p = pick("q", ["a", "b", "c"], { id: "p" });
  const r = rate("q", ["low", "mid", "high"], { id: "r" });
  const jv = (patch: Record<string, unknown>): Verdict =>
    G<Verdict>({ kind: "judge", questionId: "j", pYes: 0.3, confidence: 0.7, ...patch });
  it("rejects pYes that is not a finite probability (the old check let NaN, null and '0.97' through)", () => {
    for (const pYes of [Number.NaN, null, "0.97", undefined, Number.POSITIVE_INFINITY, 1.7, -0.4]) {
      expect(() => validateVerdict(j, jv({ pYes, confidence: 0.97 })), String(pYes)).toThrow();
    }
  });
  it("rejects a judge confidence that is not max(pYes, 1 - pYes)", () => {
    expect(() => validateVerdict(j, jv({ confidence: 0.99 }))).toThrow(/confidence/);
    expect(() => validateVerdict(j, jv({ confidence: Number.NaN }))).toThrow(/confidence/);
    expect(() => validateVerdict(j, jv({ confidence: 0.7004 }))).not.toThrow();
  });
  it("rejects a missing verdict and an unknown kind", () => {
    expect(() => validateVerdict(j, G<Verdict>(undefined))).toThrow(/missing/);
    expect(() => validateVerdict(j, G<Verdict>(null))).toThrow(/missing/);
  });
  it("checks pick confidence, entries and keys", () => {
    const ok = pickVerdictFrom(p, [0.6, 0.3, 0.1]);
    expect(() => validateVerdict(p, ok)).not.toThrow();
    expect(() => validateVerdict(p, { ...ok, confidence: 0.99 })).toThrow(/mass/);
    expect(() =>
      validateVerdict(p, { ...ok, probabilities: { a: 0.6, b: 0.3, c: 0.1, d: 0 } }),
    ).toThrow(/not an option/);
    expect(() =>
      validateVerdict(p, { ...ok, probabilities: { a: 0.6, b: Number.NaN, c: 0.4 } }),
    ).toThrow(/probabilities/);
    expect(() =>
      validateVerdict(p, { ...ok, probabilities: { a: 1.2, b: -0.1, c: -0.1 } }),
    ).toThrow(/probabilities/);
  });
  it("an option named like an Object prototype key is not read from the prototype", () => {
    const proto = pick("q", ["constructor", "toString"], { id: "proto" });
    const v = G<Verdict>({
      kind: "pick",
      questionId: "proto",
      choice: "constructor",
      probabilities: {},
      confidence: 0,
    });
    expect(() => validateVerdict(proto, v)).toThrow(/sum/);
  });
  it("checks rate confidence and score", () => {
    const ok = rateVerdictFrom(r, [0.2, 0.5, 0.3]);
    expect(() => validateVerdict(r, ok)).not.toThrow();
    expect(() => validateVerdict(r, { ...ok, confidence: 0.9 })).toThrow(/mass/);
    expect(() => validateVerdict(r, { ...ok, score: 2 })).toThrow(/score/);
    expect(() => validateVerdict(r, { ...ok, score: Number.NaN })).toThrow(/score/);
  });
  it("accepts every neutral verdict and every verdict the builders make", () => {
    for (const q of [j, p, r]) expect(() => validateVerdict(q, neutralVerdict(q))).not.toThrow();
    for (const x of [0, 0.5, 1, 0.123]) {
      expect(() => validateVerdict(j, judgeVerdictFrom(j, x))).not.toThrow();
    }
  });
});

describe("T4-01: failOpen checks every answer, cost and latency", () => {
  const ok = (q: Question): Decision => ({
    verdict: judgeVerdictFrom(q as never, 0.97),
    oracle: "x",
    latencyMs: 1,
    cost: 0.002,
    at: "2026-11-12T00:00:00Z",
  });
  const returning = (fn: (qs: readonly Question[]) => unknown): Oracle => ({
    id: "x",
    decide: async (_s, qs) => fn(qs) as Decision[],
  });
  it("a swapped batch fails open whole, and keeps the cost it was billed", async () => {
    const swapped = returning((qs) => qs.map(ok).reverse());
    const ds = await failOpen(swapped).decide("s", [qJudge, qJudge2]);
    expect(ds.every((d) => d.failedOpen === true)).toBe(true);
    expect(ds[0]?.error).toMatch(/answer 1 of 2 \(safe\).*does not match question safe/);
    expect(ds.reduce((s, d) => s + d.cost, 0)).toBeCloseTo(0.004, 12);
    expect(ds.some((d) => d.costUnknown)).toBe(false);
  });
  it("a repeated answer fails open", async () => {
    const dup = returning((qs) => qs.map(() => ok(qs[qs.length - 1] as Question)));
    const ds = await failOpen(dup).decide("s", [qJudge, qJudge2]);
    expect(ds.every((d) => d.failedOpen === true)).toBe(true);
  });
  it("a NaN or negative cost, or a negative latency, fails open with the cost unknown", async () => {
    for (const patch of [{ cost: Number.NaN }, { cost: -1 }, { latencyMs: -1 }, { cost: "1" }]) {
      const bad = returning((qs) => qs.map((q) => ({ ...ok(q), ...patch })));
      const [d] = await failOpen(bad).decide("s", [qJudge]);
      expect(d?.failedOpen, JSON.stringify(patch)).toBe(true);
      expect(Number.isFinite(d?.cost)).toBe(true);
      if ("cost" in patch) expect(d?.costUnknown).toBe(true);
    }
  });
  it("a non-array, a null entry or a short batch fails open", async () => {
    for (const fn of [() => ({}), () => [null], () => []]) {
      const [d] = await failOpen(returning(fn)).decide("s", [qJudge]);
      expect(d?.failedOpen).toBe(true);
      expect(d?.verdict).toEqual(neutralVerdict(qJudge));
    }
  });
  it("checkDecisions returns plain copies of a valid batch", () => {
    const batch = [ok(qJudge), ok(qJudge2)];
    const checked = checkDecisions("x", [qJudge, qJudge2], batch);
    expect(checked).toEqual(batch);
    expect(checked[0]).not.toBe(batch[0]);
    expect(checked[0]?.verdict).not.toBe(batch[0]?.verdict);
  });
});

describe("T4-01 (V1): failOpen never throws, and rules on what it checked", () => {
  const nasty = (fn: (qs: readonly Question[]) => unknown): Oracle => ({
    id: "nasty",
    decide: async (_s, qs) => fn(qs) as Decision[],
  });
  const throwing = (thrown: () => unknown): Oracle => ({
    id: "nasty",
    decide: async () => {
      throw thrown();
    },
  });
  const messageThrows = () => {
    const e = new Error("x");
    Object.defineProperty(e, "message", {
      get() {
        throw new Error("no message");
      },
    });
    return e;
  };
  const ok2 = (q: Question): Decision => ({
    verdict: judgeVerdictFrom(q as never, 0.97),
    oracle: "x",
    latencyMs: 1,
    cost: 0.002,
    at: "2026-11-12T00:00:00Z",
  });
  const withGetter = (q: Question, key: string) => {
    const d = { ...ok2(q) } as Record<string, unknown>;
    Object.defineProperty(d, key, {
      get() {
        throw new Error(`${key} getter`);
      },
      enumerable: true,
    });
    return d;
  };
  const hostile: [string, Oracle][] = [
    ["a rejection with no prototype", throwing(() => Object.create(null))],
    ["an error whose message getter throws", throwing(messageThrows)],
    ["an answer whose cost getter throws", nasty((qs) => qs.map((q) => withGetter(q, "cost")))],
    [
      "an answer whose verdict getter throws",
      nasty((qs) => qs.map((q) => withGetter(q, "verdict"))),
    ],
    [
      "a list whose length getter throws",
      nasty(
        (qs) =>
          new Proxy(qs.map(ok2), {
            get(t, k) {
              if (k === "length") throw new Error("length getter");
              return Reflect.get(t, k);
            },
          }),
      ),
    ],
    [
      "a sparse list with a hole where answer 1 should be",
      nasty((qs) => {
        const arr = new Array(qs.length);
        for (let i = 1; i < qs.length; i++) arr[i] = ok2(qs[i] as Question);
        return arr;
      }),
    ],
  ];
  for (const [name, inner] of hostile) {
    it(`fails open on ${name}`, async () => {
      const ds = await failOpen(inner, {
        onError: () => {
          throw new Error("a hook that throws too");
        },
      }).decide("s", [qJudge, qJudge2]);
      expect(ds).toHaveLength(2);
      expect(ds.every((d) => d.failedOpen === true && typeof d.error === "string")).toBe(true);
      // Through the engine, the ask returns and writes its row.
      const engine = new Engine({ oracle: inner, mode: "enforce" });
      const r = await engine.gate({ id: "g", question: qJudge, policy: POLICY_YES }).ask(STATE);
      expect(r.action).toBe("review");
      expect(await engine.ledger.all()).toHaveLength(1);
    });
  }
  it("a getter that reads 0.2 while checked and 0.99 later is ruled on the 0.2", async () => {
    let reads = 0;
    const shifty = {
      kind: "judge",
      questionId: qJudge.id,
      confidence: 0.8,
      get pYes() {
        reads++;
        return reads <= 1 ? 0.2 : 0.99;
      },
    };
    const inner = nasty(() => [{ ...ok2(qJudge), verdict: shifty }]);
    const [d] = await failOpen(inner).decide("s", [qJudge]);
    expect(d?.failedOpen).toBeUndefined();
    expect(rule(d as Decision, { actAbove: 0.9 }).action).toBe("review");
    expect((d?.verdict as JudgeVerdict | undefined)?.pYes).toBe(0.2);
    expect(reads).toBe(1);
  });
  it("drops strategy, members and other fields an adapter adds, so it cannot fabricate a compound", async () => {
    const inner = nasty((qs) =>
      qs.map((q) => ({
        ...ok2(q),
        strategy: "ensemble",
        members: [ok2(q), ok2(q)],
        agreement: 1,
        detail: { forged: true },
        vendor: { batch: 2, nested: { x: 1 } },
      })),
    );
    const [d] = await failOpen(inner).decide("s", [qJudge]);
    expect(Object.keys(d ?? {}).sort()).toEqual([
      "at",
      "cost",
      "latencyMs",
      "oracle",
      "vendor",
      "verdict",
    ]);
    expect(d?.vendor).toEqual({ batch: 2 });
    const engine = new Engine({ oracle: inner, mode: "enforce" });
    await engine.gate({ id: "g", question: qJudge, policy: POLICY_YES }).ask(STATE);
    const [row] = await engine.ledger.all();
    expect(row?.strategy).toBe("single");
    expect(row?.members).toBeUndefined();
  });
  it("a pick option named __proto__ is copied as a key, not a prototype", async () => {
    const q = pick("Which?", ["__proto__", "b"], { id: "proto" });
    const probabilities = JSON.parse(`{"__proto__": 0.9, "b": 0.1}`);
    const verdict = {
      kind: "pick",
      questionId: "proto",
      choice: "__proto__",
      probabilities,
      confidence: 0.9,
    };
    const inner = nasty(() => [{ ...ok2(qJudge), verdict }]);
    const [d] = await failOpen(inner).decide("s", [q]);
    expect(d?.failedOpen).toBeUndefined();
    const keys = Object.keys(
      (d?.verdict as { probabilities: object } | undefined)?.probabilities ?? {},
    );
    expect(keys).toEqual(["__proto__", "b"]);
  });
});

describe("T4-01: rule() reads a go probability that is not a probability as failed open", () => {
  const d = (pYes: unknown): Decision =>
    G<Decision>({
      verdict: { kind: "judge", questionId: "q", pYes, confidence: 0.9 },
      oracle: "raw",
      latencyMs: 0,
      cost: 0,
      at: "now",
    });
  it("never acts on NaN, infinities, out-of-range or non-numbers, even at actAbove 0", () => {
    for (const pYes of [Number.NaN, Number.POSITIVE_INFINITY, 1.7, -0.4, "0.97", null]) {
      for (const goIsYes of [true, false]) {
        const r = rule(d(pYes), { actAbove: 0, goIsYes });
        expect(r.action, String(pYes)).toBe("review");
        expect(r.reason).toMatch(/not a probability/);
      }
    }
    expect(rule(d(1.7), { actAbove: 0.5, onFailOpen: "refuse" }).action).toBe("refuse");
    expect(rule(G<Decision>({ ...d(0.9), verdict: undefined }), { actAbove: 0 }).action).toBe(
      "review",
    );
  });
  it("still rules a valid probability as before", () => {
    expect(rule(d(0.95), { actAbove: 0.9 }).action).toBe("act");
    expect(rule(d(1), { actAbove: 1 }).action).toBe("act");
    expect(rule(d(0.05), { actAbove: 0.9, refuseBelow: 0.1 }).action).toBe("refuse");
  });
});

describe("T4-05: a timeout cancels the call and leaves its cost unknown", () => {
  /** A backend that never answers on its own and records whether it was told to stop. */
  const slow = () => {
    const seen: { signal?: AbortSignal; aborted: boolean } = { aborted: false };
    const oracle: Oracle = {
      id: "slow",
      decide: (_s, qs, opts) =>
        new Promise<Decision[]>((resolve, reject) => {
          if (opts?.signal) seen.signal = opts.signal;
          opts?.signal?.addEventListener("abort", () => {
            seen.aborted = true;
            reject(new Error("AbortError"));
          });
          setTimeout(
            () =>
              resolve(
                qs.map((q) => ({
                  verdict: neutralVerdict(q),
                  oracle: "slow",
                  latencyMs: 0,
                  cost: 0.5,
                  at: "now",
                })),
              ),
            5_000,
          );
        }),
    };
    return { oracle, seen };
  };
  it("aborts the underlying request through its signal on timeout", async () => {
    const { oracle, seen } = slow();
    const [d] = await failOpen(oracle, { timeoutMs: 10 }).decide("s", [qJudge]);
    expect(seen.aborted).toBe(true);
    expect(d).toMatchObject({ failedOpen: true, cost: 0, costUnknown: true });
    expect(d?.error).toMatch(/timed out after 10 ms/);
  });
  it("forwards the caller's abort to the call, and marks the cost unknown", async () => {
    const { oracle, seen } = slow();
    const caller = new AbortController();
    const pending = failOpen(oracle).decide("s", [qJudge], { signal: caller.signal });
    caller.abort();
    const [d] = await pending;
    expect(seen.aborted).toBe(true);
    expect(d).toMatchObject({ failedOpen: true, costUnknown: true, error: "oracle call aborted" });
  });
  it("does not call at all when the caller's signal is already aborted", async () => {
    const { oracle, seen } = slow();
    const caller = new AbortController();
    caller.abort();
    const [d] = await failOpen(oracle).decide("s", [qJudge], { signal: caller.signal });
    expect(seen.signal).toBeUndefined();
    expect(d).toMatchObject({ failedOpen: true, cost: 0 });
    expect(d?.costUnknown).toBeUndefined();
  });
  it("an error the backend raised is not an unknown cost (an outage must not fill a cap)", async () => {
    const down: Oracle = { id: "down", decide: async () => Promise.reject(new Error("402")) };
    const [d] = await failOpen(down).decide("s", [qJudge]);
    expect(d).toMatchObject({ failedOpen: true, cost: 0 });
    expect(d?.costUnknown).toBeUndefined();
  });
  it("a compound decision carries costUnknown when any member's cost is unknown", async () => {
    const { oracle } = slow();
    const fast = new FaultOracle("none", 0.2, "fast");
    const engine = new Engine({ oracle: fast, timeoutMs: 10 });
    const r = await engine.ask(STATE, qJudge, {
      policy: POLICY_YES,
      strategy: {
        ensemble: {
          members: [{ oracle: fast }, { oracle }],
          minMembers: 1,
        } as never,
      },
    });
    expect(r.decision.costUnknown).toBe(true);
    expect(r.decision.members.find((m) => m.oracle === "slow")?.costUnknown).toBe(true);
  });
});
