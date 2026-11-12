/**
 * V2 round 2: attacks on the round-2 fixes. Non-negative GLS on edge-case matrices and a seeded
 * fuzz; `modelFamily` merges and splits on model ids from this repo's ledgers and on common
 * OpenRouter ids, and whether a split or a merge makes a gate less cautious (default rho, the
 * lead count, disagreement); configuration scope with interleaved and per-question evidence
 * versions, and a policy change on a gate whose question ids are asked once each. Offline.
 *
 *   bun experiments/e2e/verify/v2-learning/attacks-r2.ts
 *
 * Writes experiments/out/e2e/verify/v2-learning/attacks-r2.txt. Exits 1 when a case is a defect.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkGate } from "../../../../src/cli/check.ts";
import { groupGates } from "../../../../src/cli/common.ts";
import { poolJudge, poolPick, poolWeights } from "../../../../src/compound/aggregate.ts";
import { voterKey } from "../../../../src/compound/sequential.ts";
import { Engine } from "../../../../src/engine.ts";
import { modelFamily } from "../../../../src/ledger/calibration.ts";
import { currentConfiguration, gradeOf } from "../../../../src/ledger/evidence.ts";
import { MemoryLedger } from "../../../../src/ledger/ledger.ts";
import { rng } from "../../../../src/math.ts";
import { judge, judgeVerdictFrom, pick, pickVerdictFrom } from "../../../../src/questions.ts";
import type { Decision, JudgeQuestion, Oracle } from "../../../../src/types.ts";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const OUT = join(ROOT, "experiments", "out", "e2e", "verify", "v2-learning");
const lines: string[] = [];
let defects = 0;
const say = (id: string, ok: boolean, text: string, severity = "") => {
  if (!ok) defects++;
  lines.push(`[${ok ? "ok" : `DEFECT ${severity}`}] ${id}: ${text}`);
};

const v = (p: number) => judgeVerdictFrom(judge("q?", { id: "q" }), p);

function gls(): void {
  // Equicorrelated: the matrix pool must equal the scalar design effect.
  for (const n of [2, 3, 5]) {
    for (const r of [0.3, 0.75, 0.99]) {
      const keys = Array.from({ length: n }, (_, i) => `m${i}`);
      const m: Record<string, Record<string, number>> = {};
      for (const a of keys) {
        const row: Record<string, number> = {};
        for (const b of keys) if (a !== b) row[b] = r;
        m[a] = row;
      }
      const w = poolWeights(n, { correlations: m, memberKeys: keys });
      const s = poolWeights(n, { correlation: r });
      const pm = poolJudge(
        keys.map(() => v(0.8)),
        { correlations: m, memberKeys: keys },
      ).pYes;
      const ps = poolJudge(
        keys.map(() => v(0.8)),
        { correlation: r },
      ).pYes;
      say(
        `G-eq n${n} rho${r}`,
        Math.abs(w.effectiveN - s.effectiveN) < 1e-9 && Math.abs(pm - ps) < 1e-9,
        `matrix n_eff ${w.effectiveN.toFixed(4)} vs scalar ${s.effectiveN.toFixed(4)}; pool ${pm.toFixed(6)} vs ${ps.toFixed(6)}`,
        "medium",
      );
    }
  }
  // One member equally correlated with all others, the rest mixed.
  {
    const keys = ["a", "b", "c", "d"];
    const m = { a: { b: 0.5, c: 0.5, d: 0.5 }, b: { c: 0.9, d: 0.1 }, c: { d: 0.1 } };
    const w = poolWeights(4, { correlations: m, memberKeys: keys });
    say(
      "G-hub",
      w.weights.every((x) => x >= 0 && x <= 1) && w.effectiveN <= 4,
      `weights ${w.weights.map((x) => x.toFixed(3)).join(", ")}, n_eff ${w.effectiveN.toFixed(3)}`,
    );
  }
  // 1x1, empty matrix, keys not present, duplicate keys.
  const cases: [string, Parameters<typeof poolWeights>[1], number][] = [
    ["1x1 empty matrix", { correlations: {}, memberKeys: ["a"] }, 1],
    [
      "empty matrix, fallback 0.5, n 3",
      { correlations: {}, memberKeys: ["a", "b", "c"], correlation: 0.5 },
      3,
    ],
    [
      "matrix keyed by absent members",
      { correlations: { x: { y: 0.9 } }, memberKeys: ["a", "b"] },
      2,
    ],
    ["duplicate key twice", { correlations: {}, memberKeys: ["a", "a"] }, 2],
    ["NaN fallback", { correlations: {}, memberKeys: ["a", "b"], correlation: Number.NaN }, 2],
  ];
  for (const [name, o, n] of cases) {
    let text: string;
    let ok: boolean;
    try {
      const w = poolWeights(n, o);
      const s = poolWeights(n, {
        correlation: Number.isFinite(o?.correlation) ? (o?.correlation ?? 0) : 0,
      });
      ok = w.weights.every((x) => Number.isFinite(x) && x >= 0 && x <= 1) && w.effectiveN <= n;
      text = `weights ${w.weights.map((x) => x.toFixed(3)).join(", ")}, n_eff ${w.effectiveN.toFixed(3)} (scalar at the fallback ${s.effectiveN.toFixed(3)})`;
    } catch (e) {
      ok = false;
      text = `threw ${e instanceof Error ? e.message : String(e)}`;
    }
    say(`G-edge ${name}`, ok, text, "low");
  }
  // Seeded fuzz: random matrices (some NaN, negative, above 1), random answers; judge and pick.
  const rand = rng(17);
  let worst = 0;
  let bad = 0;
  const q = pick("which?", ["x", "y", "z"], { id: "p" });
  for (let t = 0; t < 3000; t++) {
    const n = 2 + Math.floor(rand() * 4);
    const keys = Array.from({ length: n }, (_, i) => `k${i}`);
    const m: Record<string, Record<string, number>> = {};
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const u = rand();
        const row = m[keys[i] as string] ?? {};
        row[keys[j] as string] = u < 0.05 ? Number.NaN : -0.3 + 1.5 * rand();
        m[keys[i] as string] = row;
      }
    }
    const ps = keys.map(() => 0.02 + 0.96 * rand());
    const w = poolWeights(n, { correlations: m, memberKeys: keys });
    const pm = poolJudge(ps.map(v), { correlations: m, memberKeys: keys }).pYes;
    const p0 = poolJudge(ps.map(v)).pYes;
    const conf = (p: number) => Math.max(p, 1 - p);
    const over = conf(pm) - conf(p0);
    const picks = keys.map(() => {
      const a = rand();
      const b = rand() * (1 - a);
      return pickVerdictFrom(q, [a, b, 1 - a - b]);
    });
    const km = poolPick(q, picks, { correlations: m, memberKeys: keys }).confidence;
    const k0 = poolPick(q, picks).confidence;
    worst = Math.max(worst, over, km - k0);
    const okW =
      w.weights.every((x) => Number.isFinite(x) && x >= 0 && x <= 1) && w.effectiveN <= n + 1e-9;
    if (!okW || over > 1e-9 || km - k0 > 1e-9 || !Number.isFinite(pm) || !Number.isFinite(km))
      bad++;
  }
  say(
    "G-fuzz",
    bad === 0,
    `3,000 random matrices: ${bad} pools more confident than at rho 0 or with weights outside [0, 1]; worst excess ${worst.toExponential(2)}`,
    "high",
  );
}

/** Model ids seen in this repo's live ledgers (row models, member models, oracle ids). */
function ledgerIds(): string[] {
  const ids = new Set<string>();
  const dirs = [
    join(ROOT, "experiments", "out", "e2e", "t1-toolgate", "2026-11-12T10-22-04-541Z-live"),
    join(
      ROOT,
      "experiments",
      "out",
      "e2e",
      "t2-verifier",
      "2026-11-12T10-32-34-553Z-live",
      "ledgers",
    ),
    join(ROOT, "experiments", "out", "e2e", "t3-triage", "2026-11-12T10-19-41-682Z-live"),
    join(ROOT, "experiments", "out", "e2e", "t5-compound", "2026-11-12T10-35-57-202Z-main-live"),
  ];
  for (const d of dirs) {
    for (const f of readdirSync(d).filter((x) => x.endsWith(".jsonl"))) {
      for (const m of readFileSync(join(d, f), "utf8").matchAll(/"(?:model|oracle)":"([^"]+)"/g)) {
        if (m[1] !== undefined) ids.add(m[1]);
      }
    }
  }
  return [...ids].sort();
}

async function families(): Promise<void> {
  const seen = ledgerIds();
  lines.push(
    `ledger ids and their families: ${seen.map((x) => `${x} -> ${modelFamily(x)}`).join("; ")}`,
  );
  // [a, b, truly one family (shares errors), note]
  const pairs: [string, string, boolean, string][] = [
    ["typesafe/jev-1.13-20260917", "typesafe/jev-1.14-20261014", true, "two pins (phi 0.785)"],
    ["jev113@openrouter", "jev114@openrouter", true, "oracle ids used when no model is reported"],
    ["jev113.orig", "jev113.para", true, "framing member ids of one model (T5)"],
    ["typesafe/jev-1.13", "typesafe/jev-router", true, "a router over the Jev pins"],
    ["typesafe/jev-1.13", "jev-1.13", true, "same model, with and without owner"],
    [
      "anthropic/claude-sonnet-4.5",
      "claude-sonnet-4-5",
      true,
      "same model, OpenRouter id vs vendor id",
    ],
    [
      "anthropic/claude-3-5-sonnet",
      "anthropic/claude-sonnet-4.5",
      true,
      "one product line, two naming schemes",
    ],
    ["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5", false, "two tiers of one vendor"],
    ["anthropic/claude-3-haiku", "anthropic/claude-3-5-sonnet", false, "two tiers, old scheme"],
    ["openai/gpt-6-luna", "openai/gpt-6-luna-pro", true, "base and pro"],
    ["openai/gpt-4o", "openai/gpt-4o-mini", false, "two sizes"],
    [
      "meta-llama/llama-3.1-70b-instruct",
      "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
      true,
      "same weights, two hosts' spellings",
    ],
    ["mistralai/mistral-large", "mistralai/mistral-small", false, "two sizes"],
    ["google/gemini-2.5-pro", "google/gemini-2.5-flash", false, "two tiers"],
    ["anthropic/claude-haiku-5.5", "typesafe/jev-1.13", false, "different vendors"],
  ];
  const member = (id: string, model: string): Oracle => ({
    id,
    async decide(_s, qs) {
      return qs.map((q) => ({
        verdict: judgeVerdictFrom(q as JudgeQuestion, 0.8),
        oracle: id,
        model,
        latencyMs: 0,
        cost: 0,
        at: new Date().toISOString(),
      }));
    },
  });
  for (const [a, b, oneFamily, note] of pairs) {
    const merged = modelFamily(a) === modelFamily(b);
    // What the engine does with two members recording these models, distinct oracle ids.
    const ledger = new MemoryLedger();
    const e = new Engine({ oracle: member("x", "x"), ledger });
    const g = e.gate({
      id: "g",
      question: judge("ok?", { id: "ok" }),
      policy: { actAbove: 0.9 },
      strategy: {
        ensemble: { members: [{ oracle: member("oa", a) }, { oracle: member("ob", b) }] },
      },
    });
    const r = await g.ask("s");
    const rho = (await ledger.all())[0]?.detail?.correlation;
    const lead = new Set([a, b].map((m) => voterKey({ model: m, oracle: "o" } as Decision))).size;
    const verdict =
      merged === oneFamily
        ? "right"
        : merged
          ? "false merge (more cautious)"
          : "false split (less cautious)";
    say(
      `F ${a} | ${b}`,
      !(oneFamily && !merged),
      `${modelFamily(a)} | ${modelFamily(b)}: ${merged ? "one family" : "two"}; ${note}; ${verdict}; engine default rho ${String(rho)}, pooled ${r.decision.verdict.confidence.toFixed(4)} (act at 0.9: ${r.ruling.action}); lead counts ${lead} voice${lead === 1 ? "" : "s"}; disagreement ${merged ? "refused" : "accepted"}`,
      "medium",
    );
  }
}

async function scope(): Promise<void> {
  const oracle = (p: number): Oracle => ({
    id: "fixed",
    async decide(_s, qs) {
      return qs.map((q) => ({
        verdict: judgeVerdictFrom(q as JudgeQuestion, p),
        oracle: "fixed",
        model: "m-1",
        latencyMs: 0,
        cost: 0,
        at: new Date().toISOString(),
      }));
    },
  });
  // S1: a relevance-style gate (each item id asked once) loosens its policy: per-question
  // policy matching keeps every old item's rows current.
  {
    const ledger = new MemoryLedger();
    const e = new Engine({ oracle: oracle(0.96), ledger });
    const g = e.gate({
      id: "keep",
      question: judge("needed?", { id: "keep" }),
      policy: { actAbove: 0.9 },
    });
    for (let i = 0; i < 40; i++) {
      const [r] = await g.askAll(`ctx ${i}`, [judge(`Is item ${i} needed?`, { id: `item-${i}` })], {
        policy: { actAbove: 0.95 },
      });
      if (r) await e.label(r.recordId, { correct: true, truth: true, source: "review:blind:v2" });
    }
    for (let i = 40; i < 50; i++) {
      await g.askAll(`ctx ${i}`, [judge(`Is item ${i} needed?`, { id: `item-${i}` })], {
        policy: { actAbove: 0.1 },
      });
    }
    const rows = await ledger.all();
    const cur = currentConfiguration(rows);
    const chk = checkGate(groupGates(rows), {
      gate: "keep",
      promise: 0.95,
      minRows: 30,
      window: 500,
    });
    const gr = gradeOf(rows);
    say(
      "S1 policy loosened on a gate whose item ids are asked once",
      !(chk.pass && cur.older.length === 0),
      `current ${cur.current.length}, older ${cur.older.length}; grade ${gr.kind}${gr.kind === "estimated" ? ` on ${gr.n} rows, all under actAbove 0.95` : ""}; check ${chk.pass ? "PASS" : "FAIL"} for a gate now acting above 0.1 with no label (round 1 retired them: policy was gate-wide)`,
      "medium",
    );
  }
  // S2: per-question evidence versions in one gate.
  {
    const ledger = new MemoryLedger();
    const e = new Engine({ oracle: oracle(0.96), ledger });
    const g = e.gate({ id: "pair", question: judge("x?", { id: "x" }), policy: { actAbove: 0.9 } });
    const qs = [judge("Is it safe?", { id: "safe" }), judge("Is it in scope?", { id: "scope" })];
    for (let i = 0; i < 40; i++) {
      const rs = await g.askAll(`s ${i}`, qs, (q) => ({
        policy: { actAbove: 0.9 },
        evidenceVersion: q.id === "safe" ? "safe-v3" : "scope-v1",
      }));
      for (const r of rs) await e.label(r.recordId, { correct: true, truth: true });
    }
    const cur = currentConfiguration(await ledger.all());
    say(
      "S2 two questions in one gate, an evidence version each",
      true,
      `current ${cur.current.length}, older ${cur.older.length}: the evidence version is gate-wide by design (documented), so the question asked first always reads as older; worth a sentence where per-question options are documented`,
    );
  }
  // S3: interleaved evidence versions request by request.
  {
    const ledger = new MemoryLedger();
    const e = new Engine({ oracle: oracle(0.96), ledger });
    const q = judge("ok?", { id: "ok" });
    for (let i = 0; i < 80; i++) {
      const r = await e.ask(`s ${i}`, q, {
        policy: { actAbove: 0.9 },
        evidenceVersion: i % 2 === 0 ? "v1" : "v2",
      });
      await e.label(r.recordId, { correct: i % 2 === 0, truth: i % 2 === 0 });
    }
    const rows = await ledger.all();
    const a = gradeOf(rows);
    const b = gradeOf(rows.slice(0, -1));
    say(
      "S3 evidence versions interleaved request by request",
      true,
      `grade ${a.kind} ${a.kind === "estimated" ? `${(100 * a.accuracy).toFixed(0)}% on ${a.n}` : ""}; one row fewer: ${b.kind} ${b.kind === "estimated" ? `${(100 * b.accuracy).toFixed(0)}% on ${b.n}` : ""} (by design, documented for policies; the same holds for versions)`,
    );
  }
  // S4: single-question gate, policy loosened: still retired (T4-20 base case).
  {
    const ledger = new MemoryLedger();
    const e = new Engine({ oracle: oracle(0.96), ledger });
    const q = judge("ok?", { id: "ok" });
    for (let i = 0; i < 40; i++) {
      const r = await e.ask(`s ${i}`, q, { policy: { actAbove: 0.95 } });
      await e.label(r.recordId, { correct: true, truth: true });
    }
    for (let i = 0; i < 5; i++) await e.ask(`t ${i}`, q, { policy: { actAbove: 0.1 } });
    const gr = gradeOf(await ledger.all());
    say("S4 single-question policy change", gr.kind === "none", `grade ${gr.kind}`, "high");
  }
}

async function main(): Promise<void> {
  gls();
  await families();
  await scope();
  const text = `${lines.join("\n")}\n`;
  writeFileSync(join(OUT, "attacks-r2.txt"), text);
  process.stdout.write(text);
  process.exitCode = defects > 0 ? 1 : 0;
}

if (import.meta.main) await main();
