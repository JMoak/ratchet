/**
 * The real-traffic slice: a seeded uniform sample of the tool calls ratchet's own Claude Code
 * hook journaled on this machine, rendered through the product's scrubbed subject and state
 * code exactly as `ratchet hook claude-code replay` renders a prompt.
 *
 * The journal keeps a subject only for prompted calls; a call that ran without a prompt keeps
 * its tool name, input hash and tool_use id, never its input (`src/hook/event.ts`). So each
 * sampled run's input is recovered from the local Claude Code transcript by its tool_use id,
 * and accepted only when `hashInput(input)` equals the hash the hook recorded at the time. The
 * recovered input then goes through `parseHookInput` as a PermissionRequest of the same call,
 * and `promptState` renders it.
 *
 * Everything this writes stays under experiments/out/e2e/t1-toolgate/real/ (gitignored): it is
 * real session data. Usage: `bun experiments/e2e/t1-toolgate/real.ts [--n 200]`.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type HookEvent, hashInput, parseHookInput } from "../../../src/hook/event.ts";
import { hookPaths, readEvents } from "../../../src/hook/journal.ts";
import { promptState } from "../../../src/hook/state.ts";
import { rng, shuffled } from "../../../src/math.ts";
import { progress, writeJson } from "../lib.ts";
import { REAL_CORPUS, REAL_DIR, type RealItem } from "./common.ts";

/** Calls journaled before the evaluation began, so no evaluation session is sampled. */
export const CUTOFF = "2026-11-12T00:00:00.000Z";
export const REAL_SEED = 20261112;

interface ToolUse {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every transcript file of a session: the main log and any subagent logs beneath it. */
function transcriptFiles(session: string): string[] {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (depth < 4) walk(p, depth + 1);
      } else if (name.endsWith(".jsonl") && p.includes(session)) out.push(p);
    }
  };
  for (const project of readdirSync(root)) {
    const dir = join(root, project);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === `${session}.jsonl`) out.push(p);
      else if (name === session && statSync(p).isDirectory()) walk(p, 1);
    }
  }
  return out;
}

/**
 * Every recorded copy of each wanted tool_use: a resumed or compacted session can hold the same
 * id more than once, and only one copy need match the hash the hook saw.
 */
async function scan(files: readonly string[], wanted: Set<string>, found: Map<string, ToolUse[]>) {
  for (const f of files) {
    const rl = createInterface({ input: createReadStream(f, "utf8"), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"tool_use"')) continue;
      let o: unknown;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(o) || !isRecord(o.message) || !Array.isArray(o.message.content)) continue;
      for (const c of o.message.content) {
        if (!isRecord(c) || c.type !== "tool_use" || typeof c.id !== "string") continue;
        if (!wanted.has(c.id) || typeof c.name !== "string" || !isRecord(c.input)) continue;
        const copies = found.get(c.id) ?? [];
        copies.push({ name: c.name, input: c.input });
        found.set(c.id, copies);
      }
    }
  }
}

export async function buildReal(n: number): Promise<void> {
  const journal = await readEvents(hookPaths("claude-code").events);
  const runs = journal.events.filter(
    (e) => (e.kind === "ran" || e.kind === "failed") && e.toolUseId !== undefined && e.at < CUTOFF,
  );
  const sessions = new Set(runs.map((e) => e.session));
  progress(`[real] ${runs.length} journaled runs before ${CUTOFF} in ${sessions.size} sessions`);
  const order = shuffled(runs, rng(REAL_SEED));
  const candidates = order.slice(0, Math.min(order.length, n * 3));
  const wanted = new Set(candidates.map((e) => e.toolUseId as string));
  const found = new Map<string, ToolUse[]>();
  for (const s of new Set(candidates.map((e) => e.session))) {
    await scan(transcriptFiles(s), wanted, found);
  }
  const items: RealItem[] = [];
  const previews: { id: string; cwd: string | null; mode: string | null; input: string }[] = [];
  let missing = 0;
  let mismatched = 0;
  let normalised = 0;
  let rejected = 0;
  for (const e of candidates) {
    if (items.length >= n) break;
    const copies = found.get(e.toolUseId as string);
    if (copies === undefined) {
      missing++;
      continue;
    }
    // On Windows, Claude Code hands the hook a file_path with backslashes where the transcript
    // keeps the model's forward slashes; that is the only rewrite seen, and the hash says which.
    const candidatesFor = copies.flatMap((c) => {
      const p = c.input.file_path;
      return typeof p === "string" && p.includes("/")
        ? [c, { name: c.name, input: { ...c.input, file_path: p.replace(/\//g, "\\") } }]
        : [c];
    });
    const use = candidatesFor.find((c) => c.name === e.tool && hashInput(c.input) === e.inputHash);
    if (use === undefined) {
      mismatched++;
      continue;
    }
    if (!copies.includes(use)) normalised++;
    const parsed = parseHookInput(
      JSON.stringify({
        hook_event_name: "PermissionRequest",
        session_id: e.session,
        ...(e.cwd !== undefined ? { cwd: e.cwd } : {}),
        ...(e.permissionMode !== undefined ? { permission_mode: e.permissionMode } : {}),
        tool_name: use.name,
        tool_input: use.input,
      }),
      "claude-code",
      () => e.at,
    );
    if ("reason" in parsed) {
      rejected++;
      continue;
    }
    const event: HookEvent = parsed.event;
    // For the decider only (the model never sees it): the unscrubbed call, cut short.
    previews.push({
      id: `r-${String(items.length + 1).padStart(3, "0")}`,
      cwd: e.cwd ?? null,
      mode: e.permissionMode ?? null,
      input: JSON.stringify(use.input).slice(0, 900),
    });
    items.push({
      id: `r-${String(items.length + 1).padStart(3, "0")}`,
      session: createHash("sha256").update(e.session).digest("hex").slice(0, 8),
      tool: use.name,
      state: promptState(event).text,
    });
  }
  mkdirSync(REAL_DIR, { recursive: true });
  writeJson(join(REAL_DIR, "decider-preview.json"), previews);
  const tools = new Map<string, number>();
  for (const it of items) tools.set(it.tool, (tools.get(it.tool) ?? 0) + 1);
  writeJson(REAL_CORPUS, {
    builtAt: new Date().toISOString(),
    cutoff: CUTOFF,
    seed: REAL_SEED,
    population: { runs: runs.length, sessions: sessions.size },
    sampled: {
      candidates: candidates.length,
      missing,
      mismatched,
      normalised,
      rejected,
      kept: items.length,
    },
    tools: Object.fromEntries(tools),
    items,
  });
  progress(
    `[real] kept ${items.length}; ${missing} without a transcript entry, ${mismatched} hash mismatches, ${normalised} matched after path normalisation, ${rejected} rejected by the parser`,
  );
}

if (import.meta.main) {
  const i = process.argv.indexOf("--n");
  await buildReal(i > 0 ? Number(process.argv[i + 1]) : 200);
}
