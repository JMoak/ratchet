/**
 * V2 on wave-1 ledgers, across surfaces:
 * - T3-04: `Engine.report()` and `ratchet report` read one ledger with one set of defaults.
 * - T3-03: on T3's live sibling ledger, a gate borrowing a profile keeps it until its own labels
 *   grade it estimated (labels arriving in ledger order, read at checkpoints).
 * - W2-C (backlog), quantified: a judge profile still bins the leading answer's confidence, so the
 *   bar it lends a judge gate is not the act-side bar; what it delivers on T1's held-out rows.
 * - `ratchet trail`'s per-policy grades against the independent scorer.
 * Post hoc and offline; copies of wave-1 rows are written under experiments/out/e2e/verify/v2-learning/.
 *
 *   bun experiments/e2e/verify/v2-learning/surfaces.ts
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../../../../src/engine.ts";
import { JsonlLedger } from "../../../../src/ledger/ledger.ts";
import { borrowedBar, buildProfile } from "../../../../src/ledger/profile.ts";
import type { Oracle } from "../../../../src/types.ts";
import { cli } from "./recompute.ts";
import {
  actRight,
  decisions,
  exactLower,
  fitTrusted,
  pct,
  type Row,
  readLedger,
  readout,
  rowGoIsYes,
  settled,
} from "./scorer.ts";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const E2E = join(ROOT, "experiments", "out", "e2e");
const OUT = join(E2E, "verify", "v2-learning");
const T1 = join(E2E, "t1-toolgate", "2026-11-12T10-22-04-541Z-live");
const T2 = join(E2E, "t2-verifier", "2026-11-12T10-32-34-553Z-live", "ledgers");
const T3 = join(E2E, "t3-triage", "2026-11-12T10-19-41-682Z-live");

const never: Oracle = {
  id: "never",
  async decide() {
    throw new Error("no model call in a verification");
  },
};

type Json = Record<string, unknown>;

async function defaults(lines: string[]): Promise<void> {
  lines.push("## T3-04: Engine.report() and ratchet report at their defaults", "");
  lines.push(
    "| ledger | gate | engine grade / act bar / point / fit rows | cli grade / act bar / point / fit rows | same |",
  );
  lines.push("| --- | --- | --- | --- | --- |");
  for (const [name, src] of [
    ["T3 sibling", join(T3, "sibling.jsonl")],
    ["T3 routing", join(T3, "routing.jsonl")],
    ["T1 ledger", join(T1, "ledger.jsonl")],
    ["T2 heldout-battery-learned", join(T2, "heldout-battery-learned.jsonl")],
  ] as const) {
    const copy = join(OUT, `defaults-${name.replace(/\W+/g, "-")}.jsonl`);
    copyFileSync(src, copy);
    const engine = new Engine({ oracle: never, ledger: new JsonlLedger(copy) });
    const rep = await engine.report();
    const cliRep = JSON.parse(cli(["report", copy, "--json"]).out) as { gates: Json[] };
    for (const [gate, q] of Object.entries(rep.byGate)) {
      const c = cliRep.gates.find((g) => g.gate === gate);
      const e = `${q.grade.kind} / ${q.fitted?.threshold ?? "none"} / ${q.pointFitted?.threshold ?? "none"} / ${q.fitRows ?? "-"}`;
      const cf = c?.fitted as Json | undefined;
      const cp = c?.pointFitted as Json | undefined;
      const k = `${String((c?.grade as Json | undefined)?.kind)} / ${cf?.threshold ?? "none"} / ${cp?.threshold ?? "none"} / ${c?.fitRows ?? "-"}`;
      lines.push(`| ${name} | ${gate} | ${e} | ${k} | ${e === k} |`);
    }
  }
  lines.push("");
}

async function lending(lines: string[]): Promise<void> {
  lines.push(
    "## T3-03: lending on the live sibling ledger, labels arriving in ledger order",
    "",
    "Decisions as recorded; only the first k labels of each sibling gate kept. Profiles: the",
    "track's `profile-pick.json` and `profile-rate.json` (the gates' declared `barSource`).",
    "",
    "| labels per gate | sib.route (cli) | sib.urgency (cli) | sib.route (engine) | sib.urgency (engine) |",
    "| --- | --- | --- | --- | --- |",
  );
  const text = readFileSync(join(T3, "sibling.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const gateOf = new Map<string, string>();
  for (const l of text) {
    const x = JSON.parse(l) as { type: string; record?: { id: string; gateId: string } };
    if (x.type === "decision" && x.record) gateOf.set(x.record.id, x.record.gateId);
  }
  const profiles = [join(T3, "profile-pick.json"), join(T3, "profile-rate.json")];
  const parsed = profiles.map((p) => JSON.parse(readFileSync(p, "utf8")) as never);
  for (const k of [0, 10, 19, 20, 25, 29, 30, 31, 60, 120, 140]) {
    const seen = new Map<string, number>();
    const kept = text.filter((l) => {
      const x = JSON.parse(l) as { type: string; id?: string };
      if (x.type !== "outcome") return true;
      const g = gateOf.get(x.id ?? "") ?? "";
      const n = seen.get(g) ?? 0;
      seen.set(g, n + 1);
      return n < k;
    });
    const path = join(OUT, `lending-${k}.jsonl`);
    writeFileSync(path, `${kept.join("\n")}\n`);
    const rep = JSON.parse(
      cli(["report", path, "--json", ...profiles.flatMap((p) => ["--profile", p])]).out,
    ) as {
      gates: Json[];
    };
    const kind = (g: string) => {
      const gr = rep.gates.find((x) => x.gate === g)?.grade as Json | undefined;
      return `${String(gr?.kind)}${gr?.stale === true ? " (stale)" : ""}`;
    };
    const engine = new Engine({ oracle: never, ledger: new JsonlLedger(path), profiles: parsed });
    const er = await engine.report();
    const ek = (g: string) => {
      const gr = er.byGate[g]?.grade;
      return `${gr?.kind}${gr?.kind === "borrowed" && gr.stale === true ? " (stale)" : ""}`;
    };
    lines.push(
      `| ${k} | ${kind("sib.route")} | ${kind("sib.urgency")} | ${ek("sib.route")} | ${ek("sib.urgency")} |`,
    );
  }
  lines.push("");
}

async function judgeProfile(lines: string[]): Promise<void> {
  // A judge profile from T1's raw fit rows, the way `ratchet profile build` reads them.
  const fitRows = new JsonlLedger(join(OUT, "t1-raw-fit-only.jsonl"));
  const rows = await fitRows.all();
  {
    const model = rows.find((r) => r.model !== undefined)?.model ?? "";
    const profile = buildProfile(rows, { model, kind: "judge" }, { ledgers: ["t1 raw fit"] });
    const raw = readLedger(join(T1, "raw-ledger.jsonl"));
    const main = readLedger(join(T1, "ledger.jsonl"));
    const slices: [string, Row[]][] = [
      ["evidence, with floors", main.filter((r) => r.evidenceVersion === "t1-toolgate-frozen-v1")],
      ["challenge, no floors", raw.filter((r) => r.tags.includes("split:challenge"))],
      ["drift, no floors", raw.filter((r) => r.tags.includes("split:drift"))],
    ];
    lines.push(
      "## W2-C quantified: a judge profile's lent bar is a leading-answer bar",
      "",
      "Profile built by `buildProfile` from T1's 180 raw fit rows (judge, jev-1.13). Its bar is read",
      "on the leading answer's confidence; used as `actAbove` it acts on p(approve). Acts at that bar",
      "on T1's held-out rows (post hoc):",
      "",
      "| promise | profile bar | act-side conservative bar on the same rows (report) | slice | acts right at the profile bar (exact lower) |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const target of [0.95, 0.98]) {
      const bar = profile === undefined ? undefined : borrowedBar(profile, target);
      const rep = JSON.parse(
        cli(["report", join(OUT, "t1-raw-fit-only.jsonl"), "--json", "--target", String(target)])
          .out,
      ) as {
        gates: Json[];
      };
      const own = (rep.gates[0]?.fitted as Json | undefined)?.threshold;
      for (const [name, rows] of slices) {
        if (bar === undefined) {
          lines.push(`| ${target} | none | ${own ?? "none"} | ${name} | - |`);
          continue;
        }
        let acts = 0;
        let right = 0;
        for (const r of rows) {
          if (r.outcome === undefined || !fitTrusted(r) || settled(r) || r.failedOpen) continue;
          const g = rowGoIsYes(r) ?? true;
          const p = g ? (r.pYes ?? 0) : 1 - (r.pYes ?? 1);
          if (p < bar) continue;
          acts++;
          if (actRight(r, g) === true) right++;
        }
        lines.push(
          `| ${target} | ${bar} | ${own ?? "none"} | ${name} | ${acts === 0 ? "no acts" : `${right}/${acts} = ${pct(right / acts)} (${pct(exactLower(right, acts))})`} |`,
        );
      }
    }
    lines.push("");
  }
}

function trail(lines: string[]): void {
  lines.push("## ratchet trail: per-policy grades against the independent scorer", "");
  lines.push("| ledger | gate | policy | trail grade (n) | mine (n) | same |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const [name, path] of [
    ["T1 ledger", join(T1, "ledger.jsonl")],
    ["T1 mechanics", join(T1, "mechanics-ledger.jsonl")],
    ["T2 chain", join(T2, "chain.jsonl")],
    ["T3 sibling", join(T3, "sibling.jsonl")],
    ["T3 moderation", join(T3, "moderation.jsonl")],
  ] as const) {
    const t = JSON.parse(cli(["trail", path, "--json", "--last", "1"]).out) as { bars: Json[] };
    const rows = decisions(readLedger(path));
    for (const b of t.bars) {
      const mine = readout(
        rows.filter((r) => r.gateId === b.gate && r.policyHash === b.policyHash),
        { target: 0.98, minSupport: 30, minEstimated: 30 },
        true,
      ).grade;
      const g = b.grade as Json;
      const theirs = `${String(g.kind)} (${String(g.n ?? g.sampleSize ?? g.unselected ?? "-")})`;
      const ours = `${mine.kind} (${mine.kind === "estimated" ? mine.n : mine.kind === "measured" ? mine.sample : mine.kind === "none" ? mine.unselected : "-"})`;
      lines.push(
        `| ${name} | ${String(b.gate)} | ${String(b.policyHash).slice(0, 8)} | ${theirs} | ${ours} | ${theirs === ours} |`,
      );
    }
  }
  lines.push("");
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const lines: string[] = ["# Surfaces and lending on wave-1 ledgers (post hoc)", ""];
  await defaults(lines);
  await lending(lines);
  await judgeProfile(lines);
  trail(lines);
  const md = `${lines.join("\n")}\n`;
  writeFileSync(join(OUT, "surfaces.md"), md);
  process.stdout.write(md);
}

if (import.meta.main) await main();
