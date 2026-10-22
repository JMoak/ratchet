/**
 * keywork's decision export (`keywork sessions decisions`, schema "keywork.tool-decision/1"):
 * one verdict on one agent tool call, with the facts keywork's own code computed about the call.
 * The file is untrusted input. It is parsed as JSON and validated field by field; anything that
 * does not match is rejected with its line number rather than half-read.
 */
export const KEYWORK_SCHEMA = "keywork.tool-decision/1";

export type AnsweredBy = "person" | "headless" | "grant" | "rule" | "unknown";

export type PathChange =
  | { readonly kind: "write"; readonly lines: number }
  | {
      readonly kind: "edit";
      readonly removedLines: number;
      readonly addedLines: number;
      readonly replaceAll: boolean;
    };

export type KeyworkSubject =
  | {
      readonly kind: "command";
      readonly command: string;
      readonly truncated: boolean;
      readonly parts: number;
      readonly destructive: boolean;
      readonly opaque: boolean;
    }
  | {
      readonly kind: "path";
      readonly path: string;
      readonly insideWorkspace: boolean;
      readonly change?: PathChange;
    }
  | { readonly kind: "call"; readonly arguments: string; readonly truncated: boolean };

export interface KeyworkAsk {
  readonly at: string;
  readonly rule: "policy" | "default" | "trusted";
  readonly grantable: boolean;
  readonly change?: {
    readonly creates: boolean;
    readonly linesBefore: number;
    readonly linesAfter: number;
  };
}

export interface KeyworkAnswer {
  readonly at: string;
  readonly verdict: "granted" | "denied";
  readonly gate: string;
  readonly scope?: string;
  readonly by: AnsweredBy;
  readonly afterMs?: number;
}

export interface ToolDecision {
  readonly session: string;
  readonly rootSession: string;
  readonly callId: string;
  readonly at: string;
  readonly tool: string;
  readonly subject: KeyworkSubject;
  readonly ask?: KeyworkAsk;
  readonly answer: KeyworkAnswer;
  readonly result?: { readonly isError: boolean };
}

export interface ParsedExport {
  readonly decisions: ToolDecision[];
  readonly rejected: { readonly line: number; readonly reason: string }[];
}

/** Parse JSON Lines; blank lines are skipped, every other line is one record or one rejection. */
export function parseToolDecisions(text: string): ParsedExport {
  const decisions: ToolDecision[] = [];
  const rejected: { line: number; reason: string }[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    if (raw.trim() === "") return;
    try {
      decisions.push(toolDecision(JSON.parse(raw)));
    } catch (e) {
      rejected.push({ line: index + 1, reason: e instanceof Error ? e.message : String(e) });
    }
  });
  return { decisions, rejected };
}

/** A stable identity for one decision, unique across sessions. */
export const decisionKey = (d: ToolDecision): string => `${d.session}:${d.callId}`;

function toolDecision(value: unknown): ToolDecision {
  const v = object(value, "record");
  if (v.schema !== KEYWORK_SCHEMA) throw new Error(`schema must be ${KEYWORK_SCHEMA}`);
  const ask = v.ask === undefined ? undefined : keyworkAsk(v.ask);
  const result = v.result === undefined ? undefined : object(v.result, "result");
  return {
    session: text(v.session, "session"),
    rootSession: text(v.rootSession, "rootSession"),
    callId: text(v.callId, "callId"),
    at: timestamp(v.at, "at"),
    tool: text(v.tool, "tool"),
    subject: subject(v.subject),
    ...(ask !== undefined ? { ask } : {}),
    answer: answer(v.answer),
    ...(result !== undefined
      ? { result: { isError: flag(result.isError, "result.isError") } }
      : {}),
  };
}

function subject(value: unknown): KeyworkSubject {
  const v = object(value, "subject");
  switch (v.kind) {
    case "command":
      return {
        kind: "command",
        command: string(v.command, "subject.command"),
        truncated: flag(v.truncated, "subject.truncated"),
        parts: count(v.parts, "subject.parts"),
        destructive: flag(v.destructive, "subject.destructive"),
        opaque: flag(v.opaque, "subject.opaque"),
      };
    case "path": {
      const change = v.change === undefined ? undefined : pathChange(v.change);
      return {
        kind: "path",
        path: text(v.path, "subject.path"),
        insideWorkspace: flag(v.insideWorkspace, "subject.insideWorkspace"),
        ...(change !== undefined ? { change } : {}),
      };
    }
    case "call":
      return {
        kind: "call",
        arguments: string(v.arguments, "subject.arguments"),
        truncated: flag(v.truncated, "subject.truncated"),
      };
    default:
      throw new Error("subject.kind must be command, path or call");
  }
}

function pathChange(value: unknown): PathChange {
  const v = object(value, "subject.change");
  if (v.kind === "write") return { kind: "write", lines: count(v.lines, "change.lines") };
  if (v.kind === "edit") {
    return {
      kind: "edit",
      removedLines: count(v.removedLines, "change.removedLines"),
      addedLines: count(v.addedLines, "change.addedLines"),
      replaceAll: flag(v.replaceAll, "change.replaceAll"),
    };
  }
  throw new Error("subject.change.kind must be write or edit");
}

function keyworkAsk(value: unknown): KeyworkAsk {
  const v = object(value, "ask");
  const rule = oneOf(v.rule, ["policy", "default", "trusted"] as const, "ask.rule");
  const change =
    v.change === undefined
      ? undefined
      : (() => {
          const c = object(v.change, "ask.change");
          return {
            creates: flag(c.creates, "ask.change.creates"),
            linesBefore: count(c.linesBefore, "ask.change.linesBefore"),
            linesAfter: count(c.linesAfter, "ask.change.linesAfter"),
          };
        })();
  return {
    at: timestamp(v.at, "ask.at"),
    rule,
    grantable: flag(v.grantable, "ask.grantable"),
    ...(change !== undefined ? { change } : {}),
  };
}

function answer(value: unknown): KeyworkAnswer {
  const v = object(value, "answer");
  return {
    at: timestamp(v.at, "answer.at"),
    verdict: oneOf(v.verdict, ["granted", "denied"] as const, "answer.verdict"),
    gate: text(v.gate, "answer.gate"),
    ...(v.scope !== undefined ? { scope: text(v.scope, "answer.scope") } : {}),
    by: oneOf(v.by, ["person", "headless", "grant", "rule", "unknown"] as const, "answer.by"),
    ...(v.afterMs !== undefined ? { afterMs: count(v.afterMs, "answer.afterMs") } : {}),
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function text(value: unknown, name: string): string {
  const s = string(value, name);
  if (s.trim() === "" || s.length > 4_096)
    throw new Error(`${name} must be a short non-empty string`);
  return s;
}

function timestamp(value: unknown, name: string): string {
  const s = text(value, name);
  if (Number.isNaN(Date.parse(s))) throw new Error(`${name} must be an ISO timestamp`);
  return s;
}

function flag(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function count(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value as number;
}

function oneOf<const T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}
