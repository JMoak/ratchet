/**
 * What leaves the machine about one tool call: a scrubbed subject plus facts computed by this
 * code. Mirrors the keywork gate's contract. The agent wrote the command, path or arguments,
 * so they are untrusted spans; the facts (destructive, opaque, inside the workspace, change
 * size) are digests the floors can read. File contents, tool output and the conversation are
 * never kept: a write is its line count, an edit is lines removed and added.
 *
 * Scrubbing is best effort and documented as such. It removes the shapes secrets usually take
 * (bearer headers, `key=value` credentials, vendor token prefixes, long opaque blobs). It is not
 * a guarantee, which is why the dry run prints the exact text before anything is sent.
 */
import { isAbsolute, relative, resolve } from "node:path";

export type Change =
  | { readonly kind: "write"; readonly lines: number }
  | {
      readonly kind: "edit";
      readonly removedLines: number;
      readonly addedLines: number;
      readonly replaceAll: boolean;
    }
  | {
      readonly kind: "patch";
      readonly files: number;
      readonly addedLines: number;
      readonly removedLines: number;
      readonly deletes: number;
    };

export type Subject =
  | {
      readonly kind: "command";
      readonly command: string;
      readonly parts: number;
      readonly destructive: boolean;
      readonly opaque: boolean;
      readonly uploads: boolean;
      readonly truncated: boolean;
      readonly redacted: boolean;
    }
  | {
      readonly kind: "path";
      readonly path: string;
      /** Undefined when the harness gave no cwd to measure against. */
      readonly insideWorkspace?: boolean;
      readonly readOnly: boolean;
      readonly destructive: boolean;
      readonly change?: Change;
      readonly redacted: boolean;
    }
  | {
      readonly kind: "url";
      readonly url: string;
      readonly truncated: boolean;
      readonly redacted: boolean;
    }
  | { readonly kind: "query"; readonly query: string; readonly truncated: boolean }
  | { readonly kind: "call"; readonly shape: string; readonly truncated: boolean };

export const COMMAND_MAX_CHARS = 1000;
export const URL_MAX_CHARS = 500;
export const QUERY_MAX_CHARS = 300;
export const SHAPE_MAX_CHARS = 600;

const SECRETS: readonly RegExp[] = [
  /(authorization\s*[:=]\s*bearer\s+)\S+/gi,
  /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|token)\s*[=:]\s*["']?)[^\s"'&;]+/gi,
  /\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
  /\b[0-9a-f]{40,}\b/gi,
];

/** Replace the usual shapes of a secret. Returns the text and whether anything was replaced. */
export function scrub(text: string): { readonly text: string; readonly redacted: boolean } {
  let out = text;
  for (const re of SECRETS) {
    out = out.replace(re, (_m: string, keep?: string) =>
      typeof keep === "string" ? `${keep}[redacted]` : "[redacted]",
    );
  }
  return { text: out, redacted: out !== text };
}

function cap(text: string, max: number): { readonly text: string; readonly truncated: boolean } {
  return text.length <= max
    ? { text, truncated: false }
    : { text: text.slice(0, max), truncated: true };
}

/** Commands that delete, rewrite history, publish or reshape a machine: one-way doors. */
const DESTRUCTIVE: readonly RegExp[] = [
  /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/,
  /\b(?:rmdir|del|erase)\s+\/[sq]\b/i,
  /\bRemove-Item\b[^|;&]*-Recurse/i,
  /\bgit\s+push\b/,
  /\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*f|branch\s+-D|filter-branch|filter-repo)\b/,
  /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA|INDEX)\b/i,
  /\bDELETE\s+FROM\b/i,
  /\b(?:mkfs|fdisk|diskpart)\b/,
  /\bdd\s+if=/,
  />\s*\/dev\/(?:sd|nvme|disk)/,
  /\b(?:shutdown|reboot|halt|poweroff)\b/,
  /\bformat\s+[a-z]:/i,
  /\bkubectl\s+(?:delete|drain)\b/,
  /\bterraform\s+(?:destroy|apply)\b/,
  /\bdocker\s+(?:system\s+prune|rm|rmi|volume\s+rm)\b/,
  /\b(?:npm|bun|pnpm|yarn)\s+publish\b/,
  /\bgh\s+(?:release\s+create|pr\s+merge|repo\s+delete)\b/,
  /\bchmod\s+(?:-R\s+)?[0-7]*777\b/,
];

/** Commands whose effect the model cannot read from the text. */
const OPAQUE: readonly RegExp[] = [
  /\beval\b/,
  /\$\(/,
  /`[^`]+`/,
  /\|\s*(?:sh|bash|zsh|fish|pwsh|powershell|python[0-9.]*|node|perl|ruby)\b/,
  /\bbase64\s+(?:-d|--decode)\b/,
  /\b(?:curl|wget|Invoke-WebRequest|iwr)\b[^|]*\|\s*(?:sh|bash|iex)\b/i,
  /\biex\b/i,
];

/** Commands that send data somewhere else. */
const UPLOADS: readonly RegExp[] = [
  /\b(?:scp|rsync)\b[^|;&]*\S+@\S+:/,
  /\bcurl\b[^|;&]*\s(?:-d|--data(?:-\w+)?|-F|--form|-T|--upload-file|-X\s*(?:POST|PUT|PATCH))\b/,
  /\bwget\b[^|;&]*--post-(?:data|file)\b/,
  /\baws\s+s3\s+(?:cp|sync|mv)\b[^|;&]*\ss3:\/\//,
  /\b(?:gsutil|gcloud\s+storage)\s+(?:cp|rsync)\b/,
  /\bInvoke-RestMethod\b[^|;&]*-Method\s+(?:Post|Put)\b/i,
];

const any = (res: readonly RegExp[], text: string): boolean => res.some((re) => re.test(text));

/** Pipeline and list operators, counted roughly: a digest, not a parser. */
const countParts = (command: string): number =>
  1 + (command.match(/\s(?:&&|\|\||\||;)\s/g)?.length ?? 0);

const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const PATH_TOOLS = new Set([
  ...READ_ONLY_TOOLS,
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
]);

const str = (o: Record<string, unknown>, key: string): string | undefined => {
  const v = o[key];
  return typeof v === "string" ? v : undefined;
};

const lines = (text: string): number => (text === "" ? 0 : text.split(/\r\n|\r|\n/).length);

function insideWorkspace(path: string, cwd: string | undefined): boolean | undefined {
  if (cwd === undefined) return undefined;
  const rel = relative(resolve(cwd), resolve(cwd, path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Parse the headers of a Codex `apply_patch` body: which files, and how many lines each way. */
export function patchFacts(patch: string): {
  readonly paths: string[];
  readonly change: Extract<Change, { kind: "patch" }>;
} {
  const paths: string[] = [];
  let deletes = 0;
  let added = 0;
  let removed = 0;
  for (const line of patch.split(/\r?\n/)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      paths.push((header[2] as string).trim());
      if (header[1] === "Delete") deletes++;
      continue;
    }
    if (/^\*\*\* /.test(line)) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return {
    paths,
    change: {
      kind: "patch",
      files: paths.length,
      addedLines: added,
      removedLines: removed,
      deletes,
    },
  };
}

/**
 * Describe one call the way the gate will see it. Unknown tools (MCP servers, anything new)
 * are reduced to the shape of their input: key names, value types and sizes, never values.
 * That is deliberately little to judge on; a per-tool subject is the way to give the gate more.
 */
export function subjectOf(
  tool: string,
  input: Record<string, unknown>,
  cwd: string | undefined,
): Subject {
  if (tool === "Bash" || tool === "shell" || tool === "exec_command") {
    const raw = str(input, "command") ?? str(input, "cmd") ?? "";
    const scrubbed = scrub(raw);
    const capped = cap(scrubbed.text, COMMAND_MAX_CHARS);
    return {
      kind: "command",
      command: capped.text,
      parts: countParts(raw),
      destructive: any(DESTRUCTIVE, raw),
      opaque: any(OPAQUE, raw),
      uploads: any(UPLOADS, raw),
      truncated: capped.truncated,
      redacted: scrubbed.redacted,
    };
  }
  if (PATH_TOOLS.has(tool)) return pathSubject(tool, input, cwd);
  if (tool === "WebFetch") {
    const scrubbed = scrub(str(input, "url") ?? "");
    const capped = cap(scrubbed.text, URL_MAX_CHARS);
    return {
      kind: "url",
      url: capped.text,
      truncated: capped.truncated,
      redacted: scrubbed.redacted,
    };
  }
  if (tool === "WebSearch") {
    const capped = cap(str(input, "query") ?? "", QUERY_MAX_CHARS);
    return { kind: "query", query: capped.text, truncated: capped.truncated };
  }
  const capped = cap(shapeOf(input), SHAPE_MAX_CHARS);
  return { kind: "call", shape: capped.text, truncated: capped.truncated };
}

function pathSubject(
  tool: string,
  input: Record<string, unknown>,
  cwd: string | undefined,
): Subject {
  if (tool === "apply_patch") {
    const body = str(input, "input") ?? str(input, "patch") ?? "";
    const facts = patchFacts(body);
    const first = facts.paths[0] ?? "";
    const inside = facts.paths.map((p) => insideWorkspace(p, cwd));
    const scrubbed = scrub(facts.paths.join(", "));
    return {
      kind: "path",
      path: scrubbed.text,
      ...(inside.every((v) => v !== undefined) && first !== ""
        ? { insideWorkspace: inside.every((v) => v === true) }
        : {}),
      readOnly: false,
      destructive: facts.change.deletes > 0,
      change: facts.change,
      redacted: scrubbed.redacted,
    };
  }
  const path =
    str(input, "file_path") ??
    str(input, "notebook_path") ??
    str(input, "path") ??
    str(input, "pattern") ??
    "";
  const inside = insideWorkspace(path, cwd);
  const scrubbed = scrub(path);
  const base = {
    kind: "path" as const,
    path: scrubbed.text,
    ...(inside === undefined ? {} : { insideWorkspace: inside }),
    readOnly: READ_ONLY_TOOLS.has(tool),
    destructive: false,
    redacted: scrubbed.redacted,
  };
  if (tool === "Write")
    return { ...base, change: { kind: "write", lines: lines(str(input, "content") ?? "") } };
  if (tool === "Edit") {
    return {
      ...base,
      change: {
        kind: "edit",
        removedLines: lines(str(input, "old_string") ?? ""),
        addedLines: lines(str(input, "new_string") ?? ""),
        replaceAll: input.replace_all === true,
      },
    };
  }
  if (tool === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    let removed = 0;
    let added = 0;
    let replaceAll = false;
    for (const e of edits) {
      if (typeof e !== "object" || e === null) continue;
      const o = e as Record<string, unknown>;
      removed += lines(str(o, "old_string") ?? "");
      added += lines(str(o, "new_string") ?? "");
      replaceAll ||= o.replace_all === true;
    }
    return {
      ...base,
      change: { kind: "edit", removedLines: removed, addedLines: added, replaceAll },
    };
  }
  if (tool === "NotebookEdit") {
    return { ...base, change: { kind: "write", lines: lines(str(input, "new_source") ?? "") } };
  }
  return base;
}

/** Keys, types and sizes; never values. */
export function shapeOf(input: Record<string, unknown>): string {
  const parts = Object.keys(input)
    .sort()
    .map((k) => {
      const v = input[k];
      if (typeof v === "string") return `${k}: string(${v.length})`;
      if (Array.isArray(v)) return `${k}: array(${v.length})`;
      if (v === null) return `${k}: null`;
      if (typeof v === "object") return `${k}: object(${Object.keys(v as object).length})`;
      return `${k}: ${typeof v}`;
    });
  return `{ ${parts.join(", ")} }`;
}
