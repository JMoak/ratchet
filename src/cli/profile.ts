import { readFile, writeFile } from "node:fs/promises";
import { parseProfile } from "../ledger/borrow.ts";
import { describeDonor, describeSources } from "../ledger/evidence.ts";
import { type DecisionRecord, decisionRows } from "../ledger/ledger.ts";
import {
  buildProfile,
  type CalibrationProfile,
  coarseBins,
  gateBars,
  keyText,
  mergeProfiles,
  PROFILE_TARGETS,
  type ProfileKey,
} from "../ledger/profile.ts";
import { trustRegistry } from "../ledger/sources.ts";
import { policyFromProfile } from "../policy.ts";
import type { QuestionKind } from "../types.ts";
import {
  CliError,
  numberFlag,
  numberList,
  type Parsed,
  parseArgs,
  requiredString,
  trustFlag,
} from "./args.ts";
import { type CommandResult, countBy, dec, loadLedger, pct, runCommand, table } from "./common.ts";

export const PROFILE_USAGE = `Usage: ratchet profile build <ledger...> --model <pin> --kind <judge|pick|rate> [--question-hash <h>] [--target 0.98 ...] [--min-support 30] [--resolution 100] [--trust <prefix>=<class> ...] [--out <file>]
       ratchet profile show <file> [--json]
       ratchet profile merge <a> <b> [<c> ...] --out <file>

A calibration profile is what one model's stated confidence has meant on other gates'
labelled rows, so a new gate can start in shadow from a bar earned elsewhere instead of
from a guess. It reads only labelled unselected rows (shadow rows and blind audits) of
trusted sources that the exact --model answered alone, for --kind questions (of one
rubric, with --question-hash), and keeps them as --resolution equal confidence bins per
donor gate.

The bar for each --target is the cautious end: the lowest bin edge at which every donor
gate with at least --min-support rows in its tail (every row at or above the edge) clears
the target on that tail at the lower end of a 95% Wilson interval (a one-sided 97.5% bound). On one gate that is the bar "ratchet
report" fits, read the same way; across gates it is the strictest donor's bar, since a
profile is lent to gates it has not seen. A profile is borrowed evidence, shadow only.

  build                  Read the ledgers; write the profile to --out, or print its JSON.
    --model <pin>        The exact model rows record. Required.
    --kind <kind>        judge, pick or rate. Required.
    --question-hash <h>  Only rows of this rubric (a row's questionHash).
    --target <p>         A promise to state a bar for. Repeatable. Default 0.9, 0.95, 0.98
                         and 0.99.
    --min-support <n>    Rows a donor gate needs at or above its bar. Default 30.
    --resolution <n>     Equal confidence bins across [0, 1], 1 to 1000; a bar is one of
                         their edges. Default 100.
    --trust <p>=<c>      Read labels whose source starts <p> as trust class <c>, as in
                         "ratchet report". Repeatable.
    --out <file>         Write the profile here instead of printing it.
  show                   A profile's bars, each donor gate's own bar, and its bins
                         grouped into tenths for reading.
    --json               The profile itself, checked, with every bin.
  merge                  Profiles of one model, kind, min support and resolution, into
                         --out (required). Their ledgers must differ, or rows would count
                         twice.

"ratchet report|check|trail --profile <file>" then grades a gate as borrowed from it until
the gate's own labels grade it estimated, and policyFromProfile builds a gate's policy from
it in code.

Exits 0 on success, 2 on a usage error, an unreadable ledger or profile, no rows to build
from, or profiles that cannot be merged.
`;

/** A profile a command was offered, as its output names it. */
export interface OfferedProfile {
  readonly hash: string;
  readonly key: ProfileKey;
}

export const offered = (profiles: readonly CalibrationProfile[]): OfferedProfile[] =>
  profiles.map((p) => ({ hash: p.hash, key: p.key }));

/** The line a report or trail prints for the profiles it was offered. */
export function offeredLine(profiles: readonly OfferedProfile[]): string {
  const named = profiles.map((p) => `${p.hash.slice(0, 8)} (${keyText(p.key)})`).join(", ");
  return `Profiles offered with --profile: ${named}. A gate borrows from the first that matches it until its own labels grade it estimated, shadow only.`;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Read and check one profile file. A missing or malformed one is a usage error, exit 2. */
export async function readProfile(path: string, command: string): Promise<CalibrationProfile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    throw new CliError(
      missing ? `profile not found: ${path}` : `could not read profile ${path}`,
      command,
    );
  }
  try {
    return parseProfile(JSON.parse(text));
  } catch (e) {
    throw new CliError(`could not read profile ${path}: ${message(e)}`, command);
  }
}

/** Every `--profile <file>` given, read and checked, one per hash; undefined when none was. */
export async function readProfiles(
  p: Parsed,
  command: string,
): Promise<CalibrationProfile[] | undefined> {
  const paths = p.lists.get("profile");
  if (paths === undefined) return undefined;
  const out: CalibrationProfile[] = [];
  for (const path of paths) {
    const profile = await readProfile(path, command);
    if (!out.some((x) => x.hash === profile.hash)) out.push(profile);
  }
  return out;
}

const KINDS: readonly string[] = ["judge", "pick", "rate"];
const json = (profile: CalibrationProfile): string => `${JSON.stringify(profile, null, 2)}\n`;

/** One line: the profile, its donor and its bars. */
function summary(p: CalibrationProfile): string {
  const bars = p.targets.map((t) => {
    const b = p.bars.find((x) => x.target === t);
    return b ? `${pct(t)} at ${dec(b.bar)} (support ${b.support})` : `${pct(t)} none`;
  });
  return `profile ${p.hash.slice(0, 8)} of ${keyText(p.key)}: ${describeDonor(p.from)}; bars ${bars.join(", ")}`;
}

async function written(
  profile: CalibrationProfile,
  out: string | undefined,
): Promise<CommandResult> {
  if (out === undefined) return { exitCode: 0, output: json(profile) };
  try {
    await writeFile(out, json(profile), "utf8");
  } catch (e) {
    throw new CliError(`could not write ${out}: ${message(e)}`, "profile");
  }
  return { exitCode: 0, output: `wrote ${out}: ${summary(profile)}\n` };
}

/** The answers the ledgers do hold, so a key that matched nothing can be corrected. */
function held(rows: readonly DecisionRecord[]): string {
  const alone = decisionRows(rows).filter(
    (r) => r.model !== undefined && !r.failedOpen && r.strategy === "single",
  );
  const kinds = countBy(alone, (r) => `${r.model} ${r.kind}`);
  if (kinds.length === 0) return "the ledgers hold no answer a model gave alone";
  return `answers a model gave alone, by model and kind: ${kinds.map((k) => `${k.key} (${k.rows})`).join(", ")}`;
}

async function build(p: Parsed): Promise<CommandResult> {
  const ledgers = p.positionals;
  if (ledgers.length === 0) throw new CliError("missing <ledger> path", "profile");
  const model = requiredString(p, "model", "profile");
  const kind = requiredString(p, "kind", "profile");
  if (!KINDS.includes(kind)) {
    throw new CliError(`--kind must be judge, pick or rate, got "${kind}"`, "profile");
  }
  const questionHash = p.values.get("question-hash");
  const targets =
    numberList(p, "target", { min: 0, max: 1, above: true }, "profile") ?? PROFILE_TARGETS;
  const minSupport = numberFlag(p, "min-support", { min: 1, integer: true }, "profile") ?? 30;
  const resolution =
    numberFlag(p, "resolution", { min: 1, max: 1000, integer: true }, "profile") ?? 100;
  const labelTrust = trustFlag(p, "profile");
  const rows: DecisionRecord[] = [];
  for (const path of ledgers) rows.push(...(await loadLedger(path, "profile")));
  const key: ProfileKey = {
    model,
    kind: kind as QuestionKind,
    ...(questionHash !== undefined ? { questionHash } : {}),
  };
  const profile = buildProfile(rows, key, {
    ledgers,
    targets,
    minSupport,
    resolution,
    trust: trustRegistry(labelTrust),
  });
  if (profile === undefined) {
    throw new CliError(
      `no labelled unselected row of a trusted source for ${keyText(key)}; ${held(rows)}`,
      "profile",
    );
  }
  return written(profile, p.values.get("out"));
}

export function renderProfile(path: string, p: CalibrationProfile): string {
  const out: string[] = [`# ratchet profile: ${path}`, ""];
  out.push(
    `Profile ${p.hash} of ${keyText(p.key)}, from ${describeDonor(p.from)} (labels: ${describeSources(p.from.sources)}). Borrowed evidence: a gate may start from it in shadow and never enforce on it.`,
    "",
    "## Bars",
    "",
  );
  out.push(
    table(
      ["promise", "bar", "support", "act above"],
      p.targets.map((t) => {
        const b = p.bars.find((x) => x.target === t);
        if (!b) return [pct(t), "none", "-", "-"];
        return [pct(t), dec(b.bar), String(b.support), dec(policyFromProfile(p, t).actAbove)];
      }),
    ),
    "",
    `Bars sit on the edges of ${p.resolution} equal bins. A bar is the lowest edge at which every donor gate with at least ${p.minSupport} rows in its tail (every row at or above the edge) keeps the promise on that tail at the lower end of a 95% Wilson interval (a one-sided 97.5% bound): the strictest donor's bar, since a profile is lent to gates it has not seen. "support" is the fewest tail rows among the gates that kept it; "none" means no edge held on every such gate. Each gate's own bar is below, for reading. "act above" is what policyFromProfile puts in a policy: the bar plus a 0.05 half-band up to a bar of 0.9, and above that the same band in log-odds, so it stays below 1.`,
    "",
    "## Donor gates",
    "",
  );
  const own = p.targets.map((t) => gateBars(p, t));
  out.push(
    table(
      ["gate", "rows", ...p.targets.map((t) => `bar at ${pct(t)}`)],
      (own[0] ?? []).map((g, i) => [
        g.gate,
        String(g.rows),
        ...own.map((bars) => {
          const b = bars[i];
          return b?.bar === undefined ? "none" : `${dec(b.bar)} (${b.support})`;
        }),
      ]),
    ),
  );
  // A hundred bins a gate is a table nobody reads; tenths say where the model's confidence stood.
  const tenths = p.resolution > 10 && p.resolution % 10 === 0;
  const shown = tenths ? coarseBins(p, 10) : p.bins;
  const places = tenths || 10 % p.resolution === 0 ? 1 : 3;
  out.push(
    "",
    tenths
      ? `## Bins, in tenths (the profile holds ${p.resolution}; --json lists them)`
      : "## Bins",
    "",
    table(
      ["gate", "confidence", "rows", "mean confidence", "accuracy"],
      shown.map((b) => [
        b.gate,
        `${dec(b.lo, places)} to ${dec(b.hi, places)}`,
        String(b.n),
        dec(b.meanConfidence),
        pct(b.accuracy),
      ]),
    ),
  );
  return `${out.join("\n")}\n`;
}

async function show(p: Parsed): Promise<CommandResult> {
  const [path, ...rest] = p.positionals;
  if (path === undefined) throw new CliError("missing <file> path", "profile");
  if (rest.length > 0) throw new CliError(`unexpected argument "${rest[0]}"`, "profile");
  const profile = await readProfile(path, "profile");
  return {
    exitCode: 0,
    output: p.booleans.has("json") ? json(profile) : renderProfile(path, profile),
  };
}

async function merge(p: Parsed): Promise<CommandResult> {
  const paths = p.positionals;
  if (paths.length < 2) throw new CliError("merge needs at least two profiles", "profile");
  const out = requiredString(p, "out", "profile");
  let merged: CalibrationProfile | undefined;
  for (const path of paths) {
    const next = await readProfile(path, "profile");
    try {
      merged = merged === undefined ? next : mergeProfiles(merged, next);
    } catch (e) {
      throw new CliError(`cannot merge ${path}: ${message(e)}`, "profile");
    }
  }
  return written(merged as CalibrationProfile, out);
}

const SPECS = {
  build: {
    values: ["model", "kind", "question-hash", "min-support", "resolution", "out"],
    booleans: ["help"],
    lists: ["target", "trust"],
  },
  show: { booleans: ["json", "help"] },
  merge: { values: ["out"], booleans: ["help"] },
} as const;

export function profile(argv: readonly string[]): Promise<CommandResult> {
  return runCommand("profile", async () => {
    const [sub, ...rest] = argv;
    if (sub === "--help" || sub === "-h") return { exitCode: 0, output: PROFILE_USAGE };
    if (sub !== "build" && sub !== "show" && sub !== "merge") {
      const what = sub === undefined ? "missing subcommand" : `unknown subcommand "${sub}"`;
      throw new CliError(`${what}: build, show or merge`, "profile");
    }
    const p = parseArgs(rest, SPECS[sub], "profile");
    if (p.booleans.has("help")) return { exitCode: 0, output: PROFILE_USAGE };
    return sub === "build" ? build(p) : sub === "show" ? show(p) : merge(p);
  });
}
