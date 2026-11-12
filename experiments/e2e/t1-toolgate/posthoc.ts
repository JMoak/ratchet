/**
 * Post-hoc readings of a finished live run, for the next wave. Nothing here was pre-registered
 * and nothing here refits the frozen gate; each figure answers "what would another rule have
 * done", which is a finding, never a result. Reads the newest live run unless --run is given.
 *
 *   bun experiments/e2e/t1-toolgate/posthoc.ts [--run <dir>]
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { exactLowerBound } from "../../../src/acceptance.ts";
import { poolJudge } from "../../../src/compound/aggregate.ts";
import { fitThreshold, scoredForYes } from "../../../src/ledger/calibration.ts";
import { type DecisionRecord, decisionRows, JsonlLedger } from "../../../src/ledger/ledger.ts";
import type { JudgeVerdict } from "../../../src/types.ts";
import { E2E_OUT } from "../lib.ts";
import { auc, rate } from "./analyze.ts";
import { loadCorpus, loadReal, tagValue } from "./common.ts";
import type { Item } from "./corpus.ts";
import { BATTERY_GATE_ID, PLAN, RAW_GATE_ID, REAL_GATE_ID, TRACK } from "./gate.ts";

const argv = process.argv.slice(2);
const i = argv.indexOf("--run");
const base = join(E2E_OUT, TRACK);
const dir =
  i >= 0
    ? (argv[i + 1] as string)
    : join(
        base,
        readdirSync(base)
          .filter((d) => d.endsWith("-live"))
          .sort()
          .at(-1) as string,
      );

const corpus = loadCorpus();
const byId = new Map(corpus.map((it) => [it.id, it]));
const itemOf = (r: DecisionRecord): Item | undefined => byId.get(tagValue(r.tags, "item:") ?? "");
const pYes = (r: DecisionRecord) => (r.verdict.kind === "judge" ? r.verdict.pYes : Number.NaN);

const raw = decisionRows(await new JsonlLedger(join(dir, "raw-ledger.jsonl")).all()).filter(
  (r) => r.gateId === RAW_GATE_ID,
);
const at = (rows: readonly DecisionRecord[], split: string, bar: number) => {
  const rs = rows.filter((r) => itemOf(r)?.split === split);
  const acts = rs.filter((r) => pYes(r) >= bar);
  const right = acts.filter((r) => itemOf(r)?.truth === true).length;
  const approves = rs.filter((r) => itemOf(r)?.truth === true).length;
  return `${split}: ${right}/${acts.length} right${acts.length ? ` (exact 95% lower ${(100 * exactLowerBound(right, acts.length)).toFixed(1)}%)` : ""}, approves acted on ${rate(right, approves)}`;
};

const out: string[] = [`# Post-hoc readings of ${dir}`, ""];

// 1. The same fit rule with the Wilson lower bound (fitThreshold's `conservative` option).
const fitRows = raw.filter((r) => itemOf(r)?.split === "fit");
for (const conservative of [false, true]) {
  const f = fitThreshold(scoredForYes(fitRows), PLAN.fitTarget, PLAN.fitMinSupport, {
    conservative,
  });
  out.push(
    `## Fit at 98% on the raw gate's fit rows, conservative ${conservative}: bar ${f?.threshold ?? "none"} (n ${f?.n ?? "-"})`,
  );
  if (f) {
    for (const bar of [f.threshold, Math.min(1, f.threshold + PLAN.halfWidth)]) {
      out.push(`- act above ${bar.toFixed(2)}:`);
      for (const s of ["fit", "evidence", "challenge", "drift"]) out.push(`  - ${at(raw, s, bar)}`);
    }
  }
  out.push("");
}

// 2. Fixed bars, for the shape of the trade-off on held-out groups.
out.push("## Fixed bars on the raw gate");
for (const bar of [0.7, 0.75, 0.8, 0.85, 0.9]) {
  out.push(
    `- act above ${bar}: ${["evidence", "challenge", "drift"].map((s) => at(raw, s, bar)).join("; ")}`,
  );
}
const maxP = Math.max(...raw.map(pYes));
out.push(`- highest pYes Jev gave any of ${raw.length} items: ${maxP}`, "");

// 3. The battery without the additive band, and re-pooled at a measured correlation.
const batAll = await new JsonlLedger(join(dir, "battery-ledger.jsonl")).all();
const combined = batAll.filter((r) => r.gateId === BATTERY_GATE_ID && r.combined === true);
const members = new Map<string, DecisionRecord[]>();
for (const m of batAll.filter((r) => r.combined !== true)) {
  const list = members.get(m.requestId) ?? [];
  list.push(m);
  members.set(m.requestId, list);
}
const batFit = fitThreshold(
  scoredForYes(combined.filter((r) => itemOf(r)?.split === "fit")),
  PLAN.fitTarget,
  PLAN.fitMinSupport,
);
out.push(`## Battery at its own fitted bar with no band: ${batFit?.threshold ?? "none"}`);
if (batFit)
  for (const s of ["evidence", "challenge", "drift"])
    out.push(`- ${at(combined, s, batFit.threshold)}`);
// Error correlation of the members on fit, then the pooled verdict re-computed at it.
const fitCombined = combined.filter((r) => itemOf(r)?.split === "fit");
const errs = fitCombined.map((c) => {
  const ms = (members.get(c.requestId) ?? []).sort((a, b) =>
    a.questionId.localeCompare(b.questionId),
  );
  const truth = itemOf(c)?.truth === true;
  return ms.map((m) => pYes(m) >= 0.5 !== truth);
});
const pairs: [number, number][] = [
  [0, 1],
  [0, 2],
  [1, 2],
];
const phi = (a: boolean[], b: boolean[]) => {
  const n = a.length;
  const pa = a.filter(Boolean).length / n;
  const pb = b.filter(Boolean).length / n;
  const pab = a.filter((x, k) => x && b[k]).length / n;
  const d = Math.sqrt(pa * (1 - pa) * pb * (1 - pb));
  return d === 0 ? 0 : (pab - pa * pb) / d;
};
const rhos = pairs.map(([x, y]) =>
  phi(
    errs.map((e) => e[x] === true),
    errs.map((e) => e[y] === true),
  ),
);
const rho = Math.max(0, rhos.reduce((s, v) => s + v, 0) / rhos.length);
out.push(
  `- member error correlation on fit (phi, pairs): ${rhos.map((v) => v.toFixed(2)).join(", ")}; mean ${rho.toFixed(2)}`,
);
const repooled = combined.map((c) => {
  const ms = members.get(c.requestId) ?? [];
  const v = poolJudge(
    ms.map((m) => m.verdict as JudgeVerdict),
    { method: "logodds", correlation: rho },
  );
  return { ...c, verdict: v, go: v.pYes, confidence: v.confidence } as DecisionRecord;
});
const reFit = fitThreshold(
  scoredForYes(repooled.filter((r) => itemOf(r)?.split === "fit")),
  PLAN.fitTarget,
  PLAN.fitMinSupport,
);
out.push(
  `- re-pooled at correlation ${rho.toFixed(2)}: fitted bar ${reFit?.threshold.toFixed(3) ?? "none"}`,
);
if (reFit) {
  for (const bar of [reFit.threshold, Math.min(1, reFit.threshold + PLAN.halfWidth)]) {
    out.push(
      `  - act above ${bar.toFixed(3)}: ${["evidence", "challenge", "drift"].map((s) => at(repooled, s, bar)).join("; ")}`,
    );
  }
}
for (const s of ["evidence", "challenge", "drift"]) {
  const a = (rows: readonly DecisionRecord[]) =>
    auc(
      rows
        .filter((r) => itemOf(r)?.split === s)
        .map((r) => ({ p: pYes(r), truth: itemOf(r)?.truth === true })),
    );
  out.push(`- AUC ${s}: single ${a(raw)?.toFixed(3)}, battery ${a(combined)?.toFixed(3)}`);
}
out.push("");

// 4. Real traffic: discrimination and the two denials.
const real = loadReal();
if (real) {
  const rows = decisionRows(await new JsonlLedger(join(dir, "real-ledger.jsonl")).all());
  for (const gate of [REAL_GATE_ID, "agent.tool.claude-code"]) {
    const rs = rows.filter((r) => r.gateId === gate && r.strategy !== "floored");
    const joined = rs.map((r) => ({ r, l: real.labels.get(tagValue(r.tags, "item:") ?? "") }));
    const denials = joined.filter((j) => j.l?.truth === false);
    const ps = joined.map((j) => pYes(j.r));
    out.push(
      `## Real, ${gate}: ${rs.length} answered; pYes median ${ps.sort((a, b) => a - b)[Math.floor(ps.length / 2)]}, max ${Math.max(...ps)}; denials' pYes ${denials.map((d) => `${d.l?.id} ${pYes(d.r)}`).join(", ") || "floored"}`,
    );
    const tools = new Map<string, { n: number; acts: number }>();
    for (const j of joined) {
      const t = tagValue(j.r.tags, "tool:") ?? "?";
      const v = tools.get(t) ?? { n: 0, acts: 0 };
      v.n++;
      if (pYes(j.r) >= 0.62) v.acts++;
      tools.set(t, v);
    }
    out.push(
      `- answered by tool, acted at 0.62: ${[...tools].map(([t, v]) => `${t} ${v.acts}/${v.n}`).join(", ")}`,
    );
  }
}
process.stdout.write(`${out.join("\n")}\n`);
