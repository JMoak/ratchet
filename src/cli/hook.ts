/**
 * `ratchet hook <harness> ...`: shadow an agent harness's permission prompts.
 *
 *   event    the hook itself: one event from stdin, appended to the journal; prints nothing
 *   install  the settings to paste, and what they do
 *   status   what the journal holds and how the prompts resolved
 *   replay   settled prompts through the gate in shadow (dry run unless --live)
 *
 * `event` must never get in the harness's way: whatever stdin holds, it exits 0 with no stdout,
 * because a synchronous hook's stdout is parsed as its decision and a non-zero exit is reported
 * to the person. Rejected input is noted in `rejected.log` beside the journal.
 */
import { appendFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Engine } from "../engine.ts";
import { EVENTS_FOR, type Harness, isHarness, parseHookInput } from "../hook/event.ts";
import { hookGateId, hookGateSpec } from "../hook/gate.ts";
import { ingestPrompts } from "../hook/ingest.ts";
import { installText } from "../hook/install.ts";
import {
  appendEvent,
  type HookPaths,
  hookPaths,
  readEvents,
  withReplayLock,
} from "../hook/journal.ts";
import { type PromptOutcome, resolvePrompts } from "../hook/resolve.ts";
import { promptState } from "../hook/state.ts";
import { JsonlLedger } from "../ledger/ledger.ts";
import { jev, jevViaOpenRouter } from "../oracles/systemone.ts";
import type { Oracle } from "../types.ts";
import { CliError, numberFlag, parseArgs } from "./args.ts";
import { type CommandResult, runCommand } from "./common.ts";

export const HOOK_USAGE = `Usage: ratchet hook <claude-code|codex> <event|install|status|replay> [options]

Shadow the harness's permission prompts: record each prompt, whether the call then ran, and
when the session ended; replay the prompts through the agent.tool gate in shadow; label each
row with the answer the person gave. Nothing is enforced and no prompt changes.

  event              Read one hook event from stdin and append it to the journal. For the
                     harness's hook configuration only; always exits 0 and prints nothing.
  install            Print the hook settings to paste and what they record.
  status             Count events, sessions and prompts, and how each prompt resolved.
  replay             Ask the gate about every settled prompt not yet in the ledger. A dry run
                     prints the exact text the gate would see; --live asks the oracle.

Options:
  --home <dir>       Where journals and ledgers live. Default $RATCHET_HOME or ~/.ratchet.
  --ledger <path>    replay: write to this ledger instead of the harness's own.
  --live             replay: ask the oracle (TYPESAFE_API_KEY or OPENROUTER_API_KEY).
  --budget <usd>     replay: spend cap per UTC day, read from the ledger. Default 0.05.

Exit codes: 0 ok, 2 usage error or unreadable journal. \`event\` always exits 0.
`;

export interface HookIo {
  /** The hook's stdin. Default: the process's stdin, or "" when it is a terminal. */
  readonly stdin?: () => Promise<string>;
  /** replay --live: the oracle to ask. Default: Jev from the environment. */
  readonly oracle?: Oracle;
  readonly now?: () => string;
}

export async function hook(argv: readonly string[], io: HookIo = {}): Promise<CommandResult> {
  return runCommand("hook", async () => {
    const p = parseArgs(
      argv,
      { values: ["home", "ledger", "budget"], booleans: ["live", "help"] },
      "hook",
    );
    if (p.booleans.has("help")) return { exitCode: 0, output: HOOK_USAGE };
    const [harness, verb, ...rest] = p.positionals;
    if (harness === undefined) throw new CliError("missing <harness>", "hook");
    if (!isHarness(harness))
      throw new CliError(`unknown harness "${harness}"; use claude-code or codex`, "hook");
    if (verb === undefined) throw new CliError("missing <event|install|status|replay>", "hook");
    if (rest.length > 0) throw new CliError(`unexpected argument "${rest[0]}"`, "hook");
    const paths = hookPaths(harness, p.values.get("home"));
    switch (verb) {
      case "event":
        return event(harness, paths, io);
      case "install":
        return { exitCode: 0, output: installText(harness, paths) };
      case "status":
        return status(harness, paths);
      case "replay": {
        const budget = numberFlag(p, "budget", { min: 0, above: true, max: 1 }, "hook") ?? 0.05;
        return replay(harness, paths, {
          live: p.booleans.has("live"),
          budgetUsd: budget,
          ...(p.values.has("ledger") ? { ledger: p.values.get("ledger") as string } : {}),
          io,
        });
      }
      default:
        throw new CliError(`unknown subcommand "${verb}"`, "hook");
    }
  });
}

async function readProcessStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

const SILENT: CommandResult = { exitCode: 0, output: "" };

/** Why an event was not journaled, for the person to read; the harness never sees it. */
async function note(paths: HookPaths, reason: string): Promise<void> {
  await mkdir(paths.dir, { recursive: true });
  await appendFile(
    join(paths.dir, "rejected.log"),
    `${new Date().toISOString()} ${reason}
`,
  );
}

async function event(harness: Harness, paths: HookPaths, io: HookIo): Promise<CommandResult> {
  try {
    const raw = await (io.stdin ?? readProcessStdin)();
    if (raw.trim() === "") return SILENT;
    const parsed = parseHookInput(raw, harness, io.now);
    if ("reason" in parsed) {
      await mkdir(paths.dir, { recursive: true });
      await appendFile(
        join(paths.dir, "rejected.log"),
        `${new Date().toISOString()} ${parsed.reason}\n`,
      );
      return SILENT;
    }
    await appendEvent(paths.events, parsed.event);
  } catch (e) {
    // A hook that fails must fail quietly: the harness is mid tool call. Leave a note instead.
    await note(paths, `error: ${e instanceof Error ? e.message : String(e)}`).catch(
      () => undefined,
    );
  }
  return SILENT;
}

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

async function status(harness: Harness, paths: HookPaths): Promise<CommandResult> {
  const journal = await readEvents(paths.events);
  const r = resolvePrompts(journal.events);
  const count = (label: PromptOutcome["label"]): number =>
    r.outcomes.filter((o) => o.label === label).length;
  const byTool = new Map<string, number>();
  for (const o of r.outcomes)
    byTool.set(o.prompt.tool ?? "?", (byTool.get(o.prompt.tool ?? "?") ?? 0) + 1);
  const ledgerRows = (await exists(paths.ledger)) ? await new JsonlLedger(paths.ledger).all() : [];
  const labelled = ledgerRows.filter((row) => row.outcome !== undefined).length;
  const kinds = new Map<string, number>();
  for (const e of journal.events) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
  const lines = [
    `# ratchet hook ${harness}: status`,
    "",
    `Journal: ${paths.events}`,
    journal.events.length === 0
      ? `No events yet. Hooks to register: ${EVENTS_FOR[harness].join(", ")} (run \`ratchet hook ${harness} install\`).`
      : `${journal.events.length} events across ${r.sessions} sessions (${r.sessionsEnded} ended)` +
        `${journal.rejected > 0 ? `; ${journal.rejected} lines rejected` : ""}: ` +
        [...kinds].map(([k, n]) => `${n} ${k}`).join(", ") +
        ".",
    "",
    "| prompts | allowed | denied | open | classifier | runs without a prompt |",
    "| --- | --- | --- | --- | --- | --- |",
    `| ${r.outcomes.length} | ${count("allowed")} | ${count("denied")} | ${count("open")} | ${count("classifier")} | ${r.runsWithoutPrompt} |`,
    "",
    ...(byTool.size > 0
      ? [`Prompts by tool: ${[...byTool].map(([t, n]) => `${t} ${n}`).join(", ")}.`, ""]
      : []),
    `Ledger: ${paths.ledger}: ${ledgerRows.length} rows, ${labelled} labelled.`,
    "",
    "allowed: the prompted call ran. denied: it never ran before the turn moved on or the session",
    "ended (a blind review decides whether that judged the call or the moment). open: no signal",
    "yet. classifier: the harness's own classifier settled it, so no person did.",
    "",
  ];
  return { exitCode: 0, output: lines.join("\n") };
}

interface ReplayOptions {
  readonly live: boolean;
  readonly budgetUsd: number;
  readonly ledger?: string;
  readonly io: HookIo;
}

function liveOracle(): Oracle {
  const options = { maxRetries: 0 } as const;
  if (process.env.TYPESAFE_API_KEY) return jev(options);
  if (process.env.OPENROUTER_API_KEY) return jevViaOpenRouter(options);
  throw new CliError(
    "--live needs TYPESAFE_API_KEY or OPENROUTER_API_KEY in the environment",
    "hook",
  );
}

async function replay(
  harness: Harness,
  paths: HookPaths,
  opts: ReplayOptions,
): Promise<CommandResult> {
  const journal = await readEvents(paths.events);
  const r = resolvePrompts(journal.events);
  const settled = r.outcomes.filter((o) => o.label === "allowed" || o.label === "denied");
  const ledgerPath = opts.ledger ?? paths.ledger;
  const head = [
    `${journal.events.length} events; ${r.outcomes.length} prompts, ${settled.length} settled by a person, ` +
      `${r.outcomes.filter((o) => o.label === "open").length} open.`,
  ];
  if (!opts.live) {
    const first = settled[0];
    const sample =
      first === undefined
        ? ["", "No settled prompt to show yet."]
        : [
            "",
            "Dry run. This is the exact text the gate would send for the earliest settled prompt:",
            "",
            promptState(first.prompt).text,
          ];
    return {
      exitCode: 0,
      output: [
        ...head,
        ...sample,
        "",
        "Nothing was sent or written. Add --live to ask the oracle in shadow.",
        "",
      ].join("\n"),
    };
  }
  const oracle = opts.io.oracle ?? liveOracle();
  await mkdir(join(ledgerPath, ".."), { recursive: true });
  return withReplayLock(paths.lock, async () => {
    const engine = new Engine({
      oracle,
      ledger: new JsonlLedger(ledgerPath),
      mode: "shadow",
      keepState: true,
      dailyBudgetUsd: opts.budgetUsd,
      reserveUsd: 0.001,
    });
    const gate = engine.gate(hookGateSpec(harness));
    const result = await ingestPrompts(engine, gate, harness, r.outcomes);
    const lines = [
      ...head,
      `Asked ${result.asked}; ${result.already} already in the ledger; ${result.open} still open; ` +
        `${result.classifier} settled by a classifier. Recorded spend $${engine.spent.toFixed(6)}.`,
      ...(result.stoppedAtBudget
        ? [
            `Stopped at the daily spend cap ($${opts.budgetUsd} a UTC day); run again tomorrow or raise --budget.`,
          ]
        : []),
      "",
      `Ledger: ${ledgerPath}`,
      `Next: ratchet report ${ledgerPath}`,
      `      ratchet review ${ledgerPath} --gate ${hookGateId(harness)} --denied`,
      "",
    ];
    return { exitCode: 0, output: lines.join("\n") };
  });
}
