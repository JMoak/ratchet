/**
 * V1 attacks on T4-02 (JSONL ledger tolerance), T2-11 (incremental index), T4-17 (duplicate
 * ids). Temp-dir ledgers only; the multi-process case spawns two `appender.ts` children.
 *
 *   bun experiments/e2e/verify/v1-safety/ledger.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../../../src/engine.ts";
import { type DecisionRecord, JsonlLedger } from "../../../../src/ledger/ledger.ts";
import { judge } from "../../../../src/questions.ts";
import { attack, describeError, fixed, report } from "./lib.ts";

const dir = mkdtempSync(join(tmpdir(), "v1-ledger-"));
const q = judge("Is it safe?", { id: "q" });

function rec(id: string, extra: Record<string, unknown> = {}): DecisionRecord {
  return {
    id,
    at: "2026-11-12T12:00:00.000Z",
    gateId: "g",
    requestId: `req-${id}`,
    questionId: "q",
    kind: "judge",
    prompt: "q?",
    questionHash: "0000000000000000",
    stateHash: "s",
    trustedHash: "s",
    untrusted: [],
    oracle: "o",
    strategy: "single",
    verdict: { kind: "judge", questionId: "q", pYes: 0.9, confidence: 0.9 },
    go: 0.9,
    confidence: 0.9,
    agreement: 1,
    soft: "act",
    action: "review",
    mode: "shadow",
    cost: 0.001,
    latencyMs: 1,
    failedOpen: false,
    tags: [],
    ...extra,
  } as DecisionRecord;
}
const line = (r: DecisionRecord) => `${JSON.stringify({ type: "decision", record: r })}\n`;
const outcomeLine = (id: string, correct: boolean, source?: string) =>
  `${JSON.stringify({ type: "outcome", id, outcome: { correct, truth: correct, at: "2026-11-12T12:00:00.000Z", ...(source ? { source } : {}) } })}\n`;
let k = 0;
const fresh = (text: string) => {
  const p = join(dir, `l${k++}.jsonl`);
  writeFileSync(p, text);
  return p;
};

try {
  await attack(
    "ledger",
    "T4-02",
    "a torn line mid-file is skipped and every later line is read",
    async () => {
      const p = fresh(
        `${line(rec("a"))}{"type":"decision","record":{"id":"torn"\n${line(rec("b"))}${outcomeLine("b", true)}`,
      );
      const l = new JsonlLedger(p);
      const rows = await l.all();
      return {
        held:
          rows.map((r) => r.id).join(",") === "a,b" &&
          rows[1]?.outcome?.correct === true &&
          l.skipped === 1,
        observed: `rows ${rows.map((r) => r.id).join(",")}; skipped ${l.skipped}; torn ${l.torn}`,
      };
    },
  );

  await attack("ledger", "T4-02", "CRLF line endings, a BOM, blank CRLF lines", async () => {
    const p = fresh(
      `﻿${line(rec("a")).replace("\n", "\r\n")}\r\n${line(rec("b")).replace("\n", "\r\n")}`,
    );
    const rows = await new JsonlLedger(p).all();
    return { held: rows.length === 2, observed: `rows ${rows.length}` };
  });

  await attack(
    "ledger",
    "T4-02",
    "a line that is valid JSON but an array, a number, null, a string",
    async () => {
      const p = fresh(`[1,2]\n42\nnull\n"x"\n${line(rec("a"))}`);
      const l = new JsonlLedger(p);
      const rows = await l.all();
      return {
        held: rows.length === 1 && l.skipped === 4,
        observed: `rows ${rows.length}, skipped ${l.skipped}`,
      };
    },
  );

  await attack(
    "ledger",
    "T4-02",
    "after a crash left a torn last line, the next append (this process) is not swallowed into it",
    async () => {
      const p = fresh(`${line(rec("a"))}{"type":"decision","record":{"id":"to`);
      const l = new JsonlLedger(p);
      await l.all();
      await l.append(rec("b"));
      const labelled = await l.label("b", {
        correct: true,
        truth: true,
        at: "2026-11-12T12:00:00.000Z",
      });
      const again = await new JsonlLedger(p).all();
      return {
        held: again.some((r) => r.id === "b") && labelled,
        observed: `label(b) ${labelled}; a fresh reader sees ${again.map((r) => r.id).join(",") || "nothing"}; file tail ${JSON.stringify(readFileSync(p, "utf8").slice(-60))}`,
      };
    },
  );

  await attack(
    "ledger",
    "T4-02",
    "after a torn last line, an engine ask is recorded and its label lands",
    async () => {
      const p = fresh(`${line(rec("a"))}{"type":"decision","record":{"id":"to`);
      const ledger = new JsonlLedger(p);
      const engine = new Engine({ oracle: fixed("s", 0.95), ledger });
      const gate = engine.gate({ id: "g", question: q, policy: { actAbove: 0.9 } });
      const r = await gate.ask("ls");
      const ok = await engine.label(r.recordId, {
        correct: true,
        truth: true,
        source: "review:blind:v1",
      });
      const fresh2 = await new JsonlLedger(p).all();
      const row = fresh2.find((x) => x.id === r.recordId);
      return {
        held: ok && row?.outcome?.correct === true,
        observed: `label returned ${ok}; fresh reader: row ${row ? "present" : "MISSING"}, outcome ${row?.outcome ? "present" : "missing"}; skipped ${new JsonlLedger(p).skipped}`,
      };
    },
  );

  await attack(
    "ledger",
    "T4-17",
    "a duplicate decision line after a labelled row keeps the first record and its label",
    async () => {
      const p = fresh(
        `${line(rec("a", { go: 0.95 }))}${outcomeLine("a", true, "review:blind:v1")}${line(rec("a", { go: 0.2 }))}`,
      );
      const l = new JsonlLedger(p);
      const rows = await l.all();
      return {
        held:
          rows.length === 1 &&
          rows[0]?.go === 0.95 &&
          rows[0]?.outcome?.correct === true &&
          l.duplicates === 1,
        observed: `rows ${rows.length}, go ${rows[0]?.go}, outcome ${rows[0]?.outcome?.correct}, duplicates ${l.duplicates}`,
      };
    },
  );

  await attack(
    "ledger",
    "T4-17",
    "a duplicate id appended by this process is reported, not indexed over the first",
    async () => {
      const p = fresh("");
      const l = new JsonlLedger(p);
      await l.append(rec("a", { go: 0.95 }));
      await l.label("a", { correct: true, at: "2026-11-12T12:00:00.000Z" });
      await l.append(rec("a", { go: 0.1 }));
      const rows = await l.all();
      const other = await new JsonlLedger(p).all();
      return {
        held:
          rows[0]?.go === 0.95 &&
          other[0]?.go === 0.95 &&
          rows[0]?.outcome !== undefined &&
          l.duplicates === 1,
        observed: `this process: go ${rows[0]?.go} dup ${l.duplicates}; fresh reader go ${other[0]?.go}`,
      };
    },
  );

  await attack("ledger", "T2-11", "labelling 2,000 rows one by one stays incremental", async () => {
    const p = fresh("");
    const l = new JsonlLedger(p);
    for (let i = 0; i < 2000; i++) await l.append(rec(`r${i}`));
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++)
      await l.label(`r${i}`, { correct: true, at: "2026-11-12T12:00:00.000Z" });
    const ms = performance.now() - t0;
    const rows = await new JsonlLedger(p).all();
    return {
      held: ms < 10_000 && rows.every((r) => r.outcome?.correct === true),
      observed: `${ms.toFixed(0)} ms for 2,000 labels; all labelled ${rows.every((r) => r.outcome?.correct === true)}`,
    };
  });

  await attack(
    "ledger",
    "T2-11",
    "two child processes append 150 large rows each while this process labels every row it sees",
    async () => {
      const p = fresh("");
      const labeller = new JsonlLedger(p);
      const child = (prefix: string) =>
        new Promise<number>((resolve) => {
          const c = spawn(
            process.execPath,
            [join(import.meta.dir, "appender.ts"), p, prefix, "150"],
            {
              stdio: "ignore",
            },
          );
          c.on("exit", (code) => resolve(code ?? -1));
        });
      const done = Promise.all([child("A"), child("B")]);
      let finished = false;
      void done.then(() => {
        finished = true;
      });
      const labelled = new Set<string>();
      let failures = 0;
      for (;;) {
        const last = finished;
        for (const r of await labeller.all()) {
          if (labelled.has(r.id)) continue;
          const ok = await labeller.label(r.id, {
            correct: true,
            truth: true,
            source: `review:blind:${r.id}`,
            at: "2026-11-12T12:00:00.000Z",
          });
          if (ok) labelled.add(r.id);
          else failures++;
        }
        if (last) break;
        await new Promise((r) => setTimeout(r, 2));
      }
      const codes = await done;
      const reader = new JsonlLedger(p);
      const rows = await reader.all();
      const wrong = rows.filter((r) => r.outcome?.source !== `review:blind:${r.id}`);
      const raw = readFileSync(p, "utf8")
        .split("\n")
        .filter((x) => x !== "");
      return {
        held:
          codes.every((c) => c === 0) &&
          rows.length === 300 &&
          labelled.size === 300 &&
          wrong.length === 0 &&
          failures === 0 &&
          reader.skipped === 0,
        observed: `exit ${codes.join(",")}; lines ${raw.length}; rows ${rows.length}; labelled ${labelled.size}; label failures ${failures}; misattached or missing labels ${wrong.length}; skipped ${reader.skipped}, torn ${reader.torn}`,
      };
    },
  );

  // Garbage numeric fields: rows that parse but whose numbers are not numbers.
  const garbage = fresh(
    [
      line(rec("a")),
      line(
        rec("b", {
          go: "0.99",
          confidence: null,
          verdict: { kind: "judge", questionId: "q", pYes: "0.99", confidence: null },
        }),
      ),
      outcomeLine("b", true, "review:blind:v1"),
      line(rec("c", { tags: "audit", at: 12345, latencyMs: "fast" })),
      outcomeLine("c", false, "review:blind:v1"),
    ].join(""),
  );
  for (const cmd of ["report", "check", "replay", "trail", "profile"]) {
    await attack(
      "ledger",
      "T4-02",
      `CLI ${cmd} on rows whose numeric fields are strings or null ends without an internal error`,
      async () => {
        const bin = join(import.meta.dir, "..", "..", "..", "..", "bin", "ratchet.ts");
        const extra: Record<string, string[]> = {
          report: [garbage],
          check: [garbage, "--gate", "g", "--promise", "0.9"],
          replay: [garbage, "--gate", "g", "--act-above", "0.5"],
          trail: [garbage],
          profile: ["build", garbage, "--model", "o", "--kind", "judge"],
        };
        const args = [bin, cmd, ...(extra[cmd] ?? [])];
        const res = await new Promise<{ code: number; err: string }>((resolve) => {
          const c = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"] });
          let err = "";
          c.stderr.on("data", (d) => {
            err += String(d);
          });
          c.on("exit", (code) => resolve({ code: code ?? -1, err }));
        });
        const crashed = /TypeError|RangeError|internal error|at .*\.ts:\d+/.test(res.err);
        return {
          held: !crashed && (res.code === 0 || res.code === 2 || res.code === 1),
          observed: `exit ${res.code}; stderr ${res.err.trim().split("\n").slice(-2).join(" / ").slice(0, 160)}`,
        };
      },
    );
  }

  await attack(
    "ledger",
    "T4-02",
    "engine readers (report, daily spend, rollout) on the same garbage rows",
    async () => {
      const ledger = new JsonlLedger(garbage);
      const out: string[] = [];
      try {
        const engine = new Engine({ oracle: fixed("s", 0.95), ledger, dailyBudgetUsd: 1 });
        const gate = engine.gate({
          id: "g",
          question: q,
          policy: { actAbove: 0.9 },
          promisedAccuracy: 0.9,
        });
        await engine.report();
        out.push("report ok");
        const r = await gate.ask("ls");
        out.push(`ask ok (${r.action})`);
        await gate.rollout.evaluate();
        out.push("rollout ok");
        return { held: true, observed: out.join("; ") };
      } catch (e) {
        return { held: false, observed: `${out.join("; ")}; threw ${describeError(e)}` };
      }
    },
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const broken = report("V1: JSONL ledger (T4-02, T2-11, T4-17)");
process.exitCode = broken > 0 ? 1 : 0;
