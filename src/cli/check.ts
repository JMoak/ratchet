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
  describeGrade,
  type EvidenceGrade,
  type FittedFrom,
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
  gradeGroup,
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
    blind audits), is below --promise, with at least --min-rows such rows;
  - ECE is above --max-ece, with at least --min-rows labelled rows (unselected rows
    when there are enough, else all labelled rows);
  - a model other than --model answered any row in the window.

The grade required is measured when any row of the gate in the window enforces, and
estimated while the gate is in shadow: a gate acting on its own owes its promise an exact
bound, one in shadow is being asked whether it is on course. The line says which applied.
The grade reads the gate's whole history, not the window, as "ratchet report" does.
measured: the first acts of the gate's current shadow phase, fixed before their labels
were read, reached --promise by an exact 95% lower bound with no wrong act (only rows
--model answered, when it is given). estimated: a 95% Wilson interval on at least
--min-estimated labelled unselected rows. Anything weaker is borrowed or none.

Floor and allowlist rows decided without an oracle call do not count toward accuracy,
calibration, or minimum evidence. They remain in the operational window row count.
Labels are read by the trust class of their source: acted accuracy and unselected ECE
read only blind, census and unsourced labels, and no figure reads a consequence label.

  --gate <id>        The gate to check. Required.
  --promise <p>      Accuracy promised on acted rows, e.g. 0.98. Required.
  --require <grade>  The weakest grade that passes: measured or estimated. Default
                     measured if the window holds an enforce row, else estimated;
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
  --profile <file>   A calibration profile a gate with no fitted bar of its own may be
                     graded borrowed from, matched against --model when given, else the
                     model of its newest answered row. Borrowed never passes; the line
                     says what the gate has. Repeatable.
  --min-support <n>  With --profile: labelled rows a bar of the gate's own needs at or
                     above it, as in "ratchet report". Default 30.

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
   * The weakest grade that passes. Default measured when any row in the window enforces,
   * estimated while the gate is in shadow.
   */
  readonly require?: RequiredGrade;
  /** Labelled unselected rows an estimated grade needs. Default 30. */
  readonly minEstimated?: number;
  /** Evidence that is not this gate's labels, graded when nothing stronger exists. */
  readonly borrowed?: BorrowedVia;
  /** Profiles a gate with no fitted bar may be graded borrowed from, as `--profile` gives them. */
  readonly profiles?: readonly CalibrationProfile[];
  /** With `profiles`: labelled rows a bar of the gate's own needs at or above it. Default 30. */
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
  /** The gate's grade, read from its whole history (`gradeGroup`), and the grade required. */
  readonly grade: EvidenceGrade;
  readonly require: RequiredGrade;
  /**
   * Why that grade: `--require` asked for it, or it is the default for a gate with an enforce
   * row in the window (measured) or for one in shadow (estimated).
   */
  readonly requiredBy: "flag" | "enforce" | "shadow";
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

/** Judge one gate against its promise. Pure: the ledger rows in, the verdict out. */
export function checkGate(groups: readonly GateGroup[], opts: CheckOptions): CheckResult {
  const group = findGate(groups, opts.gate, "check");
  const ordered = byTime(group.rows);
  const recent = ordered.slice(-opts.window);
  const failures: string[] = [];
  const notes: string[] = [];
  const trust = trustRegistry(opts.labelTrust);

  // A gate acting on its own owes its promise a measured grade; one still in shadow is being
  // asked whether it is on course, not whether it has proven itself, so it owes an estimate.
  const enforcing = recent.some((r) => r.mode === "enforce");
  const requiredBy = opts.require !== undefined ? "flag" : enforcing ? "enforce" : "shadow";
  const required = opts.require ?? (enforcing ? "measured" : "estimated");
  const requireNote =
    requiredBy === "flag"
      ? `requiring ${required}, as --require asks`
      : requiredBy === "enforce"
        ? "requiring measured: this gate enforces"
        : "requiring estimated: this gate is in shadow; pass --require measured to insist";
  // The grade reads the whole history: a planned sample is the first acts of its phase, and a
  // window sliding past them would turn it back into a moving one.
  const grade = gradeGroup(group, trust, {
    target: opts.promise,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.minEstimated !== undefined ? { minEstimated: opts.minEstimated } : {}),
    ...(opts.borrowed !== undefined ? { borrowed: opts.borrowed } : {}),
    ...(opts.profiles !== undefined ? { profiles: opts.profiles } : {}),
    ...(opts.minSupport !== undefined ? { minSupport: opts.minSupport } : {}),
  });
  // The grade travels on every line, pass or fail, so no figure in it is read without it.
  const meets = atLeast(grade, required);
  const gradeNote = meets ? [describeGrade(grade)] : [];
  if (!meets && required === "measured" && opts.promise >= 1) {
    failures.push("requires measured evidence, which no planned sample can give a promise of 1");
  } else if (!meets) failures.push(`requires ${required} evidence, has ${describeGrade(grade)}`);

  // Accuracy on the rows the policy acted on, among rows its confidence did not select.
  const fallback = inferGoIsYes(group.rows).goIsYes;
  const acted = recent.filter(
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
  const unselected = scoredFromLedger(recent, { unselectedOnly: true, trust });
  const labelled = scoredFromLedger(recent, { sources: COUNTED_SOURCES, trust });
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
  const windowNote = `window ${recent.length} of ${ordered.length} rows`;
  const pass = failures.length === 0;
  const line = pass
    ? `PASS ${group.key}: ${[requireNote, ...gradeNote, ...notes, ...trustNote, windowNote].join("; ")}`
    : `FAIL ${group.key}: ${[...failures, requireNote, ...gradeNote, ...trustNote, windowNote].join("; ")}`;
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
