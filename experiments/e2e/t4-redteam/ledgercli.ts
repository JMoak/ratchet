/**
 * Attack 5: ledger and CLI robustness. A clean JSONL ledger is mutated into the shapes real
 * files take (a torn last line after a crash, CRLF, a BOM from an editor, a huge state, emoji,
 * duplicate ids, labels for unknown ids, an outcome before its decision, non-object lines,
 * corrupt fields, two writers at once) and every read path is run on each: the CLI commands
 * (`check` is meant for CI, so its exit code is the contract), and the engine's own readers
 * (label, daily budget, rollout, report). Then the hook's `event` command gets hostile stdin
 * under a scratch `--home`; the installed hook and real journal are never touched.
 */
import { spawn } from "node:child_process";
import { appendFileSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hook } from "../../../src/cli/hook.ts";
import { main as cli } from "../../../src/cli/main.ts";
import {
  Engine,
  JsonlLedger,
  judge,
  type Oracle,
  parseJsonlLedger,
  scrub,
} from "../../../src/index.ts";
import { ROOT } from "../lib.ts";
import { attempt, type Findings, scratch, table } from "./common.ts";

const model = "fixed-1";
const oracle = (pYes: (s: string) => number): Oracle => ({
  id: "fixed",
  decide: async (s, qs) =>
    qs.map((q) => {
      const p = pYes(s);
      return {
        verdict: { kind: "judge", questionId: q.id, pYes: p, confidence: Math.max(p, 1 - p) },
        oracle: "fixed",
        model,
        latencyMs: 1,
        cost: 0.00003,
        at: new Date().toISOString(),
      };
    }),
});

/** 60 shadow rows of gate "g", every one labelled by a blind reviewer. */
async function baseLedger(path: string, gateId = "g", stateOf = (i: number) => `state ${i}`) {
  writeFileSync(path, "");
  const e = new Engine({
    oracle: oracle((s) => (Number(/\d+/.exec(s)?.[0] ?? 0) % 3 === 0 ? 0.2 : 0.97)),
    ledger: new JsonlLedger(path),
    keepState: true,
  });
  const g = e.gate({
    id: gateId,
    question: judge("Is this safe?", { id: "safe" }),
    policy: { actAbove: 0.9 },
  });
  for (let i = 0; i < 60; i++) {
    const r = await g.ask(stateOf(i));
    const truth = i % 3 !== 0;
    // Half reviewed blind, half labelled in the moment, so `review` has rows left to draw.
    const source = i % 2 === 0 ? "review:blind:t4" : "claude-code:person";
    await e.label(r.recordId, { correct: true, truth, source });
  }
}

interface CmdResult {
  readonly exit: number;
  readonly first: string;
}

async function runAll(path: string, gate = "g"): Promise<Record<string, CmdResult>> {
  const out: Record<string, CmdResult> = {};
  const first = (s: string) => (s.split("\n").find((l) => l.trim() !== "") ?? "").slice(0, 90);
  const cmds: [string, string[]][] = [
    ["report", ["report", path]],
    ["check", ["check", path, "--gate", gate, "--promise", "0.9"]],
    ["replay", ["replay", path, "--gate", gate, "--act-above", "0.9"]],
    ["trail", ["trail", path, "--gate", gate, "--last", "3"]],
    [
      "profile",
      [
        "profile",
        "build",
        path,
        "--model",
        model,
        "--kind",
        "judge",
        "--out",
        `${path}.profile.json`,
      ],
    ],
  ];
  for (const [name, argv] of cmds) {
    const r = await cli(argv);
    out[name] = { exit: r.exitCode, first: first(r.output) };
  }
  const copy = `${path}.review.jsonl`;
  copyFileSync(path, copy);
  const rv = await cli(["review", copy, "--gate", gate, "--sample", "2", "--seed", "1"], {
    print: () => {},
    ask: async () => "q",
  });
  out.review = { exit: rv.exitCode, first: first(rv.output) };
  return out;
}

async function engineReaders(path: string): Promise<Record<string, string>> {
  const res: Record<string, string> = {};
  const ledger = new JsonlLedger(path);
  const all = await attempt(() => ledger.all());
  res.all = all.ok ? `${all.value.length} rows` : `threw: ${all.error.slice(0, 50)}`;
  const e = new Engine({ oracle: oracle(() => 0.3), ledger, dailyBudgetUsd: 1 });
  const g = e.gate({
    id: "g",
    question: judge("Is this safe?", { id: "safe" }),
    policy: { actAbove: 0.9 },
    evidenceVersion: "v1",
    promisedAccuracy: 0.9,
  });
  const ask = await attempt(() => g.ask("new state"));
  res.askDaily = ask.ok ? `ok (${ask.value.action})` : `threw: ${ask.error.slice(0, 50)}`;
  const lab = await attempt(() => e.label("does-not-matter", { correct: true }));
  res.label = lab.ok ? `ok (${lab.value})` : `threw: ${lab.error.slice(0, 50)}`;
  const rep = await attempt(() => e.report());
  res.report = rep.ok ? `ok (${rep.value.records} records)` : `threw: ${rep.error.slice(0, 50)}`;
  const ro = await attempt(() => g.rollout.evaluate());
  res.rollout = ro.ok ? `ok (${ro.value.mode})` : `threw: ${ro.error.slice(0, 50)}`;
  return res;
}

function runWorker(path: string, tag: string, n: number, chars: number): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(
      process.execPath,
      [
        join(ROOT, "experiments/e2e/t4-redteam/workers/append.ts"),
        path,
        tag,
        String(n),
        String(chars),
      ],
      { stdio: "ignore", cwd: ROOT },
    );
    p.on("exit", (code) => resolve(code ?? 1));
  });
}

export async function runLedgerCliAttacks(findings: Findings): Promise<string> {
  const out: string[] = [];
  const dir = scratch("ledger");
  const clean = join(dir, "clean.jsonl");
  await baseLedger(clean);
  const text = readFileSync(clean, "utf8");
  const lines = text.trimEnd().split("\n");

  const variants: [string, () => string][] = [
    ["clean", () => text],
    ["torn last line (crash mid-append)", () => `${text}${lines[1]?.slice(0, 80) ?? ""}`],
    ["CRLF line endings", () => text.replace(/\n/g, "\r\n")],
    ["UTF-8 BOM at start", () => `\uFEFF${text}`],
    ["a `null` line", () => `${text}null\n`],
    ["a `42` line", () => `${text}42\n`],
    ['a `{"type":"decision"}` line with no record', () => `${text}{"type":"decision"}\n`],
    [
      "outcome for an unknown id",
      () =>
        `${text}${JSON.stringify({ type: "outcome", id: "ghost", outcome: { at: "x", correct: true } })}\n`,
    ],
    [
      "duplicate decision id (second copy, unlabelled)",
      () => {
        const first = JSON.parse(lines[0] as string) as { record: Record<string, unknown> };
        return `${text}${JSON.stringify({ type: "decision", record: { ...first.record, verdict: { kind: "judge", questionId: "safe", pYes: 0.99, confidence: 0.99 } } })}\n`;
      },
    ],
    [
      "row with verdict missing",
      () => {
        const first = JSON.parse(lines[0] as string) as { record: Record<string, unknown> };
        const { verdict: _v, ...rest } = first.record;
        return `${text}${JSON.stringify({ type: "decision", record: { ...rest, id: "noverdict" } })}\n`;
      },
    ],
    [
      "row with cost and go as strings",
      () => {
        const first = JSON.parse(lines[0] as string) as { record: Record<string, unknown> };
        return `${text}${JSON.stringify({ type: "decision", record: { ...first.record, id: "strings", cost: "0.5", go: "0.99", confidence: "high" } })}\n`;
      },
    ],
    ["empty file", () => ""],
  ];
  const rows: string[][] = [];
  const engineRows: string[][] = [];
  for (const [name, make] of variants) {
    const path = join(dir, `${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.jsonl`);
    writeFileSync(path, make());
    const r = await runAll(path);
    rows.push([
      name,
      ...["report", "check", "replay", "trail", "review", "profile"].map((c) => String(r[c]?.exit)),
    ]);
    const er = await engineReaders(path);
    engineRows.push([
      name,
      er.all ?? "",
      er.askDaily ?? "",
      er.label ?? "",
      er.report ?? "",
      er.rollout ?? "",
    ]);
    if (name === "clean") {
      findings.check(
        "cli",
        "every command on a clean ledger",
        Object.values(r).every((x) => x.exit === 0),
        JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.exit]))),
        "exit 0",
      );
    }
    if (name.startsWith("torn")) {
      findings.check(
        "ledger",
        "torn final line (a crash mid-append): engine readers",
        !er.askDaily?.startsWith("threw") && !er.label?.startsWith("threw"),
        `ask with dailyBudgetUsd: ${er.askDaily}; label: ${er.label}; rollout: ${er.rollout}`,
        "a torn last line is skipped (or the engine fails open), not every later ask and label throwing",
        "T4-02",
      );
      findings.check(
        "cli",
        "torn final line: CLI exit codes",
        Object.values(r).every((x) => x.exit !== 1),
        JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.exit]))),
        "never 1 (a broken promise to CI): since wave 2 the torn line is ignored and named on stderr (exit 0), or the ledger is unreadable (exit 2)",
      );
    }
    if (name.startsWith("UTF-8 BOM")) {
      findings.check(
        "ledger",
        "ledger saved with a BOM by an editor",
        r.report?.exit === 0,
        `report exit ${r.report?.exit}: ${r.report?.first}`,
        "read (BOM stripped)",
        "T4-02",
      );
    }
    if (name.startsWith("CRLF")) {
      findings.check(
        "ledger",
        "CRLF ledger",
        Object.values(r).every((x) => x.exit === 0),
        JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.exit]))),
        "exit 0",
      );
    }
    if (name.startsWith("duplicate")) {
      const parsed = parseJsonlLedger(make());
      const dup = parsed.find(
        (x) => x.id === (JSON.parse(lines[0] as string) as { record: { id: string } }).record.id,
      );
      findings.check(
        "ledger",
        "a second decision line reusing a labelled row's id",
        dup?.outcome !== undefined,
        `the row now reads pYes ${(dup?.verdict as { pYes: number } | undefined)?.pYes} with ${dup?.outcome ? "its label" : "no label (label dropped)"}`,
        "duplicate ids are refused or reported, not silently overwriting a labelled row",
        "T4-17",
      );
    }
  }
  out.push(
    "### CLI exit codes per ledger shape (0 ok, 1 check failed, 2 unreadable)",
    "",
    table(["ledger", "report", "check", "replay", "trail", "review", "profile"], rows),
    "",
    "### Engine readers per ledger shape",
    "",
    table(
      [
        "ledger",
        "JsonlLedger.all",
        "gate.ask (dailyBudgetUsd)",
        "engine.label",
        "engine.report",
        "rollout.evaluate",
      ],
      engineRows,
    ),
    "",
  );

  // Huge state and unicode.
  {
    const huge = join(dir, "huge.jsonl");
    await baseLedger(huge, "g", (i) =>
      i === 7 ? `state ${i}\n${"x".repeat(2_000_000)}` : `state ${i}`,
    );
    const t0 = performance.now();
    const r = await runAll(huge);
    const ms = performance.now() - t0;
    const uni = join(dir, "unicode.jsonl");
    await baseLedger(
      uni,
      "gate-🚀-מבחן",
      (i) => `état ${i} 🧨 \u202Erm -rf\u202C 你好 ${"👩‍👩‍👧".repeat(3)}`,
    );
    const ru = await runAll(uni, "gate-🚀-מבחן");
    findings.check(
      "cli",
      "ledger with one 2 MB state",
      Object.values(r).every((x) => x.exit === 0),
      `${JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.exit])))} in ${ms.toFixed(0)} ms`,
      "exit 0",
    );
    findings.check(
      "cli",
      "emoji / RTL override / CJK in gate ids and states",
      Object.values(ru).every((x) => x.exit === 0),
      JSON.stringify(Object.fromEntries(Object.entries(ru).map(([k, v]) => [k, v.exit]))),
      "exit 0",
    );
  }

  // __proto__ as a gate id.
  {
    const p = join(dir, "proto.jsonl");
    await baseLedger(p, "__proto__");
    const e = new Engine({ oracle: oracle(() => 0.3), ledger: new JsonlLedger(p) });
    const rep = await e.report();
    const listed = Object.keys(rep.byGate);
    const cliRep = await cli(["report", p, "--json"]);
    findings.check(
      "ledger",
      "a gate (or relevance item) id of `__proto__`",
      listed.includes("__proto__"),
      `Engine.report().byGate keys: [${listed.join(", ")}]; CLI report exit ${cliRep.exitCode}, mentions it: ${cliRep.output.includes("__proto__")}`,
      "the gate is reported like any other",
      "T4-18",
    );
  }

  // Rubric and policy change: does `check` (CI) still pass on the old rubric's labels?
  {
    const p = join(dir, "rubric-change.jsonl");
    writeFileSync(p, "");
    const ledger = new JsonlLedger(p);
    const e = new Engine({ oracle: oracle(() => 0.97), ledger, keepState: true });
    const a = e.gate({
      id: "g",
      question: judge("Is this command safe to run without asking?", { id: "safe" }),
      policy: { actAbove: 0.9 },
      evidenceVersion: "v1",
    });
    for (let i = 0; i < 40; i++) {
      const r = await a.ask(`old ${i}`);
      await e.label(r.recordId, { correct: true, truth: true, source: "review:blind:t4" });
    }
    // Same gate id, new rubric, a far looser policy, a new evidence version, no labels yet.
    const e2 = new Engine({ oracle: oracle(() => 0.15), ledger, keepState: true });
    const b = e2.gate({
      id: "g",
      question: judge("Would the user probably not mind this?", { id: "safe" }),
      policy: { actAbove: 0.1 },
      evidenceVersion: "v2",
    });
    for (let i = 0; i < 10; i++) await b.ask(`new ${i}`);
    const chk = await cli(["check", p, "--gate", "g", "--promise", "0.9"]);
    const grade = (await b.report()).grade;
    findings.check(
      "evidence",
      "rubric, policy and evidenceVersion all changed; 0 labels on the new configuration",
      chk.exitCode !== 0,
      `ratchet check exit ${chk.exitCode}: ${chk.output.split("\n")[0]?.slice(0, 110)}; gate.report() grade ${grade.kind}`,
      "check fails or grades none: the new rubric has no evidence (Rollout resets; report and check should too)",
      "T4-20",
    );
  }

  // Two writers at once.
  {
    const path = join(dir, "concurrent.jsonl");
    writeFileSync(path, "");
    const codes = await Promise.all([
      runWorker(path, "A", 300, 20_000),
      runWorker(path, "B", 300, 20_000),
    ]);
    const raw = readFileSync(path, "utf8");
    const ls = raw.split("\n").filter((l) => l.trim() !== "");
    let bad = 0;
    for (const l of ls) {
      try {
        JSON.parse(l);
      } catch {
        bad++;
      }
    }
    findings.check(
      "ledger",
      "two processes appending 300 rows each with 20 KB states to one ledger",
      bad === 0 && ls.length === 600,
      `exit codes ${codes.join(",")}; ${ls.length} lines, ${bad} unparseable`,
      "600 whole lines",
    );
    out.push(`Two writers: ${ls.length} lines, ${bad} interleaved or torn.`, "");
  }

  // Hook: hostile stdin under a scratch home.
  {
    const home = scratch("hookhome");
    const deep = `{"hook_event_name":"PermissionRequest","session_id":"s","tool_name":"Bash","tool_input":${"[".repeat(200_000)}${"]".repeat(200_000)}}`;
    const payloads: [string, string][] = [
      ["empty", ""],
      ["not JSON", "rm -rf /"],
      ["array", "[]"],
      ["null", "null"],
      [
        "BOM + valid event",
        `\uFEFF${JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s" })}`,
      ],
      [
        "hook_event_name __proto__",
        JSON.stringify({
          hook_event_name: "__proto__",
          session_id: "s",
          tool_name: "Bash",
          tool_input: {},
        }),
      ],
      [
        "hook_event_name toString",
        JSON.stringify({
          hook_event_name: "toString",
          session_id: "s",
          tool_name: "Bash",
          tool_input: {},
        }),
      ],
      ["200k-deep tool_input", deep],
      [
        "20 MB command",
        JSON.stringify({
          hook_event_name: "PermissionRequest",
          session_id: "s",
          tool_name: "Bash",
          tool_input: { command: "a".repeat(20_000_000) },
        }),
      ],
      [
        "NUL and lone surrogate",
        JSON.stringify({
          hook_event_name: "PermissionRequest",
          session_id: "s\u0000",
          tool_name: "Bash",
          tool_input: { command: "echo \ud800 \u0000" },
        }),
      ],
    ];
    const hookRows: string[][] = [];
    let loud = 0;
    for (const [name, stdin] of payloads) {
      const r = await hook(["claude-code", "event", "--home", home], { stdin: async () => stdin });
      if (r.exitCode !== 0 || r.output !== "") loud++;
      hookRows.push([name, String(r.exitCode), JSON.stringify(r.output.slice(0, 30))]);
    }
    const status = await hook(["claude-code", "status", "--home", home]);
    const journal = readFileSync(join(home, "hooks", "claude-code", "events.jsonl"), "utf8");
    const protoJournaled = journal
      .split("\n")
      .some((l) => l.includes('"session":"s"') && !l.includes('"kind":"'));
    findings.check(
      "hook",
      `${payloads.length} hostile stdin payloads to \`hook event\``,
      loud === 0,
      `${loud} produced output or a non-zero exit`,
      "exit 0, no stdout, always",
    );
    findings.check(
      "hook",
      "hook_event_name 'toString' / '__proto__' (prototype keys)",
      !protoJournaled,
      protoJournaled ? "journaled as an event with no kind (read back as rejected)" : "rejected",
      "rejected as an unsupported event",
      "T4-18",
    );
    out.push(
      "### Hook `event` with hostile stdin (scratch --home)",
      "",
      table(["stdin", "exit", "stdout"], hookRows),
      "",
      `status after: exit ${status.exitCode}; ${status.output.split("\n").find((l) => l.includes("events across")) ?? ""}`,
      "",
    );

    // Secrets in commands: what the scrubber leaves in the subject that leaves the machine.
    const secrets: [string, string, string][] = [
      ["curl -u", "curl -u admin:hunter2pass https://api.example.com/v1", "hunter2pass"],
      [
        "URL userinfo",
        "psql postgres://app:S3cretPassw0rd@db.internal:5432/prod",
        "S3cretPassw0rd",
      ],
      ["mysql -p", "mysql -u root -pS3cretPassw0rd prod", "S3cretPassw0rd"],
      [
        "--password value",
        "docker login -u me --password hunter2hunter2 registry.example.com",
        "hunter2hunter2",
      ],
      ["--token value", "gh auth login --token abcdef1234567890", "abcdef1234567890"],
      [
        "env assignment",
        "export OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef0123456789abcdef",
        "0123456789abcdef0123456789abcdef",
      ],
      [
        "bearer header",
        'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"',
        "eyJzdWIiOiIxIn0",
      ],
      [
        "AWS secret via CLI",
        "aws configure set aws_secret_access_key wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
        "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
      ],
      [
        "GitHub token in URL",
        "git clone https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r",
        "ghs_abcdefghijklmnopqrstuvwxyz0123",
      ],
      [
        "Stripe live key",
        "stripe login --api-key rk_live_abcdefghijklmnop1234",
        "rk_live_abcdefghijklmnop1234",
      ],
      ["PGPASSWORD env", "PGPASSWORD=Tr0ub4dor psql -h db prod", "Tr0ub4dor"],
    ];
    const secretRows: string[][] = [];
    let survived = 0;
    for (const [name, cmd, secret] of secrets) {
      const s = scrub(cmd);
      const leaks = s.text.includes(secret);
      if (leaks) survived++;
      secretRows.push([name, leaks ? "LEAKS" : "redacted", s.text.slice(0, 80)]);
    }
    findings.check(
      "hook",
      `${secrets.length} common secret shapes in a Bash command (scrub, best effort by its own docs)`,
      survived === 0,
      `${survived} survive into the subject sent to the model on \`replay --live\``,
      "the shapes secrets usually take are removed",
      "T4-19",
    );
    out.push(
      "### Hook subject scrubbing",
      "",
      table(["shape", "result", "scrubbed text"], secretRows),
      "",
    );
    void appendFileSync;
  }
  return out.join("\n");
}
