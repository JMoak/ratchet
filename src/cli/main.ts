import { CHECK_USAGE, check } from "./check.ts";
import type { CommandResult } from "./common.ts";
import { HOOK_USAGE, hook } from "./hook.ts";
import { PROFILE_USAGE, profile } from "./profile.ts";
import { REPLAY_USAGE, replay } from "./replay.ts";
import { REPORT_USAGE, report } from "./report.ts";
import { REVIEW_USAGE, type ReviewIo, review } from "./review.ts";
import { TRAIL_USAGE, trail } from "./trail.ts";

export { check, checkGate } from "./check.ts";
export type { CommandResult } from "./common.ts";
export { groupGates, loadLedger } from "./common.ts";
export { type OfferedProfile, profile, readProfile, renderProfile } from "./profile.ts";
export { replay, replayGate } from "./replay.ts";
export { buildReport, report } from "./report.ts";
export { REVIEW_SOURCE, type ReviewIo, review } from "./review.ts";
export {
  buildTrail,
  type GradedBar,
  type InferredBar,
  inferBars,
  renderTrail,
  selectTrail,
  type Trail,
  type TrailEntry,
  type TrailMember,
  trail,
} from "./trail.ts";

export const HELP = `ratchet: read a decision ledger and say what it shows.

Usage:
  ratchet report <ledger> [--gate <id>] [--target 0.98] [--min-support 30]
                 [--min-estimated 30] [--trust <prefix>=<class> ...]
                 [--profile <file> ...] [--exact-bar [--group <tagPrefix>]] [--json]
  ratchet check  <ledger> --gate <id> --promise <p> [--require measured|estimated]
                 [--min-rows 30] [--min-estimated 30] [--max-ece <e>] [--model <id>]
                 [--window 500] [--trust <prefix>=<class> ...]
                 [--profile <file> ...] [--min-support 30]
  ratchet replay <ledger> --gate <id> --act-above <p> [--refuse-below <p>]
                 [--go-is-yes true|false] [--json]
  ratchet review <ledger> --gate <id> [--sample 20] [--seed <n>] [--reviewer <name>]
                 [--denied | --audits | --adjudicate]
  ratchet trail  <ledger> [--gate <id>] [--request <id>] [--last 10] [--target 0.98]
                 [--min-estimated 30] [--trust <prefix>=<class> ...]
                 [--profile <file> ...] [--min-support 30] [--json]
  ratchet profile build <ledger...> --model <pin> --kind <judge|pick|rate>
                 [--question-hash <h>] [--target 0.98 ...] [--min-support 30] [--resolution 100]
                 [--trust <prefix>=<class> ...] [--out <file>]
  ratchet profile show <file> [--json]
  ratchet profile merge <a> <b> [<c> ...] --out <file>
  ratchet hook   <claude-code|codex> <event|install|status|replay> [--live] [--budget <usd>]
  ratchet help [command]

Commands:
  report   Evidence grade, calibration, posture, fitted bar and coverage, models,
           failures and cost, per gate.
  check    The CI gate: fail when a gate's evidence is weaker than required, or it
           breaks its accuracy promise, its ECE bound or its model pin.
  replay   Re-rule every recorded verdict under a new policy, without oracle calls.
  review   Blind review: label a random sample yourself before seeing the model's answers.
  trail    How each decision was reached: members, verdict, floor, action and label,
           with each gate's inferred bar and its grade.
  profile  Build, show or merge a calibration profile: a model's confidence on other
           gates' labelled rows, which a new gate can borrow a shadow bar from.
  hook     Shadow a coding agent's permission prompts and learn from the answers.

<ledger> is a JSON Lines file written by JsonlLedger. Rows group by gate id, or by
question id in ledgers written before gates.

Exit codes: 0 ok, 1 check failed, 2 usage error or unreadable ledger or profile.
`;

const USAGE: Readonly<Record<string, string>> = {
  report: REPORT_USAGE,
  check: CHECK_USAGE,
  replay: REPLAY_USAGE,
  review: REVIEW_USAGE,
  trail: TRAIL_USAGE,
  profile: PROFILE_USAGE,
  hook: HOOK_USAGE,
};

/**
 * Dispatch one command line. Never throws; every outcome is an exit code and some text. Only
 * `review` talks to a person, through `io`; report, check, replay and trail only read, and
 * `profile` writes nothing but the file its `--out` names.
 */
export async function main(argv: readonly string[], io?: ReviewIo): Promise<CommandResult> {
  const [command, ...rest] = argv;
  switch (command) {
    case "report":
      return report(rest);
    case "check":
      return check(rest);
    case "replay":
      return replay(rest);
    case "review":
      return review(rest, io);
    case "trail":
      return trail(rest);
    case "profile":
      return profile(rest);
    case "hook":
      return hook(rest);
    case "help":
    case "--help":
    case "-h": {
      const topic = rest[0];
      if (topic === undefined) return { exitCode: 0, output: HELP };
      const usage = USAGE[topic];
      if (usage) return { exitCode: 0, output: usage };
      return { exitCode: 2, output: `ratchet: no help for "${topic}"\n\n${HELP}` };
    }
    case undefined:
      return { exitCode: 2, output: HELP };
    default:
      return { exitCode: 2, output: `ratchet: unknown command "${command}"\n\n${HELP}` };
  }
}
