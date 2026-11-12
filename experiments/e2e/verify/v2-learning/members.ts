/**
 * V2 on wave-1 ledgers: battery member truths (T3-07, T2-06), member correlation on batteries
 * and on pick gates and for pairs with no variance (T5-06, T5-07), per-pair correlation pooling
 * (T5-02) and the disagreement reader (T5-03). The library's readers are run on the real rows and
 * compared with phi, R^-1 1 and disagreement rates computed here. Post hoc and offline: the only
 * writes are copies of wave-1 decision rows under experiments/out/e2e/verify/v2-learning/, labelled
 * through the real `Engine.label` from the labels the decider fixed in wave 1.
 *
 *   bun experiments/e2e/verify/v2-learning/members.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool, poolWeights } from "../../../../src/compound/aggregate.ts";
import { Engine } from "../../../../src/engine.ts";
import { disagreement, memberCorrelation } from "../../../../src/ledger/calibration.ts";
import { describeGrade, gradeOf } from "../../../../src/ledger/evidence.ts";
import { type DecisionRecord, JsonlLedger } from "../../../../src/ledger/ledger.ts";
import { judge } from "../../../../src/questions.ts";
import type { Oracle, Question, Verdict } from "../../../../src/types.ts";
import { cli } from "./recompute.ts";
import { pct } from "./scorer.ts";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const OUT = join(ROOT, "experiments", "out", "e2e", "verify", "v2-learning");
const T3 = join(ROOT, "experiments", "out", "e2e", "t3-triage", "2026-11-12T10-19-41-682Z-live");
const T5 = join(
  ROOT,
  "experiments",
  "out",
  "e2e",
  "t5-compound",
  "2026-11-12T10-35-57-202Z-main-live",
);

const never: Oracle = {
  id: "never",
  async decide() {
    throw new Error("no model call in a verification");
  },
};

/** Phi between two boolean columns, undefined when either does not vary. */
function phi(pairs: readonly [boolean, boolean][]): number | undefined {
  let a = 0;
  let b = 0;
  let ab = 0;
  for (const [x, y] of pairs) {
    if (x) a++;
    if (y) b++;
    if (x && y) ab++;
  }
  const n = pairs.length;
  if (a === 0 || a === n || b === 0 || b === n) return undefined;
  const n11 = ab;
  const n10 = a - ab;
  const n01 = b - ab;
  const n00 = n - a - b + ab;
  return (n11 * n00 - n10 * n01) / Math.sqrt(a * (n - a) * b * (n - b));
}

/** R^-1 1 by Gaussian elimination, no clamping: the textbook GLS weights. */
function glsWeights(r: readonly number[][]): number[] {
  const n = r.length;
  const m = r.map((row) => [...row, 1]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let k = c + 1; k < n; k++)
      if (Math.abs(m[k]?.[c] ?? 0) > Math.abs(m[piv]?.[c] ?? 0)) piv = k;
    [m[c], m[piv]] = [m[piv] as number[], m[c] as number[]];
    const top = m[c] as number[];
    for (let k = 0; k < n; k++) {
      if (k === c) continue;
      const row = m[k] as number[];
      const f = (row[c] ?? 0) / (top[c] ?? 1);
      for (let j = c; j <= n; j++) row[j] = (row[j] ?? 0) - f * (top[j] ?? 0);
    }
  }
  return m.map((row, i) => (row[n] ?? 0) / (row[i] ?? 1));
}

const memberRight = (v: Verdict, truth: unknown): boolean | undefined =>
  v.kind === "judge"
    ? typeof truth === "boolean"
      ? v.pYes >= 0.5 === truth
      : undefined
    : typeof truth === "string"
      ? (v.kind === "pick" ? v.choice : v.level) === truth
      : undefined;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const lines: string[] = ["# Member readers on wave-1 ledgers (post hoc)", ""];

  // ---- T3 moderation: relabel a copy through Engine.label with each member's own truth -------
  const corpus = JSON.parse(
    readFileSync(
      join(ROOT, "experiments", "e2e", "t3-triage", "corpus", "moderation.json"),
      "utf8",
    ),
  ) as {
    items: {
      state: string;
      split: string;
      label: { truth: boolean };
      sub: Record<string, boolean>;
    }[];
  };
  const byState = new Map(corpus.items.map((i) => [i.state, i]));
  const src = readFileSync(join(T3, "moderation.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const decisionsOnly = src.filter((l) => (JSON.parse(l) as { type: string }).type === "decision");
  const results: string[] = [];
  for (const variant of ["own", "partial", "none"] as const) {
    const path = join(OUT, `t3-moderation-memberTruths-${variant}.jsonl`);
    writeFileSync(path, `${decisionsOnly.join("\n")}\n`);
    const engine = new Engine({ oracle: never, ledger: new JsonlLedger(path) });
    const rows = await engine.ledger.all();
    for (const r of rows) {
      if (r.combined !== true || r.gateId !== "mod.action" || r.state === undefined) continue;
      // A floored request has no member rows, and Engine.label refuses memberTruths for it.
      if (r.strategy === "floored") continue;
      const item = byState.get(r.state);
      if (item === undefined) continue;
      const truth = item.label.truth;
      const lean = r.verdict.kind === "judge" && r.verdict.pYes >= 0.5;
      const memberTruths =
        variant === "own"
          ? item.sub
          : variant === "partial"
            ? { threat: item.sub.threat === true }
            : undefined;
      await engine.label(r.id, {
        correct: lean === truth,
        truth,
        source: "review:blind:decider",
        ...(memberTruths !== undefined ? { memberTruths } : {}),
      });
    }
    const labelled = await engine.ledger.all();
    const rep = JSON.parse(cli(["report", path, "--json", "--gate", "mod.action"]).out) as {
      gates: { gate: string; accuracy?: number; ece?: number }[];
    };
    // My own per-member accuracy against each member's own sub-truth, from the corpus.
    const own = new Map<string, { n: number; right: number }>();
    for (const r of labelled) {
      if (r.gateId !== "mod.action" || r.combined === true || r.state === undefined) continue;
      const item = byState.get(r.state);
      if (item === undefined || r.verdict.kind !== "judge") continue;
      const t = item.sub[r.questionId];
      if (typeof t !== "boolean") continue;
      const s = own.get(r.questionId) ?? { n: 0, right: 0 };
      s.n++;
      if (r.verdict.pYes >= 0.5 === t) s.right++;
      own.set(r.questionId, s);
    }
    for (const g of rep.gates) {
      const q = g.gate.split("/")[1];
      if (q === undefined) continue;
      const o = own.get(q);
      results.push(
        `| ${variant} | ${q} | ${pct(g.accuracy ?? Number.NaN)} | ${o ? `${o.right}/${o.n} = ${pct(o.right / o.n)}` : "-"} | ${g.ece?.toFixed(3) ?? "-"} |`,
      );
    }
    const mc = memberCorrelation(labelled.filter((r) => r.gateId === "mod.action"));
    // My own phi against own sub-truths, paired by request.
    const byReq = new Map<string, Map<string, boolean>>();
    for (const r of labelled) {
      if (r.gateId !== "mod.action" || r.combined === true || r.verdict.kind !== "judge") continue;
      const t = r.outcome?.truth;
      if (typeof t !== "boolean") continue;
      const m = byReq.get(r.requestId) ?? new Map<string, boolean>();
      m.set(r.questionId, r.verdict.pYes >= 0.5 === t);
      byReq.set(r.requestId, m);
    }
    const keys = ["harass", "selfharm", "spam", "threat"];
    const mine: string[] = [];
    let agree = true;
    for (const [i, a] of keys.entries()) {
      for (const b of keys.slice(i + 1)) {
        const pairs: [boolean, boolean][] = [];
        for (const m of byReq.values()) {
          const x = m.get(a);
          const y = m.get(b);
          if (x !== undefined && y !== undefined) pairs.push([x, y]);
        }
        const p = phi(pairs);
        const lib = mc.pairs.find((q) => q.keys[0] === a && q.keys[1] === b);
        if (
          lib === undefined ||
          lib.n !== pairs.length ||
          (lib.correlation === undefined) !== (p === undefined) ||
          (p !== undefined && Math.abs((lib.correlation ?? 0) - p) > 1e-12)
        ) {
          agree = false;
        }
        mine.push(`${a}~${b} ${p === undefined ? "undefined" : p.toFixed(3)} (n ${pairs.length})`);
      }
    }
    results.push(
      `| ${variant} | memberCorrelation | mean ${mc.mean?.toFixed(3) ?? "undefined"} over ${mc.pairs.filter((p) => p.correlation !== undefined).length} of ${mc.pairs.length} pairs, n ${mc.n} | mine: ${mine.join(", ")} | library = mine: ${agree} |`,
    );
  }
  lines.push(
    "## T3 moderation members: labelled through Engine.label with own truths, one own truth, or none",
    "",
    "`own`: every member's sub-truth from the corpus (`memberTruths`); `partial`: only `threat`;",
    "`none`: the battery's truth alone, which is what `ratchet review` writes (it has no way to",
    "give member truths). Report accuracy is `ratchet report`'s member row.",
    "",
    "| labels | member | report accuracy | own-question accuracy (mine) | report ECE |",
    "| --- | --- | --- | --- | --- |",
    ...results,
    "",
  );

  // ---- T5: memberCorrelation on every compound ledger (fit split), judge and pick ------------
  const t5Rows = (name: string) =>
    new JsonlLedger(join(T5, `${name}.jsonl`))
      .all()
      .then((rs) => rs.filter((r) => r.tags.includes("split:fit")));
  lines.push("## T5 member correlation from the fit split (library vs mine)", "");
  lines.push("| ledger | gate kind | pairs (library) | mean (library) | mine | agree |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const name of [
    "rep3-jev113",
    "framing3-jev113",
    "diverse2",
    "diverse3",
    "cascade-haiku",
    "seq-bar",
  ]) {
    const all = await t5Rows(name);
    for (const kind of ["judge", "pick"] as const) {
      const rows = all.filter((r) => r.kind === kind);
      const mc = memberCorrelation(rows);
      const cols: Map<string, boolean>[] = [];
      for (const r of rows) {
        const t = r.outcome?.truth;
        if (t === undefined || !r.members || r.failedOpen) continue;
        const m = new Map<string, boolean>();
        for (const x of r.members) {
          if (x.failedOpen || x.verdict.kind !== r.verdict.kind || m.has(x.key)) continue;
          const ok = memberRight(x.verdict as Verdict, t);
          if (ok !== undefined) m.set(x.key, ok);
        }
        if (m.size > 0) cols.push(m);
      }
      const keys = [...new Set(cols.flatMap((c) => [...c.keys()]))].sort();
      const mine: string[] = [];
      let ok = true;
      for (const [i, a] of keys.entries()) {
        for (const b of keys.slice(i + 1)) {
          const pairs: [boolean, boolean][] = cols.flatMap((c) => {
            const x = c.get(a);
            const y = c.get(b);
            return x === undefined || y === undefined ? [] : [[x, y] as [boolean, boolean]];
          });
          if (pairs.length === 0) continue;
          const p = phi(pairs);
          const lib = mc.pairs.find((q) => q.keys[0] === a && q.keys[1] === b);
          if (
            lib === undefined ||
            lib.n !== pairs.length ||
            (lib.correlation === undefined) !== (p === undefined) ||
            (p !== undefined && Math.abs((lib.correlation ?? 0) - p) > 1e-12)
          )
            ok = false;
          mine.push(`${a}~${b} ${p === undefined ? "undef" : p.toFixed(2)} (${pairs.length})`);
        }
      }
      lines.push(
        `| ${name} | ${kind} | ${mc.pairs.map((p) => `${p.keys.join("~")} ${p.correlation?.toFixed(2) ?? "undef"} (${p.n})`).join(", ")} | ${mc.mean?.toFixed(3) ?? "undefined"} | ${mine.join(", ")} | ${ok} |`,
      );
    }
  }
  lines.push("");

  // ---- T5-02: pooling with the per-pair matrix through the library ----------------------------
  const d3 = await new JsonlLedger(join(T5, "diverse3.jsonl")).all();
  const fit = d3.filter((r) => r.tags.includes("split:fit"));
  const held = d3.filter((r) => r.tags.includes("split:held"));
  const mc = memberCorrelation(fit);
  const keys = ["jev113", "jev114", "haiku55"];
  const R = keys.map((a) => keys.map((b) => (a === b ? 1 : Math.max(0, mc.matrix?.[a]?.[b] ?? 0))));
  const own = glsWeights(R);
  const lib = poolWeights(3, { correlations: mc.matrix ?? {}, memberKeys: keys });
  const questionOf = (r: DecisionRecord): Question =>
    r.kind === "judge"
      ? judge(r.prompt, { id: r.questionId })
      : ({
          kind: "pick",
          id: r.questionId,
          prompt: r.prompt,
          options: Object.keys(r.verdict.kind === "pick" ? r.verdict.probabilities : {}),
        } as Question);
  const score = (opts: Parameters<typeof pool>[2]) => {
    let n = 0;
    let right = 0;
    let brier = 0;
    let ll = 0;
    for (const r of held) {
      const ms = keys.map((k) => r.members?.find((m) => m.key === k));
      if (ms.some((m) => m === undefined || m.failedOpen)) continue;
      const v = pool(
        questionOf(r),
        ms.map((m) => (m as NonNullable<typeof m>).verdict),
        opts,
      );
      const t = r.outcome?.truth;
      const pTrue =
        v.kind === "judge"
          ? t === true
            ? v.pYes
            : 1 - v.pYes
          : v.kind === "pick"
            ? (v.probabilities[String(t)] ?? 0)
            : 0;
      const ok = memberRight(v, t) === true;
      n++;
      if (ok) right++;
      brier += (v.confidence - (ok ? 1 : 0)) ** 2;
      ll -= Math.log(Math.min(1 - 1e-6, Math.max(1e-6, pTrue)));
    }
    return `${right}/${n} = ${pct(right / n)}, Brier ${(brier / n).toFixed(3)}, log loss ${(ll / n).toFixed(3)}`;
  };
  lines.push(
    "## T5-02: diverse3 pooled with the fit-split phi matrix through `pool(..., { correlations, memberKeys })`",
    "",
    `Matrix (fit split, judge and pick): ${mc.pairs.map((p) => `${p.keys.join("~")} ${p.correlation?.toFixed(3)}`).join(", ")}.`,
    `GLS weights: library ${lib.weights.map((w) => w.toFixed(4)).join(", ")} (effective n ${lib.effectiveN.toFixed(3)}); mine (R^-1 1 with negatives read as 0 in R) ${own.map((w) => w.toFixed(4)).join(", ")}.`,
    "",
    `- rho 0: ${score({ correlation: 0 })}`,
    `- scalar mean rho ${(mc.mean ?? 0).toFixed(3)}: ${score({ correlation: mc.mean ?? 0 })}`,
    `- per-pair matrix (library): ${score({ correlations: mc.matrix ?? {}, memberKeys: keys })}`,
    "",
  );

  // ---- T5-03: disagreement -------------------------------------------------------------------
  lines.push("## T5-03: disagreement on held-out rows", "");
  for (const name of ["diverse2", "diverse3"]) {
    const rows = (await new JsonlLedger(join(T5, `${name}.jsonl`)).all()).filter((r) =>
      r.tags.includes("split:held"),
    );
    const d = disagreement(rows);
    let mineText = "";
    if (d !== undefined) {
      const [ka, kb] = d.keys;
      let pairs = 0;
      let differ = 0;
      let oneWrong = 0;
      for (const r of rows) {
        const a = r.members?.find((m) => m.key === ka && !m.failedOpen);
        const b = r.members?.find((m) => m.key === kb && !m.failedOpen);
        if (!a || !b || r.failedOpen) continue;
        pairs++;
        const la =
          a.verdict.kind === "judge"
            ? String(a.verdict.pYes >= 0.5)
            : a.verdict.kind === "pick"
              ? a.verdict.choice
              : a.verdict.level;
        const lb =
          b.verdict.kind === "judge"
            ? String(b.verdict.pYes >= 0.5)
            : b.verdict.kind === "pick"
              ? b.verdict.choice
              : b.verdict.level;
        if (la !== lb) differ++;
        const t = r.outcome?.truth;
        if (memberRight(a.verdict, t) === false || memberRight(b.verdict, t) === false) oneWrong++;
      }
      const g = gradeOf([], { borrowed: d.via, borrowedAt: d.at });
      mineText = `mine ${differ}/${pairs} = ${pct(differ / pairs)}; at least one judge actually wrong on ${oneWrong}/${pairs} = ${pct(oneWrong / pairs)}. Sentence: "${describeGrade(g)}"`;
    }
    lines.push(
      `- ${name}: library ${d === undefined ? "undefined (refused: no pair of two model families)" : `${d.keys.join(" vs ")} ${pct(d.via.rate)} of ${d.via.pairs}`}${mineText ? `; ${mineText}` : ""}`,
    );
  }
  lines.push("");
  const md = `${lines.join("\n")}\n`;
  writeFileSync(join(OUT, "members.md"), md);
  process.stdout.write(md);
}

if (import.meta.main) await main();
