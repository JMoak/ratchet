/**
 * V1 attacks on T4-01 (verdict validation in failOpen, validateVerdict, rule()) and T4-05
 * (timeouts abort). Offline and deterministic.
 *
 *   bun experiments/e2e/verify/v1-safety/failopen.ts
 */
import { Engine } from "../../../../src/engine.ts";
import { MemoryLedger } from "../../../../src/ledger/ledger.ts";
import { failOpen } from "../../../../src/oracles/oracle.ts";
import { rule } from "../../../../src/policy.ts";
import { judge, pick, rate, validateVerdict } from "../../../../src/questions.ts";
import type { Decision, Oracle, Question } from "../../../../src/types.ts";
import { attack, describeError, judged, report, scripted } from "./lib.ts";

const q = judge("Is it safe to run this command without asking?", { id: "q.safe" });
const policy = { actAbove: 0.9 };

/** Ask a fresh enforce gate once through the engine with an oracle; return action or error. */
async function askWith(oracle: Oracle): Promise<{ action?: string; error?: string; rows: number }> {
  const ledger = new MemoryLedger();
  const engine = new Engine({ oracle, ledger, mode: "enforce" });
  const gate = engine.gate({ id: "g", question: q, policy, mode: "enforce" });
  try {
    const r = await gate.ask("rm -rf build");
    return { action: r.ruling.action, rows: (await ledger.all()).length };
  } catch (e) {
    return { error: describeError(e), rows: (await ledger.all()).length };
  }
}

/** A verdict object shaped by hand. */
const verdictOf = (fields: Record<string, unknown>) => ({
  kind: "judge",
  questionId: q.id,
  ...fields,
});
const decisionOf = (verdict: unknown, extra: Record<string, unknown> = {}) => ({
  verdict,
  oracle: "garbage",
  latencyMs: 1,
  cost: 0.001,
  at: "2026-11-12T12:00:00.000Z",
  ...extra,
});
const garbage = (verdict: unknown, extra: Record<string, unknown> = {}): Oracle =>
  scripted("garbage", (qs) => qs.map(() => decisionOf(verdict, extra)));

// --- numeric edge cases through validateVerdict and the engine --------------------------------
const numeric: [string, unknown, unknown, boolean][] = [
  // name, pYes, confidence, should be accepted
  ["pYes -0, confidence 1", -0, 1, true],
  ["pYes 1 + 1e-12", 1 + 1e-12, 1, false],
  ["pYes Number.MIN_VALUE, confidence 1", Number.MIN_VALUE, 1, true],
  ["pYes boxed new Number(0.99)", new Number(0.99), 0.99, false],
  ["pYes 0.99, confidence boxed", 0.99, new Number(0.99), false],
  ["pYes '0.99' string", "0.99", 0.99, false],
  ["pYes 0.99n bigint", 99n, 0.99, false],
  ["pYes 0.99, confidence 0.5 (inconsistent)", 0.99, 0.5, false],
  ["pYes 0.99, confidence 0 (only neutral may)", 0.99, 0, false],
  ["pYes Infinity", Number.POSITIVE_INFINITY, 1, false],
];
for (const [name, pYes, confidence, ok] of numeric) {
  await attack("failOpen", "T4-01", `${name} -> ${ok ? "accepted" : "fails open"}`, async () => {
    const r = await askWith(garbage(verdictOf({ pYes, confidence })));
    const acted = r.action === "act";
    const expectAct = ok && typeof pYes === "number" && pYes >= 0.9;
    const held = r.error === undefined && r.rows === 1 && acted === expectAct;
    return { held, observed: JSON.stringify(r) };
  });
}

// --- a getter that changes between reads (TOCTOU) ---------------------------------------------
await attack(
  "failOpen",
  "T4-01",
  "pYes getter: 0.2 while validated, 0.99 afterwards (validated value is what gets ruled)",
  async () => {
    let reads = 0;
    const v = {
      kind: "judge",
      questionId: q.id,
      confidence: 0.8,
      get pYes() {
        reads++;
        return reads <= 4 ? 0.2 : 0.99;
      },
    };
    const r = await askWith(garbage(v));
    return {
      held: r.action !== "act",
      observed: `${JSON.stringify(r)}; pYes read ${reads} times. The validated verdict said 0.2; the ruling read a later value.`,
    };
  },
);

await attack("failOpen", "T4-01", "Proxy verdict whose every read of pYes differs", async () => {
  let n = 0;
  const target = { kind: "judge", questionId: q.id, pYes: 0.2, confidence: 0.8 };
  const v = new Proxy(target, {
    get(t, k) {
      if (k === "pYes") return n++ < 4 ? 0.2 : 2; // out of range after validation
      return Reflect.get(t, k);
    },
  });
  const r = await askWith(garbage(v));
  return { held: r.action !== "act" && r.error === undefined, observed: JSON.stringify(r) };
});

await attack("failOpen", "T4-01", "frozen valid verdict at 0.95 is accepted and acts", async () => {
  const v = Object.freeze({ kind: "judge", questionId: q.id, pYes: 0.95, confidence: 0.95 });
  const r = await askWith(garbage(v));
  return { held: r.action === "act", observed: JSON.stringify(r) };
});

// --- pick distributions with extra or prototype keys ------------------------------------------
const pq = pick("Which queue?", ["a", "b"], { id: "q.pick" });
const pickCases: [string, unknown][] = [
  ["extra key 'c'", { a: 0.9, b: 0.1, c: 0 }],
  ["own __proto__ key (JSON.parse)", JSON.parse('{"a":0.9,"b":0.1,"__proto__":0}')],
  ["a/b inherited from prototype only", Object.create({ a: 0.9, b: 0.1 })],
  ["array instead of record", [0.9, 0.1]],
];
for (const [name, probabilities] of pickCases) {
  await attack("validateVerdict", "T4-01", `pick probabilities: ${name} is rejected`, () => {
    try {
      validateVerdict(pq, {
        kind: "pick",
        questionId: pq.id,
        choice: "a",
        confidence: 0.9,
        probabilities,
      } as never);
      return { held: false, observed: "accepted" };
    } catch (e) {
      return { held: true, observed: describeError(e) };
    }
  });
}

// --- rate verdicts: probabilities out of order with the level, a wrong score ------------------
const rq = rate("How urgent?", ["low", "mid", "high"], { id: "q.rate" });
const rateCases: [string, Record<string, unknown>, boolean][] = [
  [
    "consistent (level high, mass 0.9 at index 2)",
    { level: "high", confidence: 0.9, probabilities: [0.05, 0.05, 0.9], score: 1.85 },
    true,
  ],
  [
    "probabilities reversed against the level",
    { level: "high", confidence: 0.9, probabilities: [0.9, 0.05, 0.05], score: 1.85 },
    false,
  ],
  [
    "score from the other order",
    { level: "high", confidence: 0.9, probabilities: [0.05, 0.05, 0.9], score: 0.15 },
    false,
  ],
  [
    "one level missing (length 2)",
    { level: "high", confidence: 0.9, probabilities: [0.1, 0.9], score: 0.9 },
    false,
  ],
  [
    "probabilities as a {low,mid,high} record",
    {
      level: "high",
      confidence: 0.9,
      probabilities: { low: 0.05, mid: 0.05, high: 0.9 },
      score: 1.85,
    },
    false,
  ],
];
for (const [name, fields, ok] of rateCases) {
  await attack(
    "validateVerdict",
    "T4-01",
    `rate: ${name} -> ${ok ? "accepted" : "rejected"}`,
    () => {
      try {
        validateVerdict(rq, { kind: "rate", questionId: rq.id, ...fields } as never);
        return { held: ok, observed: "accepted" };
      } catch (e) {
        return { held: !ok, observed: describeError(e) };
      }
    },
  );
}

// --- failOpen must never throw ----------------------------------------------------------------
const neverThrows: [string, Oracle][] = [
  [
    "inner rejects with Object.create(null) (String() of it throws)",
    scripted("weird", () => {
      throw Object.create(null);
    }),
  ],
  [
    "inner rejects with an Error whose message getter throws",
    scripted("weird", () => {
      const e = new Error("x");
      Object.defineProperty(e, "message", {
        get() {
          throw new Error("no message for you");
        },
      });
      throw e;
    }),
  ],
  [
    "answer whose cost getter throws",
    scripted("weird", (qs) =>
      qs.map((x) => {
        const d = judged(x, 0.95) as unknown as Record<string, unknown>;
        Object.defineProperty(d, "cost", {
          get() {
            throw new Error("cost getter");
          },
        });
        return d;
      }),
    ),
  ],
  [
    "answer array (Proxy) whose length getter throws",
    scripted(
      "weird",
      (qs) =>
        new Proxy(
          qs.map((x) => judged(x, 0.95)),
          {
            get(t, k) {
              if (k === "length") throw new Error("length getter");
              return Reflect.get(t, k);
            },
          },
        ),
    ),
  ],
];
for (const [name, inner] of neverThrows) {
  await attack("failOpen", "T4-01", `failOpen never throws: ${name}`, async () => {
    try {
      const ds = await failOpen(inner).decide("s", [q]);
      return {
        held: ds.length === 1 && ds[0]?.failedOpen === true,
        observed: `failed open: ${ds[0]?.error ?? ""}`,
      };
    } catch (e) {
      const r = await askWith(inner);
      return {
        held: false,
        observed: `failOpen threw "${describeError(e)}"; through a gate: ${JSON.stringify(r)}`,
      };
    }
  });
}

await attack(
  "failOpen",
  "T4-01",
  "sparse answer array of the right length (a hole where answer 1 should be)",
  async () => {
    const inner = scripted("holey", (qs) => {
      const arr = new Array(qs.length);
      for (let i = 1; i < qs.length; i++) arr[i] = judged(qs[i] as Question, 0.95);
      return arr;
    });
    try {
      const ds = await failOpen(inner).decide("s", [q, judge("other?", { id: "q.other" })]);
      const ok = ds.length === 2 && ds.every((d) => d?.failedOpen === true);
      return {
        held: ok,
        observed: `${ds.map((d) => (d ? (d.failedOpen ? "failedOpen" : "ok") : "HOLE")).join(",")}`,
      };
    } catch (e) {
      return { held: false, observed: `threw ${describeError(e)}` };
    }
  },
);

await attack(
  "failOpen",
  "T4-01",
  "battery: a hole where the cautious member's answer should be never acts",
  async () => {
    const members = [
      judge("Is it destructive?", { id: "m.destructive" }),
      judge("Is it in the workspace?", { id: "m.inside" }),
    ];
    const inner = scripted("holey", (qs) => {
      const arr = new Array(qs.length);
      for (let i = 1; i < qs.length; i++) arr[i] = judged(qs[i] as Question, 0.999);
      return arr;
    });
    const ledger = new MemoryLedger();
    const engine = new Engine({ oracle: inner, ledger, mode: "enforce" });
    const gate = engine.gate({ id: "b", question: members, policy, mode: "enforce" });
    try {
      const r = await gate.ask("s");
      return { held: r.ruling.action !== "act", observed: `${r.ruling.action}` };
    } catch (e) {
      const rows = await ledger.all();
      return {
        held: true,
        observed: `threw "${describeError(e)}" (no act); ${rows.length} rows written, combined row ${rows.some((r) => r.combined) ? "present" : "missing"}`,
      };
    }
  },
);

await attack(
  "failOpen",
  "T4-01",
  "adapter decision carrying strategy/members keys is passed through as a compound",
  async () => {
    const inner = scripted("compoundish", (qs) =>
      qs.map((x) => ({
        ...judged(x, 0.95),
        strategy: "ensemble",
        members: [judged(x, 0.95, { cost: 5 }), judged(x, 0.95, { cost: 5 })],
        agreement: 1,
        detail: {},
      })),
    );
    const ledger = new MemoryLedger();
    const engine = new Engine({ oracle: inner, ledger, budgetUsd: 1 });
    const gate = engine.gate({ id: "g", question: q, policy });
    await gate.ask("s");
    const [row] = await ledger.all();
    const fabricated = (row?.members?.length ?? 0) > 1;
    return {
      held: !fabricated,
      observed: `ledger row members: ${row?.members?.length ?? 0}, strategy ${String((row as unknown as { strategy?: string })?.strategy)}, engine.spent ${engine.spent}`,
    };
  },
);

// --- rule() guard -----------------------------------------------------------------------------
const ruleCases: [string, unknown, Record<string, unknown>][] = [
  ["judge pYes 1.5", verdictOf({ pYes: 1.5, confidence: 1 }), {}],
  [
    "judge pYes -0.5 with goIsYes false (go 1.5)",
    verdictOf({ pYes: -0.5, confidence: 1 }),
    { goIsYes: false },
  ],
  ["judge pYes NaN", verdictOf({ pYes: Number.NaN, confidence: 1 }), {}],
  ["judge pYes boxed 0.99", verdictOf({ pYes: new Number(0.99), confidence: 0.99 }), {}],
  ["verdict null", null, {}],
  [
    "pick confidence '0.99'",
    { kind: "pick", questionId: "x", choice: "a", confidence: "0.99" },
    {},
  ],
  ["unknown kind with confidence 1", { kind: "vote", questionId: "x", confidence: 1, pYes: 1 }, {}],
];
for (const [name, verdict, extra] of ruleCases) {
  await attack("rule", "T4-01", `rule() never acts on ${name}`, () => {
    const r = rule(decisionOf(verdict) as unknown as Decision, { actAbove: 0.5, ...extra });
    return { held: r.action !== "act", observed: `${r.action}: ${r.reason}` };
  });
}

// --- T4-05: the timeout aborts the underlying call --------------------------------------------
await attack(
  "failOpen",
  "T4-05",
  "timeout aborts the inner call's signal and marks costUnknown",
  async () => {
    let aborted = false;
    const slow: Oracle = {
      id: "slow",
      decide: (_s, qs, opts) =>
        new Promise((resolve) => {
          opts?.signal?.addEventListener("abort", () => {
            aborted = true;
          });
          setTimeout(() => resolve(qs.map((x) => judged(x, 0.99))), 200);
        }),
    };
    const [d] = await failOpen(slow, { timeoutMs: 20 }).decide("s", [q]);
    return {
      held: aborted && d?.failedOpen === true && d.costUnknown === true,
      observed: `aborted ${aborted}, failedOpen ${d?.failedOpen}, costUnknown ${d?.costUnknown}`,
    };
  },
);

await attack("failOpen", "T4-05", "caller abort mid-call aborts the inner call", async () => {
  let aborted = false;
  const slow: Oracle = {
    id: "slow",
    decide: (_s, qs, opts) =>
      new Promise((resolve) => {
        opts?.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        setTimeout(() => resolve(qs.map((x) => judged(x, 0.99))), 100);
      }),
  };
  const c = new AbortController();
  setTimeout(() => c.abort(), 10);
  const [d] = await failOpen(slow).decide("s", [q], { signal: c.signal });
  return {
    held: aborted && d?.failedOpen === true && d.costUnknown === true,
    observed: `aborted ${aborted}, failedOpen ${d?.failedOpen}, costUnknown ${d?.costUnknown}`,
  };
});

await attack(
  "failOpen",
  "T4-05",
  "no unhandled rejection when the caller aborts after the call settled",
  async () => {
    let unhandled = 0;
    const onUnhandled = () => {
      unhandled++;
    };
    process.on("unhandledRejection", onUnhandled);
    const c = new AbortController();
    const fast: Oracle = { id: "fast", decide: async (_s, qs) => qs.map((x) => judged(x, 0.99)) };
    await failOpen(fast, { timeoutMs: 50 }).decide("s", [q], { signal: c.signal });
    c.abort();
    await new Promise((r) => setTimeout(r, 80));
    process.off("unhandledRejection", onUnhandled);
    return { held: unhandled === 0, observed: `unhandled rejections: ${unhandled}` };
  },
);

const broken = report("V1: fail-open and verdict validation (T4-01, T4-05)");
process.exitCode = broken > 0 ? 1 : 0;
