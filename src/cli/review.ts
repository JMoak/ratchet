import {
  type DecisionRecord,
  inheritOutcome,
  isMemberOf,
  JsonlLedger,
  type Outcome,
} from "../ledger/ledger.ts";
import { rng, shuffled } from "../math.ts";
import { CliError, ledgerPath, numberFlag, parseArgs, requiredString } from "./args.ts";
import { type CommandResult, findGate, groupGates, loadLedger, runCommand } from "./common.ts";

export const REVIEW_USAGE = `Usage: ratchet review <ledger> --gate <id> [--sample 20] [--seed <n>] [--reviewer <name>] [--denied]

Blind review: label a uniform random sample of one gate's decisions yourself. Each item
shows only the state the oracle saw; your answer is recorded before anything about the
model's verdict or an earlier label is shown, and those are revealed together at the end,
so neither can steer the next answer. Rows you or anyone already reviewed are not drawn
again. The sample is drawn by the seed, never chosen by hand: a hand-picked review would
be a selected sample, not evidence.

  --gate <id>          The gate to review: a judge gate whose ledger kept its states
                       (Engine keepState). Required.
  --sample <n>         How many to draw this session. Default 20.
  --seed <n>           Seed of the draw. Default: the current time, printed so the draw
                       can be repeated.
  --reviewer <name>    Recorded with each label as review:blind:<name>.
  --denied             Review every unreviewed row whose label is a denial, in ledger
                       order, instead of a random sample (--sample and --seed are then
                       ignored). Denials are rare and often judge the moment rather than
                       the call. Chosen by the person's label, never by the model's
                       verdict, so the gate's score stays unbiased; but it can only move
                       labels toward approval, so pair it with the uniform sample.

Answer y (approve), n (deny), s (skip, not recorded) or q (stop and keep what you
answered). A review replaces the row's label, the earlier one is kept in its note,
and the ledger's history keeps both.
`;

/** The terminal a review runs in. `ask` resolves undefined when input ends. */
export interface ReviewIo {
  print(text: string): void;
  ask(prompt: string): Promise<string | undefined>;
}

export const REVIEW_SOURCE = "review:blind";

interface Reviewed {
  readonly row: DecisionRecord;
  readonly truth: boolean;
}

/** Run one blind review session. The summary is the command's output; items go through `io`. */
export function review(argv: readonly string[], io?: ReviewIo): Promise<CommandResult> {
  return runCommand("review", async () => {
    const p = parseArgs(
      argv,
      { values: ["gate", "sample", "seed", "reviewer"], booleans: ["denied"] },
      "review",
    );
    const path = ledgerPath(p, "review");
    const gateKey = requiredString(p, "gate", "review");
    const size = numberFlag(p, "sample", { min: 1, max: 1_000, integer: true }, "review") ?? 20;
    const seed = numberFlag(p, "seed", { min: 0, integer: true }, "review") ?? Date.now() % 2 ** 31;
    const reviewer = p.values.get("reviewer");
    const denied = p.booleans.has("denied");
    if (io === undefined) throw new CliError("review needs an interactive terminal", "review");
    const rows = await loadLedger(path, "review");
    const gate = findGate(groupGates(rows), gateKey, "review");
    if (gate.memberOf !== undefined) {
      throw new CliError("review a battery through its gate, not one member", "review");
    }
    const pool = gate.rows.filter(
      (r) =>
        r.verdict.kind === "judge" &&
        typeof r.state === "string" &&
        !(r.outcome?.source ?? "").startsWith("review:"),
    );
    if (pool.length === 0) {
      throw new CliError(
        `gate ${gateKey} has no unreviewed judge rows with a stored state (Engine keepState)`,
        "review",
      );
    }
    const draw = denied
      ? pool.filter((r) => r.outcome?.truth === false)
      : shuffled(pool, rng(seed)).slice(0, size);
    if (denied && draw.length === 0) {
      throw new CliError(`gate ${gateKey} has no unreviewed denials`, "review");
    }
    const drawn = denied ? "every denial" : `seed ${seed}`;
    io.print(
      denied
        ? `Blind review of ${gateKey}: every unreviewed denial, ${draw.length} of ${pool.length} rows.\n`
        : `Blind review of ${gateKey}: ${draw.length} of ${pool.length} unreviewed rows, seed ${seed}.\n`,
    );
    const reviewed: Reviewed[] = [];
    for (const [i, row] of draw.entries()) {
      io.print(`\n--- ${i + 1} of ${draw.length} ---\n${row.state ?? ""}\n`);
      const answer = await answerFor(io);
      if (answer === "quit") break;
      if (answer === "skip") continue;
      reviewed.push({ row, truth: answer === "yes" });
    }
    const source = reviewer === undefined ? REVIEW_SOURCE : `${REVIEW_SOURCE}:${reviewer}`;
    await record(path, rows, reviewed, source);
    return { exitCode: 0, output: summary(gateKey, reviewed, drawn) };
  });
}

async function answerFor(io: ReviewIo): Promise<"yes" | "no" | "skip" | "quit"> {
  for (;;) {
    const raw = await io.ask("Approve? [y]es / [n]o / [s]kip / [q]uit: ");
    if (raw === undefined) return "quit";
    const a = raw.trim().toLowerCase();
    if (a === "y" || a === "yes") return "yes";
    if (a === "n" || a === "no") return "no";
    if (a === "s" || a === "skip") return "skip";
    if (a === "q" || a === "quit") return "quit";
  }
}

/** Label each reviewed row and, for a battery, every member through the battery's truth. */
async function record(
  path: string,
  rows: readonly DecisionRecord[],
  reviewed: readonly Reviewed[],
  source: string,
): Promise<void> {
  const ledger = new JsonlLedger(path);
  const at = new Date().toISOString();
  for (const { row, truth } of reviewed) {
    const previous = row.outcome;
    const outcome: Outcome = {
      at,
      correct: row.verdict.kind === "judge" && row.verdict.pYes >= 0.5 === truth,
      truth,
      source,
      ...(previous !== undefined
        ? {
            note: `replaced ${previous.source ?? "unsourced"} label truth=${String(previous.truth)}`,
          }
        : {}),
    };
    await ledger.label(row.id, outcome);
    if (row.combined !== true) continue;
    for (const member of rows.filter((m) => isMemberOf(row, m))) {
      const inherited = inheritOutcome(row, member, outcome);
      if (inherited) await ledger.label(member.id, inherited);
    }
  }
}

/** Revealed only now: how the reviewer's answers compare with the model and the earlier labels. */
function summary(gate: string, reviewed: readonly Reviewed[], drawn: string): string {
  if (reviewed.length === 0) return `No answers recorded for ${gate} (${drawn}).\n`;
  const leanAgrees = reviewed.filter(
    ({ row, truth }) => row.verdict.kind === "judge" && row.verdict.pYes >= 0.5 === truth,
  ).length;
  const withPrior = reviewed.filter(({ row }) => typeof row.outcome?.truth === "boolean");
  const priorAgrees = withPrior.filter(({ row, truth }) => row.outcome?.truth === truth).length;
  const lines = [
    `Recorded ${reviewed.length} blind ${reviewed.length === 1 ? "label" : "labels"} for ${gate} (${drawn}).`,
    `Your answer matched the model's lean on ${leanAgrees} of ${reviewed.length}.`,
    withPrior.length > 0
      ? `It matched the earlier label on ${priorAgrees} of ${withPrior.length}.`
      : "None of these rows had an earlier label.",
  ];
  const changed = withPrior.filter(({ row, truth }) => row.outcome?.truth !== truth);
  for (const { row, truth } of changed) {
    lines.push(
      `  ${row.id.slice(0, 8)}: was ${String(row.outcome?.truth)} (${row.outcome?.source ?? "unsourced"}), now ${truth}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
