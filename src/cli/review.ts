import { actWasRight, inferGoIsYes, recordedGoIsYes } from "../ledger/calibration.ts";
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

export const REVIEW_USAGE = `Usage: ratchet review <ledger> --gate <id> [--sample 20] [--seed <n>] [--reviewer <name>] [--denied | --audits]

Blind review: label a uniform random sample of one gate's decisions yourself. Each item
shows the question the gate asks and the state the oracle saw, and asks for that question's
answer; your answer is recorded before anything about the model's verdict or an earlier
label is shown, and those are revealed together at the end, so neither can steer the next
answer. Rows you or anyone already reviewed are not drawn again. The sample is drawn by the
seed, never chosen by hand: a hand-picked review would be a selected sample, not evidence.

  --gate <id>          The gate to review: a judge gate whose ledger kept its states
                       (Engine keepState). Required.
  --sample <n>         How many to draw this session. Default 20.
  --seed <n>           Seed of the draw. Default: the current time, printed so the draw
                       can be repeated.
  --reviewer <name>    Recorded with each label as review:blind:<name>.
  --denied             Review every unreviewed row whose label says acting was wrong (a
                       denial), in ledger order, instead of a random sample (--sample and
                       --seed are then ignored). The label is read through the row's own
                       polarity, so on a gate whose question is "does this need action?"
                       a denial is a yes. Denials are rare and often judge the moment
                       rather than the call. Chosen by the person's label, never by the
                       model's verdict, so the gate's score stays unbiased; but it can only
                       move labels toward acting, so pair it with the uniform sample.
  --audits             Review every unreviewed blind audit (rows tagged audit: acts an
                       enforcing gate diverted to review at random), in ledger order. They
                       are the labels that can demote an enforcing gate.

Answer the question: y (yes), n (no), s (skip, not recorded) or q (stop and keep what you
answered). Your answer is the row's truth for that question. A battery asks each member's
question in turn and records each answer as that member's own truth; the battery's truth is
the OR of them for an "any" battery and the AND for an "all" one, and otherwise one last
question asks whether acting on the row was right. A review replaces the row's label, the
earlier one is kept in its note, and the ledger's history keeps both.
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
  /** A battery's members, each answered on its own question; absent members were skipped. */
  readonly memberTruths?: Readonly<Record<string, boolean>>;
}

/**
 * Which answer is "go" for a row: the one it was ruled with (`recordedGoIsYes`), else the one
 * its policy's other rows were ruled with (same `policyHash`; a failed-open or exactly-even
 * row records none of its own), else the gate's majority. A gate whose policy flipped polarity
 * mid-life reads each row by its own policy.
 */
function goPolarity(rows: readonly DecisionRecord[]): (r: DecisionRecord) => boolean {
  const byPolicy = new Map<string, { yes: number; no: number }>();
  for (const r of rows) {
    const g = recordedGoIsYes(r);
    if (g === undefined || r.policyHash === undefined) continue;
    const c = byPolicy.get(r.policyHash) ?? { yes: 0, no: 0 };
    if (g) c.yes++;
    else c.no++;
    byPolicy.set(r.policyHash, c);
  }
  const gate = inferGoIsYes(rows).goIsYes;
  return (r) => {
    const own = recordedGoIsYes(r);
    if (own !== undefined) return own;
    const c = r.policyHash === undefined ? undefined : byPolicy.get(r.policyHash);
    return c === undefined || c.yes === c.no ? gate : c.yes > c.no;
  };
}

/**
 * Review one battery row: every member's question in turn, then the battery's own truth. For
 * `any` it is the OR of the members' answers and for `all` the AND, once the answers given
 * settle it; otherwise (another combiner, or skips that leave it open) one last question asks
 * whether acting was right, read through the gate's polarity. Skipping that question skips
 * the item.
 */
async function reviewBattery(
  io: ReviewIo,
  row: DecisionRecord,
  rows: readonly DecisionRecord[],
  gateKey: string,
  goIsYes: boolean,
): Promise<Reviewed | "skip" | "quit"> {
  const members = rows.filter((m) => isMemberOf(row, m));
  io.print(
    `Questions (one per member):\n${members.map((m) => `  ${m.questionId}: ${m.prompt}`).join("\n")}\n`,
  );
  const memberTruths: Record<string, boolean> = {};
  for (const m of members) {
    const answer = await answerFor(io, `${m.questionId}: ${shortQuestion(m.prompt)}`);
    if (answer === "quit") return "quit";
    if (answer === "yes" || answer === "no") memberTruths[m.questionId] = answer === "yes";
  }
  const given = Object.values(memberTruths);
  const all = given.length === members.length && members.length > 0;
  const combine = row.detail?.combine;
  let truth: boolean | undefined;
  if (combine === "any") truth = given.some((t) => t) ? true : all ? false : undefined;
  else if (combine === "all") truth = given.some((t) => !t) ? false : all ? true : undefined;
  if (truth === undefined) {
    const side = goIsYes ? "yes" : "no";
    const answer = await answerFor(
      io,
      `Overall, should ${gateKey} act on this (it acts when its combined answer is ${side})?`,
    );
    if (answer === "quit") return "quit";
    if (answer === "skip") return "skip";
    truth = answer === "yes" ? goIsYes : !goIsYes;
  }
  return { row, truth, memberTruths };
}

/**
 * The question as a one-line prompt: its first sentence when that is a question, cut at 160
 * characters. A rubric's later sentences are printed in full before the item.
 */
export function shortQuestion(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  const first = /^.*?\?(?=\s|$)/.exec(flat)?.[0] ?? flat.replace(/[.:;!]+$/, "");
  const line = first.length > 160 ? `${first.slice(0, 157).trimEnd()}...` : first;
  return line.endsWith("?") || line.endsWith("...") ? line : `${line}?`;
}

/** Run one blind review session. The summary is the command's output; items go through `io`. */
export function review(argv: readonly string[], io?: ReviewIo): Promise<CommandResult> {
  return runCommand("review", async () => {
    const p = parseArgs(
      argv,
      { values: ["gate", "sample", "seed", "reviewer"], booleans: ["denied", "audits"] },
      "review",
    );
    const path = ledgerPath(p, "review");
    const gateKey = requiredString(p, "gate", "review");
    const size = numberFlag(p, "sample", { min: 1, max: 1_000, integer: true }, "review") ?? 20;
    const seed = numberFlag(p, "seed", { min: 0, integer: true }, "review") ?? Date.now() % 2 ** 31;
    const reviewer = p.values.get("reviewer");
    const denied = p.booleans.has("denied");
    const audits = p.booleans.has("audits");
    if (denied && audits)
      throw new CliError("--denied and --audits are separate queues; pick one", "review");
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
    const polarityOf = goPolarity(gate.rows);
    const actingWasWrong = (r: DecisionRecord): boolean => actWasRight(r, polarityOf(r)) === false;
    const draw = denied
      ? pool.filter(actingWasWrong)
      : audits
        ? pool.filter((r) => r.tags.includes("audit"))
        : shuffled(pool, rng(seed)).slice(0, size);
    if (denied && draw.length === 0) {
      throw new CliError(`gate ${gateKey} has no unreviewed denials`, "review");
    }
    if (audits && draw.length === 0) {
      throw new CliError(`gate ${gateKey} has no unreviewed audits`, "review");
    }
    const drawn = denied ? "every denial" : audits ? "every audit" : `seed ${seed}`;
    const prompts = new Set(draw.map((r) => r.prompt));
    const shared =
      prompts.size === 1 && !draw.some((r) => r.combined === true)
        ? (draw[0]?.prompt as string)
        : undefined;
    io.print(
      `${
        denied
          ? `Blind review of ${gateKey}: every unreviewed denial, ${draw.length} of ${pool.length} rows.`
          : audits
            ? `Blind review of ${gateKey}: every unreviewed audit, ${draw.length} of ${pool.length} rows.`
            : `Blind review of ${gateKey}: ${draw.length} of ${pool.length} unreviewed rows, seed ${seed}.`
      }\n${shared === undefined ? "" : `Question: ${shared}\n`}`,
    );
    const reviewed: Reviewed[] = [];
    for (const [i, row] of draw.entries()) {
      // The state block is printed on its own, exactly; harnesses parse it.
      io.print(`\n--- ${i + 1} of ${draw.length} ---\n${row.state ?? ""}\n`);
      if (row.combined === true) {
        const done = await reviewBattery(io, row, rows, gateKey, polarityOf(row));
        if (done === "quit") break;
        if (done !== "skip") reviewed.push(done);
        continue;
      }
      if (shared === undefined) io.print(`Question: ${row.prompt}\n`);
      const answer = await answerFor(io, shortQuestion(row.prompt));
      if (answer === "quit") break;
      if (answer === "skip") continue;
      reviewed.push({ row, truth: answer === "yes" });
    }
    const source = reviewer === undefined ? REVIEW_SOURCE : `${REVIEW_SOURCE}:${reviewer}`;
    await record(path, rows, reviewed, source);
    return { exitCode: 0, output: summary(gateKey, reviewed, drawn) };
  });
}

async function answerFor(io: ReviewIo, question: string): Promise<"yes" | "no" | "skip" | "quit"> {
  for (;;) {
    const raw = await io.ask(`${question} [y]es / [n]o / [s]kip / [q]uit: `);
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
  for (const { row, truth, memberTruths } of reviewed) {
    const previous = row.outcome;
    const outcome: Outcome = {
      at,
      correct: row.verdict.kind === "judge" && row.verdict.pYes >= 0.5 === truth,
      truth,
      source,
      ...(memberTruths === undefined ? {} : { memberTruths }),
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
