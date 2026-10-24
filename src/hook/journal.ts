/**
 * Where a harness's events and ledger live, and the append-only journal the hooks write.
 *
 * Default home: `$RATCHET_HOME` or `~/.ratchet`, then `hooks/<harness>/`. One journal per
 * harness, shared by every project, because labels are scarce and the gate is per harness; the
 * project is recorded on each event as `cwd`. Appends are one `appendFile` of one line, which
 * is atomic enough for the hooks' concurrency (a few short processes per tool call).
 */
import { appendFile, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type Harness, type HookEvent, parseJournalLine } from "./event.ts";

export interface HookPaths {
  readonly home: string;
  readonly dir: string;
  readonly events: string;
  readonly ledger: string;
  readonly lock: string;
}

export function hookPaths(harness: Harness, home?: string): HookPaths {
  const root = resolve(home ?? process.env.RATCHET_HOME ?? join(homedir(), ".ratchet"));
  const dir = join(root, "hooks", harness);
  return {
    home: root,
    dir,
    events: join(dir, "events.jsonl"),
    ledger: join(dir, "ledger.jsonl"),
    lock: join(dir, "replay.lock"),
  };
}

export async function appendEvent(path: string, event: HookEvent): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

export interface ReadJournal {
  readonly events: readonly HookEvent[];
  /** Lines that did not parse as a journal event; counted, never half-read. */
  readonly rejected: number;
}

export async function readEvents(path: string): Promise<ReadJournal> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { events: [], rejected: 0 };
    throw e;
  }
  const events: HookEvent[] = [];
  let rejected = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const event = parseJournalLine(line);
    if (event === undefined) rejected++;
    else events.push(event);
  }
  return { events, rejected };
}

/** A lock older than this is assumed to belong to a process that died. */
export const LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * Serialise replays per harness, so two sessions' Stop hooks cannot both ask about the same
 * prompt. `wx` fails if the file exists; a stale file is removed and the attempt repeated once.
 */
export async function withReplayLock<T>(lockPath: string, body: () => Promise<T>): Promise<T> {
  await mkdir(join(lockPath, ".."), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      await handle.close();
      try {
        return await body();
      } finally {
        await rm(lockPath, { force: true });
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const age = Date.now() - (await stat(lockPath)).mtimeMs;
      if (age < LOCK_STALE_MS || attempt > 0) {
        throw new Error(`another replay holds ${lockPath}; try again in a few minutes`);
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new Error("unreachable");
}
