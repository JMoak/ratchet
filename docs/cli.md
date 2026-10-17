# The `ratchet` command line

`bin/ratchet.ts` reads a decision ledger (the JSON Lines file `JsonlLedger` writes) and answers
three questions about it without calling any oracle or touching the network:

- **`report`**: what does the record say about each gate? Calibration, posture, the bar the
  labels support and how much traffic it would cover, which models answered, what failed.
- **`check`**: has a gate broken its promise? Exits 1 when it has, so it can sit in CI.
- **`replay`**: what would a different bar have done on the traffic already recorded?

It has no dependencies. Output is markdown tables (or JSON) and plain one-line verdicts, with
no colour codes.

```sh
bun run ratchet <command> <ledger> [flags]     # from the repo
bun bin/ratchet.ts <command> <ledger> [flags]  # the same, directly
ratchet <command> <ledger> [flags]             # when installed as a package bin
```

| exit code | meaning |
| --- | --- |
| 0 | the command ran; for `check`, the gate passed |
| 1 | `check` only: the gate failed (accuracy, ECE or model pin) |
| 2 | usage error, unknown gate, or a ledger that is missing or cannot be parsed |

Exit 2 output goes to stderr, everything else to stdout. An unexpected internal error is also
exit 2, never 1, so CI cannot mistake a crash for a broken promise.

```text
ratchet: read a decision ledger and say what it shows.

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
```

`ratchet help <command>` and `ratchet <command> --help` print each command's flags. Flags take
`--name value` or `--name=value`; an unknown or repeated flag is a usage error, because in a CI
gate a misspelled option that is silently ignored is worse than one that fails.

## How rows become gates

Rows are grouped by `gateId`. Ledgers written before gates existed have no gate id;
`JsonlLedger` reads those rows as `adhoc:<questionId>`, and a row with no gate id at all is
grouped by its question id.

A battery writes one row per member plus a combined row that carries the ruling and the label
(`combined: true`, same `requestId`). The combined rows are the gate. Each member's rows are
listed separately as `<gate>/<question>`, marked `(member)` in the report, so every member can
be calibrated on its own against the battery's truth. Any of these keys can be passed to
`--gate`.

## The example ledger

Every example below was produced by running the CLI on
`experiments/out/cli-example-ledger.jsonl`, a fixture built with `SimOracle` (simulated, seeded,
shadow mode, every row labelled):

- `bash.safe`: a judge gate with `actAbove: 0.9`. 300 rows from a slightly underconfident
  model (`sim-p0.93-rho0`), then 12 rows that failed open on HTTP 503, 4 that timed out, and
  120 rows from an "upgraded" overconfident model (`sim-p0.85-rho0`).
- `ticket.route`: a five-way pick with `actAbove: 0.85`, answered by an overconfident model.
- `stop.done`: a three-question battery (tests pass, claims match, scope kept) pooled in
  log-odds, with `actAbove: 0.95`.

## `report`

```text
ratchet report <ledger> [--gate <id>] [--target 0.98] [--min-support 30] [--json]
```

| flag | default | meaning |
| --- | --- | --- |
| `--gate <id>` | all | one gate, plus its battery members if it has any |
| `--target <p>` | 0.98 | accuracy the fitted bar must deliver |
| `--min-support <n>` | 30 | labelled rows the bar needs at or above it |
| `--json` | off | JSON instead of markdown |

```text
$ bun run ratchet report experiments/out/cli-example-ledger.jsonl
```

```text
# ratchet report: experiments/out/cli-example-ledger.jsonl

1286 rows in 6 gates. Bar target 98.0% accuracy with at least 30 labelled rows at or above it.

## Calibration and fitted bar

| gate                      | rows | labelled | unselected | observed | expected | posture        | ECE   | Brier | bar   | coverage     | fitted on        |
| ------------------------- | ---- | -------- | ---------- | -------- | -------- | -------------- | ----- | ----- | ----- | ------------ | ---------------- |
| bash.safe                 | 436  | 420      | 420        | 94.0%    | 91.7%    | underconfident | 0.030 | 0.055 | 0.962 | 43.8% (184)  | unselected (420) |
| ticket.route              | 250  | 250      | 250        | 77.6%    | 91.1%    | overconfident  | 0.152 | 0.194 | 0.998 | 12.0% (30)   | unselected (250) |
| stop.done                 | 150  | 150      | 150        | 99.3%    | 98.5%    | calibrated     | 0.018 | 0.007 | 0.502 | 100.0% (150) | unselected (150) |
| stop.done/tests (member)  | 150  | 150      | 150        | 94.0%    | 91.4%    | underconfident | 0.063 | 0.044 | 0.749 | 92.0% (138)  | unselected (150) |
| stop.done/claims (member) | 150  | 150      | 150        | 93.3%    | 90.1%    | underconfident | 0.056 | 0.068 | 0.961 | 38.0% (57)   | unselected (150) |
| stop.done/scope (member)  | 150  | 150      | 150        | 88.0%    | 90.4%    | overconfident  | 0.026 | 0.096 | 0.953 | 43.3% (65)   | unselected (150) |

## Operations

| gate                      | models                                     | failed open | errors                     | fixed | cost     | mean latency |
| ------------------------- | ------------------------------------------ | ----------- | -------------------------- | ----- | -------- | ------------ |
| bash.safe                 | sim-p0.93-rho0 (300), sim-p0.85-rho0 (120) | 16          | HTTP 503 (12), timeout (4) | 0     | $0.00840 | 145 ms       |
| ticket.route              | sim-p0.78-rho0 (250)                       | 0           | -                          | 0     | $0.00500 | 150 ms       |
| stop.done                 | sim-p0.93-rho0 (150)                       | 0           | -                          | 0     | $0       | 150 ms       |
| stop.done/tests (member)  | sim-p0.93-rho0 (150)                       | 0           | -                          | 0     | $0.00300 | 150 ms       |
| stop.done/claims (member) | sim-p0.93-rho0 (150)                       | 0           | -                          | 0     | $0.00300 | 150 ms       |
| stop.done/scope (member)  | sim-p0.93-rho0 (150)                       | 0           | -                          | 0     | $0.00300 | 150 ms       |

Observed is accuracy on labelled rows; expected is their mean stated confidence. Bar is the lowest confidence that delivered the target with enough support, and coverage is the share of the fitted rows at or above it; "none" means no bar did. Rows fitted on "all" were selected by the engine's own confidence, so treat that bar as a fallback. Fixed rows were decided by a floor or an allowlist without a call. A battery's spend is recorded on its member rows; its own row carries the ruling.
```

How to read it:

- **labelled** counts rows with an outcome that did not fail open; every accuracy number is
  computed on them. **unselected** is the part of that the oracle's confidence did not select:
  shadow rows and blind audits.
- **observed** is accuracy of the leading answer; **expected** is the mean stated confidence on
  the same rows, so the gap is miscalibration and nothing else. (The JSON also carries
  `expectedAllRows`, the label-free estimate over every answered row.)
- **posture** is `underconfident` when observed beats expected by more than 2 points,
  `overconfident` when it falls short by more than 2, `calibrated` otherwise. It says which way
  a bar can move: `ticket.route` claims 91% and delivers 78%, so its bar has to sit near the top
  (0.998, covering 12%), while `bash.safe` delivers more than it claims.
- **bar** is `fitThreshold(rows, target, minSupport)`: the lowest confidence whose rows at or
  above it reached the target, with at least `--min-support` of them. **coverage** is the share
  of the fitted rows at or above the bar (with the count), which is the share of traffic the gate
  could decide automatically at that promise. The bar is fitted on unselected rows when there
  are at least `--min-support` of them, else on every labelled row, shown as `all (n), biased`.
  `none` means no bar reached the target with enough support.
- **errors** groups failed-open rows by class: `HTTP <status>`, `timeout`, `aborted`,
  `short batch`, `malformed`, `unrecorded` (failed open with no message, as a budget cap does),
  or the message with numbers masked.
- **fixed** rows were decided by a floor or an allowlist without a call; they are excluded from
  latency and from the label-free expected accuracy. **mean latency** is over rows that called
  an oracle, including the ones that failed.

`--json` prints the same numbers unrounded, one object per gate (abridged here to one gate):

```text
$ bun run ratchet report experiments/out/cli-example-ledger.jsonl --gate ticket.route --json
```

```json
{
  "ledger": "experiments/out/cli-example-ledger.jsonl",
  "rows": 1286,
  "target": 0.98,
  "minSupport": 30,
  "gates": [
    {
      "gate": "ticket.route",
      "rows": 250,
      "requests": 250,
      "labelled": 250,
      "unselected": 250,
      "accuracy": 0.776,
      "expectedAccuracy": 0.91060259187894,
      "expectedAllRows": 0.91060259187894,
      "posture": "overconfident",
      "ece": 0.1515545974118519,
      "brier": 0.19386210580839905,
      "fittedFrom": "unselected",
      "fitRows": 250,
      "fitted": {
        "threshold": 0.9980659352160888,
        "coverage": 0.12,
        "accuracy": 1,
        "n": 30
      },
      "models": [
        {
          "model": "sim-p0.78-rho0",
          "rows": 250
        }
      ],
      "failedOpen": 0,
      "errors": [],
      "fixed": 0,
      "cost": 0.005000000000000011,
      "meanLatencyMs": 150
    }
  ]
}
```

A battery member's entry also carries `"memberOf": "<gate>"`.

## `check`

```text
ratchet check <ledger> --gate <id> --promise <p> [--min-rows 30] [--max-ece <e>] [--model <id>] [--window 500]
```

| flag | default | meaning |
| --- | --- | --- |
| `--gate <id>` | required | the gate to judge |
| `--promise <p>` | required | accuracy promised on the rows the policy acts on |
| `--min-rows <n>` | 30 | rows needed before accuracy or ECE is judged |
| `--max-ece <e>` | not checked | ECE bound |
| `--model <id>` | not checked | the pinned model version |
| `--window <n>` | 500 | most recent rows of the gate to judge, by timestamp |

The check looks at the most recent `--window` rows of the gate and fails when any of these holds:

1. **Accuracy.** Among labelled, unselected rows (shadow rows and blind audits) on which the
   recorded policy said act, the share where acting was right is below `--promise`, and there are
   at least `--min-rows` such rows. In shadow mode these are the acts the engine would have made;
   in enforce mode they are the blind audits. Confidence-selected rows never count: they are the
   engine grading its own homework.
2. **Calibration.** ECE is above `--max-ece`, on the unselected labelled rows when there are at
   least `--min-rows` of them, else on every labelled row, and only with at least `--min-rows`.
3. **Model pin.** Any row in the window that a model answered reports a model other than
   `--model`. Rows that failed open and rows a floor or an allowlist fixed are skipped; for a
   battery the members are checked, since they are the rows a model answered. A row that answered
   without reporting a model counts as `(none)` and fails the pin, because the pin cannot be
   verified on it. Compound strategies (ensemble, cascade, sequential) may not record a single
   model on the row; look at the report's models column before pinning one.

It prints one line: `PASS` with a summary, or `FAIL` with every reason that applies.

```text
$ bun run ratchet check experiments/out/cli-example-ledger.jsonl --gate bash.safe --promise 0.95
PASS bash.safe: acted accuracy 98.7% on 230 shadow acted rows (promise 95.0%); ECE 0.030 on 420 unselected rows; window 436 of 436 rows
$ echo $?
0

$ bun run ratchet check experiments/out/cli-example-ledger.jsonl --gate bash.safe --promise 0.95 --model sim-p0.93-rho0
FAIL bash.safe: 120 of 420 answered rows came from models other than the pinned sim-p0.93-rho0: sim-p0.85-rho0 (120); window 436 of 436 rows
$ echo $?
1

$ bun run ratchet check experiments/out/cli-example-ledger.jsonl --gate ticket.route --promise 0.95 --max-ece 0.05
FAIL ticket.route: acted accuracy 81.0% on 195 shadow acted rows is below the promise 95.0%; ECE 0.152 on 250 unselected rows exceeds 0.05; window 250 of 250 rows
$ echo $?
1

$ bun run ratchet check experiments/out/cli-example-ledger.jsonl --gate stop.done --promise 0.98 --max-ece 0.05 --model sim-p0.93-rho0
PASS stop.done: acted accuracy 100.0% on 91 shadow acted rows (promise 98.0%); ECE 0.018 on 150 unselected rows (max 0.05); model sim-p0.93-rho0 on all 450 answered rows; window 150 of 150 rows
$ echo $?
0

$ bun run ratchet check experiments/out/cli-example-ledger.jsonl --gate nope --promise 0.9
ratchet check: no gate "nope" in the ledger; gates: bash.safe, ticket.route, stop.done, stop.done/tests, stop.done/claims, stop.done/scope
Run "ratchet help check" for usage.
$ echo $?
2
```

The first two lines are the same gate: its accuracy is fine, and the pin still fails, because a
model version the bar was never fitted on answered the last 120 rows. That is the drift the pin
exists to catch.

Things to know before putting it in CI:

- **Too few rows is a pass, said out loud.** Below `--min-rows`, accuracy and ECE are reported
  as `not judged` and do not fail the check. Read the line, or pair the check with a job that
  asserts labels are arriving.
- **ECE is noisy on small samples.** With 10 bins, a perfectly calibrated simulated oracle at
  90% accuracy averages an ECE of 0.086 on 30 rows (one run in ten above 0.13), 0.048 on 100 and
  0.028 on 300. Use `--max-ece` with a few hundred labelled rows, or with a generous bound.
- **The window is rows, not time.** Re-pinning after an upgrade only passes once the old
  model's rows have left the window; `--window` is the knob.

A CI step is one line, for example:

```sh
bun run ratchet check ledger.jsonl --gate bash.safe --promise 0.98 --max-ece 0.08 --model typesafe/jev-1.13-20260917
```

## `replay`

```text
ratchet replay <ledger> --gate <id> --act-above <p> [--refuse-below <p>] [--go-is-yes true|false] [--json]
```

| flag | default | meaning |
| --- | --- | --- |
| `--gate <id>` | required | the gate to replay |
| `--act-above <p>` | required | the new act bar, on the probability that acting is right |
| `--refuse-below <p>` | none | refuse at or below this; omitted, low rows are reviewed |
| `--go-is-yes true\|false` | as recorded | for judge questions, whether yes means go |
| `--json` | off | JSON instead of markdown |

Every row's recorded verdict goes back through `rule()` from `src/policy.ts` under the new
policy. The ledger keeps full distributions, so this needs no oracle calls and costs nothing.
It answers "what would this bar have done on last week's traffic?" before anyone flips it.

```text
$ bun run ratchet replay experiments/out/cli-example-ledger.jsonl --gate bash.safe --act-above 0.97 --refuse-below 0.1
```

```text
# ratchet replay: bash.safe

436 rows from experiments/out/cli-example-ledger.jsonl, re-ruled without oracle calls. New policy: act at or above 0.97, refuse at or below 0.1; yes means go (as the recorded rows were ruled).

## Actions

| action | recorded | replayed |
| ------ | -------- | -------- |
| act    | 230      | 129      |
| review | 206      | 248      |
| refuse | 0        | 59       |

## Changes

160 of 436 rows change action: 160 more cautious, 0 less cautious.

| from   | to     | rows |
| ------ | ------ | ---- |
| act    | review | 101  |
| review | refuse | 59   |

## On 420 labelled rows

| policy   | acted | coverage | accuracy | wrong acts | refused | wrong refusals |
| -------- | ----- | -------- | -------- | ---------- | ------- | -------------- |
| recorded | 230   | 54.8%    | 98.7%    | 3          | 0       | 0              |
| replayed | 129   | 30.7%    | 100.0%   | 0          | 59      | 6              |

Coverage is the share of the slice acted on; accuracy is the share of acted rows where acting was right. A wrong refusal is a refused row where acting would have been right.
```

Raising the bar from 0.9 to 0.97 would have removed the three wrong acts and cost 24 points of
coverage; refusing at 0.1 would have refused six commands that were safe. Whether that trade is
worth it is a cost question, which is the point of seeing it before deciding.

Semantics, precisely:

- **Recorded** is the ruling the ledger holds for each row (`soft`, floors included), not what
  the application did with it. In shadow mode those differ by design.
- **Acting was right** means: for pick and rate questions, the leading answer was correct; for
  judge questions, the truth was the go side (or, without a boolean truth, the go side was the
  leading answer and it was right).
- **Polarity.** Without `--go-is-yes`, each row's polarity is read from its own `go` (the
  probability the policy acted on), and the new policy uses the polarity most rows were ruled
  with.
- **Rows no answer decided** (strategy `floored` or `bypass`) keep their recorded action, since
  there is no answer to re-rule. Failed-open rows take the policy default, review.
- **Floors on answered rows.** A floor that raised caution on a row the oracle did answer is not
  stored separately on the row, so replay cannot reapply it; such rows are re-ruled on their
  verdict alone.
- When the labelled slice contains confidence-selected rows (enforce mode outside audits), a
  second table repeats the comparison on unselected rows only, which is the slice to trust.

## The library underneath

The CLI is a thin layer over functions any program can call. `src/cli/report.ts`,
`src/cli/check.ts` and `src/cli/replay.ts` export `buildReport`, `checkGate` and `replayGate`
(pure, rows in, result out) next to the command functions `report`, `check` and `replay`, which
take an argv array and return `{ exitCode, output }`; `src/cli/main.ts` dispatches.

`src/ledger/calibration.ts` gained the fitting modes the design asks for:

```ts
type FitMode = "accuracy" | "recall";
interface FitOptions { conservative?: boolean; confidence?: number; mode?: FitMode }

fitThreshold(items: readonly Scored[], target: number, minSupport = 20, opts: FitOptions = {}): FittedThreshold | undefined
scoredWithTruth(records: readonly DecisionRecord[], opts?: { unselectedOnly?: boolean }): ScoredTruth[]
coverageAt(items: readonly Scored[], threshold: number): { coverage: number; accuracy: number; n: number }
```

- `mode: "accuracy"` (the default) is unchanged: the lowest bar whose rows reach the target
  accuracy with `minSupport` of them.
- `mode: "recall"` is for screening, where a missed include costs more than a wasted read. Rows
  at or above the bar are decided by their leading answer and the rest go to review; recall is
  the share of truly positive rows that automation did not answer "no". It returns the lowest
  bar that keeps recall at the target (lowering the bar can only lose positives, so this is the
  bar with the most work saved), with `coverage`, `recall`, `precision` of the automated yes
  answers and the `positives` count; `minSupport` counts positives. It needs items from
  `scoredWithTruth`, which reads labelled judge rows with a boolean truth and records whether the
  oracle leaned yes; plain `Scored` items throw. `conservative: true` applies the Wilson lower
  bound to recall.
- `coverageAt` reads what one bar delivers on labelled history: the share of rows at or above
  it and their accuracy.
