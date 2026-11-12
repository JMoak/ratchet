/**
 * CLI truthfulness: run `ratchet report | check | replay | trail` as a user would (a child
 * process over the ledger file) and compare every number with an independent computation from
 * the raw JSONL. The independent side parses the file itself and re-implements each figure
 * from its documented definition (docs/cli.md); it imports nothing from src/ledger or src/cli.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { progress, ROOT, writeJson } from "../lib.ts";
import { type Run, readJson } from "./common.ts";
import { BATTERY_GATE_ID, GATE_ID, PLAN, RAW_GATE_ID } from "./gate.ts";

// ---------------------------------------------------------------------------
// Independent parse
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  at: string;
  gateId: string;
  requestId: string;
  combined?: boolean;
  questionId: string;
  policyHash?: string;
  evidenceVersion?: string;
  model?: string;
  strategy: string;
  verdict: { kind: string; pYes?: number };
  go: number;
  confidence: number;
  soft: string;
  mode: string;
  floor?: string;
  cost: number;
  latencyMs: number;
  failedOpen: boolean;
  tags: string[];
  outcome?: { correct: boolean; truth?: boolean | string; source?: string; at: string };
}

export function parse(path: string): Row[] {
  const rows = new Map<string, Row>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as {
      type: string;
      record?: Row;
      id?: string;
      outcome?: Row["outcome"];
    };
    if (o.type === "decision" && o.record) rows.set(o.record.id, { ...o.record });
    else if (o.type === "outcome" && o.id) {
      const r = rows.get(o.id);
      if (r && o.outcome) r.outcome = o.outcome;
    }
  }
  return [...rows.values()];
}

/** Decision rows of a gate: battery members (rows sharing a combined row's request) excluded. */
function gateRows(all: readonly Row[], gate: string): Row[] {
  const batteries = new Set(all.filter((r) => r.combined).map((r) => `${r.gateId}|${r.requestId}`));
  return all.filter(
    (r) =>
      r.gateId === gate && (r.combined === true || !batteries.has(`${r.gateId}|${r.requestId}`)),
  );
}

const fixed = (r: Row) => r.strategy === "floored" || r.strategy === "bypass";
/** review:blind[:name] is blind; no source is unknown; both are trusted (docs/cli.md). */
const trusted = (r: Row) => {
  const s = r.outcome?.source;
  return (
    s === undefined ||
    /^review:blind(?::|$)/.test(s) ||
    /^(keywork|claude-code|codex):person/.test(s)
  );
};
const labelled = (r: Row) => r.outcome !== undefined && !r.failedOpen && !fixed(r);
const unselected = (r: Row) =>
  labelled(r) && trusted(r) && (r.mode === "shadow" || r.tags.includes("audit"));
const mean = (xs: readonly number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN;

function ece(items: readonly { c: number; ok: boolean }[]): number {
  const bins = Array.from({ length: 10 }, () => [] as { c: number; ok: boolean }[]);
  for (const x of items) bins[Math.min(9, Math.floor(Math.min(1, Math.max(0, x.c)) * 10))]?.push(x);
  return bins.reduce(
    (s, b) =>
      b.length === 0
        ? s
        : s +
          (b.length / items.length) *
            Math.abs(mean(b.map((x) => x.c)) - mean(b.map((x) => (x.ok ? 1 : 0)))),
    0,
  );
}

/** Lowest distinct confidence whose rows at or above reach the target with support. */
function fitBar(items: readonly { c: number; ok: boolean }[], target: number, minSupport: number) {
  const sorted = [...items].sort((a, b) => b.c - a.c);
  let right = 0;
  let best: { threshold: number; n: number; coverage: number; accuracy: number } | undefined;
  sorted.forEach((x, i) => {
    if (x.ok) right++;
    const next = sorted[i + 1];
    if (next && next.c === x.c) return;
    const n = i + 1;
    if (n >= minSupport && right / n >= target)
      best = { threshold: x.c, n, coverage: n / sorted.length, accuracy: right / n };
  });
  return best;
}

function independentReport(rows: readonly Row[], target: number, minSupport: number) {
  const lab = rows.filter(labelled);
  const uns = rows.filter(unselected);
  const items = (rs: readonly Row[]) =>
    rs.map((r) => ({ c: r.confidence, ok: r.outcome?.correct === true }));
  const fitFrom = uns.length >= minSupport ? uns : lab.filter(trusted);
  const fit = fitBar(items(fitFrom), target, minSupport);
  const called = rows.filter((r) => !fixed(r));
  return {
    rows: rows.length,
    labelled: lab.length,
    unselected: uns.length,
    accuracy: mean(lab.map((r) => (r.outcome?.correct ? 1 : 0))),
    expected: mean(lab.map((r) => r.confidence)),
    ece: ece(items(lab)),
    brier: mean(lab.map((r) => (r.confidence - (r.outcome?.correct ? 1 : 0)) ** 2)),
    fittedFrom: uns.length >= minSupport ? "unselected" : "all",
    fitted: fit,
    failedOpen: rows.filter((r) => r.failedOpen).length,
    fixed: rows.filter(fixed).length,
    cost: rows.reduce((s, r) => s + r.cost, 0),
    meanLatencyMs: mean(called.map((r) => r.latencyMs)),
    models: Object.fromEntries(
      [
        ...new Set(rows.filter((r) => !r.failedOpen && !fixed(r)).map((r) => r.model ?? "(none)")),
      ].map((m) => [
        m,
        rows.filter((r) => !r.failedOpen && !fixed(r) && (r.model ?? "(none)") === m).length,
      ]),
    ),
  };
}

function independentReplay(rows: readonly Row[], actAbove: number) {
  const recorded: Record<string, number> = { act: 0, review: 0, refuse: 0 };
  const replayed: Record<string, number> = { act: 0, review: 0, refuse: 0 };
  let changed = 0;
  const lab = { rows: 0, acted: 0, right: 0, recActed: 0, recRight: 0 };
  for (const r of rows) {
    const rec = r.soft;
    const rep = fixed(r)
      ? rec
      : r.failedOpen
        ? "review"
        : (r.verdict.pYes ?? 0) >= actAbove
          ? "act"
          : "review";
    recorded[rec] = (recorded[rec] ?? 0) + 1;
    replayed[rep] = (replayed[rep] ?? 0) + 1;
    if (rec !== rep) changed++;
    if (r.outcome && !r.failedOpen) {
      lab.rows++;
      const right = r.outcome.truth === true;
      if (rep === "act") {
        lab.acted++;
        if (right) lab.right++;
      }
      if (rec === "act") {
        lab.recActed++;
        if (right) lab.recRight++;
      }
    }
  }
  return { recorded, replayed, changed, lab };
}

function independentBars(rows: readonly Row[]) {
  const by = new Map<string, { acts: number[]; held: number[] }>();
  for (const r of rows) {
    if (fixed(r) || r.failedOpen || r.floor !== undefined) continue;
    const g = by.get(r.policyHash ?? "") ?? { acts: [], held: [] };
    (r.soft === "act" ? g.acts : g.held).push(r.go);
    by.set(r.policyHash ?? "", g);
  }
  return [...by].map(([policyHash, g]) => ({
    policyHash,
    rows: g.acts.length + g.held.length,
    above: g.held.length ? Math.max(...g.held) : undefined,
    atOrBelow: g.acts.length ? Math.min(...g.acts) : undefined,
  }));
}

/** check's acted accuracy: the window's unselected, labelled, trusted act rows; yes is go. */
function independentChecked(rows: readonly Row[], window: number) {
  const recent = [...rows]
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Date.parse(a.r.at) - Date.parse(b.r.at) || a.i - b.i)
    .map((x) => x.r)
    .slice(-window);
  const acted = recent.filter((r) => unselected(r) && r.soft === "act");
  const right = acted.filter((r) => r.outcome?.truth === true).length;
  // The same, restricted to the newest row's policy: what the current bar has done.
  const newest = recent.at(-1)?.policyHash;
  const current = acted.filter((r) => r.policyHash === newest);
  return {
    window: recent.length,
    acted: acted.length,
    accuracy: acted.length ? right / acted.length : Number.NaN,
    policies: [...new Set(acted.map((r) => r.policyHash))].length,
    currentPolicyActed: current.length,
    currentPolicyAccuracy: current.length
      ? current.filter((r) => r.outcome?.truth === true).length / current.length
      : Number.NaN,
  };
}

// ---------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------

function cli(args: readonly string[]): { code: number; out: string } {
  const res = spawnSync(process.execPath, [join(ROOT, "bin", "ratchet.ts"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return { code: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const close = (a: number | undefined, b: number | undefined, tol = 1e-9) =>
  (a === undefined && b === undefined) ||
  (a !== undefined &&
    b !== undefined &&
    (Number.isNaN(a) ? Number.isNaN(b) : Math.abs(a - b) <= tol));

export async function verifyCli(run: Run): Promise<void> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    progress(`[cli] ${ok ? "ok  " : "DIFF"} ${name}: ${detail}`);
  };
  const target = 0.98;
  const minSupport = 30;

  // report --json against the independent report, for each gate in each ledger
  for (const [ledger, gates] of [
    [run.ledger, [GATE_ID]],
    [run.rawLedger, [RAW_GATE_ID]],
    [run.batteryLedger, [BATTERY_GATE_ID]],
  ] as const) {
    if (!existsSync(ledger)) continue;
    const all = parse(ledger);
    const res = cli([
      "report",
      ledger,
      "--json",
      "--target",
      String(target),
      "--min-support",
      String(minSupport),
    ]);
    const rep = JSON.parse(res.out) as { gates: Record<string, unknown>[] };
    for (const gate of gates) {
      const mine = independentReport(gateRows(all, gate), target, minSupport);
      const theirs = rep.gates.find((g) => g.gate === gate) as Record<string, unknown> & {
        fitted?: { threshold: number; n: number; coverage: number };
        models: { model: string; rows: number }[];
      };
      const fields: [string, number | undefined, number | undefined][] = [
        ["rows", mine.rows, theirs.rows as number],
        ["labelled", mine.labelled, theirs.labelled as number],
        ["unselected", mine.unselected, theirs.unselected as number],
        ["accuracy", mine.accuracy, theirs.accuracy as number],
        ["expected", mine.expected, theirs.expectedAccuracy as number],
        ["ece", mine.ece, theirs.ece as number],
        ["brier", mine.brier, theirs.brier as number],
        ["bar", mine.fitted?.threshold, theirs.fitted?.threshold],
        ["bar support", mine.fitted?.n, theirs.fitted?.n],
        ["coverage", mine.fitted?.coverage, theirs.fitted?.coverage],
        ["failedOpen", mine.failedOpen, theirs.failedOpen as number],
        ["fixed", mine.fixed, theirs.fixed as number],
        ["cost", mine.cost, theirs.cost as number],
        ["meanLatencyMs", mine.meanLatencyMs, theirs.meanLatencyMs as number],
      ];
      const bad = fields.filter(([, a, b]) => !close(a, b, 1e-9));
      add(
        `report ${gate}`,
        bad.length === 0 && theirs.fittedFrom === mine.fittedFrom,
        bad.length === 0
          ? `${fields.length} figures agree (rows ${mine.rows}, labelled ${mine.labelled}, accuracy ${mine.accuracy.toFixed(4)}, ECE ${mine.ece.toFixed(4)}, bar ${mine.fitted?.threshold ?? "none"} on ${mine.fittedFrom})`
          : bad.map(([k, a, b]) => `${k}: mine ${a} vs cli ${b}`).join("; "),
      );
      const modelsAgree = theirs.models.every((m) => mine.models[m.model] === m.rows);
      add(`report ${gate} models`, modelsAgree, JSON.stringify(theirs.models));
    }
  }

  // check: the acted-accuracy figure, the grade it requires, and the model pin
  if (existsSync(run.ledger)) {
    const all = gateRows(parse(run.ledger), GATE_ID);
    const frozen = readJson<{ pinnedModel?: string; frozen: { policy: { actAbove: number } } }>(
      join(run.dir, "frozen.json"),
    );
    const c = cli(["check", run.ledger, "--gate", GATE_ID, "--promise", String(PLAN.promise)]);
    const ind = independentChecked(all, 500);
    const m = /acted accuracy ([\d.]+)% on (\d+) /.exec(c.out);
    const cliAcc = m ? Number(m[1]) / 100 : Number.NaN;
    const cliN = m ? Number(m[2]) : -1;
    add(
      "check acted accuracy",
      cliN === ind.acted && Math.abs(cliAcc - ind.accuracy) < 0.0006,
      `cli ${m?.[0] ?? c.out.trim()} | mine ${ind.acted} rows at ${(100 * ind.accuracy).toFixed(1)}% across ${ind.policies} policies; current policy alone: ${ind.currentPolicyActed} rows at ${(100 * ind.currentPolicyAccuracy).toFixed(1)}%`,
    );
    add(
      "check exit code",
      c.code === 0 || c.code === 1,
      `exit ${c.code}: ${c.out.trim().slice(0, 400)}`,
    );
    const measured = cli([
      "check",
      run.ledger,
      "--gate",
      GATE_ID,
      "--promise",
      String(PLAN.promise),
      "--require",
      "measured",
    ]);
    add(
      "check --require measured",
      measured.code === 0 || measured.code === 1,
      `exit ${measured.code}: ${measured.out.trim().slice(0, 400)}`,
    );
    if (frozen.pinnedModel) {
      const pin = cli([
        "check",
        run.ledger,
        "--gate",
        GATE_ID,
        "--promise",
        String(PLAN.promise),
        "--model",
        frozen.pinnedModel,
      ]);
      const answered = all.filter((r) => !r.failedOpen && !fixed(r));
      const foreign = answered.filter((r) => r.model !== frozen.pinnedModel).length;
      add(
        "check --model pin",
        (foreign === 0) === !/models other than the pinned/.test(pin.out),
        `exit ${pin.code}; ${foreign} of ${answered.length} answered rows by another model (whole gate); cli: ${pin.out.trim().slice(0, 300)}`,
      );
      const wrong = cli([
        "check",
        run.ledger,
        "--gate",
        GATE_ID,
        "--promise",
        String(PLAN.promise),
        "--model",
        "typesafe/jev-0.0-wrong",
      ]);
      add("check --model wrong pin fails", wrong.code === 1, `exit ${wrong.code}`);
    }

    // replay at several bars
    const productBar = readJson<{
      productReport: { at98: { fitted: { threshold: number } | null } };
    }>(join(run.dir, "frozen.json")).productReport.at98.fitted?.threshold;
    const bars = [
      frozen.frozen.policy.actAbove,
      0.9,
      0.99,
      ...(productBar !== undefined ? [productBar] : []),
    ];
    for (const b of bars) {
      const r = cli(["replay", run.ledger, "--gate", GATE_ID, "--act-above", String(b), "--json"]);
      const j = JSON.parse(r.out) as {
        actions: { recorded: Record<string, number>; replayed: Record<string, number> };
        changed: number;
        labelled: {
          recorded: { acted: number; accuracy?: number; rows: number };
          replayed: { acted: number; accuracy?: number; rows: number; wrongActs: number };
        };
      };
      const mine = independentReplay(all, b);
      const agree =
        ["act", "review", "refuse"].every(
          (a) =>
            (j.actions.recorded[a] ?? 0) === mine.recorded[a] &&
            (j.actions.replayed[a] ?? 0) === mine.replayed[a],
        ) &&
        j.changed === mine.changed &&
        j.labelled.replayed.acted === mine.lab.acted &&
        j.labelled.replayed.rows === mine.lab.rows &&
        close(
          j.labelled.replayed.accuracy,
          mine.lab.acted ? mine.lab.right / mine.lab.acted : undefined,
        ) &&
        j.labelled.recorded.acted === mine.lab.recActed;
      add(
        `replay --act-above ${b}`,
        agree,
        `cli replayed acts ${j.actions.replayed.act}, labelled acted ${j.labelled.replayed.acted} at ${j.labelled.replayed.accuracy?.toFixed(4)} | mine ${mine.replayed.act}, ${mine.lab.acted} at ${(mine.lab.right / Math.max(1, mine.lab.acted)).toFixed(4)}; changed ${j.changed} vs ${mine.changed}`,
      );
    }

    // trail: inferred bars per policy
    const t = cli(["trail", run.ledger, "--gate", GATE_ID, "--json", "--last", "3"]);
    const tj = JSON.parse(t.out) as {
      bars: {
        policyHash?: string;
        rows: number;
        above?: number;
        atOrBelow?: number;
        grade: { kind: string };
      }[];
      total: number;
    };
    const mineBars = independentBars(all);
    const barsAgree = mineBars.every((m) => {
      const b = tj.bars.find((x) => (x.policyHash ?? "") === m.policyHash);
      return (
        b !== undefined &&
        b.rows === m.rows &&
        close(b.above, m.above) &&
        close(b.atOrBelow, m.atOrBelow)
      );
    });
    add(
      "trail inferred bars",
      barsAgree && tj.total === all.length,
      tj.bars
        .map(
          (b) =>
            `${b.policyHash?.slice(0, 8)}: ${b.rows} rows, above ${b.above} at-or-below ${b.atOrBelow}, grade ${b.grade.kind}`,
        )
        .join("; "),
    );
    // markdown report renders without error
    const md = cli(["report", run.ledger]);
    add(
      "report markdown",
      md.code === 0 && md.out.includes("## Evidence"),
      md.out
        .split("\n")
        .filter((l) => l.startsWith("- "))
        .join(" | ")
        .slice(0, 500),
    );
  }

  // review summaries: the counts the real review command printed against the ledger
  for (const file of ["review-fit.txt", "review-evidence.txt"]) {
    const p = join(run.dir, file);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    const m = /matched the model's lean on (\d+) of (\d+)/.exec(text);
    const all = gateRows(parse(run.ledger), GATE_ID);
    const version = file === "review-fit.txt" ? PLAN.fitVersion : PLAN.frozenVersion;
    const reviewed = all.filter(
      (r) =>
        r.evidenceVersion === version &&
        r.outcome?.source === "review:blind:decider" &&
        r.mode === "shadow" &&
        !r.tags.some((x) => x.startsWith("phase:")),
    );
    const lean = reviewed.filter(
      (r) => (r.verdict.pYes ?? 0.5) >= 0.5 === (r.outcome?.truth === true),
    ).length;
    add(
      `review summary (${file})`,
      m !== null && Number(m[1]) === lean && Number(m[2]) === reviewed.length,
      `cli "${m?.[0]}" | mine ${lean} of ${reviewed.length}`,
    );
  }
  writeJson(join(run.dir, "cli-verify.json"), { checks });
}
