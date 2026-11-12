/**
 * Wave 3 fixes to package D's hook, from verifier V3's attack (experiments/e2e/verify/v3-hook).
 * Item 1: `harness_owned` is an allowlist (scratch space, notes) and configuration always wins,
 * matched on the resolved, normalised path. Item 6: the event command never drops an event to
 * deep nesting or a BOM, and its canonical hash is unchanged for ordinary input.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hook } from "../src/cli/hook.ts";
import { floorFor } from "../src/floors.ts";
import {
  type HookContext,
  type HookEvent,
  hashInput,
  hookContext,
  JOURNAL_SCHEMA,
  parseHookInput,
} from "../src/hook/event.ts";
import { hookFloors, hookQuestion } from "../src/hook/gate.ts";
import { hookPaths } from "../src/hook/journal.ts";
import { promptState } from "../src/hook/state.ts";
import { placePath } from "../src/hook/subject.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const ctx: HookContext = hookContext(
  "claude-code",
  { CLAUDE_PROJECT_DIR: "C:\\src\\proj" },
  { home: "C:\\Users\\dev", tmp: "C:\\Users\\dev\\AppData\\Local\\Temp" },
);
const floor = (state: string) => floorFor([...hookFloors], state, hookQuestion);

function write(file_path: string, cwd = "C:\\src\\proj") {
  const parsed = parseHookInput(
    JSON.stringify({
      hook_event_name: "PermissionRequest",
      session_id: "s",
      cwd,
      tool_name: "Write",
      tool_input: { file_path, content: "x" },
    }),
    "claude-code",
    () => "2026-11-12T00:00:00.000Z",
    ctx,
  );
  if ("reason" in parsed) throw new Error(parsed.reason);
  return { event: parsed.event, floor: floor(promptState(parsed.event).text) };
}

describe("item 1: harness-owned is an allowlist, and configuration wins", () => {
  it.each([
    "C:\\Users\\dev\\.claude\\plugins\\marketplaces\\m\\plugins\\p\\hooks\\hooks.json",
    "C:\\Users\\dev\\.claude\\skills\\x\\run.ps1",
    "C:\\Users\\dev\\.claude\\CLAUDE.md",
    "C:\\Users\\dev\\.claude\\agents\\helper.md",
    "C:\\Users\\dev\\.claude\\commands\\deploy.md",
    "C:\\Users\\dev\\.claude\\projects\\p\\transcript.jsonl",
    "C:\\Users\\dev\\.codex\\rules\\default.rules",
    "C:\\Users\\dev\\.codex\\AGENTS.md",
    "C:\\Users\\dev\\.codex\\prompts\\review.md",
  ])("reviews %s as harness configuration (v1 reviewed it as outside)", (path) => {
    const { event, floor: f } = write(path);
    expect(event.subject).toMatchObject({ harnessOwned: false, harnessConfig: true });
    expect(f).toBe("review");
  });

  it.each([
    "C:\\Users\\dev\\AppData\\Local\\Temp\\claude\\p\\s\\scratchpad\\a.py",
    "C:\\Users\\dev\\.claude\\projects\\C--src-proj\\memory\\MEMORY.md",
    "~/.claude/projects/p/memory/notes.md",
  ])("still lets %s through: scratch space and notes", (path) => {
    const { event, floor: f } = write(path);
    expect(event.subject).toMatchObject({ harnessOwned: true, harnessConfig: false });
    expect(f).toBe("act");
  });

  it.each([
    ["C:\\Users\\dev\\.claude\\.\\settings.json"],
    ["C:\\Users\\dev\\.claude\\x\\..\\settings.json"],
    ["C:\\Users\\dev\\.claude\\\\settings.json"],
    ["C:\\Users\\dev\\.claude\\settings.json."],
    ["C:\\Users\\dev\\.claude\\settings.json "],
    ["C:\\Users\\dev\\.claude\\settings.json::$DATA"],
    ["C:\\Users\\dev\\.claude\\SETTINGS.JSON"],
    ["\\\\?\\C:\\Users\\dev\\.claude\\settings.json"],
    ["settings.json", "C:\\Users\\dev\\.claude"],
    ["..\\.claude\\settings.json", "C:\\Users\\dev\\Documents"],
    ["C:\\src\\proj\\.claude\\x\\..\\settings.local.json"],
    ["C:\\src\\proj\\.claude\\settings.local.json::$DATA"],
    ["C:\\src\\proj\\.mcp.json"],
    ["C:\\src\\proj\\sub\\..\\.mcp.json."],
  ] as const)("finds the settings file in %j", (path, cwd?: string) => {
    const { event, floor: f } = write(path, cwd);
    expect(event.subject).toMatchObject({ harnessConfig: true, harnessOwned: false });
    expect(f).toBe("review");
  });

  it("leaves ordinary project files alone", () => {
    for (const p of ["C:\\src\\proj\\settings.json", "C:\\src\\proj\\docs\\mcp.json"]) {
      const { event, floor: f } = write(p);
      expect(event.subject).toMatchObject({ harnessConfig: false, insideWorkspace: true });
      expect(f).toBe("act");
    }
  });

  it("a scratch path that climbs out is not owned", () => {
    const { event, floor: f } = write("C:\\Users\\dev\\AppData\\Local\\Temp\\claude\\..\\evil.ps1");
    expect(event.subject).toMatchObject({ harnessOwned: false, insideWorkspace: false });
    expect(f).toBe("review");
  });

  it("placePath on POSIX: notes owned, everything else under the home is configuration", () => {
    const at = { cwd: "/w", home: "/home/me", harnessHomes: ["/home/me/.claude"] };
    expect(placePath("/home/me/.claude/projects/x/memory/a.md", at)).toMatchObject({
      harnessOwned: true,
      harnessConfig: false,
    });
    expect(placePath("/home/me/.claude/projects/x/a.md", at)).toMatchObject({
      harnessOwned: false,
      harnessConfig: true,
    });
    expect(placePath("/home/me/.claude/./hooks/../settings.json", at).harnessConfig).toBe(true);
    expect(placePath("/w/src/a.ts", at)).toMatchObject({
      insideWorkspace: true,
      harnessOwned: false,
      harnessConfig: false,
    });
  });

  it("re-places a subject journalled under the faulty wave-2 rule at replay", () => {
    // What wave 2 journalled for the global CLAUDE.md: harness-owned, not configuration.
    const legacy: HookEvent = {
      schema: JOURNAL_SCHEMA,
      id: "p1",
      harness: "claude-code",
      kind: "prompt",
      at: "2026-11-12T00:00:00.000Z",
      session: "s",
      cwd: "C:\\src\\proj",
      projectDir: "C:\\src\\proj",
      tool: "Write",
      inputHash: "h",
      subject: {
        kind: "path",
        path: "C:\\Users\\dev\\.claude\\CLAUDE.md",
        insideWorkspace: false,
        harnessOwned: true,
        harnessConfig: false,
        readOnly: false,
        destructive: false,
        change: { kind: "write", lines: 1 },
        redacted: false,
      },
    };
    // Round 2: `.claude/CLAUDE.md` is configuration by its shape, so even without a placement.
    expect(floor(promptState(legacy).text)).toBe("review");
    const { home, harnessHomes, harnessScratch } = ctx;
    const placement = {
      ...(home === undefined ? {} : { home }),
      ...(harnessHomes === undefined ? {} : { harnessHomes }),
      ...(harnessScratch === undefined ? {} : { harnessScratch }),
    };
    const state = promptState(legacy, { placement }).text;
    expect(state).toMatch(/^harness_owned: false$/m);
    expect(state).toMatch(/^harness_config: true$/m);
    expect(floor(state)).toBe("review");
  });

  it("a journalled settings path is configuration by its shape even without a placement", () => {
    const legacy: HookEvent = {
      schema: JOURNAL_SCHEMA,
      id: "p2",
      harness: "claude-code",
      kind: "prompt",
      at: "2026-11-12T00:00:00.000Z",
      session: "s",
      cwd: "C:\\src\\proj",
      tool: "Write",
      inputHash: "h",
      subject: {
        kind: "path",
        path: "C:\\src\\proj\\.mcp.json",
        insideWorkspace: true,
        harnessOwned: false,
        harnessConfig: false,
        readOnly: false,
        destructive: false,
        redacted: false,
      },
    };
    const state = promptState(legacy).text;
    expect(state).toMatch(/^harness_config: true$/m);
    expect(floor(state)).toBe("review");
  });
});

/** The recursive canonical form wave 2 shipped: the iterative one must produce the same text. */
function recursive(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(recursive).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${recursive(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

describe("item 6: the event command never drops an event", () => {
  it("hashes ordinary input exactly as before, so old prompts still match their runs", async () => {
    const { createHash } = await import("node:crypto");
    const old = (v: unknown) =>
      createHash("sha256").update(recursive(v)).digest("hex").slice(0, 16);
    for (const input of [
      { command: "git status", description: "x" },
      { b: [1, "two", { z: null, a: [true, false] }], a: { "": 0, é: "ü" } },
      { file_path: "C:\\x\\a.ts", edits: [{ old_string: "a", new_string: "b" }], n: -1.5e-7 },
      [],
      {},
    ]) {
      expect(hashInput(input)).toBe(old(input));
    }
  });

  it("journals a run whose input is nested 100,000 deep, and a BOM-prefixed event", async () => {
    const home = await mkdtemp(join(tmpdir(), "ratchet-d-wave3-"));
    dirs.push(home);
    const n = 100_000;
    const deep = `{"hook_event_name":"PostToolUse","session_id":"s","tool_name":"mcp__x","tool_use_id":"t","tool_input":{"a":${"[".repeat(n)}${"]".repeat(n)}}}`;
    const bom = `\uFEFF${JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s" })}`;
    for (const stdin of [deep, bom]) {
      const r = await hook(["claude-code", "event", "--home", home], {
        stdin: async () => stdin,
        context: {},
      });
      expect(r).toEqual({ exitCode: 0, output: "" });
    }
    const journal = (await readFile(hookPaths("claude-code", home).events, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as HookEvent);
    expect(journal.map((e) => e.kind)).toEqual(["ran", "session-end"]);
    expect(journal[0]?.inputHash).toMatch(/^[0-9a-f]{16}$/);
  });
});
