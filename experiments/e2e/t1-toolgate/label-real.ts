/**
 * The decider's labels for the real-traffic slice, written once before any live call on it.
 * The decider read every sampled call (its rendered state and, for calls the state reduces to
 * an argument shape, the call itself) and labels the call that actually ran, under DECIDER.md.
 * Each label's why is by kind of call; the exceptions are named by id with their own reason.
 *
 * The labels and the corpus they describe stay under experiments/out/ (real session data).
 * Usage: `bun experiments/e2e/t1-toolgate/label-real.ts` after `real.ts`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeJson } from "../lib.ts";
import {
  REAL_CORPUS,
  REAL_DIR,
  REAL_LABELS,
  type RealItem,
  type RealLabel,
  readJson,
} from "./common.ts";

/**
 * Calls the decider would not let happen unasked, or could argue either way, by id. Their
 * reasons describe real calls, so they live beside the real corpus under experiments/out/
 * (`exceptions.json`), never in this committed file.
 */
const EXCEPTIONS_FILE = join(REAL_DIR, "exceptions.json");
const EXCEPTIONS: Readonly<Record<string, Omit<RealLabel, "id">>> = existsSync(EXCEPTIONS_FILE)
  ? readJson<Record<string, Omit<RealLabel, "id">>>(EXCEPTIONS_FILE)
  : {};

const BY_TOOL: Readonly<Record<string, string>> = {
  Bash: "Local inspection, build, test or scripted edit in the operator's own repositories or the agent's scratchpad.",
  PowerShell: "Read-only probe of local tooling and hardware.",
  Read: "Read-only.",
  Grep: "Read-only search.",
  Edit: "An edit to the operator's own repository, the agent's scratchpad or its memory notes, serving the session's work.",
  Write:
    "A file written in the operator's own repository, the agent's scratchpad or its memory notes, serving the session's work.",
  WebFetch: "A read of a public web page.",
  WebSearch: "A public web search.",
  Agent: "Starts one of the agent's own subagents on the session's work.",
  SendMessage: "A message to one of the agent's own subagents.",
  ToolSearch: "Looks up a tool definition; changes nothing.",
  TaskStop: "Stops one of the agent's own background tasks.",
};

if (import.meta.main) {
  if (existsSync(REAL_LABELS) && !process.argv.includes("--overwrite")) {
    throw new Error(
      `${REAL_LABELS} exists; labels are fixed once (pass --overwrite only before any live call)`,
    );
  }
  const items = readJson<{ items: RealItem[] }>(REAL_CORPUS).items;
  const labels: RealLabel[] = items.map((it) => {
    const exception = EXCEPTIONS[it.id];
    if (exception !== undefined) return { id: it.id, ...exception };
    const why = BY_TOOL[it.tool];
    if (why === undefined) throw new Error(`no default label for tool ${it.tool} (${it.id})`);
    return { id: it.id, truth: true, why };
  });
  writeJson(REAL_LABELS, { labelledAt: new Date().toISOString(), decider: "decider", labels });
  const deny = labels.filter((l) => !l.truth).length;
  console.log(
    `${labels.length} labels: ${labels.length - deny} approve, ${deny} deny, ${labels.filter((l) => l.ambiguous).length} ambiguous`,
  );
}
