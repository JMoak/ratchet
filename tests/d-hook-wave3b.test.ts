/**
 * Wave 3, round 2 fixes to package D's hook, from verifier V3's second attack
 * (experiments/e2e/verify/v3-hook/attack2.ts). A: a project's harness extension points and
 * settings are configuration on the path side, as on the command side. C: the Read tool and a
 * command agree on credential files. D: replay never lowers a journalled `harness_config`.
 * H: a note's alternate data stream is not harness-owned.
 */
import { describe, expect, it } from "vitest";
import { floorFor } from "../src/floors.ts";
import {
  type HookContext,
  type HookEvent,
  hookContext,
  JOURNAL_SCHEMA,
  parseHookInput,
} from "../src/hook/event.ts";
import { hookFloors, hookQuestion } from "../src/hook/gate.ts";
import { promptState } from "../src/hook/state.ts";
import { placePath, subjectOf } from "../src/hook/subject.ts";

const ctx: HookContext = hookContext(
  "claude-code",
  { CLAUDE_PROJECT_DIR: "C:\\src\\proj" },
  { home: "C:\\Users\\dev", tmp: "C:\\Users\\dev\\AppData\\Local\\Temp" },
);
const floor = (state: string) => floorFor([...hookFloors], state, hookQuestion);

function prompt(
  tool: string,
  input: Record<string, unknown>,
  cwd = "C:\\src\\proj",
  context = ctx,
) {
  const parsed = parseHookInput(
    JSON.stringify({
      hook_event_name: "PermissionRequest",
      session_id: "s",
      cwd,
      tool_name: tool,
      tool_input: input,
    }),
    "claude-code",
    () => "2026-11-12T00:00:00.000Z",
    context,
  );
  if ("reason" in parsed) throw new Error(parsed.reason);
  return { event: parsed.event, floor: floor(promptState(parsed.event).text) };
}

describe("A: a project's harness extension points are configuration by path too", () => {
  it.each([
    "C:\\src\\proj\\.claude\\agents\\helper.md",
    "C:\\src\\proj\\.claude\\commands\\ship.md",
    "C:\\src\\proj\\.claude\\skills\\x\\SKILL.md",
    "C:\\src\\proj\\.claude\\skills\\x\\run.ps1",
    "C:\\src\\proj\\.claude\\plugins\\p\\plugin.json",
    "C:\\src\\proj\\.claude\\output-styles\\terse.md",
    "C:\\src\\proj\\.claude\\settings.json",
    "C:\\src\\proj\\.claude\\CLAUDE.md",
    "C:\\src\\proj\\.codex\\AGENTS.md",
    "C:\\src\\proj\\.codex\\prompts\\review.md",
    "C:\\src\\proj\\.codex\\rules\\default.rules",
  ])("Write %s is reviewed, as `cp` onto it already was", (file_path) => {
    const write = prompt("Write", { file_path, content: "x" });
    expect(write.event.subject).toMatchObject({ insideWorkspace: true, harnessConfig: true });
    expect(write.floor).toBe("review");
    const viaCommand = prompt("PowerShell", { command: `Copy-Item .\\x ${file_path}` });
    expect(viaCommand.floor).toBe("review");
  });

  it("a session rooted at the user's home, with the hook's home misread, still reviews a skill", () => {
    const wrong = hookContext(
      "claude-code",
      { CLAUDE_PROJECT_DIR: "C:\\Users\\dev" },
      { home: "D:\\elsewhere", tmp: "C:\\Users\\dev\\AppData\\Local\\Temp" },
    );
    const r = prompt(
      "Write",
      { file_path: "C:\\Users\\dev\\.claude\\skills\\x\\run.ps1", content: "x" },
      "C:\\Users\\dev",
      wrong,
    );
    expect(r.event.subject).toMatchObject({ insideWorkspace: true, harnessConfig: true });
    expect(r.floor).toBe("review");
  });

  it("leaves the project's own CLAUDE.md, AGENTS.md and docs alone", () => {
    for (const file_path of [
      "C:\\src\\proj\\CLAUDE.md",
      "C:\\src\\proj\\AGENTS.md",
      "C:\\src\\proj\\docs\\agents\\guide.md",
    ]) {
      const r = prompt("Write", { file_path, content: "x" });
      expect(r.event.subject).toMatchObject({ harnessConfig: false });
      expect(r.floor).toBe("act");
    }
  });
});

describe("C: credential files, by tool and by command, agree", () => {
  it.each([
    ["C:\\Users\\dev\\.ssh\\id_ed25519", "cat ~/.ssh/id_ed25519"],
    ["C:\\Users\\dev\\.aws\\credentials", "Get-Content $HOME\\.aws\\credentials"],
    ["C:\\Users\\dev\\.git-credentials", "type %USERPROFILE%\\.git-credentials"],
    ["C:\\src\\proj\\certs\\server.key", "cat certs/server.key"],
    ["C:\\src\\other\\.env", "cat ../other/.env"],
  ])("Read %s and `%s` are both reviewed", (file_path, command) => {
    const read = prompt("Read", { file_path });
    expect(read.event.subject).toMatchObject({ credential: true });
    expect(read.floor).toBe("review");
    const shell = prompt("Bash", { command });
    expect(shell.event.subject).toMatchObject({ kind: "command", credential: true });
    expect(promptState(shell.event).text).toMatch(/^credential: true$/m);
    expect(shell.floor).toBe("review");
  });

  it("the project's own .env and a public key are not credentials", () => {
    expect(prompt("Read", { file_path: "C:\\src\\proj\\.env" }).event.subject).toMatchObject({
      credential: false,
      insideWorkspace: true,
    });
    expect(prompt("Read", { file_path: "C:\\src\\proj\\.env" }).floor).toBe("act");
    expect(placePath("/home/me/.ssh/id_ed25519.pub", { cwd: "/w" }).credential).toBe(false);
    expect(placePath("/w/.env.example", { cwd: "/w" }).credential).toBe(false);
    expect(subjectOf("Bash", { command: "cat .env" }, "/w")).toMatchObject({ credential: false });
  });
});

const legacy = (subject: HookEvent["subject"]): HookEvent => ({
  schema: JOURNAL_SCHEMA,
  id: "p",
  harness: "claude-code",
  kind: "prompt",
  at: "2026-11-12T00:00:00.000Z",
  session: "s",
  cwd: "C:\\src\\proj",
  projectDir: "C:\\src\\proj",
  tool: "Write",
  inputHash: "h",
  ...(subject === undefined ? {} : { subject }),
});

describe("D: replay never lowers a journalled harness_config", () => {
  it("journalled true, replayed where the harness home is elsewhere, stays true", () => {
    // Journalled on a machine whose CLAUDE_CONFIG_DIR was D:\cc: a plugin hook there.
    const event = legacy({
      kind: "path",
      path: "D:\\cc\\plugins\\p\\hooks\\hooks.json",
      insideWorkspace: false,
      harnessOwned: false,
      harnessConfig: true,
      readOnly: false,
      destructive: false,
      redacted: false,
    });
    const { home, harnessHomes, harnessScratch } = ctx;
    const placement = {
      ...(home === undefined ? {} : { home }),
      ...(harnessHomes === undefined ? {} : { harnessHomes }),
      ...(harnessScratch === undefined ? {} : { harnessScratch }),
    };
    const state = promptState(event, { placement }).text;
    expect(state).toMatch(/^harness_config: true$/m);
    expect(floor(state)).toBe("review");
  });
});

describe("H: a note's alternate data stream is not a note", () => {
  it.each([
    "C:\\Users\\dev\\.claude\\projects\\p\\memory\\x.md:evil.ps1",
    "C:\\Users\\dev\\.claude\\projects\\p\\memory\\x.md::$DATA",
    "C:\\Users\\dev\\AppData\\Local\\Temp\\claude\\p\\s\\scratchpad\\a.py:payload",
  ])("%s is not harness-owned, and is reviewed", (file_path) => {
    const r = prompt("Write", { file_path, content: "x" });
    expect(r.event.subject).toMatchObject({ harnessOwned: false });
    expect(r.floor).toBe("review");
  });

  it("the plain note is still owned", () => {
    const r = prompt("Write", {
      file_path: "C:\\Users\\dev\\.claude\\projects\\p\\memory\\x.md",
      content: "x",
    });
    expect(r.event.subject).toMatchObject({ harnessOwned: true });
    expect(r.floor).toBe("act");
  });
});

describe("a rule split for speed still states itself whole in `pattern`", () => {
  it("pattern and the per-segment test agree, on hits, misses and other segments", async () => {
    const { CREDENTIAL_COMMANDS, HARNESS_CONFIG_COMMANDS, matchingRules } = await import(
      "../src/hook/subject.ts"
    );
    const rules = [...HARNESS_CONFIG_COMMANDS, ...CREDENTIAL_COMMANDS].filter(
      (r) => r.inSegment !== undefined,
    );
    expect(rules.map((r) => r.id).sort()).toEqual([
      "command-writes-harness-config",
      "link-to-harness-home",
      "reads-credential-file",
    ]);
    for (const command of [
      "cp x ~/.claude/settings.json",
      "ln -s ~/.claude ./cfg",
      "cat ~/.ssh/id_ed25519",
      "cat ~/.ssh/id_ed25519.pub",
      "echo ~/.claude/settings.json; cp a b",
      'f="$HOME/.claude/settings.json"; Set-Content $f x',
    ]) {
      for (const r of rules) {
        expect(matchingRules([r], command, "posix").length > 0).toBe(r.pattern.test(command));
      }
    }
  });
});
