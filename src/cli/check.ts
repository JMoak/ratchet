import type { ActBar } from "../ledger/bars.ts";
import {
  actWasRight,
  ece,
  inferGoIsYes,
  isUnselected,
  recordedGoIsYes,
  scoredFromLedger,
} from "../ledger/calibration.ts";
import {
  atLeast,
  type BorrowedVia,
  currentConfiguration,
  describeGrade,
  describeStray,
  type EvidenceGrade,
  type FittedFrom,
  type StrayQuestion,
  strayQuestions,
} from "../ledger/evidence.ts";
import type { DecisionRecord } from "../ledger/ledger.ts";
import type { CalibrationProfile } from "../ledger/profile.ts";
import { COUNTED_SOURCES, type TrustClass, trustRegistry } from "../ledger/sources.ts";
import {
  CliError,
  ledgerPath,
  numberFlag,
  parseArgs,
  requiredNumber,
  requiredString,
  trustFlag,
} from "./args.ts";
import {
  answered,
  byTime,
  type CommandResult,
  countBy,
  dec,
  findGate,
  type GateGroup,
  groupEvidence,
  groupGates,
  isFixed,
  loadLedger,
  modelOf,
  pct,
  requestIdOf,
  runCommand,
} from "./common.ts";
import { readProfiles } from "./profile.ts";

export const CHECK_USAGE = `Usage: ratchet check <ledger> --gate <id> --promise <p> [--require measured|estimated] [--min-rows 30] [--min-estimated 30] [--max-ece <e>] [--model <id>] [--window 500] [--trust <prefix>=<class> ...] [--profile <file> ...] [--min-support 30]

The CI gate. Fails when the gate's evidence grade is weaker than --require, or when, in
the most recent --window rows of the gate:

  - accuracy on the rows the policy acted on, among unselected rows (shadow rows and
    blind audits) of the gate's current configuration, is below --promise, with at
    least --min-rows such rows;
  - ECE is above --max-ece, with at least --min-rows labelled rows of the current
    configuration (unselected rows when there are enough, else all labelled rows);
  - a model other than --model answered any row in the window.

The current configuration is the policy and evidence version of the gate's newest row, with
each question at the newest rubric recorded for it. Rows recorded under an older one
describe a gate that no longer answers: they are counted on the line and never read, so a
changed rubric or policy starts with no evidence.

The line also carries the gate's fitted act bar, as "ratchet report" fits it: the lowest
probability that acting is right at which the lower end of a 95% Wilson interval of acting
right (a one-sided 97.5% bound) reaches
--promise, with at least --min-support rows at or above it. It never fails the check; it
says where the gate could act.

The grade required is measured when the gate's newest row enforces, and estimated while
the gate is in shadow, including after a demotion: a gate acting on its own owes its
promise an exact bound, one in shadow is being asked whether it is on course. The line
says which applied. The grade reads the gate's whole history, not the window, as "ratchet
report" does. measured: the first acts of the gate's current shadow phase, fixed before
their labels were read, reached --promise by an exact 95% lower bound with no wrong act
(only rows --model answered, when it is given). estimated: a 95% Wilson interval on at
least --min-estimated labelled unselected rows of the current configuration. Anything
weaker is borrowed or none.

Floor and allowlist rows decided without an oracle call do not count toward accuracy,
calibration, or minimum evidence. They remain in the operational window row count.
Labels are read by the trust class of their source: acted accuracy and unselected ECE
read only blind, census and unsourced labels, and no figure reads a consequence label.

  --gate <id>        The gate to check. Required.
  --promise <p>      Accuracy promised on acted rows, e.g. 0.98. Required.
  --require <grade>  The weakest grade that passes: measured or estimated. Default
                     measured if the gate's newest row enforces, else estimated;
                     --require measured insists on the exact bound in shadow too.
  --min-rows <n>     Rows needed before accuracy or ECE is judged. Default 30.
  --min-estimated <n>  Labelled unselected rows an estimated grade needs. Default 30.
  --max-ece <e>      ECE bound. Not checked when omitted.
  --model <id>       The pinned model version. Every row in the window that a model
                     answered must report exactly this one; rows that failed open or
                     were fixed by a floor or an allowlist are skipped, and a row that
                     answered without reporting a model, shown as (none), fails.
  --window <n>       Most recent rows of the gate to judge. Default 500.
  --trust <p>=<c>    Read labels whose source starts <p> (channel:kind or channel:*) as
                     trust class <c>: blind, census, moment, consequence or unknown.
                     Repeatable; laid over the defaults.
  --profile <file>   A calibration profile a gate may be graded borrowed from until its
                     own labels grade it estimated, matched against --model when given,
                     else the model of its newest answered row. Borrowed never passes;
                     the line says what the gate has. Repeatable.
  --min-support <n>  Labelled rows the fitted act bar on the line needs at or above it,
                     as in "ratchet report". Default 30.

Prints one line, PASS or FAIL with the reason, and exits 0 on pass, 1 on fail,
2 on a usage error or an unreadable ledger.
`;

export interface CheckOptions {
  readonly gate: string;
  readonly promise: number;
  readonly minRows: number;
  readonly maxEce?: number;
  readonly model?: string;
  readonly window: number;
  /** Trust classes laid over `DEFAULT_TRUST`, as `--trust` gives them. */
  readonly labelTrust?: Readonly<Record<string, TrustClass>>;
  /**
   * The weakest grade that passes. Default measured when the gate's newest row enforces,
   * estimated while the gate is in shadow (after a demotion too).
   */
  readonly require?: RequiredGrade;
  /** Labelled unselected rows an estimated grade needs. Default `REPORT_DEFAULTS.minEstimated`. */
  readonly minEstimated?: number;
  /** Evidence that is not this gate's labels, graded when nothing stronger exists. */
  readonly borrowed?: BorrowedVia;
  /** Profiles a gate may be graded borrowed from until it grades estimated, as `--profile` gives them. */
  readonly profiles?: readonly CalibrationProfile[];
  /** Labelled rows the fitted act bar needs at or above it. Default `REPORT_DEFAULTS.minSupport`. */
  readonly minSupport?: number;
}

/** What `--require` takes: a grade that is this gate's own labels. */
export type RequiredGrade = "measured" | "estimated";

export interface CheckResult {
  readonly gate: string;
  readonly pass: boolean;
  /** One line, PASS or FAIL first. */
  readonly line: string;
  /** Why it failed; empty on a pass. */
  readonly failures: readonly string[];
  readonly windowRows: number;
  readonly gateRows: number;
  /** The gate's grade, read from its whole history (`groupEvidence`), and the grade required. */
  readonly grade: EvidenceGrade;
  readonly require: RequiredGrade;
  /**
   * Why that grade: `--require` asked for it, or it is the default for a gate whose newest row
   * enforces (measured) or for one in shadow (estimated).
   */
  readonly requiredBy: "flag" | "enforce" | "shadow";
  /**
   * Rows in the window recorded under an older policy, rubric or evidence version than the
   * gate's newest row: never read by the accuracy or ECE figures.
   */
  readonly olderRows: number;
  /**
   * The gate's fitted act bar at the promise, as `report` fits it (`fitActBar`), with
   * `minSupport` rows at or above it. Informational: it never fails the check.
   */
  readonly bar: ActBar;
  /**
   * Questions whose rows still read as current though the gate's newest request, which asked
   * one question, did not ask them (`strayQuestions`): flagged on the line, never failed on.
   */
  readonly strays: readonly StrayQuestion[];
  readonly acted: {
    readonly n: number;
    readonly shadow: number;
    readonly audit: number;
    readonly accuracy?: number;
    readonly judged: boolean;
  };
  readonly ece?: {
    readonly value: number;
    readonly n: number;
    readonly from: FittedFrom;
    readonly judged: boolean;
  };
  readonly model?: {
    readonly pinned: string;
    readonly answered: number;
    readonly foreign: readonly { readonly model: string; readonly rows: number }[];
  };
}

/** Describe the acted slice by where its labels came from. */
function actedSlice(n: number, shadow: number, audit: number): string {
  if (audit === 0) return `${n} shadow acted rows`;
  if (shadow === 0) return `${n} audited acted rows`;
  return `${n} unselected acted rows (${shadow} shadow, ${audit} audit)`;
}

/**
 * The gate's fitted act bar in a few words, for the check line: where it could act, or why it
 * has no bar at the promise. Nothing when no labelled row of a trusted source exists.
 */
function actBarNote(bar: ActBar, promise: number, minSupport: number): string[] {
  const f = bar.fitted;
  const p = bar.pointFitted;
  if (f !== undefined) {
    return [
      `act bar ${dec(f.threshold)}: acting right ${pct(f.accuracy)} on the ${f.n} rows at or above it, lower end of the 95% interval >= ${pct(promise)}`,
    ];
  }
  if (bar.fitRows === undefined) return [];
  if (p !== undefined) {
    return [
      `no act bar at ${pct(promise)}: the point estimate's ${dec(p.threshold)} rests on ${p.n} rows, too few for the lower end of a 95% interval to clear it`,
    ];
  }
  if (bar.fitRows < minSupport) {
    return [
      `no act bar: ${bar.fitRows} labelled rows, and a bar needs ${minSupport} at or above it`,
    ];
  }
  return [`no act bar at ${pct(promise)}`];
}

/** Judge one gate against its promise. Pure: the ledger rows in, the verdict out. */
export function checkGate(groups: readonly GateGroup[], opts: CheckOptions): CheckResult {
  const group = findGate(groups, opts.gate, "check");
  const ordered = byTime(group.rows);
  const recent = ordered.slice(-opts.window);
  const failures: string[] = [];
  const notes: string[] = [];
  const trust = trustRegistry(opts.labelTrust);
  // Accuracy and calibration read the newest configuration's rows alone, as the grade does: a
  // looser policy or a new rubric earns nothing from labels the old one collected.
  const current = new Set(currentConfiguration(group.rows).current.map((r) => r.id));
  const scoped = recent.filter((r) => current.has(r.id));
  const olderRows = recent.length - scoped.length;

  // A gate acting on its own owes its promise a measured grade; one in shadow is being asked
  // whether it is on course, not whether it has proven itself, so it owes an estimate. What the
  // gate does now is its newest row's mode: enforce rows left in the window by a demotion do
  // not make a shadow gate an enforcing one.
  const enforcing = ordered.at(-1)?.mode === "enforce";
  const enforcedEarlier = !enforcing && recent.some((r) => r.mode === "enforce");
  const requiredBy = opts.require !== undefined ? "flag" : enforcing ? "enforce" : "shadow";
  const required = opts.require ?? (enforcing ? "measured" : "estimated");
  const requireNote =
    requiredBy === "flag"
      ? `requiring ${required}, as --require asks`
      : requiredBy === "enforce"
        ? "requiring measured: this gate enforces"
        : enforcedEarlier
          ? "requiring estimated: this gate is in shadow now (enforce rows in the window predate its newest row); pass --require measured to insist"
          : "requiring estimated: this gate is in shadow; pass --require measured to insist";
  // The grade reads the whole history: a planned sample is the first acts of its phase, and a
  // window sliding past them would turn it back into a moving one.
  const { grade, bar, levers } = groupEvidence(group, trust, {
    target: opts.promise,
    ...(opts.minSupport !== undefined ? { minSupport: opts.minSupport } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.minEstimated !== undefined ? { minEstimated: opts.minEstimated } : {}),
    ...(opts.borrowed !== undefined ? { borrowed: opts.borrowed } : {}),
    ...(opts.profiles !== undefined ? { profiles: opts.profiles } : {}),
  });
  // The grade travels on every line, pass or fail, so no figure in it is read without it.
  const meets = atLeast(grade, required);
  const gradeNote = meets ? [describeGrade(grade)] : [];
  if (!meets && required === "measured" && opts.promise >= 1) {
    failures.push("requires measured evidence, which no planned sample can give a promise of 1");
  } else if (!meets) failures.push(`requires ${required} evidence, has ${describeGrade(grade)}`);

  // Accuracy on the rows the policy acted on, among rows its confidence did not select.
  const fallback = inferGoIsYes(group.rows).goIsYes;
  const acted = scoped.filter(
    (r) =>
      r.outcome && !r.failedOpen && !isFixed(r) && isUnselected(r, { trust }) && r.soft === "act",
  );
  const audit = acted.filter((r) => r.tags.includes("audit")).length;
  const shadow = acted.length - audit;
  const right = acted.filter((r) => actWasRight(r, recordedGoIsYes(r) ?? fallback)).length;
  const accuracy = acted.length > 0 ? right / acted.length : undefined;
  const judged = acted.length >= opts.minRows;
  const slice = actedSlice(acted.length, shadow, audit);
  if (judged && accuracy !== undefined && accuracy < opts.promise) {
    failures.push(
      `acted accuracy ${pct(accuracy)} on ${slice} is below the promise ${pct(opts.promise)}`,
    );
  } else if (judged) {
    notes.push(`acted accuracy ${pct(accuracy)} on ${slice} (promise ${pct(opts.promise)})`);
  } else {
    notes.push(`acted accuracy not judged: ${slice}, need ${opts.minRows}`);
  }

  // Calibration: unselected rows when there are enough of them, else every labelled row.
  const unselected = scoredFromLedger(scoped, { unselectedOnly: true, trust });
  const labelled = scoredFromLedger(scoped, { sources: COUNTED_SOURCES, trust });
  const useUnselected = unselected.length >= opts.minRows;
  const eceRows = useUnselected ? unselected : labelled;
  const eceFrom: FittedFrom = useUnselected ? "unselected" : "all";
  const eceJudged = eceRows.length >= opts.minRows;
  const eceValue = eceRows.length > 0 ? ece(eceRows) : undefined;
  const where = `on ${eceRows.length} ${useUnselected ? "unselected" : "labelled"} rows`;
  if (eceValue !== undefined && opts.maxEce !== undefined && eceJudged) {
    if (eceValue > opts.maxEce) {
      failures.push(`ECE ${dec(eceValue)} ${where} exceeds ${opts.maxEce}`);
    } else notes.push(`ECE ${dec(eceValue)} ${where} (max ${opts.maxEce})`);
  } else if (opts.maxEce !== undefined) {
    notes.push(`ECE not judged: ${labelled.length} labelled rows, need ${opts.minRows}`);
  } else if (eceValue !== undefined) {
    notes.push(`ECE ${dec(eceValue)} ${where}`);
  }

  // Model pin: every row that a model answered, including a battery's members.
  let model: CheckResult["model"];
  if (opts.model !== undefined) {
    const requests = new Set(recent.map(requestIdOf));
    const members = groups
      .filter((g) => g.memberOf === group.key)
      .flatMap((g) => g.rows.filter((r) => requests.has(requestIdOf(r))));
    const callers: DecisionRecord[] = [...recent, ...members].filter(answered);
    const foreign = countBy(
      callers.filter((r) => r.model !== opts.model),
      modelOf,
    ).map((m) => ({ model: m.key, rows: m.rows }));
    model = { pinned: opts.model, answered: callers.length, foreign };
    if (foreign.length > 0) {
      const n = foreign.reduce((s, f) => s + f.rows, 0);
      const who = foreign.map((f) => `${f.model} (${f.rows})`).join(", ");
      failures.push(
        `${n} of ${callers.length} answered rows came from models other than the pinned ${opts.model}: ${who}`,
      );
    } else if (callers.length === 0) {
      notes.push(`model ${opts.model} pinned; no row in the window was answered by a model`);
    } else notes.push(`model ${opts.model} on all ${callers.length} answered rows`);
  }

  const overrides = Object.entries(opts.labelTrust ?? {});
  const trustNote =
    overrides.length > 0 ? [`trust ${overrides.map(([p, c]) => `${p}=${c}`).join(", ")}`] : [];
  const olderNote =
    olderRows > 0
      ? `, ${olderRows} of them under an older policy, rubric or evidence version and not read`
      : "";
  const windowNote = `window ${recent.length} of ${ordered.length} rows${olderNote}`;
  const barNote = actBarNote(bar, opts.promise, levers.minSupport);
  const pass = failures.length === 0;
  // A renamed question's old rows still grade the gate until the evidence version moves: say so.
  const strays = strayQuestions(group.rows);
  const tail = [...trustNote, ...strays.map(describeStray), ...barNote, windowNote];
  const line = pass
    ? `PASS ${group.key}: ${[requireNote, ...gradeNote, ...notes, ...tail].join("; ")}`
    : `FAIL ${group.key}: ${[...failures, requireNote, ...gradeNote, ...tail].join("; ")}`;
  return {
    gate: group.key,
    pass,
    line,
    failures,
    windowRows: recent.length,
    gateRows: ordered.length,
    grade,
    require: required,
    requiredBy,
    olderRows,
    strays,
    bar,
    acted: {
      n: acted.length,
      shadow,
      audit,
      ...(accuracy !== undefined ? { accuracy } : {}),
      judged,
    },
    ...(eceValue !== undefined
      ? { ece: { value: eceValue, n: eceRows.length, from: eceFrom, judged: eceJudged } }
      : {}),
    ...(model ? { model } : {}),
  };
}

export function check(argv: readonly string[]): Promise<CommandResult> {
  return runCommand("check", async () => {
    const p = parseArgs(
      argv,
      {
        values: [
          "gate",
          "promise",
          "require",
          "min-rows",
          "min-estimated",
          "max-ece",
          "model",
          "window",
          "min-support",
        ],
        booleans: ["help"],
        lists: ["trust", "profile"],
      },
      "check",
    );
    if (p.booleans.has("help")) return { exitCode: 0, output: CHECK_USAGE };
    const path = ledgerPath(p, "check");
    const gate = requiredString(p, "gate", "check");
    const promise = requiredNumber(p, "promise", { min: 0, max: 1, above: true }, "check");
    const required = p.values.get("require");
    if (required !== undefined && required !== "measured" && required !== "estimated") {
      throw new CliError(`--require must be measured or estimated, got "${required}"`, "check");
    }
    if (required === "measured" && promise === 1) {
      throw new CliError(
        "no planned sample can bound a promise of 1, so it can never be measured: promise less, or --require estimated",
        "check",
      );
    }
    const minRows = numberFlag(p, "min-rows", { min: 1, integer: true }, "check") ?? 30;
    const minEstimated = numberFlag(p, "min-estimated", { min: 1, integer: true }, "check");
    const maxEce = numberFlag(p, "max-ece", { min: 0, max: 1 }, "check");
    const window = numberFlag(p, "window", { min: 1, integer: true }, "check") ?? 500;
    const model = p.values.get("model");
    const labelTrust = trustFlag(p, "check");
    const minSupport = numberFlag(p, "min-support", { min: 1, integer: true }, "check");
    const profiles = await readProfiles(p, "check");
    const rows = await loadLedger(path, "check");
    const r = checkGate(groupGates(rows), {
      gate,
      promise,
      minRows,
      window,
      ...(required !== undefined ? { require: required } : {}),
      ...(minEstimated !== undefined ? { minEstimated } : {}),
      ...(maxEce !== undefined ? { maxEce } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(labelTrust !== undefined ? { labelTrust } : {}),
      ...(profiles !== undefined ? { profiles } : {}),
      ...(minSupport !== undefined ? { minSupport } : {}),
    });
    return { exitCode: r.pass ? 0 : 1, output: `${r.line}\n` };
  });
}
