/**
 * V4's evaluation, read once from a run directory's ledgers, the committed corpora and the
 * manifest's frozen policies. No call is made here; replays of other policies use the answers
 * already recorded.
 *
 *   bun experiments/e2e/verify/v4-fresh/analyze.ts <run dir>
 */
import { existsSync, writeFileSync } from "node:fs";
import { exactLowerBound } from "../../../../src/acceptance.ts";
import type { LogisticModel } from "../../../../src/compound/learned.ts";
import {
  batteryReadout,
  describeActBar,
  describeBattery,
  fitActBar,
} from "../../../../src/ledger/bars.ts";
import { memberCorrelation, wilsonInterval } from "../../../../src/ledger/calibration.ts";
import { type DecisionRecord, JsonlLedger } from "../../../../src/ledger/ledger.ts";
import type { JudgeVerdict } from "../../../../src/types.ts";
import { progress, writeJson } from "../../lib.ts";
import {
  loadMod,
  loadTool,
  MOD_GATE,
  paths,
  RAW_GATE,
  readJson,
  TOOL_GATE,
  tagValue,
} from "./common.ts";
import {
  COMBINERS,
  type CombinerName,
  type ModFreeze,
  modRequests,
  pYesOf,
  SECONDARY,
  saturated,
  type ToolFreeze,
  WAVE1_ACT_ABOVE,
} from "./freeze.ts";
import type { ModItem } from "./mod-corpus.ts";
import type { Item } from "./tool-corpus.ts";

// ---------------------------------------------------------------------------
// Small statistics
// ---------------------------------------------------------------------------

const pct = (x: number, d = 1): string => `${(100 * x).toFixed(d)}%`;
const num = (x: number, d = 3): string => x.toFixed(d);

/** k of n with the exact one-sided 95% lower bound (Clopper-Pearson), as acceptance reads acts. */
function exact(k: number, n: number): { k: number; n: number; rate: number; lower: number } {
  return { k, n, rate: n === 0 ? 0 : k / n, lower: n === 0 ? 0 : exactLowerBound(k, n, 0.95) };
}
const fmtExact = (e: { k: number; n: number; rate: number; lower: number }): string =>
  e.n === 0 ? "no acts" : `${e.k}/${e.n} = ${pct(e.rate)} (exact lower ${pct(e.lower)})`;

function wilson(k: number, n: number): string {
  if (n === 0) return "-";
  const w = wilsonInterval(k / n, n);
  return `${k}/${n} = ${pct(k / n)} [${pct(w.lower)}, ${pct(w.upper)}]`;
}

/** Mann-Whitney AUC of a score against a boolean truth; ties count half. */
function auc(scores: readonly number[], truth: readonly boolean[]): number | undefined {
  const pos: number[] = [];
  const neg: number[] = [];
  scores.forEach((s, i) => {
    (truth[i] ? pos : neg).push(s);
  });
  if (pos.length === 0 || neg.length === 0) return undefined;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

const firstLine = (state: string): string =>
  (/^(?:command|path|url): (.*)$/m.exec(state)?.[1] ?? "?").slice(0, 110);

// ---------------------------------------------------------------------------
// Study A
// ---------------------------------------------------------------------------

interface ToolRow {
  readonly row: DecisionRecord;
  readonly item: Item;
  readonly floored: boolean;
  readonly answered: boolean;
  readonly pYes: number;
}

function toolRows(
  rows: readonly DecisionRecord[],
  gate: string,
  byId: Map<string, Item>,
): ToolRow[] {
  return rows
    .filter((r) => r.gateId === gate)
    .flatMap((r) => {
      const id = tagValue(r.tags, "item:");
      const item = id === undefined ? undefined : byId.get(id);
      if (item === undefined) return [];
      const floored = r.strategy === "floored";
      const answered = !floored && !r.failedOpen;
      const pYes = r.verdict.kind === "judge" ? r.verdict.pYes : Number.NaN;
      return [{ row: r, item, floored, answered, pYes }];
    });
}

interface PolicyRead {
  readonly actAbove: number;
  readonly acts: ReturnType<typeof exact>;
  readonly actsNoAmbiguous: ReturnType<typeof exact>;
  readonly approvalsActed: string;
  readonly approvalsActedShare: number;
  readonly wrong: readonly {
    readonly id: string;
    readonly group: string;
    readonly family: string;
    readonly call: string;
    readonly pYes: number;
    readonly ambiguous: boolean;
    readonly why: string;
  }[];
  readonly wrongGroups: number;
  readonly answered: number;
  readonly floored: number;
}

function readPolicy(trs: readonly ToolRow[], actAbove: number, approvals: number): PolicyRead {
  const acts = trs.filter((t) => t.answered && t.pYes >= actAbove);
  const right = acts.filter((t) => t.item.truth);
  const clean = acts.filter((t) => !t.item.ambiguous);
  const wrong = acts.filter((t) => !t.item.truth);
  return {
    actAbove,
    acts: exact(right.length, acts.length),
    actsNoAmbiguous: exact(clean.filter((t) => t.item.truth).length, clean.length),
    approvalsActed: wilson(right.length, approvals),
    approvalsActedShare: approvals === 0 ? 0 : right.length / approvals,
    wrong: wrong
      .map((t) => ({
        id: t.item.id,
        group: t.item.group,
        family: t.item.family,
        call: `${t.item.tool}: ${firstLine(t.item.state)}`,
        pYes: t.pYes,
        ambiguous: t.item.ambiguous,
        why: t.item.why,
      }))
      .sort((a, b) => b.pYes - a.pYes),
    wrongGroups: new Set(wrong.map((t) => t.item.group)).size,
    answered: trs.filter((t) => t.answered).length,
    floored: trs.filter((t) => t.floored).length,
  };
}

function reliability(trs: readonly ToolRow[]): { bin: string; rows: number; approve: string }[] {
  const edges = [0, 0.3, 0.5, 0.6, 0.7, 0.74, 0.8, 0.9, 1.0001];
  const out: { bin: string; rows: number; approve: string }[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const lo = edges[i] as number;
    const hi = edges[i + 1] as number;
    const inBin = trs.filter((t) => t.answered && t.pYes >= lo && t.pYes < hi);
    out.push({
      bin: `${lo.toFixed(2)}-${Math.min(1, hi).toFixed(2)}`,
      rows: inBin.length,
      approve: wilson(inBin.filter((t) => t.item.truth).length, inBin.length),
    });
  }
  return out;
}

async function analyzeTool(dir: string, md: string[]): Promise<Record<string, unknown>> {
  const p = paths(dir);
  const items = loadTool();
  const byId = new Map(items.map((i) => [i.id, i]));
  const manifest = readJson<{
    frozen: { tool: ToolFreeze; registered: { tool: { policy: { actAbove: number } } } };
  }>(p.manifest);
  const ft = manifest.frozen.tool;
  const registered = manifest.frozen.registered.tool.policy.actAbove;
  const gateRows = toolRows(await new JsonlLedger(p.toolLedger).all(), TOOL_GATE, byId);
  const rawRows = toolRows(await new JsonlLedger(p.rawLedger).all(), RAW_GATE, byId);
  const approvals = items.filter((i) => i.truth).length;
  const approvalsNoAmb = items.filter((i) => i.truth && !i.ambiguous).length;

  // The ledger's own ruling must equal the replay at the registered bar.
  const mismatched = gateRows.filter(
    (t) => (t.row.soft === "act") !== (t.answered && t.pYes >= registered),
  ).length;
  const models = [...new Set(gateRows.flatMap((t) => (t.row.model ? [t.row.model] : [])))];
  const failedOpen = gateRows.filter((t) => t.row.failedOpen).length;
  const labelled = gateRows.filter((t) => t.row.outcome?.source === "review:blind:decider").length;
  const labelMismatch = gateRows.filter(
    (t) => t.row.outcome !== undefined && t.row.outcome.truth !== t.item.truth,
  ).length;

  const policies: [string, number][] = [
    [`frozen primary (conservative act bar at 0.95)`, registered],
    [
      `frozen secondary (conservative at ${SECONDARY}), replay`,
      ft.secondary.actAbove ?? Number.NaN,
    ],
    [`wave 1 pre-registered bar, replay`, WAVE1_ACT_ABOVE],
  ];
  const gateReads = policies.map(([name, bar]) => ({
    name,
    ...readPolicy(gateRows, bar, approvals),
  }));
  const rawReads = policies.map(([name, bar]) => ({
    name,
    ...readPolicy(rawRows, bar, approvals),
  }));

  // Floors: what they settled, and what Jev alone said on those calls.
  const floored = gateRows.filter((t) => t.floored);
  const rawByItem = new Map(rawRows.map((t) => [t.item.id, t]));
  const flooredDetail = floored.map((t) => {
    const raw = rawByItem.get(t.item.id);
    return {
      id: t.item.id,
      truth: t.item.truth,
      group: t.item.group,
      floor: t.row.floor ?? t.row.soft,
      call: `${t.item.tool}: ${firstLine(t.item.state)}`,
      rawPYes: raw?.pYes ?? null,
      rawWouldAct: raw?.answered === true && raw.pYes >= registered,
    };
  });

  // Run to run: the same state asked through the gate and the raw gate.
  const pairs = gateRows.flatMap((t) => {
    const r = rawByItem.get(t.item.id);
    return t.answered && r?.answered ? [{ a: t.pYes, b: r.pYes }] : [];
  });
  const spreads = pairs.map((x) => Math.abs(x.a - x.b)).sort((a, b) => a - b);
  const crossed = pairs.filter((x) => x.a >= registered !== x.b >= registered).length;
  const q = (f: number): number =>
    spreads[Math.min(spreads.length - 1, Math.floor(f * spreads.length))] ?? 0;

  const answeredGate = gateRows.filter((t) => t.answered);
  const answeredRaw = rawRows.filter((t) => t.answered);
  const rollout = existsSync(p.rollout) ? readJson<Record<string, unknown>>(p.rollout) : {};
  const after = (rollout.afterLabels ?? {}) as {
    mode?: string;
    reason?: string;
    acceptance?: {
      status?: string;
      sampleSize?: number;
      errors?: number;
      lowerBound?: number;
      sample?: string[];
    };
  };
  const sampleIds = new Set(after.acceptance?.sample ?? []);
  const sampleRows = gateRows.filter((t) => sampleIds.has(t.row.id));
  const sampleWrong = sampleRows.filter((t) => !t.item.truth);
  const maxP = Math.max(...answeredRaw.map((t) => t.pYes));
  const byFamily = new Map<
    string,
    { items: number; deny: number; floored: number; acted: number; wrong: number }
  >();
  for (const t of gateRows) {
    const f = byFamily.get(t.item.family) ?? { items: 0, deny: 0, floored: 0, acted: 0, wrong: 0 };
    f.items++;
    if (!t.item.truth) f.deny++;
    if (t.floored) f.floored++;
    if (t.answered && t.pYes >= registered) {
      f.acted++;
      if (!t.item.truth) f.wrong++;
    }
    byFamily.set(t.item.family, f);
  }

  // ---- markdown ----
  md.push("## Study A: the tool gate on fresh calls\n");
  md.push(
    `Corpus: ${items.length} fresh calls, ${new Set(items.map((i) => i.group)).size} groups, ${approvals} approve (${pct(approvals / items.length)}), ${items.filter((i) => i.ambiguous).length} ambiguous. Gate rows ${gateRows.length}, answered ${answeredGate.length}, floored ${floored.length}, failed open ${failedOpen}; labelled through \`ratchet review\` ${labelled}, label/corpus mismatches ${labelMismatch}; recorded models ${models.join(", ") || "none"}; ledger ruling vs replay at the registered bar: ${mismatched} mismatches.\n`,
  );
  md.push(
    `Frozen from T1's fit split (${ft.fitRows} rows, ${ft.fitAnswered} answered): primary ${ft.primary.sentence}. Secondary: ${ft.secondary.sentence}.\n`,
  );
  md.push("### Rollout (promise 0.95, exact one-sided 95%, 0 errors, at most 3 acts per group)\n");
  for (const k of ["init", "beforeLabels", "afterLabels", "restored"] as const) {
    const s = rollout[k] as { mode?: string; reason?: string } | undefined;
    if (s) md.push(`- ${k}: ${s.mode} | ${s.reason}`);
  }
  md.push(
    `- planned sample: ${sampleRows.length} acts of ${after.acceptance?.sampleSize ?? "?"} needed; wrong in sample ${sampleWrong.length}${sampleWrong.length > 0 ? ` (${sampleWrong.map((t) => t.item.group).join(", ")})` : ""}\n`,
  );
  md.push("### Act precision, with floors (the registered gate) and replays on the same answers\n");
  md.push(
    "| policy | act above | acts right (exact 95% lower) | no ambiguous | approvals acted on | wrong acts (groups) |",
  );
  md.push("| --- | --- | --- | --- | --- | --- |");
  for (const r of gateReads) {
    md.push(
      `| ${r.name} | ${num(r.actAbove, 2)} | ${fmtExact(r.acts)} | ${fmtExact(r.actsNoAmbiguous)} | ${r.approvalsActed} | ${r.wrong.length} (${r.wrongGroups}) |`,
    );
  }
  md.push("\nThe same rubric with no floors (raw gate, a second ask of every call):\n");
  md.push(
    "| policy | act above | acts right (exact 95% lower) | no ambiguous | approvals acted on | wrong acts (groups) |",
  );
  md.push("| --- | --- | --- | --- | --- | --- |");
  for (const r of rawReads) {
    md.push(
      `| ${r.name} | ${num(r.actAbove, 2)} | ${fmtExact(r.acts)} | ${fmtExact(r.actsNoAmbiguous)} | ${r.approvalsActed} | ${r.wrong.length} (${r.wrongGroups}) |`,
    );
  }
  md.push(
    `\nApprovals without ambiguous items: ${approvalsNoAmb}. AUC of pYes against the truth: gate (answered) ${num(
      auc(
        answeredGate.map((t) => t.pYes),
        answeredGate.map((t) => t.item.truth),
      ) ?? Number.NaN,
    )}, raw (all) ${num(
      auc(
        answeredRaw.map((t) => t.pYes),
        answeredRaw.map((t) => t.item.truth),
      ) ?? Number.NaN,
    )}. Highest raw pYes ${num(maxP, 2)}.\n`,
  );
  md.push("### Every wrong act\n");
  for (const r of [...gateReads, ...rawReads.map((x) => ({ ...x, name: `raw: ${x.name}` }))]) {
    md.push(
      `**${r.name}, act above ${num(r.actAbove, 2)}**: ${r.wrong.length === 0 ? "none" : ""}`,
    );
    for (const w of r.wrong) {
      md.push(
        `- ${w.id} ${w.family} \`${w.group}\` pYes ${num(w.pYes, 2)}${w.ambiguous ? " (ambiguous)" : ""}: \`${w.call}\` (${w.why})`,
      );
    }
    md.push("");
  }
  md.push("### By family (registered gate)\n");
  md.push("| family | items | deny | floored | acts | wrong acts |");
  md.push("| --- | --- | --- | --- | --- | --- |");
  for (const [f, v] of [...byFamily.entries()].sort())
    md.push(`| ${f} | ${v.items} | ${v.deny} | ${v.floored} | ${v.acted} | ${v.wrong} |`);
  md.push("\n### Reliability of raw pYes against the truth\n");
  md.push("| pYes | rows | truly approve |");
  md.push("| --- | --- | --- |");
  for (const b of reliability(rawRows)) md.push(`| ${b.bin} | ${b.rows} | ${b.approve} |`);
  md.push(
    `\n### Floors\n\n${floored.length} calls settled by floors (${floored.filter((t) => !t.item.truth).length} deny, ${floored.filter((t) => t.item.truth).length} approve); with no floors, Jev at the frozen bar would have acted on ${flooredDetail.filter((x) => x.rawWouldAct).length} of them (${flooredDetail.filter((x) => x.rawWouldAct && !x.truth).length} wrongly).\n`,
  );
  for (const x of flooredDetail)
    md.push(
      `- ${x.truth ? "approve" : "deny"} ${x.floor} \`${x.group}\` raw pYes ${x.rawPYes === null ? "-" : num(x.rawPYes, 2)}: \`${x.call}\``,
    );
  md.push(
    `\nRun to run (gate ask vs raw ask of the same state, ${pairs.length} pairs): median spread ${num(q(0.5), 3)}, 90th ${num(q(0.9), 3)}, max ${num(spreads.at(-1) ?? 0, 3)}; ${crossed} crossed the registered bar.\n`,
  );

  return {
    corpus: { items: items.length, approvals, approvalsNoAmbiguous: approvalsNoAmb },
    gateRows: gateRows.length,
    answered: answeredGate.length,
    floored: floored.length,
    failedOpen,
    labelled,
    labelMismatch,
    models,
    rulingMismatches: mismatched,
    frozen: { primary: ft.primary, secondary: ft.secondary },
    rollout,
    plannedSample: { acts: sampleRows.length, wrong: sampleWrong.map((t) => t.item.id) },
    gate: gateReads,
    raw: rawReads,
    floors: flooredDetail,
    runToRun: {
      pairs: pairs.length,
      median: q(0.5),
      p90: q(0.9),
      max: spreads.at(-1) ?? 0,
      crossed,
    },
    auc: {
      gate: auc(
        answeredGate.map((t) => t.pYes),
        answeredGate.map((t) => t.item.truth),
      ),
      raw: auc(
        answeredRaw.map((t) => t.pYes),
        answeredRaw.map((t) => t.item.truth),
      ),
    },
    reliabilityRaw: reliability(rawRows),
    byFamily: Object.fromEntries(byFamily),
  };
}

// ---------------------------------------------------------------------------
// Study B
// ---------------------------------------------------------------------------

async function analyzeMod(dir: string, md: string[]): Promise<Record<string, unknown>> {
  const p = paths(dir);
  const { items } = loadMod();
  const byState = new Map(items.map((i) => [i.state, i]));
  const manifest = readJson<{ frozen: { moderation: ModFreeze } }>(p.manifest);
  const fm = manifest.frozen.moderation;
  const model: LogisticModel = { weights: fm.logistic.weights, bias: fm.logistic.bias };
  const rows = await new JsonlLedger(p.modLedger).all();
  const gateRows = rows.filter((r) => r.gateId === MOD_GATE);
  const reqs = modRequests(gateRows, MOD_GATE, (s) => byState.get(s)?.truth);
  const itemOf = (state: string): ModItem => byState.get(state) as ModItem;
  const asked = items.filter((i) => !i.floored);
  const noAction = reqs.filter((r) => !r.truth).length;
  const needs = reqs.filter((r) => r.truth).length;
  const repool = Math.max(
    0,
    ...reqs.map((r) => Math.abs(r.recordedPYes - pYesOf("any", r.members, model))),
  );

  const read = (c: CombinerName, bar: number | undefined) => {
    const ps = reqs.map((r) => pYesOf(c, r.members, model));
    const lean = reqs.map((r, i) => (ps[i] ?? 0.5) >= 0.5 === r.truth);
    const clean = reqs
      .map((r, i) => ({ amb: itemOf(r.state).ambiguous, ok: lean[i] === true }))
      .filter((x) => !x.amb);
    const publishIdx =
      bar === undefined ? [] : reqs.flatMap((_, i) => (1 - (ps[i] ?? 0.5) >= bar ? [i] : []));
    const pubRight = publishIdx.filter((i) => reqs[i]?.truth === false).length;
    const pubWrong = publishIdx.filter((i) => reqs[i]?.truth === true);
    const brier =
      reqs.reduce((s, r, i) => s + ((ps[i] ?? 0.5) - (r.truth ? 1 : 0)) ** 2, 0) /
      Math.max(1, reqs.length);
    return {
      combiner: c,
      bar: bar ?? null,
      lean: wilson(lean.filter(Boolean).length, lean.length),
      leanRate: lean.filter(Boolean).length / Math.max(1, lean.length),
      leanNoAmbiguous: wilson(clean.filter((x) => x.ok).length, clean.length),
      publish: exact(pubRight, publishIdx.length),
      needingActionPublished: pubWrong.map((i) => {
        const r = reqs[i] as (typeof reqs)[number];
        const it = itemOf(r.state);
        return {
          id: it.id,
          template: it.template,
          category: it.category,
          pNoAction: 1 - (ps[i] ?? 0.5),
          why: it.why,
        };
      }),
      noActionCoverage: wilson(pubRight, noAction),
      saturated: ps.filter(saturated).length / Math.max(1, ps.length),
      auc: auc(
        ps,
        reqs.map((r) => r.truth),
      ),
      brier,
    };
  };
  const reads = COMBINERS.map((c) => read(c, fm.bars[c].secondary.actAbove));
  // Wave 1's finding replicated: the default pool at T3's own 0.9 publish bar.
  const at09 = COMBINERS.map((c) => read(c, 0.9));

  // Members on their own questions, and as the ledger now scores them (memberTruths).
  const memberIds = ["threat", "harass", "spam", "selfharm"] as const;
  const memberTable = memberIds.map((q, j) => {
    const own = reqs.filter(
      (r) => (r.members[j] as JudgeVerdict).pYes >= 0.5 === itemOf(r.state).memberTruths[q],
    ).length;
    const memberRows = gateRows.filter(
      (r) => r.combined !== true && r.questionId === q && r.outcome !== undefined,
    );
    const ledgerRight = memberRows.filter((r) => r.outcome?.correct === true).length;
    const truthMismatch = memberRows.filter((r) => {
      const combined = gateRows.find((c) => c.combined === true && c.requestId === r.requestId);
      const it = combined?.state === undefined ? undefined : byState.get(combined.state);
      return it !== undefined && r.outcome?.truth !== it.memberTruths[q];
    }).length;
    return {
      member: q,
      own: wilson(own, reqs.length),
      ledger: wilson(ledgerRight, memberRows.length),
      truthMismatch,
    };
  });
  const memberRowsAll = gateRows.filter((r) => r.combined !== true);
  const corr = memberCorrelation(memberRowsAll.length > 0 ? gateRows : []);

  const combinedRows = gateRows.filter((r) => r.combined === true);
  const readout = batteryReadout(combinedRows);
  const report = fitActBar(combinedRows, { target: 0.95, minSupport: 30 });
  const report90 = fitActBar(combinedRows, { target: 0.9, minSupport: 30 });
  const floored = combinedRows.filter((r) => r.strategy === "floored");
  const flooredMembers = memberRowsAll.filter((m) =>
    floored.some((f) => f.requestId === m.requestId),
  ).length;
  const labels = existsSync(`${dir}/mod-labels.json`)
    ? readJson<Record<string, unknown>>(`${dir}/mod-labels.json`)
    : {};

  md.push("## Study B: the moderation battery on fresh posts\n");
  md.push(
    `Corpus: ${items.length} posts (${asked.length} asked, ${items.length - asked.length} floored), ${asked.filter((i) => i.truth).length} needing action, ${asked.filter((i) => i.ambiguous).length} ambiguous. Answered requests ${reqs.length} (${needs} need action, ${noAction} do not). Recorded combined pYes vs an offline \`any\` re-pool: max difference ${repool.toExponential(2)}. Labels: ${JSON.stringify(labels)}.\n`,
  );
  md.push(
    `Frozen from T3's fit split (${fm.fitRequests} requests, ${fm.fitNoAction} needing no action): no combiner has a conservative publish bar at 0.95 (${fm.bars.any.primary.sentence}); the secondary 0.90 bars are any ${fm.bars.any.secondary.actAbove}, logodds ${fm.bars.logodds.secondary.actAbove}, learned ${fm.bars.learned.secondary.actAbove} (in-sample). The live gate published at any's bar.\n`,
  );
  md.push(
    "| combiner | frozen 0.90 publish bar | lean accuracy | no ambiguous | published right (exact 95% lower) | needing action published | no-action posts published | saturated | AUC | Brier |",
  );
  md.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of reads) {
    md.push(
      `| ${r.combiner} | ${r.bar === null ? "none" : num(r.bar, 6)} | ${r.lean} | ${r.leanNoAmbiguous} | ${fmtExact(r.publish)} | ${r.needingActionPublished.length} of ${needs} | ${r.noActionCoverage} | ${pct(r.saturated)} | ${num(r.auc ?? Number.NaN)} | ${num(r.brier)} |`,
    );
  }
  md.push("\nAt T3's original publish bar of 0.9 (the wave-1 setting), for comparison:\n");
  md.push("| combiner | published right (exact 95% lower) | needing action published |");
  md.push("| --- | --- | --- |");
  for (const r of at09)
    md.push(
      `| ${r.combiner} | ${fmtExact(r.publish)} | ${r.needingActionPublished.length} of ${needs} |`,
    );
  md.push("\nEvery post needing action that a frozen policy would have published:\n");
  for (const r of reads) {
    md.push(
      `- ${r.combiner}: ${r.needingActionPublished.length === 0 ? "none" : r.needingActionPublished.map((x) => `${x.id} ${x.category} \`${x.template}\` P(no action) ${num(x.pNoAction, 4)} (${x.why})`).join("; ")}`,
    );
  }
  md.push(
    "\n| member | right on its own question | as the ledger scores it (memberTruths) | member truth != memberTruths |",
  );
  md.push("| --- | --- | --- | --- |");
  for (const m of memberTable)
    md.push(`| ${m.member} | ${m.own} | ${m.ledger} | ${m.truthMismatch} |`);
  md.push(
    `\nMember error correlation from the ledger (memberCorrelation on own truths): mean ${corr.mean === undefined ? "none" : num(corr.mean)} over ${corr.n} requests.\n`,
  );
  md.push(
    `Product readouts on the fresh rows: battery: ${readout === undefined ? "none" : describeBattery(readout)}. Act bar at 0.95: ${describeActBar(report, { target: 0.95, minSupport: 30, minEstimated: 30 })}. At 0.90: ${describeActBar(report90, { target: 0.9, minSupport: 30, minEstimated: 30 })}.\n`,
  );
  md.push(
    `Floors: ${floored.length} of ${items.filter((i) => i.floored).length} hash-matched posts floored, ${floored.filter((r) => r.soft === "refuse").length} refused, member rows ${flooredMembers}, cost $${floored.reduce((s, r) => s + r.cost, 0)}.\n`,
  );

  return {
    requests: reqs.length,
    needs,
    noAction,
    repoolMaxDiff: repool,
    frozen: fm.bars,
    combiners: reads,
    atWave1Bar09: at09,
    members: memberTable,
    memberCorrelation: { mean: corr.mean ?? null, n: corr.n },
    readout: readout ?? null,
    readoutSentence: readout === undefined ? null : describeBattery(readout),
    reportBar95: report,
    reportBar90: report90,
    floors: {
      floored: floored.length,
      refused: floored.filter((r) => r.soft === "refuse").length,
      memberRows: flooredMembers,
    },
    labels,
  };
}

export async function analyze(dir: string): Promise<void> {
  const p = paths(dir);
  const md: string[] = [`# V4 fresh validation: ${dir.replace(/\\/g, "/").split("/").at(-1)}\n`];
  const tool = await analyzeTool(dir, md);
  const mod = await analyzeMod(dir, md);
  const spend = existsSync(`${dir}/spend.json`)
    ? readJson<Record<string, unknown>>(`${dir}/spend.json`)
    : null;
  md.push(`## Spend\n\n${JSON.stringify(spend)}\n`);
  writeJson(p.results, { tool, mod, spend });
  writeFileSync(p.resultsMd, `${md.join("\n")}\n`);
  progress(`[analyze] wrote ${p.resultsMd}`);
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (dir === undefined) throw new Error("usage: analyze.ts <run dir>");
  await analyze(dir);
}
