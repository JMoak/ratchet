/**
 * V2 attacks on the wave-2 fixes to what the engine learns and reports: configuration scoping,
 * a gate whose newest row is floored or failed open, battery member truths, per-pair correlation
 * matrices that are singular, not positive semidefinite or hold NaN, `fitLogistic` on separable
 * and one-class rows, profiles across a model change, the battery readout's wording and the
 * model-family rule. Deterministic and offline; each case prints what it observed and whether
 * that is what an honest report would say.
 *
 *   bun experiments/e2e/verify/v2-learning/attacks.ts
 *
 * Writes experiments/out/e2e/verify/v2-learning/attacks.md. Exits 1 when any case is a defect.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkGate } from "../../../../src/cli/check.ts";
import { groupGates } from "../../../../src/cli/common.ts";
import { buildReport, renderReport } from "../../../../src/cli/report.ts";
import { poolJudge, poolWeights } from "../../../../src/compound/aggregate.ts";
import { fitLogistic } from "../../../../src/compound/learned.ts";
import { Engine } from "../../../../src/engine.ts";
import { describeBattery, gateEvidence } from "../../../../src/ledger/bars.ts";
import { borrowFor } from "../../../../src/ledger/borrow.ts";
import {
  disagreement,
  memberCorrelation,
  modelFamily,
} from "../../../../src/ledger/calibration.ts";
import { currentConfiguration, describeGrade, gradeOf } from "../../../../src/ledger/evidence.ts";
import { type DecisionRecord, MemoryLedger } from "../../../../src/ledger/ledger.ts";
import { buildProfile } from "../../../../src/ledger/profile.ts";
import { judge, judgeVerdictFrom } from "../../../../src/questions.ts";
import type { JudgeQuestion, JudgeVerdict, Oracle } from "../../../../src/types.ts";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const OUT = join(ROOT, "experiments", "out", "e2e", "verify", "v2-learning");

interface Case {
  id: string;
  title: string;
  observed: string;
  defect: boolean;
  severity?: "high" | "medium" | "low";
}
const cases: Case[] = [];
const record = (c: Case) => {
  cases.push(c);
  process.stdout.write(
    `[${c.defect ? `DEFECT ${c.severity}` : "ok"}] ${c.id}: ${c.title}\n  ${c.observed}\n`,
  );
};

/** A fixed-probability oracle; states containing FAIL throw, so the engine fails open. */
const oracle = (p: number, model = "m-1"): Oracle => ({
  id: "fixed",
  async decide(state, qs) {
    if (state.includes("FAIL")) throw new Error("upstream 503");
    return qs.map((q) => ({
      verdict: judgeVerdictFrom(q as JudgeQuestion, p),
      oracle: "fixed",
      model,
      latencyMs: 0,
      cost: 0,
      at: new Date().toISOString(),
    }));
  },
});

const v = (p: number): JudgeVerdict => judgeVerdictFrom(judge("q?", { id: "q" }), p);

async function configuration(): Promise<void> {
  // A1: a rubric edit that also renames the question id (a common versioning habit). The
  // per-question rule keeps the old id's rows current, so check passes on the old rubric's labels.
  {
    const ledger = new MemoryLedger();
    const old = new Engine({ oracle: oracle(0.97), ledger });
    const g1 = old.gate({
      id: "g",
      question: judge("Safe to run?", { id: "safe.v1" }),
      policy: { actAbove: 0.9 },
    });
    for (let i = 0; i < 40; i++) {
      const r = await g1.ask(`old ${i}`);
      await old.label(r.recordId, { correct: true, truth: true, source: "review:blind:v2" });
    }
    const now = new Engine({ oracle: oracle(0.95), ledger });
    const g2 = now.gate({
      id: "g",
      question: judge("Would the user probably not mind this?", { id: "safe.v2" }),
      policy: { actAbove: 0.9 },
    });
    for (let i = 0; i < 10; i++) await g2.ask(`new ${i}`);
    const rows = await ledger.all();
    const cur = currentConfiguration(rows);
    const chk = checkGate(groupGates(rows), { gate: "g", promise: 0.95, minRows: 30, window: 500 });
    const rep = await g2.report({ targetAccuracy: 0.95 });
    record({
      id: "A1",
      title: "rubric edit with a renamed question id (same gate, policy, evidence version)",
      observed: `current ${cur.current.length}, older ${cur.older.length}; grade ${rep.grade.kind}${rep.grade.kind === "estimated" ? ` on ${rep.grade.n} rows, every one of the old rubric` : ""}; check ${chk.pass ? "PASS" : "FAIL"}: ${chk.line.slice(0, 160)}...`,
      defect: chk.pass && rep.grade.kind === "estimated",
      severity: "medium",
    });
  }
  // A2: the same rubric edit keeping the id retires the old rows (the documented rule).
  {
    const ledger = new MemoryLedger();
    const old = new Engine({ oracle: oracle(0.97), ledger });
    const g1 = old.gate({
      id: "g",
      question: judge("Safe to run?", { id: "safe" }),
      policy: { actAbove: 0.9 },
    });
    for (let i = 0; i < 40; i++) {
      const r = await g1.ask(`old ${i}`);
      await old.label(r.recordId, { correct: true, truth: true, source: "review:blind:v2" });
    }
    const now = new Engine({ oracle: oracle(0.95), ledger });
    const g2 = now.gate({
      id: "g",
      question: judge("Would the user mind?", { id: "safe" }),
      policy: { actAbove: 0.9 },
    });
    for (let i = 0; i < 10; i++) await g2.ask(`new ${i}`);
    const rows = await ledger.all();
    const chk = checkGate(groupGates(rows), { gate: "g", promise: 0.95, minRows: 30, window: 500 });
    const g = gradeOf(rows);
    record({
      id: "A2",
      title: "rubric edit keeping the question id",
      observed: `grade ${g.kind}${g.kind === "none" ? ` (older ${g.older ?? 0})` : ""}; check ${chk.pass ? "PASS" : "FAIL"}`,
      defect: g.kind !== "none" || chk.pass,
      severity: "high",
    });
  }
  // A3: a multi-question gate asked through relevance-style per-item ids, then one item's rubric
  // edited: only that item's old rows retire.
  {
    const ledger = new MemoryLedger();
    const e = new Engine({ oracle: oracle(0.96), ledger });
    const keep = e.gate({
      id: "keep",
      question: judge("needed?", { id: "keep" }),
      policy: { actAbove: 0.9 },
    });
    const items = Array.from({ length: 8 }, (_, i) =>
      judge(`Is item ${i} needed?`, { id: `item-${i}` }),
    );
    for (let i = 0; i < 5; i++) {
      const rs = await keep.askAll(`ctx ${i}`, items, { policy: { actAbove: 0.9 } });
      for (const r of rs) await e.label(r.recordId, { correct: true, truth: true });
    }
    const edited = judge("Is item 0 still needed for the task?", { id: "item-0" });
    await keep.askAll("ctx edited", [edited, ...items.slice(1)], { policy: { actAbove: 0.9 } });
    const rows = (await ledger.all()).filter((r) => r.gateId === "keep");
    const cur = currentConfiguration(rows);
    const olderIds = new Set(cur.older.map((r) => r.questionId));
    record({
      id: "A3",
      title: "multi-question gate: one item's rubric edited",
      observed: `current ${cur.current.length}, older ${cur.older.length} (question ids of older rows: ${[...olderIds].join(", ")})`,
      defect: !(cur.older.length === 5 && olderIds.size === 1 && olderIds.has("item-0")),
      severity: "medium",
    });
  }
  // A4: policies interleaved request by request (an A/B of two bars on one gate). The grade
  // reads only the newest row's half, and flips with every request.
  {
    const ledger = new MemoryLedger();
    const e = new Engine({ oracle: oracle(0.96), ledger });
    const q = judge("ok?", { id: "ok" });
    for (let i = 0; i < 80; i++) {
      const r = await e.ask(`s ${i}`, q, { policy: { actAbove: i % 2 === 0 ? 0.9 : 0.8 } });
      await e.label(r.recordId, { correct: i % 2 === 0, truth: i % 2 === 0 });
    }
    const rows = await ledger.all();
    const g1 = gradeOf(rows);
    const g2 = gradeOf(rows.slice(0, -1));
    record({
      id: "A4",
      title: "two policies interleaved request by request",
      observed: `grade on all rows: ${g1.kind} ${g1.kind === "estimated" ? `${(100 * g1.accuracy).toFixed(0)}% on ${g1.n}, older ${g1.older}` : ""}; one row fewer: ${g2.kind} ${g2.kind === "estimated" ? `${(100 * g2.accuracy).toFixed(0)}% on ${g2.n}` : ""}. By design (each policy is its own configuration), but the grade swings 0% to 100% with the newest row; worth a line in the docs`,
      defect: false,
    });
  }
  // A6: one gate, two questions asked together with a policy each (askAll takes options per
  // question). The rubric is matched per question; the policy is matched to the newest row only.
  {
    const ledger = new MemoryLedger();
    const e = new Engine({ oracle: oracle(0.96), ledger });
    const g = e.gate({ id: "pair", question: judge("x?", { id: "x" }), policy: { actAbove: 0.9 } });
    const qs = [judge("Is it safe?", { id: "safe" }), judge("Is it in scope?", { id: "scope" })];
    for (let i = 0; i < 40; i++) {
      const rs = await g.askAll(`s ${i}`, qs, (q) => ({
        policy: { actAbove: q.id === "safe" ? 0.95 : 0.8 },
      }));
      for (const r of rs) await e.label(r.recordId, { correct: true, truth: true });
    }
    const rows = await ledger.all();
    const cur = currentConfiguration(rows);
    const ids = (rs: readonly DecisionRecord[]) =>
      [...new Set(rs.map((r) => r.questionId))].join(", ");
    record({
      id: "A6",
      title: "one gate, two questions asked together under a policy each",
      observed: `current ${cur.current.length} (${ids(cur.current)}), older ${cur.older.length} (${ids(cur.older)}): every row of the question asked first reads as an older configuration, though both policies are in use on every request`,
      defect: cur.older.length > 0,
      severity: "low",
    });
  }
  // A5: newest row floored, newest row failed open: the configuration must not move.
  {
    const ledger = new MemoryLedger();
    const e = new Engine({ oracle: oracle(0.97), ledger });
    const g = e.gate({
      id: "g",
      question: judge("ok?", { id: "ok" }),
      policy: { actAbove: 0.9 },
      floors: [(s) => (s.includes("FLOOR") ? "refuse" : undefined)],
      evidenceVersion: "v1",
    });
    for (let i = 0; i < 200; i++) {
      const r = await g.ask(`s ${i}`);
      await e.label(r.recordId, { correct: true, truth: true, source: "review:blind:v2" });
    }
    const before = gateEvidence(await ledger.all());
    await g.ask("FLOOR this");
    const afterFloor = gateEvidence(await ledger.all());
    await g.ask("FAIL this");
    const rows = await ledger.all();
    const afterFail = gateEvidence(rows);
    const last = rows.at(-1);
    const same = (a: typeof before, b: typeof before) =>
      a.grade.kind === b.grade.kind &&
      a.bar.fitted?.threshold === b.bar.fitted?.threshold &&
      a.bar.fitRows === b.bar.fitRows;
    record({
      id: "A5",
      title: "newest row floored, then newest row failed open",
      observed: `before: ${before.grade.kind}, bar ${before.bar.fitted?.threshold} on ${before.bar.fitRows}; after floor: ${afterFloor.grade.kind}, bar ${afterFloor.bar.fitted?.threshold}; after fail-open (${last?.failedOpen ? "failed open" : "answered"}, policyHash ${last?.policyHash === rows[0]?.policyHash ? "same" : "different"}): ${afterFail.grade.kind}, bar ${afterFail.bar.fitted?.threshold}`,
      defect: !(same(before, afterFloor) && same(before, afterFail)),
      severity: "high",
    });
  }
}

async function members(): Promise<void> {
  // M1: memberTruths naming only some members: the rest silently take the battery's truth.
  const answers: Record<string, Record<string, number>> = {
    spam: { threat: 0.02, harass: 0.03, spam: 0.99 },
    calm: { threat: 0.01, harass: 0.02, spam: 0.02 },
  };
  const o: Oracle = {
    id: "fixed",
    async decide(state, qs) {
      return qs.map((q) => ({
        verdict: judgeVerdictFrom(
          q as JudgeQuestion,
          answers[state.split(" ")[0] ?? ""]?.[q.id] ?? 0.5,
        ),
        oracle: "fixed",
        model: "m-1",
        latencyMs: 0,
        cost: 0,
        at: new Date().toISOString(),
      }));
    },
  };
  const ledger = new MemoryLedger();
  const e = new Engine({ oracle: o, ledger });
  const risks = ["threat", "harass", "spam"].map((id) => judge(`${id}?`, { id }));
  const gate = e.gate({
    id: "mod",
    question: risks,
    policy: { actAbove: 0.9, goIsYes: false },
    combine: "any",
    floors: [(s) => (s.includes("HASH") ? "refuse" : undefined)],
  });
  for (let i = 0; i < 20; i++) {
    const r = await gate.ask(`spam ${i}`);
    await e.label(r.recordId, { correct: true, truth: true, memberTruths: { spam: true } });
  }
  const rows = await ledger.all();
  const harass = rows.filter((r) => r.questionId === "harass");
  const scoredRight = harass.filter((r) => r.outcome?.correct === true).length;
  // Round 2: a member a present map leaves out stays unlabelled, which is the honest outcome.
  const composite = harass.filter((r) => r.outcome?.truth === true).length;
  const unlabelled = harass.filter((r) => r.outcome === undefined).length;
  record({
    id: "M1",
    title: "memberTruths naming one member of an any-battery",
    observed: `harass (truly false on every spam post, answered 0.03): ${unlabelled} of ${harass.length} unlabelled, ${composite} given the battery's truth (true), ${scoredRight} scored right`,
    defect: composite > 0,
    severity: "low",
  });
  // M2: memberTruths on a floored battery request (no member rows) throws.
  const floored = await gate.ask("HASH match");
  let threw = "";
  try {
    await e.label(floored.recordId, { correct: true, truth: true, memberTruths: { spam: false } });
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  record({
    id: "M2",
    title: "memberTruths on a floored battery request",
    observed: threw === "" ? "accepted" : `threw: ${threw}`,
    defect: threw !== "",
    severity: "low",
  });
}

/**
 * Non-negative GLS by active set: solve R w = 1, drop the member with the most negative weight,
 * solve again on the rest, until every weight is non-negative. This is what "a negative weight is
 * read as 0" has to mean for the remaining weights to still be GLS weights. Entries are read in
 * [0, 0.99] as the library reads them; a matrix that is not positive definite is left as is here
 * (each case below that is not becomes positive definite once its offending member is dropped).
 */
function nonNegativeGls(r: readonly number[][]): number[] {
  const n = r.length;
  let active = Array.from({ length: n }, (_, i) => i);
  for (;;) {
    const sub = active.map((i) => active.map((j) => r[i]?.[j] ?? 0));
    const m = sub.map((row) => [...row, 1]);
    const k = sub.length;
    for (let c = 0; c < k; c++) {
      let piv = c;
      for (let x = c + 1; x < k; x++)
        if (Math.abs(m[x]?.[c] ?? 0) > Math.abs(m[piv]?.[c] ?? 0)) piv = x;
      [m[c], m[piv]] = [m[piv] as number[], m[c] as number[]];
      const top = m[c] as number[];
      for (let x = 0; x < k; x++) {
        if (x === c) continue;
        const row = m[x] as number[];
        const f = (row[c] ?? 0) / (top[c] ?? 1);
        for (let j = c; j <= k; j++) row[j] = (row[j] ?? 0) - f * (top[j] ?? 0);
      }
    }
    const w = m.map((row, i) => (row[k] ?? 0) / (row[i] ?? 1));
    let worst = -1;
    for (let i = 0; i < k; i++)
      if ((w[i] ?? 0) < 0 && (worst < 0 || (w[i] ?? 0) < (w[worst] ?? 0))) worst = i;
    if (worst < 0 || k === 1) {
      const out = new Array<number>(n).fill(0);
      active.forEach((i, j) => {
        out[i] = Math.max(0, w[j] ?? 0);
      });
      return out;
    }
    active = active.filter((_, j) => j !== worst);
  }
}

/**
 * G0: the matrix measured from a ledger, not typed in. A generalist member errs wherever either of
 * two specialists errs (its errors are the union of theirs); the specialists never err together.
 * memberCorrelation reads a~b and a~c at 0.667 and b~c below 0 (read as 0): a suppressor.
 */
function measuredMatrix(): void {
  const at = "2026-11-12T00:00:00.000Z";
  const member = (key: string, right: boolean) => ({
    key,
    model: `vendor/${key}`,
    failedOpen: false,
    verdict: { kind: "judge", questionId: "q", pYes: right ? 0.9 : 0.1, confidence: 0.9 },
  });
  const rows = Array.from({ length: 100 }, (_, i) => ({
    id: `r${i}`,
    at,
    failedOpen: false,
    mode: "shadow",
    tags: [],
    verdict: { kind: "judge", questionId: "q", pYes: 0.9, confidence: 0.9 },
    members: [member("a", i >= 20), member("b", !(i < 10)), member("c", !(i >= 10 && i < 20))],
    outcome: { at, correct: true, truth: true },
  })) as unknown as DecisionRecord[];
  const mc = memberCorrelation(rows);
  const keys = ["a", "b", "c"];
  const w = poolWeights(3, { correlations: mc.matrix ?? {}, memberKeys: keys });
  const pooled = poolJudge(
    keys.map(() => v(0.8)),
    { correlations: mc.matrix ?? {}, memberKeys: keys },
  ).pYes;
  const indep = poolJudge(keys.map(() => v(0.8))).pYes;
  record({
    id: "G0",
    title:
      "pool with the matrix memberCorrelation measured (generalist erring on the union of two specialists)",
    observed: `measured ${mc.pairs.map((p) => `${p.keys.join("~")} ${p.correlation?.toFixed(3)}`).join(", ")}; weights ${w.weights.map((x) => x.toFixed(3)).join(", ")}, effective n ${w.effectiveN.toFixed(3)} of 3; three answers of 0.8 pool to ${pooled.toFixed(5)} (independent ${indep.toFixed(5)}, a policy at actAbove 0.999 would act)`,
    defect: w.effectiveN > 3 + 1e-9,
    severity: "high",
  });
}

function matrices(): void {
  measuredMatrix();
  const keys = ["a", "b", "c"];
  const run = (name: string, m: Record<string, Record<string, number>>, ks = keys) => {
    const w = poolWeights(ks.length, { correlations: m, memberKeys: ks });
    const pooled = poolJudge(
      ks.map(() => v(0.8)),
      { correlations: m, memberKeys: ks },
    ).pYes;
    const indep = poolJudge(ks.map(() => v(0.8))).pYes;
    const rho = (a: string, b: string) => {
      const x = m[a]?.[b] ?? m[b]?.[a];
      return typeof x === "number" && Number.isFinite(x) ? Math.min(0.99, Math.max(0, x)) : 0;
    };
    const R = ks.map((a, i) => ks.map((b, j) => (i === j ? 1 : rho(a, b))));
    const ref = nonNegativeGls(R);
    const refN = ref.reduce((s, x) => s + x, 0);
    return { name, w, pooled, indep, n: ks.length, ref, refN };
  };
  const results = [
    run("singular: a~b 1, a~c 1, b~c 1", { a: { b: 1, c: 1 }, b: { c: 1 } }),
    run("not PSD: a~b 0.99, a~c 0.99, b~c 0", { a: { b: 0.99, c: 0.99 }, b: { c: 0 } }),
    run("NaN and Infinity entries", {
      a: { b: Number.NaN, c: Number.POSITIVE_INFINITY },
      b: { c: 0.5 },
    }),
    run("negative entries", { a: { b: -0.9, c: -0.9 }, b: { c: -0.9 } }),
    run("suppressor: a~b 0.7, a~c 0.7, b~c 0", { a: { b: 0.7, c: 0.7 }, b: { c: 0 } }),
    run("suppressor, milder: a~b 0.6, a~c 0.6, b~c 0.1", { a: { b: 0.6, c: 0.6 }, b: { c: 0.1 } }),
    run("noisy framings: a~b 0.9, b~c 0.9, a~c 0.5 (not PSD)", {
      a: { b: 0.9, c: 0.5 },
      b: { c: 0.9 },
    }),
    run("measured framing3 (T5 fit): orig~para 0.77, orig~neg 0.75, para~neg 0.91", {
      a: { b: 0.77, c: 0.75 },
      b: { c: 0.91 },
    }),
    run("measured seq-bar (T5 fit): jev113~jev114 0.60, jev113~haiku 0.18, jev114~haiku -0.19", {
      a: { b: 0.6, c: 0.18 },
      b: { c: -0.19 },
    }),
  ];
  for (const r of results) {
    const finite =
      r.w.weights.every(Number.isFinite) &&
      Number.isFinite(r.w.effectiveN) &&
      Number.isFinite(r.pooled);
    // More evidence than n independent members, from members that all err together, or more
    // than non-negative GLS on the same matrix allows: overconfident.
    const over =
      r.w.effectiveN > r.n + 1e-9 ||
      r.pooled > r.indep + 1e-9 ||
      r.w.effectiveN > r.refN * 1.05 + 1e-9;
    record({
      id: "G",
      title: `pool with a correlation matrix, ${r.name}`,
      observed: `weights ${r.w.weights.map((x) => x.toFixed(3)).join(", ")}, effective n ${r.w.effectiveN.toFixed(3)} of ${r.n} (non-negative GLS re-solved: ${r.ref.map((x) => x.toFixed(3)).join(", ")}, effective n ${r.refN.toFixed(3)}); three answers of 0.8 pool to ${r.pooled.toFixed(6)} (at independence ${r.indep.toFixed(6)})`,
      defect: !finite || over,
      severity: over ? "high" : "medium",
    });
  }
}

/** E1: a gate ensemble given a measured matrix: is the matrix used, and does the row say so? */
async function ensembleMatrix(): Promise<void> {
  const member = (id: string, model: string, p: number): Oracle => ({
    id,
    async decide(_state, qs) {
      return qs.map((q) => ({
        verdict: judgeVerdictFrom(q as JudgeQuestion, p),
        oracle: id,
        model,
        latencyMs: 0,
        cost: 0,
        at: new Date().toISOString(),
      }));
    },
  });
  const low = { a: { b: 0.9, c: 0 }, b: { c: 0 } };
  // Measured high everywhere: the matrix pool is worth about one member.
  const high = { a: { b: 0.95, c: 0.9 }, b: { c: 0.9 } };
  const run = async (models: [string, string, string], correlations: typeof low) => {
    const ledger = new MemoryLedger();
    const e = new Engine({ oracle: oracle(0.5), ledger });
    const g = e.gate({
      id: "ens",
      question: judge("ok?", { id: "ok" }),
      policy: { actAbove: 0.9 },
      strategy: {
        ensemble: {
          members: [
            { oracle: member("oa", models[0], 0.8), label: "a" },
            { oracle: member("ob", models[1], 0.8), label: "b" },
            { oracle: member("oc", models[2], 0.8), label: "c" },
          ],
          correlations,
        },
      },
    });
    const r = await g.ask("state");
    const row = (await ledger.all())[0];
    return {
      p: r.decision.verdict.kind === "judge" ? r.decision.verdict.pYes : Number.NaN,
      detail: row?.detail,
    };
  };
  const keys3 = ["a", "b", "c"];
  const expected = poolJudge([v(0.8), v(0.8), v(0.8)], {
    correlations: low,
    memberKeys: keys3,
  }).pYes;
  const expectedHigh = poolJudge([v(0.8), v(0.8), v(0.8)], {
    correlations: high,
    memberKeys: keys3,
  }).pYes;
  const distinct = await run(["m-a", "m-b", "m-c"], low);
  const shared = await run(["m-1", "m-1", "m-2"], high);
  record({
    id: "E1",
    title: "gate ensemble with `correlations`: provenance on the row",
    observed: `three models: pooled ${distinct.p.toFixed(4)} (matrix pool ${expected.toFixed(4)}), detail ${JSON.stringify(distinct.detail)}`,
    defect:
      JSON.stringify(distinct.detail ?? {}).includes('"rhoSource":"default') &&
      !JSON.stringify(distinct.detail ?? {}).includes("matrix"),
    severity: "low",
  });
  record({
    id: "E2",
    title: "gate ensemble with `correlations`, two members recording one model",
    observed: `matrix a~b 0.95, a~c 0.9, b~c 0.9; pooled ${shared.p.toFixed(4)} where the matrix pool is ${expectedHigh.toFixed(4)}: the engine re-pooled at the scalar default and dropped the caller's matrix, ending more confident; detail ${JSON.stringify(shared.detail)}`,
    defect: shared.p > expectedHigh + 1e-9,
    severity: "medium",
  });
}

function logistic(): void {
  const rows = (pairs: readonly [number, boolean][]) => pairs.map(([x, y]) => ({ x: [x], y }));
  const sep = rows(
    Array.from({ length: 40 }, (_, i) => [i < 20 ? -2 - i / 10 : 2 + i / 10, i >= 20]),
  );
  const cases_: [string, ReturnType<typeof fitLogistic>][] = [
    ["separable, default l2", fitLogistic(sep)],
    ["separable, l2 0", fitLogistic(sep, { l2: 0 })],
    [
      "one class (all true), default l2",
      fitLogistic(rows(Array.from({ length: 30 }, (_, i) => [i / 10, true]))),
    ],
    [
      "one class, l2 0",
      fitLogistic(rows(Array.from({ length: 30 }, (_, i) => [i / 10, true])), { l2: 0 }),
    ],
    [
      "constant feature, mixed labels",
      fitLogistic(rows(Array.from({ length: 30 }, (_, i) => [1, i % 3 === 0]))),
    ],
  ];
  for (const [name, f] of cases_) {
    const finite = [f.bias, f.loss, ...f.weights].every(Number.isFinite);
    const p = 1 / (1 + Math.exp(-(f.bias + (f.weights[0] ?? 0) * 0.5)));
    // A one-class fit has no MLE; reporting converged with a near-certain prediction is the
    // question. With l2 0 on separable rows the weights have no finite optimum either.
    const noOptimum = name.startsWith("one class") || name === "separable, l2 0";
    record({
      id: "L",
      title: `fitLogistic, ${name}`,
      observed: `weights ${f.weights.map((w) => w.toFixed(2)).join(", ")}, bias ${f.bias.toFixed(2)}, loss ${f.loss.toExponential(2)}, converged ${f.converged} in ${f.iterations}; p(yes) at x=0.5: ${p.toFixed(6)}`,
      defect: !finite || (noOptimum && f.converged),
      severity: "low",
    });
  }
}

function profiles(): void {
  // Donor rows: model A, judge, 200 shadow rows labelled, confidence 0.97, all right.
  const at = "2026-11-01T00:00:00.000Z";
  const mk = (i: number, model: string, extra: Partial<DecisionRecord> = {}): DecisionRecord =>
    ({
      id: `${model}-${i}-${extra.gateId ?? "donor"}`,
      at,
      gateId: "donor",
      requestId: `r-${model}-${i}-${extra.gateId ?? "donor"}`,
      questionId: "ok",
      kind: "judge",
      prompt: "ok?",
      questionHash: "qh",
      policyHash: "ph",
      stateHash: `s${i}`,
      trustedHash: `s${i}`,
      untrusted: [],
      oracle: "fixed",
      model,
      strategy: "single",
      verdict: { kind: "judge", questionId: "ok", pYes: 0.97, confidence: 0.97 },
      go: 0.97,
      confidence: 0.97,
      agreement: 1,
      soft: "act",
      action: "review",
      mode: "shadow",
      cost: 0,
      latencyMs: 0,
      failedOpen: false,
      tags: [],
      outcome: { at, correct: true, truth: true, source: "review:blind:v2" },
      ...extra,
    }) as DecisionRecord;
  const donor = Array.from({ length: 200 }, (_, i) => mk(i, "vendor/model-a"));
  const profile = buildProfile(
    donor,
    { model: "vendor/model-a", kind: "judge" },
    { ledgers: ["donor.jsonl"] },
  );
  if (profile === undefined) throw new Error("no profile");
  const unlabelled = (
    model: string,
    gateId: string,
    n: number,
    from = 0,
    extra: Partial<DecisionRecord> = {},
  ) =>
    Array.from({ length: n }, (_, i) => {
      const { outcome: _o, ...r } = mk(from + i, model, { gateId, ...extra });
      return r as DecisionRecord;
    });
  // P1: newest rows from model B, no barSource: nothing lent.
  const p1 = [...unlabelled("vendor/model-a", "g", 5), ...unlabelled("vendor/model-b", "g", 5, 5)];
  const b1 = borrowFor(p1, [profile], { target: 0.95 });
  // P2: declared barSource, newest rows from B: stale.
  const declared = {
    detail: { barSource: { profileHash: profile.hash } },
  } as Partial<DecisionRecord>;
  const p2 = [
    ...unlabelled("vendor/model-a", "g", 5, 0, declared),
    ...unlabelled("vendor/model-b", "g", 5, 5, declared),
  ];
  const b2 = borrowFor(p2, [profile], { target: 0.95 });
  // P3: a rollout pin of model A while the oracle now answers with B (what Gate.report() passes
  // for a gate whose rollout pins A): lent, and not stale.
  const b3 = borrowFor(p2, [profile], { target: 0.95, model: "vendor/model-a" });
  const g3 = gateEvidence(p2, {
    profiles: [profile],
    pin: "vendor/model-a",
    levers: { target: 0.95 },
  }).grade;
  record({
    id: "P1",
    title: "profile, newest rows from another model, no barSource",
    observed: b1 === undefined ? "nothing lent" : `lent bar ${b1.via.bar} (stale ${b1.stale})`,
    defect: b1 !== undefined,
    severity: "medium",
  });
  record({
    id: "P2",
    title: "profile declared as barSource, newest rows from another model",
    observed: b2 === undefined ? "nothing lent" : `lent bar ${b2.via.bar}, stale ${b2.stale}`,
    defect: b2 === undefined || !b2.stale,
    severity: "medium",
  });
  record({
    id: "P3",
    title: "profile declared, rollout pins model A, oracle now answers with model B",
    observed: `${b3 === undefined ? "nothing lent" : `lent bar ${b3.via.bar}, stale ${b3.stale}`}; grade ${g3.kind}${g3.kind === "borrowed" ? `${g3.stale ? " (stale)" : ""}` : ""}. Every row the gate now writes is model B's, which the pin's rollout will never read, yet the report says it borrows model A's bar with no stale mark`,
    defect: b3 !== undefined && !b3.stale,
    severity: "low",
  });
}

function wording(): void {
  const learned = describeBattery({
    combine: "learned",
    verdicts: 432,
    saturated: 227,
    share: 227 / 432,
  });
  record({
    id: "W1",
    title: "battery readout for a learned combiner that saturates",
    observed: learned,
    defect: learned.includes("fit a learned combiner"),
    severity: "low",
  });
  const allWrong = describeBattery({ combine: "all", verdicts: 108, saturated: 108, share: 1 });
  record({
    id: "W2",
    title: "battery readout for `all` on a disjunction (every verdict saturated)",
    observed: `${allWrong} (no hint; the report's observed 48.1% is the only sign)`,
    defect: false,
  });
  // Model family: a suffix after the version defeats the same-family refusal.
  const pairs: [string, string][] = [
    ["typesafe/jev-1.13-20260917", "typesafe/jev-1.14"],
    ["typesafe/jev-1.13-instruct", "typesafe/jev-1.14-instruct"],
    ["typesafe/jev-1.13-fp8", "typesafe/jev-1.14-fp8"],
    ["meta-llama/llama-3.1-70b-instruct", "meta-llama/llama-3.1-8b-instruct"],
    ["anthropic/claude-haiku-5.5", "typesafe/jev-1.13"],
  ];
  for (const [a, b] of pairs) {
    const same = modelFamily(a) === modelFamily(b);
    let accepted = true;
    try {
      gradeOf([], {
        borrowed: { type: "disagreement", rate: 0.05, pairs: 100, models: [a, b] },
        borrowedAt: "2026-11-12T00:00:00.000Z",
      });
    } catch {
      accepted = false;
    }
    const oneFamily = a.startsWith("typesafe/jev") && b.startsWith("typesafe/jev");
    const llama = a.startsWith("meta-llama") && b.startsWith("meta-llama");
    record({
      id: "F",
      title: `modelFamily ${a} vs ${b}`,
      observed: `${modelFamily(a)} | ${modelFamily(b)}: ${same ? "one family" : "two families"}; as a second opinion: ${accepted ? "accepted" : "refused"}`,
      defect: (oneFamily || llama) && accepted,
      severity: "medium",
    });
  }
  // The disagreement sentence: a lower bound phrased as a value.
  const rows = Array.from({ length: 100 }, (_, i) => ({
    id: `d${i}`,
    at: "2026-11-12T00:00:00.000Z",
    failedOpen: false,
    members: [
      {
        key: "x",
        model: "vendor-a/one",
        failedOpen: false,
        verdict: { kind: "judge", questionId: "q", pYes: 0.9, confidence: 0.9 },
      },
      {
        key: "y",
        model: "vendor-b/two",
        failedOpen: false,
        verdict: { kind: "judge", questionId: "q", pYes: i < 10 ? 0.1 : 0.9, confidence: 0.9 },
      },
    ],
  })) as unknown as DecisionRecord[];
  const d = disagreement(rows);
  record({
    id: "W3",
    title: "disagreement sentence",
    observed:
      d === undefined
        ? "undefined"
        : `rate ${d.via.rate}; sentence: ${describeGrade(gradeOf([], { borrowed: d.via, borrowedAt: d.at }))}`,
    defect:
      d !== undefined &&
      !describeGrade(gradeOf([], { borrowed: d.via, borrowedAt: d.at })).includes("at least 10.0%"),
    severity: "low",
  });
}

async function unregistered(): Promise<void> {
  const ledger = new MemoryLedger();
  const e = new Engine({ oracle: oracle(0.97), ledger });
  const g = e.gate({ id: "g", question: judge("ok?", { id: "ok" }), policy: { actAbove: 0.9 } });
  const sources = [
    "accepted:",
    "Reverted:git",
    "hook:inferred",
    "review:blind:x",
    undefined,
    "accepted:merge",
  ];
  for (let i = 0; i < 60; i++) {
    const r = await g.ask(`s ${i}`);
    const source = sources[i % sources.length];
    await e.label(r.recordId, {
      correct: true,
      truth: true,
      ...(source !== undefined ? { source } : {}),
    });
  }
  const rep = buildReport("synthetic.jsonl", await ledger.all(), {});
  const gr = rep.gates[0];
  const text = renderReport(rep);
  const section = /## Unregistered label sources\n\n(.*)/.exec(text)?.[1] ?? "(no section)";
  record({
    id: "U1",
    title: "Unregistered label sources section",
    observed: `labelled ${gr?.labelled} (blind 10 + unsourced 10 expected), consequence ${gr?.consequence} (accepted:merge 10 expected), unregistered ${gr?.unregistered} (30 expected), fit rows ${gr?.fitRows}; section: ${section}`,
    defect:
      gr?.labelled !== 20 ||
      gr?.unregistered !== 30 ||
      gr?.consequence !== 10 ||
      gr?.fitRows !== 20,
    severity: "medium",
  });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await configuration();
  await members();
  matrices();
  await ensembleMatrix();
  logistic();
  profiles();
  wording();
  await unregistered();
  const md = [
    "# V2 attacks on the learning and reporting fixes",
    "",
    "| case | what | observed | verdict |",
    "| --- | --- | --- | --- |",
    ...cases.map(
      (c) =>
        `| ${c.id} | ${c.title} | ${c.observed.replace(/\|/g, "\\|").replace(/\n/g, " ")} | ${c.defect ? `**defect (${c.severity})**` : "ok"} |`,
    ),
    "",
  ].join("\n");
  writeFileSync(join(OUT, "attacks.md"), md);
  process.exitCode = cases.some((c) => c.defect) ? 1 : 0;
}

if (import.meta.main) await main();
