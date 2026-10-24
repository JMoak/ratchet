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

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isRecord(v)) {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const KINDS: Readonly<Record<string, EventKind>> = {
  PermissionRequest: "prompt",
  PostToolUse: "ran",
  PostToolUseFailure: "failed",
  PermissionDenied: "classifier-denied",
  SessionEnd: "session-end",
};

/** Hook events the install registers, per harness. Codex has no `PostToolUseFailure`. */
export const EVENTS_FOR: Readonly<Record<Harness, readonly string[]>> = {
  "claude-code": ["PermissionRequest", "PostToolUse", "PostToolUseFailure", "SessionEnd"],
  codex: ["PermissionRequest", "PostToolUse", "SessionEnd"],
};

/**
 * Turn one hook's stdin into a journal event, or a rejection. `now` is injectable so tests
 * are deterministic. Unknown events are rejected rather than journaled: a hook configured on
 * an event this version does not understand should fail loudly in the status report, not
 * add rows that nothing reads.
 */
export function parseHookInput(
  raw: string,
  harness: Harness,
  now: () => string = () => new Date().toISOString(),
): ParsedEvent | RejectedEvent {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { reason: "stdin is not JSON" };
  }
  if (!isRecord(json)) return { reason: "stdin is not a JSON object" };
  const name = str(json, "hook_event_name");
  if (name === undefined) return { reason: "missing hook_event_name" };
  const kind = KINDS[name];
  if (kind === undefined) return { reason: `unsupported hook event ${name}` };
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
    return { event: { ...common, subject: subjectOf(tool, input, base.cwd) } };
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
  if (typeof kind !== "string" || !Object.values(KINDS).includes(kind as EventKind))
    return undefined;
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
    ...spread("permissionMode", str(json, "permissionMode")),
    ...spread("tool", str(json, "tool")),
    ...spread("toolUseId", str(json, "toolUseId")),
    ...spread("inputHash", str(json, "inputHash")),
    ...spread("subject", isRecord(subject) ? (subject as unknown as Subject) : undefined),
    ...spread("reason", str(json, "reason")),
  };
}
