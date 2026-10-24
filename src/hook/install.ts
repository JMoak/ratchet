/**
 * The hook configuration each harness needs, printed rather than written: a tool that edits
 * someone's agent settings on their behalf is the wrong default for a shadow experiment, and
 * both harnesses show the person the hook before it runs anyway.
 */
import type { Harness } from "./event.ts";
import type { HookPaths } from "./journal.ts";

const command = (harness: Harness): string => `ratchet hook ${harness} event`;

/** Events a short-lived process may run in the background; the harness never waits for them. */
const ASYNC = { async: true, timeout: 10 } as const;

export function settingsFor(harness: Harness): Record<string, unknown> {
  const run = command(harness);
  if (harness === "claude-code") {
    const group = (extra: Record<string, unknown> = ASYNC) => [
      { hooks: [{ type: "command", command: run, ...extra }] },
    ];
    return {
      hooks: {
        PermissionRequest: group(),
        PostToolUse: group(),
        PostToolUseFailure: group(),
        // SessionEnd hooks get 1.5 s by default; the append takes a few milliseconds.
        SessionEnd: group({ timeout: 5 }),
      },
    };
  }
  const group = (extra: Record<string, unknown> = ASYNC) => [
    {
      matcher: "*",
      hooks: [{ type: "command", command: run, statusMessage: "ratchet shadow", ...extra }],
    },
  ];
  return {
    description: "ratchet: shadow the permission prompts and learn from the answers",
    hooks: {
      PermissionRequest: group(),
      PostToolUse: group(),
      // Codex gives SessionEnd at most 3 s and always runs it synchronously.
      SessionEnd: group({ timeout: 3 }),
    },
  };
}

const FILES: Readonly<Record<Harness, string>> = {
  "claude-code": "~/.claude/settings.json (or .claude/settings.json in one project)",
  codex: "~/.codex/hooks.json (or .codex/hooks.json in one project)",
};

export function installText(harness: Harness, paths: HookPaths): string {
  const settings = JSON.stringify(settingsFor(harness), null, 2);
  const trust =
    harness === "codex"
      ? "Codex lists new hooks under /hooks and runs them only after you approve them there.\n"
      : "Claude Code shows the hook under /hooks; reload the session so it picks up the file.\n";
  return [
    `ratchet hook ${harness}: shadow the permission prompts`,
    "",
    "1. Make sure `ratchet` is on the PATH of the shell the harness uses:",
    "     npm install -g @jmoak/ratchet@alpha     (or: bun add -g @jmoak/ratchet@alpha)",
    "",
    `2. Merge this into ${FILES[harness]}:`,
    "",
    indent(settings),
    "",
    `3. ${trust.trimEnd()}`,
    "",
    "What it does: each permission prompt, each tool run and each session end appends one line",
    `to ${paths.events}. Nothing is sent anywhere and no decision changes.`,
    "File contents, tool output and the conversation are never recorded; a command is scrubbed",
    "and capped, an edit is its line counts.",
    "",
    "Then, whenever you like:",
    `     ratchet hook ${harness} status            what has been recorded`,
    `     ratchet hook ${harness} replay            dry run: the exact text the gate would see`,
    `     ratchet hook ${harness} replay --live     ask the oracle in shadow (needs a key in the environment)`,
    `     ratchet report ${paths.ledger}`,
    `     ratchet review ${paths.ledger} --gate agent.tool.${harness} --denied`,
    "",
  ].join("\n");
}

const indent = (text: string): string =>
  text
    .split("\n")
    .map((l) => `   ${l}`)
    .join("\n");
