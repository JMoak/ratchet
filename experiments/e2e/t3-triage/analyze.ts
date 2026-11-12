/**
 * Post-run analysis of a T3 run directory: operational consequences read from the ledgers, no
 * oracle calls. What each gate's frozen policy would have done (its soft action) where the
 * label says it should not have, one global bar compared with per-question bars, and the
 * ambiguous items scored both ways.
 *
 *   bun experiments/e2e/t3-triage/analyze.ts <run dir>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  coverageAt,
  fitThreshold,
  type Scored,
  scoredFromLedger,
} from "../../../src/ledger/calibration.ts";
import { type DecisionRecord, decisionRows, parseJsonlLedger } from "../../../src/ledger/ledger.ts";
import type { JudgeVerdict } from "../../../src/types.ts";
import { writeJson } from "../lib.ts";
import type { ApprovalItem } from "./corpus/approvals.ts";
import type { ModerationItem } from "./corpus/moderation.ts";
import type { TicketItem } from "./corpus/routing.ts";
import { clopper, fmt, loadCorpus, num, pct, rateOf } from "./util.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: analyze.ts <run dir>");
const ledger = (name: string): DecisionRecord[] =>
  parseJsonlLedger(readFileSync(join(dir, `${name}.jsonl`), "utf8"));
const out: Record<string, unknown> = {};
const say = (s = "") => console.log(s);
const ARMS = ["raw", "digest", "relative"] as const;

// ---- approvals: what an enforcing gate would have done ----------------------
const approvals = loadCorpus<{ items: ApprovalItem[] }>("approvals").items;
const byState = new Map(
  approvals.flatMap((i) => ARMS.map((a) => [i.states[a], { i, a }] as const)),
);
const arows = decisionRows(ledger("approvals")).filter((r) => r.outcome && !r.failedOpen);
const armOf = (r: DecisionRecord) => (r.state === undefined ? undefined : byState.get(r.state));
say(
  "## approvals: soft actions against the label (act at go >= 0.9 approves, refuse at <= 0.1 denies)\n",
);
say(
  "| arm | auto-approved | wrongly approved (exact 95%) | auto-denied | wrongly denied | to review |",
);
say("| --- | --- | --- | --- | --- | --- |");
const ops: Record<string, unknown> = {};
for (const arm of ARMS) {
  const rs = arows.filter((r) => armOf(r)?.a === arm);
  const truth = (r: DecisionRecord) => armOf(r)?.i.label.truth === true;
  const acts = rs.filter((r) => r.soft === "act");
  const refuses = rs.filter((r) => r.soft === "refuse");
  const badActs = acts.filter((r) => !truth(r)).length;
  const badRefuses = refuses.filter((r) => truth(r)).length;
  const review = rs.length - acts.length - refuses.length;
  ops[arm] = {
    acts: acts.length,
    wrongActs: clopper(badActs, acts.length),
    refuses: refuses.length,
    wrongRefuses: clopper(badRefuses, refuses.length),
    review,
  };
  say(
    `| ${arm} | ${acts.length} | ${fmt(clopper(badActs, acts.length))} | ${refuses.length} | ${fmt(clopper(badRefuses, refuses.length))} | ${review} |`,
  );
}
out.approvalsOps = ops;

// ---- moderation: each gate at its own bar ------------------------------------
const mod = loadCorpus<{ items: ModerationItem[] }>("moderation").items;
const mByState = new Map(mod.map((m) => [m.state, m]));
const itemOf = (r: DecisionRecord) => (r.state === undefined ? undefined : mByState.get(r.state));
const mrows = ledger("moderation").filter(
  (r) => r.combined === true && !r.failedOpen && r.strategy !== "floored",
);
say(
  "\n## moderation: what each gate's policy (publish when P(no action) >= 0.9) would have done\n",
);
say(
  "| gate | split | posts | published | published but needed action (exact 95%) | needed action and held |",
);
say("| --- | --- | --- | --- | --- | --- |");
const modOps: Record<string, unknown> = {};
for (const gate of ["mod.action", "mod.action.learned"]) {
  for (const split of ["fit", "heldout"] as const) {
    const rs = mrows.filter((r) => r.gateId === gate && itemOf(r)?.split === split);
    if (rs.length === 0) continue;
    const needs = (r: DecisionRecord) => itemOf(r)?.label.truth === true;
    const pub = rs.filter((r) => r.soft === "act");
    const bad = pub.filter(needs);
    const needed = rs.filter(needs);
    modOps[`${gate}:${split}`] = {
      posts: rs.length,
      published: pub.length,
      harmfulPublished: clopper(bad.length, pub.length),
      needed: needed.length,
      neededHeld: needed.filter((r) => r.soft !== "act").length,
    };
    say(
      `| ${gate} | ${split} | ${rs.length} | ${pub.length} | ${fmt(clopper(bad.length, pub.length))} | ${needed.filter((r) => r.soft !== "act").length} of ${needed.length} |`,
    );
    if (gate === "mod.action" && split === "heldout") {
      const cats: Record<string, number> = {};
      for (const r of bad) {
        const c = itemOf(r)?.category ?? "?";
        cats[c] = (cats[c] ?? 0) + 1;
      }
      const examples = bad
        .slice(0, 3)
        .map((r) => `pYes ${num((r.verdict as JudgeVerdict).pYes, 4)}: ${itemOf(r)?.label.why}`);
      modOps.defaultHeldoutHarmfulByCategory = cats;
      modOps.defaultHeldoutExamples = examples;
    }
  }
}
say(
  `\ndefault gate, held-out, published but needed action, by category: ${JSON.stringify(modOps.defaultHeldoutHarmfulByCategory)}`,
);
say(`examples: ${(modOps.defaultHeldoutExamples as string[] | undefined)?.join(" | ")}`);
out.moderationOps = modOps;

// ---- one global bar across questions ----------------------------------------
// Each question's labelled rows split in two by corpus order (even index fits, odd validates);
// bars are fitted on the fit halves, per question and pooled, and read on the validation halves.
const routing = loadCorpus<{ items: TicketItem[] }>("routing").items;
const rIndex = new Map(routing.map((t, i) => [t.state, i]));
const aIndex = new Map(approvals.flatMap((it, i) => ARMS.map((a) => [it.states[a], i] as const)));
const rr = ledger("routing");
const questions: Record<string, { fit: Scored[]; val: Scored[] }> = {};
const add = (
  name: string,
  rows: readonly DecisionRecord[],
  index: (r: DecisionRecord) => number | undefined,
) => {
  const fit: Scored[] = [];
  const val: Scored[] = [];
  for (const r of rows) {
    const i = index(r);
    const s = scoredFromLedger([r]);
    if (i === undefined || s.length === 0) continue;
    (i % 2 === 0 ? fit : val).push(...s);
  }
  questions[name] = { fit, val };
};
const idx = (m: Map<string, number>) => (r: DecisionRecord) =>
  r.state === undefined ? undefined : m.get(r.state);
add(
  "route",
  rr.filter((r) => r.questionId === "route"),
  idx(rIndex),
);
add(
  "urgency",
  rr.filter((r) => r.questionId === "urgency"),
  idx(rIndex),
);
for (const arm of ["raw", "digest"] as const) {
  add(
    `approvals.${arm}`,
    arows.filter((r) => armOf(r)?.a === arm),
    idx(aIndex),
  );
}
const globalRows: Record<string, unknown> = {};
for (const t of [0.9, 0.95]) {
  const pooled = Object.values(questions).flatMap((q) => q.fit);
  const g = fitThreshold(pooled, t, 30, { conservative: true })?.threshold;
  say(
    `\n## one global bar at ${pct(t, 0)} (conservative, fitted on the pooled fit halves): ${num(g)}\n`,
  );
  say(
    "| question | own bar | own: validation coverage, precision | global: validation coverage, precision | the global bar is |",
  );
  say("| --- | --- | --- | --- | --- |");
  for (const [name, q] of Object.entries(questions)) {
    const own = fitThreshold(q.fit, t, 30, { conservative: true })?.threshold;
    const read = (b: number | undefined) => {
      if (b === undefined) return { text: "no bar", cov: 0, prec: undefined };
      const at = coverageAt(q.val, b);
      const prec = clopper(Math.round(at.accuracy * at.n), at.n);
      return { text: `${pct(at.coverage)} (${at.n}), ${fmt(prec)}`, cov: at.coverage, prec };
    };
    const o = read(own);
    const gl = read(g);
    const verdict =
      gl.prec !== undefined && gl.prec.p < t
        ? "too low: precision below the promise"
        : own !== undefined && g !== undefined && g > own && gl.cov < o.cov
          ? `too high: ${pct(o.cov - gl.cov)} coverage lost`
          : own === undefined
            ? "the question has no bar of its own"
            : "about right";
    globalRows[`${name}:${t}`] = { own, global: g, ownRead: o, globalRead: gl, verdict };
    say(`| ${name} | ${num(own)} | ${o.text} | ${gl.text} | ${verdict} |`);
  }
}
out.globalBar = globalRows;

// ---- ambiguous items scored both ways ----------------------------------------
const ambA = approvals.filter((i) => i.label.ambiguous === true);
say(
  `\n## ambiguous approvals (${ambA.length}): accuracy as labelled and with those labels flipped\n`,
);
for (const arm of ARMS) {
  const rs = arows.filter((r) => armOf(r)?.a === arm);
  const correctAs = (flip: boolean) =>
    rateOf(
      rs.map((r) => {
        const it = armOf(r)?.i as ApprovalItem;
        const right = r.outcome?.correct === true;
        return it.label.ambiguous && flip ? !right : right;
      }),
    );
  say(`- ${arm}: as labelled ${fmt(correctAs(false))}; ambiguous flipped ${fmt(correctAs(true))}`);
}
writeJson(join(dir, "analysis.json"), out);
