import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hook } from "../src/cli/hook.ts";
import { main } from "../src/cli/main.ts";
import { hookGateId } from "../src/hook/gate.ts";
import { hookPaths } from "../src/hook/journal.ts";
import { JsonlLedger } from "../src/ledger/ledger.ts";
import type { Decision, Oracle, Question } from "../src/types.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ratchet-hook-"));
  dirs.push(dir);
  return dir;
}

const fixed = (pYes: number): Oracle => ({
  id: "fixed",
  decide: async (_state: string, questions: readonly Question[]): Promise<Decision[]> =>
    questions.map((q) => ({
      verdict: { kind: "judge", questionId: q.id, pYes, confidence: Math.max(pYes, 1 - pYes) },
      oracle: "fixed",
      latencyMs: 0,
      cost: 0.00001,
      at: "2026-10-24T00:00:00.000Z",
    })),
});

const stdin = (o: unknown) => () => Promise.resolve(JSON.stringify(o));
let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 24, 13, 0, clock++)).toISOString();

const cwd = "C:\\work\\repo";
const promptInput = (command: string, session = "s1", turn = "p1") => ({
  session_id: session,
  prompt_id: turn,
  cwd,
  permission_mode: "default",
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command },
});
const ranInput = (command: string, session = "s1", turn = "p1") => ({
  session_id: session,
  prompt_id: turn,
  cwd,
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_use_id: `tu-${command}`,
  tool_input: { command },
  tool_response: { stdout: "never kept" },
});

async function feed(dir: string, harness: string, input: unknown): Promise<void> {
  const r = await hook([harness, "event", "--home", dir], { stdin: stdin(input), now });
  expect(r).toEqual({ exitCode: 0, output: "" });
}

describe("ratchet hook ... event", () => {
  it("appends one journal line per event and prints nothing", async () => {
    const dir = await home();
    await feed(dir, "claude-code", promptInput("git status"));
    await feed(dir, "claude-code", ranInput("git status"));
    const lines = (await readFile(hookPaths("claude-code", dir).events, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("never kept");
  });

  it("never fails the harness: bad or empty stdin exits 0 with no output", async () => {
    const dir = await home();
    expect(
      await hook(["codex", "event", "--home", dir], { stdin: () => Promise.resolve("{nope") }),
    ).toEqual({
      exitCode: 0,
      output: "",
    });
    expect(
      await hook(["codex", "event", "--home", dir], { stdin: () => Promise.resolve("") }),
    ).toEqual({
      exitCode: 0,
      output: "",
    });
    expect(
      await hook(["codex", "event", "--home", dir], {
        stdin: () => Promise.reject(new Error("stdin closed")),
      }),
    ).toEqual({ exitCode: 0, output: "" });
    const rejected = await readFile(join(hookPaths("codex", dir).dir, "rejected.log"), "utf8");
    expect(rejected).toContain("stdin is not JSON");
    await expect(stat(hookPaths("codex", dir).events)).rejects.toThrow();
  });

  it("is a usage error outside the hook path: unknown harness or verb, exit 2", async () => {
    expect((await main(["hook", "cursor", "event"])).exitCode).toBe(2);
    expect((await main(["hook", "codex", "dance"])).exitCode).toBe(2);
    expect((await main(["hook"])).exitCode).toBe(2);
    expect((await main(["help", "hook"])).output).toContain("Usage: ratchet hook");
  });
});

describe("ratchet hook ... install and status", () => {
  it("prints settings for each harness that name the event command", async () => {
    const dir = await home();
    for (const harness of ["claude-code", "codex"] as const) {
      const r = await hook([harness, "install", "--home", dir]);
      expect(r.exitCode).toBe(0);
      expect(r.output).toContain(`ratchet hook ${harness} event`);
      expect(r.output).toContain("PermissionRequest");
      expect(r.output).toContain("SessionEnd");
      const json = r.output.slice(r.output.indexOf("{"), r.output.lastIndexOf("}") + 1);
      expect(() => JSON.parse(json.replace(/^ {3}/gm, ""))).not.toThrow();
    }
  });

  it("counts prompts by how they resolved", async () => {
    const dir = await home();
    await feed(dir, "claude-code", promptInput("git status"));
    await feed(dir, "claude-code", ranInput("git status"));
    await feed(dir, "claude-code", promptInput("rm -rf dist"));
    await feed(dir, "claude-code", ranInput("ls", "s1", "p1"));
    await feed(dir, "claude-code", promptInput("bun test", "s1", "p2"));
    const r = await hook(["claude-code", "status", "--home", dir]);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("| 3 | 1 | 1 | 1 | 0 | 1 |");
    expect(r.output).toContain("Prompts by tool: Bash 3.");
  });
});

describe("ratchet hook ... replay", () => {
  it("dry run shows the earliest settled prompt's exact state and writes nothing", async () => {
    const dir = await home();
    await feed(dir, "claude-code", promptInput("git status"));
    await feed(dir, "claude-code", ranInput("git status"));
    const r = await hook(["claude-code", "replay", "--home", dir]);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("[untrusted command]");
    expect(r.output).toContain("git status");
    expect(r.output).toContain("Nothing was sent or written");
    await expect(stat(hookPaths("claude-code", dir).ledger)).rejects.toThrow();
  });

  it("live: asks once per settled prompt, labels with the person's answer, and is idempotent", async () => {
    const dir = await home();
    await feed(dir, "claude-code", promptInput("git status"));
    await feed(dir, "claude-code", ranInput("git status"));
    await feed(dir, "claude-code", promptInput("bun test", "s1", "p2")); // settles the next one
    await feed(dir, "claude-code", {
      session_id: "s1",
      hook_event_name: "SessionEnd",
      reason: "exit",
    });
    await feed(dir, "claude-code", promptInput("ls", "s2")); // still open
    const first = await hook(["claude-code", "replay", "--home", dir, "--live"], {
      oracle: fixed(0.9),
    });
    expect(first.exitCode).toBe(0);
    expect(first.output).toContain("Asked 2; 0 already in the ledger; 1 still open");
    const rows = await new JsonlLedger(hookPaths("claude-code", dir).ledger).all();
    expect(rows).toHaveLength(2);
    expect(
      rows.every((row) => row.gateId === hookGateId("claude-code") && row.mode === "shadow"),
    ).toBe(true);
    const byTruth = rows.map((row) => [
      row.outcome?.truth,
      row.outcome?.correct,
      row.outcome?.source,
    ]);
    expect(byTruth).toEqual([
      [true, true, "claude-code:person"],
      [false, false, "claude-code:person"],
    ]);
    expect(rows[1]?.outcome?.note).toContain("denied: no run before session-end");
    expect(rows.every((row) => row.tags.some((t) => t.startsWith("hook:prompt:")))).toBe(true);
    expect(rows.every((row) => row.tags.includes("session:claude-code:s1"))).toBe(true);
    // The label never reaches the state.
    expect(rows.every((row) => !/allowed|denied|approved/.test(row.state ?? ""))).toBe(true);

    const second = await hook(["claude-code", "replay", "--home", dir, "--live"], {
      oracle: fixed(0.9),
    });
    expect(second.output).toContain("Asked 0; 2 already in the ledger; 1 still open");
    expect(await new JsonlLedger(hookPaths("claude-code", dir).ledger).all()).toHaveLength(2);
  });

  it("live without an oracle or a key is a usage error", async () => {
    const dir = await home();
    const saved = { t: process.env.TYPESAFE_API_KEY, o: process.env.OPENROUTER_API_KEY };
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const r = await hook(["codex", "replay", "--home", dir, "--live"]);
      expect(r.exitCode).toBe(2);
      expect(r.output).toContain("TYPESAFE_API_KEY or OPENROUTER_API_KEY");
    } finally {
      if (saved.t !== undefined) process.env.TYPESAFE_API_KEY = saved.t;
      if (saved.o !== undefined) process.env.OPENROUTER_API_KEY = saved.o;
    }
  });

  it("rejects a budget outside (0, 1]", async () => {
    const dir = await home();
    expect((await hook(["codex", "replay", "--home", dir, "--budget", "2"])).exitCode).toBe(2);
    expect((await hook(["codex", "replay", "--home", dir, "--budget", "0"])).exitCode).toBe(2);
  });
});
