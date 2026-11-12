/**
 * Hook events from an agent harness (Claude Code, Codex), parsed from the JSON the harness
 * writes to a hook's stdin. Both harnesses use the same shape: `hook_event_name`,
 * `session_id`, `cwd`, `tool_name`, `tool_input`, and `tool_use_id` on the events that run a
 * tool. The input is untrusted: it is validated field by field and anything else is rejected
 * with a reason, never half-read.
 *
 * What the journal keeps is not the raw event. A permission prompt is reduced to a scrubbed
 * subject (see `subject.ts`); a run or failure keeps only what matching needs. Nothing a hook
 * sees about the conversation, file contents or tool output is written anywhere.
 */
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type Subject, subjectOf } from "./subject.ts";

export const HARNESSES = ["claude-code", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

export const isHarness = (v: unknown): v is Harness => HARNESSES.includes(v as Harness);

/** The journal's schema; bump when a field changes meaning. */
export const JOURNAL_SCHEMA = "ratchet.hook-event/1";

export type EventKind =
  /** The harness was about to ask the person to approve a tool call. */
  | "prompt"
  /** A tool call ran (with or without a prompt first). */
  | "ran"
  /** A tool call ran and failed. It was still approved. */
  | "failed"
  /** The harness's own classifier denied the call (Claude Code auto mode). Not a person's answer. */
  | "classifier-denied"
  /** The session ended. Every prompt still open in it was never run. */
  | "session-end";

/** One line of the journal. */
export interface HookEvent {
  readonly schema: typeof JOURNAL_SCHEMA;
  readonly id: string;
  readonly harness: Harness;
  readonly kind: EventKind;
  /** When the hook ran, ISO 8601. */
  readonly at: string;
  readonly session: string;
  /** The user turn this event belongs to (Claude Code `prompt_id`, Codex `turn_id`), when the harness says. */
  readonly turn?: string;
  readonly cwd?: string;
  /**
   * The project directory the harness reports (Claude Code's `CLAUDE_PROJECT_DIR`): the
   * session's root, which does not follow the agent's `cd` the way `cwd` does.
   */
  readonly projectDir?: string;
  readonly permissionMode?: string;
  readonly tool?: string;
  readonly toolUseId?: string;
  /** Hash of the canonical tool input; it is how a run is matched back to its prompt. */
  readonly inputHash?: string;
  /** The scrubbed subject, kept on prompts only: it is what the gate will be asked about. */
  readonly subject?: Subject;
  /** The harness's reason, on a classifier denial or a session end. */
  readonly reason?: string;
}

export interface ParsedEvent {
  readonly event: HookEvent;
}

export interface RejectedEvent {
  readonly reason: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (o: Record<string, unknown>, key: string): string | undefined => {
  const v = o[key];
  return typeof v === "string" && v !== "" ? v : undefined;
};

/**
 * A stable hash of a tool input, independent of key order, so a `PermissionRequest` (which
 * carries no `tool_use_id`) can be matched to the `PostToolUse` of the same call.
 */
export function hashInput(input: unknown): string {
  return createHash("sha256").update(canonical(input)).digest("hex").slice(0, 16);
}

/** A literal piece of output on the work stack, told apart from a value still to serialise. */
class Piece {
  constructor(readonly text: string) {}
}

/**
 * The canonical text of a JSON value: keys sorted, no spaces. Iterative with an explicit
 * stack, so input nested 100,000 deep (which `JSON.parse` accepts) cannot overflow the call
 * stack and drop the event; the text is the same as the recursive form, so hashes journalled
 * before stay comparable.
 */
function canonical(root: unknown): string {
  const out: string[] = [];
  const work: unknown[] = [root];
  while (work.length > 0) {
    const v = work.pop();
    if (v instanceof Piece) {
      out.push(v.text);
      continue;
    }
    if (Array.isArray(v)) {
      work.push(new Piece("]"));
      for (let i = v.length - 1; i >= 0; i--) {
        work.push(v[i]);
        if (i > 0) work.push(new Piece(","));
      }
      out.push("[");
      continue;
    }
    if (isRecord(v)) {
      const keys = Object.keys(v).sort();
      work.push(new Piece("}"));
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i] as string;
        work.push(v[k]);
        work.push(new Piece(`${i > 0 ? "," : ""}${JSON.stringify(k)}:`));
      }
      out.push("{");
      continue;
    }
    out.push(JSON.stringify(v) ?? "null");
  }
  return out.join("");
}

/**
 * Hook event names this version reads. A Map, not an object: `hook_event_name` is untrusted,
 * and an object lookup would answer `toString` or `__proto__` with a prototype member.
 */
const KINDS: ReadonlyMap<string, EventKind> = new Map<string, EventKind>([
  ["PermissionRequest", "prompt"],
  ["PostToolUse", "ran"],
  ["PostToolUseFailure", "failed"],
  ["PermissionDenied", "classifier-denied"],
  ["SessionEnd", "session-end"],
]);

const EVENT_KINDS: ReadonlySet<string> = new Set(KINDS.values());

/** What the hook process knows about where it runs, beyond the event itself. */
export interface HookContext {
  /** The session's root as the harness reports it (Claude Code: `CLAUDE_PROJECT_DIR`). */
  readonly projectDir?: string;
  /** The user's home, for a path written with a leading `~`. */
  readonly home?: string;
  /**
   * Agent harness homes: everything under one is harness configuration except Claude Code's
   * notes (`projects/<p>/memory/`). Both harnesses' homes, whichever is asking: an agent
   * rewriting another agent's settings is changing permissions just the same.
   */
  readonly harnessHomes?: readonly string[];
  /** The harness's scratch space: harness-owned. */
  readonly harnessScratch?: readonly string[];
}

/**
 * The context a hook process reads from its environment. Claude Code sets `CLAUDE_PROJECT_DIR`
 * for hook commands and keeps its own files under `CLAUDE_CONFIG_DIR` (default `~/.claude`)
 * and its scratch space under `<tmp>/claude`; Codex keeps its files under `CODEX_HOME`
 * (default `~/.codex`), has no scratch space, and reports no project directory, but its `cwd`
 * does not follow `cd`.
 */
export function hookContext(
  harness: Harness,
  env: Readonly<Record<string, string | undefined>> = process.env,
  dirs: { readonly home?: string; readonly tmp?: string } = {},
): HookContext {
  const home = dirs.home ?? homedir();
  const tmp = dirs.tmp ?? tmpdir();
  const nonEmpty = (v: string | undefined): string | undefined =>
    v === undefined || v.trim() === "" ? undefined : v;
  const claude = nonEmpty(env.CLAUDE_CONFIG_DIR) ?? join(home, ".claude");
  const codex = nonEmpty(env.CODEX_HOME) ?? join(home, ".codex");
  if (harness === "claude-code") {
    const projectDir = nonEmpty(env.CLAUDE_PROJECT_DIR);
    const scratch = [join(tmp, "claude")];
    if (!/^[a-z]:/i.test(tmp) && tmp !== "/tmp") scratch.push("/tmp/claude");
    return {
      ...(projectDir === undefined ? {} : { projectDir }),
      home,
      harnessHomes: [claude, codex],
      harnessScratch: scratch,
    };
  }
  return { home, harnessHomes: [codex, claude], harnessScratch: [] };
}

/** Hook events the install registers, per harness. Codex has no `PostToolUseFailure`. */
export const EVENTS_FOR: Readonly<Record<Harness, readonly string[]>> = {
  "claude-code": ["PermissionRequest", "PostToolUse", "PostToolUseFailure", "SessionEnd"],
  codex: ["PermissionRequest", "PostToolUse", "SessionEnd"],
};

/**
 * Turn one hook's stdin into a journal event, or a rejection. `now` is injectable so tests
 * are deterministic. Unknown events (including prototype names such as `toString`) are
 * rejected rather than journaled: a hook configured on an event this version does not
 * understand should fail loudly in the status report, not add rows that nothing reads.
 *
 * `context` places paths: `inside_workspace` is measured from its `projectDir` when the
 * harness reports one (else from the event's cwd, and `resolvePrompts` re-measures from the
 * session's first cwd); a path under its `harnessScratch` or in Claude Code's notes is
 * harness-owned, and anything else under its `harnessHomes` is harness configuration. Without
 * it, as in a library call, the cwd is the root, nothing is harness-owned, and configuration
 * is recognised by its shape alone.
 */
export function parseHookInput(
  raw: string,
  harness: Harness,
  now: () => string = () => new Date().toISOString(),
  context: HookContext = {},
): ParsedEvent | RejectedEvent {
  let json: unknown;
  try {
    // A UTF-8 BOM before the JSON is tolerated, as the ledger tolerates one.
    json = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return { reason: "stdin is not JSON" };
  }
  if (!isRecord(json)) return { reason: "stdin is not a JSON object" };
  const name = str(json, "hook_event_name");
  if (name === undefined) return { reason: "missing hook_event_name" };
  const kind = KINDS.get(name);
  if (kind === undefined) return { reason: `unsupported hook event ${name.slice(0, 80)}` };
  const session = str(json, "session_id");
  if (session === undefined) return { reason: `${name}: missing session_id` };
  const base = {
    schema: JOURNAL_SCHEMA,
    id: randomUUID(),
    harness,
    kind,
    at: now(),
    session,
    ...spread("turn", str(json, "prompt_id") ?? str(json, "turn_id")),
    ...spread("cwd", str(json, "cwd")),
    ...spread("projectDir", context.projectDir),
    ...spread("permissionMode", str(json, "permission_mode")),
  } as const;
  if (kind === "session-end") {
    return { event: { ...base, ...spread("reason", str(json, "reason")) } };
  }
  const tool = str(json, "tool_name");
  if (tool === undefined) return { reason: `${name}: missing tool_name` };
  const input = json.tool_input;
  if (!isRecord(input)) return { reason: `${name}: tool_input is not an object` };
  const common = {
    ...base,
    tool,
    inputHash: hashInput(input),
    ...spread("toolUseId", str(json, "tool_use_id")),
  };
  if (kind === "prompt") {
    const root = context.projectDir ?? base.cwd;
    const subject = subjectOf(tool, input, {
      ...spread("cwd", base.cwd),
      ...spread("root", root),
      ...spread("home", context.home),
      ...spread("harnessHomes", context.harnessHomes),
      ...spread("harnessScratch", context.harnessScratch),
    });
    return { event: { ...common, subject } };
  }
  if (kind === "classifier-denied") {
    return { event: { ...common, ...spread("reason", str(json, "reason")) } };
  }
  return { event: common };
}

function spread<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

/** Validate one journal line read back from disk. The file is ours, but it is still parsed, never trusted. */
export function parseJournalLine(line: string): HookEvent | undefined {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(json) || json.schema !== JOURNAL_SCHEMA) return undefined;
  const id = str(json, "id");
  const harness = json.harness;
  const kind = json.kind;
  const at = str(json, "at");
  const session = str(json, "session");
  if (id === undefined || !isHarness(harness) || at === undefined || session === undefined)
    return undefined;
  if (typeof kind !== "string" || !EVENT_KINDS.has(kind)) return undefined;
  const subject = json.subject;
  return {
    schema: JOURNAL_SCHEMA,
    id,
    harness,
    kind: kind as EventKind,
    at,
    session,
    ...spread("turn", str(json, "turn")),
    ...spread("cwd", str(json, "cwd")),
    ...spread("projectDir", str(json, "projectDir")),
    ...spread("permissionMode", str(json, "permissionMode")),
    ...spread("tool", str(json, "tool")),
    ...spread("toolUseId", str(json, "toolUseId")),
    ...spread("inputHash", str(json, "inputHash")),
    ...spread("subject", isRecord(subject) ? (subject as unknown as Subject) : undefined),
    ...spread("reason", str(json, "reason")),
  };
}
