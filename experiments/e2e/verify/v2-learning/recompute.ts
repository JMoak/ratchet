/**
 * V2 recomputation: every act bar, point bar, coverage, grade and battery readout that
 * `ratchet report` prints for the wave-1 live ledgers, recomputed from the raw rows by
 * `scorer.ts` (which imports nothing from src/), and every `ratchet check` acted-accuracy line.
 * Offline: reads ledgers already bought; no model call.
 *
 *   bun experiments/e2e/verify/v2-learning/recompute.ts
 *
 * Writes experiments/out/e2e/verify/v2-learning/recompute.{json,md}. Exits 1 on any mismatch.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  actRight,
  current,
  decisions,
  fitTrusted,
  type Levers,
  majorityGoIsYes,
  members,
  pct,
  type Readout,
  type Row,
  readLedger,
  readout,
  rowGoIsYes,
  settled,
  unselected,
} from "./scorer.ts";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const E2E = join(ROOT, "experiments", "out", "e2e");
const OUT = join(E2E, "verify", "v2-learning");
const T1 = join(E2E, "t1-toolgate", "2026-11-12T10-22-04-541Z-live");
const T2 = join(E2E, "t2-verifier", "2026-11-12T10-32-34-553Z-live", "ledgers");
const T3 = join(E2E, "t3-triage", "2026-11-12T10-19-41-682Z-live");
const T5 = join(E2E, "t5-compound", "2026-11-12T10-35-57-202Z-main-live");

export const LEDGERS: readonly { track: string; name: string; path: string }[] = [
  ...["ledger", "raw-ledger", "battery-ledger", "mechanics-ledger", "real-ledger"].map((n) => ({
    track: "T1",
    name: n,
    path: join(T1, `${n}.jsonl`),
  })),
  ...[
    "fit-holistic",
    "heldout-holistic",
    "challenge-holistic",
    "fit-raw",
    "heldout-raw",
    "challenge-raw",
    "fit-battery",
    "heldout-battery",
    "heldout-battery-corr",
    "heldout-battery-learned",
    "challenge-battery",
    "chain",
  ].map((n) => ({ track: "T2", name: n, path: join(T2, `${n}.jsonl`) })),
  ...["routing", "moderation", "sibling", "approvals", "multilingual"].map((n) => ({
    track: "T3",
    name: n,
    path: join(T3, `${n}.jsonl`),
  })),
  ...[
    "single-jev113",
    "single-jev114",
    "single-haiku",
    "single-luna",
    "rep3-jev113",
    "framing3-jev113",
    "diverse2",
    "diverse3",
    "cascade-haiku",
    "cascade-luna",
    "seq-bar",
    "seq-lead",
  ].map((n) => ({ track: "T5", name: n, path: join(T5, `${n}.jsonl`) })),
];

export function cli(args: readonly string[]): { code: number; out: string } {
  const p = Bun.spawnSync(["bun", join(ROOT, "bin", "ratchet.ts"), ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode ?? -1, out: p.stdout.toString() };
}

type Json = Record<string, unknown>;
const o = (x: unknown): Json => (typeof x === "object" && x !== null ? (x as Json) : {});
const close = (a: unknown, b: unknown): boolean =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-9 : a === b;

function compare(group: string, cliGate: Json, mine: Readout, diffs: string[]): void {
  const d = (field: string, theirs: unknown, ours: unknown) => {
    if (!close(theirs, ours))
      diffs.push(`${group}: ${field} cli=${String(theirs)} mine=${String(ours)}`);
  };
  d("labelled", cliGate.labelled, mine.labelledAll);
  d("unselected", cliGate.unselected, mine.unselectedAll);
  d("older", cliGate.older, mine.olderRows);
  d("accuracy", cliGate.accuracy, mine.observed);
  d("fittedFrom", cliGate.fittedFrom, mine.fittedFrom);
  d("fitRows", cliGate.fitRows, mine.fitRows);
  for (const [k, b] of [
    ["fitted", mine.fitted],
    ["pointFitted", mine.point],
  ] as const) {
    const c = cliGate[k];
    if (c === undefined && b === undefined) continue;
    if (c === undefined || b === undefined) {
      diffs.push(`${group}: ${k} cli=${JSON.stringify(c)} mine=${JSON.stringify(b)}`);
      continue;
    }
    const cc = o(c);
    d(`${k}.threshold`, cc.threshold, b.threshold);
    d(`${k}.n`, cc.n, b.n);
    d(`${k}.accuracy`, cc.accuracy, b.accuracy);
    d(`${k}.coverage`, cc.coverage, b.coverage);
  }
  const g = o(cliGate.grade);
  const kind = g.kind;
  if (kind === "borrowed") {
    diffs.push(`${group}: grade borrowed with no profile offered`);
  } else if (mine.grade.kind !== kind) {
    diffs.push(`${group}: grade cli=${String(kind)} mine=${mine.grade.kind}`);
  } else if (mine.grade.kind === "estimated") {
    d("grade.n", g.n, mine.grade.n);
    d("grade.accuracy", g.accuracy, mine.grade.accuracy);
    d("grade.lower", g.lower, mine.grade.lower);
    d("grade.upper", g.upper, mine.grade.upper);
    d("grade.older", g.older ?? 0, mine.grade.older);
  } else if (mine.grade.kind === "none") {
    d("grade.labelled", g.labelled, mine.grade.labelled);
    d("grade.unselected", g.unselected, mine.grade.unselected);
    d("grade.older", g.older ?? 0, mine.grade.older);
  } else if (mine.grade.kind === "measured") {
    d("grade.sampleSize", g.sampleSize, mine.grade.sample);
    d("grade.lowerBound", g.lowerBound, mine.grade.lowerBound);
  }
  const b = cliGate.battery === undefined ? undefined : o(cliGate.battery);
  if ((b === undefined) !== (mine.battery === undefined)) {
    diffs.push(`${group}: battery cli=${JSON.stringify(b)} mine=${JSON.stringify(mine.battery)}`);
  } else if (b !== undefined && mine.battery !== undefined) {
    d("battery.verdicts", b.verdicts, mine.battery.verdicts);
    d("battery.saturated", b.saturated, mine.battery.saturated);
  }
}

/** `ratchet check`'s acted accuracy, recomputed: current configuration, last `window` rows by time. */
function checkMine(rows: readonly Row[], window: number) {
  const ordered = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.at < b.r.at ? -1 : a.r.at > b.r.at ? 1 : a.i - b.i))
    .map((x) => x.r);
  const recent = ordered.slice(-window);
  const now = new Set(current(rows).now.map((r) => r.id));
  const scoped = recent.filter((r) => now.has(r.id));
  const fallback = majorityGoIsYes(rows);
  const acted = scoped.filter(
    (r) =>
      r.outcome !== undefined &&
      !r.failedOpen &&
      !settled(r) &&
      unselected(r) &&
      fitTrusted(r) &&
      r.soft === "act",
  );
  const right = acted.filter((r) => actRight(r, rowGoIsYes(r) ?? fallback) === true).length;
  return { n: acted.length, right, older: recent.length - scoped.length, window: recent.length };
}

function main(): void {
  mkdirSync(OUT, { recursive: true });
  const leverSets: readonly Levers[] = [
    { target: 0.98, minSupport: 30, minEstimated: 30 },
    { target: 0.95, minSupport: 30, minEstimated: 30 },
    { target: 0.9, minSupport: 30, minEstimated: 30 },
  ];
  const diffs: string[] = [];
  const table: string[] = [];
  const checks: string[] = [];
  let compared = 0;
  for (const l of LEDGERS) {
    const rows = readLedger(l.path);
    const decided = decisions(rows);
    const gates = new Map<string, Row[]>();
    for (const r of decided) gates.set(r.gateId, [...(gates.get(r.gateId) ?? []), r]);
    const groups = new Map<string, { rows: Row[]; measurable: boolean }>();
    for (const [g, rs] of gates) groups.set(g, { rows: rs, measurable: true });
    for (const [g, rs] of members(rows)) groups.set(g, { rows: rs, measurable: false });
    for (const lv of leverSets) {
      const res = cli([
        "report",
        l.path,
        "--json",
        "--target",
        String(lv.target),
        "--min-support",
        String(lv.minSupport),
        "--min-estimated",
        String(lv.minEstimated),
      ]);
      if (res.code !== 0) {
        diffs.push(`${l.track}/${l.name}: report exited ${res.code}`);
        continue;
      }
      const rep = JSON.parse(res.out) as { gates: Json[] };
      const seen = new Set<string>();
      for (const cg of rep.gates) {
        const key = String(cg.gate);
        seen.add(key);
        const grp = groups.get(key);
        if (grp === undefined) {
          diffs.push(`${l.track}/${l.name}: cli gate ${key} not in my grouping`);
          continue;
        }
        const mine = readout(grp.rows, lv, grp.measurable);
        compare(`${l.track}/${l.name} ${key} @${lv.target}`, cg, mine, diffs);
        compared++;
        if (grp.measurable) {
          const f = mine.fitted;
          const p = mine.point;
          const gr = mine.grade;
          const gradeText =
            gr.kind === "estimated"
              ? `estimated ${pct(gr.accuracy)} on ${gr.n} [${pct(gr.lower)}, ${pct(gr.upper)}]${gr.older > 0 ? `, ${gr.older} older` : ""}`
              : gr.kind === "none"
                ? `none (${gr.unselected} unselected${gr.older > 0 ? `, ${gr.older} older` : ""})`
                : gr.kind === "measured"
                  ? `measured (${gr.sample} acts, lower ${pct(gr.lowerBound, 2)})`
                  : gr.kind;
          const bat =
            mine.battery === undefined
              ? ""
              : `${mine.battery.saturated}/${mine.battery.verdicts} (${pct(mine.battery.saturated / mine.battery.verdicts)})`;
          table.push(
            `| ${l.track} | ${l.name} | ${key} | ${lv.target} | ${mine.fittedFrom ?? "-"} (${mine.fitRows ?? 0}) | ${f ? `${f.threshold.toFixed(3)}: ${f.right}/${f.n} = ${pct(f.accuracy)}, cov ${pct(f.coverage)}` : "none"} | ${p ? `${p.threshold.toFixed(3)}: ${p.right}/${p.n} = ${pct(p.accuracy)}, cov ${pct(p.coverage)}` : "none"} | ${gradeText} | ${bat} | agree |`,
          );
        }
      }
      for (const k of groups.keys()) {
        if (!seen.has(k)) diffs.push(`${l.track}/${l.name}: my group ${k} missing from cli`);
      }
    }
    // check, at a 95% promise, for every decision gate.
    for (const [g, rs] of gates) {
      const res = cli(["check", l.path, "--gate", g, "--promise", "0.95"]);
      const line = res.out.trim();
      const mine = checkMine(rs, 500);
      const m = /acted accuracy (?:([\d.]+)% on |not judged: )(\d+) /.exec(line);
      const w = /window (\d+) of (\d+) rows(?:, (\d+) of them under an older)?/.exec(line);
      const theirsN = m ? Number(m[2]) : Number.NaN;
      const theirsAcc = m?.[1] !== undefined ? Number(m[1]) : undefined;
      const mineAcc = mine.n > 0 ? Number(((100 * mine.right) / mine.n).toFixed(1)) : undefined;
      const theirsOlder = w ? Number(w[3] ?? 0) : Number.NaN;
      let verdict = "agree";
      // A FAIL line carries only its failures, so an acted figure that did not fail is not printed.
      if (m === null && line.startsWith("FAIL"))
        verdict = "agree (acted figure not printed on FAIL)";
      else if (theirsN !== mine.n) verdict = `acted n cli=${theirsN} mine=${mine.n}`;
      else if (theirsAcc !== undefined && mine.n >= 30 && theirsAcc !== mineAcc) {
        verdict = `acted accuracy cli=${theirsAcc} mine=${mineAcc}`;
      } else if (theirsOlder !== mine.older)
        verdict = `older cli=${theirsOlder} mine=${mine.older}`;
      if (!verdict.startsWith("agree")) diffs.push(`${l.track}/${l.name} check ${g}: ${verdict}`);
      checks.push(
        `| ${l.track} | ${l.name} | ${g} | ${res.code} | ${mine.right}/${mine.n}${mine.n > 0 ? ` = ${pct(mine.right / mine.n)}` : ""} | ${mine.older} of ${mine.window} | ${verdict} |`,
      );
    }
  }
  const md = [
    "# V2 recomputation: ratchet report and check against an independent scorer",
    "",
    `${compared} gate and member readouts compared field by field (labelled, unselected, fit set, act bar, point bar, coverage, grade and its numbers, battery saturation) at promises 0.98, 0.95 and 0.90 (support 30, estimated 30); ${diffs.length} disagreements.`,
    "",
    ...(diffs.length > 0 ? ["## Disagreements", "", ...diffs.map((x) => `- ${x}`), ""] : []),
    "## Decision gates (members omitted from this table; they were compared too)",
    "",
    "| track | ledger | gate | promise | fitted on | act bar (conservative): right/n, coverage | point bar | grade | battery saturated | vs cli |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...table,
    "",
    "## ratchet check --promise 0.95: acted accuracy on the current configuration's unselected acts",
    "",
    "| track | ledger | gate | exit | acted right/n (mine) | older rows in window (mine) | vs cli |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...checks,
    "",
  ].join("\n");
  writeFileSync(join(OUT, "recompute.md"), md);
  writeFileSync(join(OUT, "recompute.json"), `${JSON.stringify({ compared, diffs }, null, 2)}\n`);
  process.stdout.write(`${compared} readouts compared, ${diffs.length} disagreements\n`);
  for (const x of diffs.slice(0, 60)) process.stdout.write(`  ${x}\n`);
  process.exitCode = diffs.length > 0 ? 1 : 0;
}

if (import.meta.main) main();
