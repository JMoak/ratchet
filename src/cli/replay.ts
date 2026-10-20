import { actWasRight, inferGoIsYes, isUnselected, recordedGoIsYes } from "../ledger/calibration.ts";
import type { DecisionRecord } from "../ledger/ledger.ts";
import { type GatePolicy, rule } from "../policy.ts";
import { type Action, CAUTION, type Decision } from "../types.ts";
import {
  booleanValue,
  CliError,
  ledgerPath,
  numberFlag,
  parseArgs,
  requiredNumber,
  requiredString,
} from "./args.ts";
import {
  type CommandResult,
  findGate,
  type GateGroup,
  groupGates,
  isFixed,
  loadLedger,
  pct,
  runCommand,
  table,
} from "./common.ts";

export const REPLAY_USAGE = `Usage: ratchet replay <ledger> --gate <id> --act-above <p> [--refuse-below <p>] [--go-is-yes true|false] [--json]

What would this bar have done on the traffic already in the ledger? Re-rules every
recorded verdict of one gate under a new policy with rule(), without calling an oracle
(the ledger keeps full distributions), and prints how many rows change action and in
which direction, and on labelled rows the coverage and accuracy the new policy would
have delivered next to the recorded one.

  --gate <id>            The gate to replay. Required.
  --act-above <p>        New act bar on the probability that acting is right. Required.
  --refuse-below <p>     Refuse at or below this. Omit to review instead.
  --go-is-yes <bool>     For judge questions, does yes mean go? Default: whatever the
                         recorded rows were ruled with (read from each row's go).
  --json                 JSON instead of markdown.

"Recorded" is the ruling the ledger holds for each row (soft), not what the application
did with it. Rows a floor or an allowlist decided without a call keep their recorded
action, since no answer exists to re-rule. Failed-open rows take the policy's default,
review. A floor that raised caution on an answered row is not stored on the row, so it
cannot be reapplied.
`;

export interface ReplayOptions {
  readonly gate: string;
  readonly actAbove: number;
  readonly refuseBelow?: number;
  readonly goIsYes?: boolean;
}

/** What one policy delivers on a slice of labelled rows. */
export interface SliceOutcome {
  readonly rows: number;
  readonly acted: number;
  /** Share of the slice acted on. */
  readonly coverage: number;
  /** Share of acted rows where acting was right; absent when nothing was acted on. */
  readonly accuracy?: number;
  readonly wrongActs: number;
  readonly refused: number;
  /** Refused rows where acting would have been right. */
  readonly wrongRefusals: number;
}

export interface ReplayResult {
  readonly gate: string;
  readonly rows: number;
  readonly policy: GatePolicy;
  /** Where the judge polarity came from. */
  readonly goIsYesFrom: "flag" | "recorded rows" | "default";
  readonly actions: {
    readonly recorded: Readonly<Record<Action, number>>;
    readonly replayed: Readonly<Record<Action, number>>;
  };
  /** Rows kept as recorded because a floor or an allowlist fixed them. */
  readonly fixed: number;
  readonly changed: number;
  readonly moreCautious: number;
  readonly lessCautious: number;
  readonly transitions: readonly {
    readonly from: Action;
    readonly to: Action;
    readonly rows: number;
  }[];
  /** Labelled rows that did not fail open. */
  readonly labelled: { readonly recorded: SliceOutcome; readonly replayed: SliceOutcome };
  /** The same, on unselected rows only; present when that is a smaller slice. */
  readonly unselected?: { readonly recorded: SliceOutcome; readonly replayed: SliceOutcome };
}

const ORDER: readonly Action[] = ["act", "review", "refuse"];

/** A ledger row back in the shape `rule()` takes. */
const decisionOf = (r: DecisionRecord): Decision => ({
  verdict: r.verdict,
  oracle: r.oracle,
  latencyMs: r.latencyMs,
  cost: r.cost,
  at: r.at,
  ...(r.model !== undefined ? { model: r.model } : {}),
  ...(r.failedOpen ? { failedOpen: true } : {}),
});

interface Replayed {
  readonly row: DecisionRecord;
  readonly recorded: Action;
  readonly replayed: Action;
  readonly recordedGoIsYes: boolean;
}

function outcomeOf(
  items: readonly Replayed[],
  pickAction: (x: Replayed) => Action,
  goIsYes: (x: Replayed) => boolean,
): SliceOutcome {
  let acted = 0;
  let right = 0;
  let refused = 0;
  let wrongRefusals = 0;
  for (const x of items) {
    const a = pickAction(x);
    const ok = actWasRight(x.row, goIsYes(x)) === true;
    if (a === "act") {
      acted++;
      if (ok) right++;
    } else if (a === "refuse") {
      refused++;
      if (ok) wrongRefusals++;
    }
  }
  return {
    rows: items.length,
    acted,
    coverage: items.length === 0 ? 0 : acted / items.length,
    ...(acted > 0 ? { accuracy: right / acted } : {}),
    wrongActs: acted - right,
    refused,
    wrongRefusals,
  };
}

/** Re-rule one gate's rows under a new policy. Pure: no oracle, no file. */
export function replayGate(groups: readonly GateGroup[], opts: ReplayOptions): ReplayResult {
  if (opts.refuseBelow !== undefined && opts.refuseBelow >= opts.actAbove) {
    throw new CliError("--refuse-below must be below --act-above", "replay");
  }
  const group = findGate(groups, opts.gate, "replay");
  const rows = group.rows;
  const inferred = inferGoIsYes(rows);
  const goIsYes = opts.goIsYes ?? inferred.goIsYes;
  const goIsYesFrom =
    opts.goIsYes !== undefined ? "flag" : inferred.evidence > 0 ? "recorded rows" : "default";
  const policy: GatePolicy = {
    actAbove: opts.actAbove,
    ...(opts.refuseBelow !== undefined ? { refuseBelow: opts.refuseBelow } : {}),
    goIsYes,
  };
  const replayed: Replayed[] = rows.map((row) => ({
    row,
    recorded: row.soft,
    replayed: isFixed(row) ? row.soft : rule(decisionOf(row), policy, row.floor).action,
    recordedGoIsYes: recordedGoIsYes(row) ?? inferred.goIsYes,
  }));
  const count = (pickAction: (x: Replayed) => Action) => {
    const c: Record<Action, number> = { act: 0, review: 0, refuse: 0 };
    for (const x of replayed) c[pickAction(x)]++;
    return c;
  };
  const moves = new Map<string, { from: Action; to: Action; rows: number }>();
  let moreCautious = 0;
  let lessCautious = 0;
  for (const x of replayed) {
    if (x.recorded === x.replayed) continue;
    if (CAUTION[x.replayed] > CAUTION[x.recorded]) moreCautious++;
    else lessCautious++;
    const k = `${x.recorded}>${x.replayed}`;
    const m = moves.get(k) ?? { from: x.recorded, to: x.replayed, rows: 0 };
    m.rows++;
    moves.set(k, m);
  }
  const transitions = [...moves.values()].sort(
    (a, b) =>
      ORDER.indexOf(a.from) - ORDER.indexOf(b.from) || ORDER.indexOf(a.to) - ORDER.indexOf(b.to),
  );
  const labelled = replayed.filter((x) => x.row.outcome && !x.row.failedOpen);
  const unselected = labelled.filter((x) => isUnselected(x.row));
  const both = (items: readonly Replayed[]) => ({
    recorded: outcomeOf(
      items,
      (x) => x.recorded,
      (x) => x.recordedGoIsYes,
    ),
    replayed: outcomeOf(
      items,
      (x) => x.replayed,
      () => goIsYes,
    ),
  });
  return {
    gate: group.key,
    rows: rows.length,
    policy,
    goIsYesFrom,
    actions: { recorded: count((x) => x.recorded), replayed: count((x) => x.replayed) },
    fixed: rows.filter(isFixed).length,
    changed: moreCautious + lessCautious,
    moreCautious,
    lessCautious,
    transitions,
    labelled: both(labelled),
    ...(unselected.length < labelled.length ? { unselected: both(unselected) } : {}),
  };
}

function describePolicy(r: ReplayResult): string {
  const p = r.policy;
  const refuse =
    p.refuseBelow !== undefined ? `, refuse at or below ${p.refuseBelow}` : ", never refuse";
  const polarity =
    r.goIsYesFrom === "default"
      ? ""
      : `; ${p.goIsYes ? "yes" : "no"} means go (${r.goIsYesFrom === "flag" ? "from --go-is-yes" : "as the recorded rows were ruled"})`;
  return `act at or above ${p.actAbove}${refuse}${polarity}`;
}

function sliceTable(s: { recorded: SliceOutcome; replayed: SliceOutcome }): string {
  const row = (name: string, o: SliceOutcome) => [
    name,
    String(o.acted),
    pct(o.coverage),
    pct(o.accuracy),
    String(o.wrongActs),
    String(o.refused),
    String(o.wrongRefusals),
  ];
  return table(
    ["policy", "acted", "coverage", "accuracy", "wrong acts", "refused", "wrong refusals"],
    [row("recorded", s.recorded), row("replayed", s.replayed)],
  );
}

export function renderReplay(ledger: string, r: ReplayResult): string {
  const out: string[] = [];
  out.push(`# ratchet replay: ${r.gate}`, "");
  out.push(
    `${r.rows} rows from ${ledger}, re-ruled without oracle calls. New policy: ${describePolicy(r)}.`,
  );
  if (r.fixed > 0) {
    out.push(`${r.fixed} rows fixed by a floor or an allowlist keep their recorded action.`);
  }
  out.push("", "## Actions", "");
  out.push(
    table(
      ["action", "recorded", "replayed"],
      ORDER.map((a) => [a, String(r.actions.recorded[a]), String(r.actions.replayed[a])]),
    ),
  );
  out.push("", "## Changes", "");
  out.push(
    `${r.changed} of ${r.rows} rows change action: ${r.moreCautious} more cautious, ${r.lessCautious} less cautious.`,
  );
  if (r.transitions.length > 0) {
    out.push("");
    out.push(
      table(
        ["from", "to", "rows"],
        r.transitions.map((t) => [t.from, t.to, String(t.rows)]),
      ),
    );
  }
  out.push("", `## On ${r.labelled.recorded.rows} labelled rows`, "");
  if (r.labelled.recorded.rows === 0) out.push("No labelled rows: nothing to score.");
  else out.push(sliceTable(r.labelled));
  if (r.unselected) {
    out.push("", `## On ${r.unselected.recorded.rows} unselected labelled rows`, "");
    out.push(
      "Shadow rows and blind audits only: the slice the recorded policy's confidence did not pick.",
    );
    out.push("", sliceTable(r.unselected));
  }
  out.push(
    "",
    "Coverage is the share of the slice acted on; accuracy is the share of acted rows where " +
      "acting was right. A wrong refusal is a refused row where acting would have been right.",
  );
  return `${out.join("\n")}\n`;
}

export function replay(argv: readonly string[]): Promise<CommandResult> {
  return runCommand("replay", async () => {
    const p = parseArgs(
      argv,
      { values: ["gate", "act-above", "refuse-below", "go-is-yes"], booleans: ["json", "help"] },
      "replay",
    );
    if (p.booleans.has("help")) return { exitCode: 0, output: REPLAY_USAGE };
    const path = ledgerPath(p, "replay");
    const gate = requiredString(p, "gate", "replay");
    const actAbove = requiredNumber(p, "act-above", { min: 0, max: 1 }, "replay");
    const refuseBelow = numberFlag(p, "refuse-below", { min: 0, max: 1 }, "replay");
    const goIsYes = booleanValue(p, "go-is-yes", "replay");
    const rows = await loadLedger(path, "replay");
    const r = replayGate(groupGates(rows), {
      gate,
      actAbove,
      ...(refuseBelow !== undefined ? { refuseBelow } : {}),
      ...(goIsYes !== undefined ? { goIsYes } : {}),
    });
    const output = p.booleans.has("json")
      ? `${JSON.stringify({ ledger: path, ...r }, null, 2)}\n`
      : renderReplay(path, r);
    return { exitCode: 0, output };
  });
}
