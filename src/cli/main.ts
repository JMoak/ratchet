import { CHECK_USAGE, check } from "./check.ts";
import type { CommandResult } from "./common.ts";
import { REPLAY_USAGE, replay } from "./replay.ts";
import { REPORT_USAGE, report } from "./report.ts";

export { check, checkGate } from "./check.ts";
export type { CommandResult } from "./common.ts";
export { groupGates, loadLedger } from "./common.ts";
export { replay, replayGate } from "./replay.ts";
export { buildReport, report } from "./report.ts";

export const HELP = `ratchet: read a decision ledger and say what it shows.

Usage:
  ratchet report <ledger> [--gate <id>] [--target 0.98] [--min-support 30] [--json]
  ratchet check  <ledger> --gate <id> --promise <p> [--min-rows 30] [--max-ece <e>]
                 [--model <id>] [--window 500]
  ratchet replay <ledger> --gate <id> --act-above <p> [--refuse-below <p>]
                 [--go-is-yes true|false] [--json]
  ratchet help [command]

Commands:
  report   Calibration, posture, fitted bar and coverage, models, failures and cost,
           per gate.
  check    The CI gate: fail when a gate breaks its accuracy promise, its ECE bound
           or its model pin.
  replay   Re-rule every recorded verdict under a new policy, without oracle calls.

<ledger> is a JSON Lines file written by JsonlLedger. Rows group by gate id, or by
question id in ledgers written before gates.

Exit codes: 0 ok, 1 check failed, 2 usage error or unreadable ledger.
`;

const USAGE: Readonly<Record<string, string>> = {
  report: REPORT_USAGE,
  check: CHECK_USAGE,
  replay: REPLAY_USAGE,
};

/** Dispatch one command line. Never throws; every outcome is an exit code and some text. */
export async function main(argv: readonly string[]): Promise<CommandResult> {
  const [command, ...rest] = argv;
  switch (command) {
    case "report":
      return report(rest);
    case "check":
      return check(rest);
    case "replay":
      return replay(rest);
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
