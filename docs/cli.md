# The `ratchet` command line

`bin/ratchet.ts` reads a decision ledger (the JSON Lines file `JsonlLedger` writes) and answers
four questions about it without calling any oracle or touching the network, and runs one
interactive session, `review`, that adds labels to it:

- **`report`**: what does the record say about each gate? What kind of evidence stands behind
  it (its [grade](#evidence-grades)), calibration, posture, the bar the labels support and how
  much traffic it would cover, which models answered, what failed.
- **`check`**: has a gate broken its promise, or not yet earned it? Exits 1 when it has, so it
  can sit in CI.
- **`replay`**: what would a different bar have done on the traffic already recorded?
- **`trail`**: how was each decision reached? Every answer bought, the pooled verdict, the
  floor, the action and the label, one request at a time.
- **`review`**: are the labels right? Label a random sample yourself, blind to the model.
- **`profile`**: what has this model's confidence meant on other gates? Build a
  [calibration profile](#profile) from labelled ledgers, so a new gate can start in shadow from
  a borrowed bar instead of a guess.

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
| 1 | `check` only: the gate failed (grade, accuracy, ECE or model pin) |
| 2 | usage error, unknown gate, or a ledger or profile that is missing or cannot be parsed |

Exit 2 output goes to stderr, everything else to stdout. An unexpected internal error is also
exit 2, never 1, so CI cannot mistake a crash for a broken promise.

```text
ratchet: read a decision ledger and say what it shows.

Usage:
  ratchet report <ledger> [--gate <id>] [--target 0.98] [--min-support 30]
                 [--min-estimated 30] [--trust <prefix>=<class> ...]
                 [--profile <file> ...] [--json]
  ratchet check  <ledger> --gate <id> --promise <p> [--require measured|estimated]
                 [--min-rows 30] [--min-estimated 30] [--max-ece <e>] [--model <id>]
                 [--window 500] [--trust <prefix>=<class> ...]
                 [--profile <file> ...] [--min-support 30]
  ratchet replay <ledger> --gate <id> --act-above <p> [--refuse-below <p>]
                 [--go-is-yes true|false] [--json]
  ratchet review <ledger> --gate <id> [--sample 20] [--seed <n>] [--reviewer <name>] [--denied]
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
```

`ratchet help <command>` and `ratchet <command> --help` print each command's flags. Flags take
`--name value` or `--name=value`; an unknown flag, or a repeated one other than `--trust`,
`--profile` and `profile build --target`, is a usage error, because in a CI gate a misspelled option that is silently ignored is worse than one
that fails.

## How rows become gates

Rows are grouped by `gateId`. Ledgers written before gates existed have no gate id;
`JsonlLedger` reads those rows as `adhoc:<questionId>`, and a row with no gate id at all is
grouped by its question id.

A battery writes one row per member plus a combined row that carries the ruling and the label
(`combined: true`, same `requestId`). The combined rows are the gate. Each member's rows are
listed separately as `<gate>/<question>`, marked `(member)` in the report, so every member can
be calibrated on its own against the battery's truth. Any of these keys can be passed to
`--gate`.

## Label sources and `--trust`

A label is only as good as the route it arrived by, so each label's `source`
(`<channel>:<kind>[:<name>]`) has a trust class, and each class is read differently
(`src/ledger/sources.ts`):

| class | meaning | default sources | fits a bar, `check` accuracy | counted in `labelled` |
| --- | --- | --- | --- | --- |
| `blind` | judged before the model's answer was shown | `review:blind`, `review:blind:<name>` | yes | yes |
| `census` | a person answered every ask in the moment | `keywork:person`, `claude-code:person`, `codex:person` | yes | yes |
| `moment` | a person answered after seeing the model's answer | `desk:assisted` | no | yes |
| `consequence` | inferred from what happened next | `accepted:*`, `reverted:*`, `silence:*` | no | no: its own `consequence` column |
| `unknown` | no source, or one no entry names | every row written before sources | yes, as before | yes |

A source is looked up by `channel:kind`, then `channel:*`. `unknown` reads exactly as an
unsourced label always has, so a ledger written before sources reports the same numbers.

`--trust <prefix>=<class>`, on `report`, `check` and `trail`, lays one entry over the defaults;
the prefix is `channel:kind` or `channel:*`, and the flag may be repeated:

```sh
bun run ratchet report ledger.jsonl --trust desk:assisted=census --trust "sms:*=moment"
```

The report prints the entries it was read with (`labelTrust` in the JSON) and `check` appends
them to its line. Reclassifying a source changes which labels fit a bar, so bump the gate's
`evidenceVersion` when the change is meant to last; in code the same lever is
`EngineOptions.labelTrust`. A malformed prefix, a class not in the table or a prefix given twice
is a usage error.

## Evidence grades

Every number a command prints rests on some kind of evidence, and `report`, `check` and `trail`
say which kind before anything else. They read it through one function, `gradeOf`
(`src/ledger/evidence.ts`; design in [design/evidence-grades.md](design/evidence-grades.md)),
so no two of them can disagree about a gate:

| grade | what it is | what it may do |
| --- | --- | --- |
| `measured` | the first acts of the gate's current shadow phase, fixed before their labels were read, reached the promise by an exact one-sided 95% (Clopper-Pearson) lower bound with no wrong act | promote a gate to enforce; nothing else can |
| `estimated` | a 95% Wilson interval on at least `--min-estimated` (default 30) labelled unselected rows of trusted sources | raise a bar, demote, schedule a plan; never enable act, because it is read again with every new label |
| `borrowed` | evidence that is not this gate's labels: a profile built from other ledgers, or the disagreement of two judges from different models | shadow only |
| `none` | fewer rows than any grade needs | nothing; it says why |

The grade is the strongest the rows support, and it reads the gate's whole history, never
`check`'s `--window`: a planned sample is the first acts of its phase, and a window sliding past
them would turn it back into a moving one. With no rollout checkpoint to mark the phase, the
rows mark it: the rows recorded under the newest row's policy, rubric and evidence version
(answered by `--model`, for `check`), and of those the shadow rows since the last enforce row,
or for a gate now enforcing the shadow rows that preceded it. A changed configuration or a
demotion therefore starts a new sample, as it does in [Rollout](rollout.md). The plan is the
command's promise (`report --target`, `check --promise`, `trail --target`) at 95% with no wrong
act allowed, the default plan; a gate whose rollout uses another plan has its authoritative
grade in `RolloutStatus.grade`. A battery member is never measured, since its rows are features
of the battery's decision, and nothing bounds a promise of 1. Borrowed evidence comes from a
[profile](#profile) offered with `--profile`, and only for a gate with no fitted bar of its own;
disagreement is not built by any command yet, and `gradeOf` and `checkGate` take it as data.

Each grade prints as one sentence that opens with its word, so no number is read before its kind,
then says how old its evidence is, and the words never share a column with one another's numbers:

- **measured** prints its date, its bound against the promise and the sample size:
  `measured as of 2026-10-17: exact 95% lower bound 98.01% >= promised 98.0% on a planned sample of 149 acts, 0 wrong (labels: unsourced 149)`.
- **estimated** prints its date, its interval and width, how many rows and that they are not a
  planned sample:
  `estimated as of 2026-10-17: 77.6% right on 250 labelled unselected rows (labels: unsourced 250), 95% interval 72.0% to 82.3%, 10.3 points wide, not a planned sample`.
- **borrowed** from a profile names its donor (rows, gates, ledgers and dates) and says
  `0 rows here`:
  `borrowed as of 2026-10-17: bar 0.860 from profile 1d0adc40, donor 300 rows of gate bash.safe in ledger experiments/out/cli-example-ledger.jsonl, 2026-10-17 to 2026-10-17, 0 rows here`.
  A gate whose rows name that profile as their bar's source and no longer match its model or
  kind prints `borrowed (stale)`, in the sentence and in `report`'s grade column. Borrowed from
  disagreement says `at least 25.0% wrong on this slice, 40 pairs` and names the two models,
  never an accuracy.
- **none** states what is missing: `none: 12 labelled unselected rows; estimated needs 30`, and
  when other labelled rows exist but were chosen by the oracle's own confidence, says to label
  shadow rows or blind audits.

`labels:` counts the rows the grade read by trust class, leaving out empty classes; labels with
no source (the `unknown` class, so named in the JSON) print as `unsourced`.

The date is the age of the evidence, not the day the command ran: for measured, the label that
completed the planned sample; for estimated, the newest label it read; for borrowed, the date the
evidence came with (a profile's newest donor row, or the newest paired row a caller supplies for
disagreement). A measured grade decays as traffic, model and rubric move away from the sample it
rests on, and "measured" is read as permanent unless the date says otherwise, so a grade measured
in July says July in October. Running a command twice on the same ledger prints the same grades.

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
ratchet report <ledger> [--gate <id>] [--target 0.98] [--min-support 30] [--min-estimated 30] [--trust <prefix>=<class> ...] [--profile <file> ...] [--json]
```

| flag | default | meaning |
| --- | --- | --- |
| `--gate <id>` | all | one gate, plus its battery members if it has any |
| `--target <p>` | 0.98 | accuracy the fitted bar must deliver, and the promise a measured grade is read against |
| `--min-support <n>` | 30 | labelled rows the bar needs at or above it |
| `--min-estimated <n>` | 30 | labelled unselected rows an estimated grade needs |
| `--trust <prefix>=<class>` | the defaults | read a label source as a trust class; repeatable (see above) |
| `--profile <file>` | none | a [calibration profile](#profile) a gate with no fitted bar may be graded borrowed from; repeatable |
| `--json` | off | JSON instead of markdown |

```text
$ bun run ratchet report experiments/out/cli-example-ledger.jsonl
```

```text
# ratchet report: experiments/out/cli-example-ledger.jsonl

1286 rows in 6 gates. Bar target 98.0% accuracy with at least 30 labelled rows at or above it.
Grades: measured on a planned sample for a 98.0% promise (exact 95% bound, no wrong act allowed); estimated on at least 30 labelled unselected rows (95% Wilson interval).

## Calibration and fitted bar

| gate                      | grade     | rows | labelled | unselected | consequence | observed | expected | posture        | ECE   | Brier | bar   | coverage     | fitted on        |
| ------------------------- | --------- | ---- | -------- | ---------- | ----------- | -------- | -------- | -------------- | ----- | ----- | ----- | ------------ | ---------------- |
| bash.safe                 | measured  | 436  | 420      | 420        | 0           | 94.0%    | 91.7%    | underconfident | 0.030 | 0.055 | 0.962 | 43.8% (184)  | unselected (420) |
| ticket.route              | estimated | 250  | 250      | 250        | 0           | 77.6%    | 91.1%    | overconfident  | 0.152 | 0.194 | 0.998 | 12.0% (30)   | unselected (250) |
| stop.done                 | estimated | 150  | 150      | 150        | 0           | 99.3%    | 98.5%    | calibrated     | 0.018 | 0.007 | 0.502 | 100.0% (150) | unselected (150) |
| stop.done/tests (member)  | estimated | 150  | 150      | 150        | 0           | 94.0%    | 91.4%    | underconfident | 0.063 | 0.044 | 0.749 | 92.0% (138)  | unselected (150) |
| stop.done/claims (member) | estimated | 150  | 150      | 150        | 0           | 93.3%    | 90.1%    | underconfident | 0.056 | 0.068 | 0.961 | 38.0% (57)   | unselected (150) |
| stop.done/scope (member)  | estimated | 150  | 150      | 150        | 0           | 88.0%    | 90.4%    | overconfident  | 0.026 | 0.096 | 0.953 | 43.3% (65)   | unselected (150) |

## Operations

| gate                      | models                                     | failed open | errors                     | fixed | cost     | mean latency |
| ------------------------- | ------------------------------------------ | ----------- | -------------------------- | ----- | -------- | ------------ |
| bash.safe                 | sim-p0.93-rho0 (300), sim-p0.85-rho0 (120) | 16          | HTTP 503 (12), timeout (4) | 0     | $0.00840 | 145 ms       |
| ticket.route              | sim-p0.78-rho0 (250)                       | 0           | -                          | 0     | $0.00500 | 150 ms       |
| stop.done                 | sim-p0.93-rho0 (150)                       | 0           | -                          | 0     | $0       | 150 ms       |
| stop.done/tests (member)  | sim-p0.93-rho0 (150)                       | 0           | -                          | 0     | $0.00300 | 150 ms       |
| stop.done/claims (member) | sim-p0.93-rho0 (150)                       | 0           | -                          | 0     | $0.00300 | 150 ms       |
| stop.done/scope (member)  | sim-p0.93-rho0 (150)                       | 0           | -                          | 0     | $0.00300 | 150 ms       |

## Evidence

- bash.safe: measured as of 2026-10-17: exact 95% lower bound 98.01% >= promised 98.0% on a planned sample of 149 acts, 0 wrong (labels: unsourced 149)
- ticket.route: estimated as of 2026-10-17: 77.6% right on 250 labelled unselected rows (labels: unsourced 250), 95% interval 72.0% to 82.3%, 10.3 points wide, not a planned sample
- stop.done: estimated as of 2026-10-17: 99.3% right on 150 labelled unselected rows (labels: unsourced 150), 95% interval 96.3% to 99.9%, 3.6 points wide, not a planned sample
- stop.done/tests (member): estimated as of 2026-10-17: 94.0% right on 150 labelled unselected rows (labels: unsourced 150), 95% interval 89.0% to 96.8%, 7.8 points wide, not a planned sample
- stop.done/claims (member): estimated as of 2026-10-17: 93.3% right on 150 labelled unselected rows (labels: unsourced 150), 95% interval 88.2% to 96.3%, 8.2 points wide, not a planned sample
- stop.done/scope (member): estimated as of 2026-10-17: 88.0% right on 150 labelled unselected rows (labels: unsourced 150), 95% interval 81.8% to 92.3%, 10.4 points wide, not a planned sample

Grade is the kind of evidence behind a gate: measured (a planned sample reached the promise by an exact bound, the only grade that can promote a gate), estimated (an interval on labelled unselected rows, looked at again with every label, so not a promise), borrowed (evidence that is not this gate's labels, shadow only) or none. Observed is accuracy on labelled rows; expected is their mean stated confidence. Bar is the lowest confidence that delivered the target with enough support, and coverage is the share of the fitted rows at or above it; "none" means no bar did. Rows fitted on "all" were selected by the engine's own confidence, so treat that bar as a fallback. Only blind, census and unsourced labels fit a bar; consequence counts labels inferred from what happened next, which no other column reads. Fixed rows were decided by a floor or an allowlist without a call; they remain in operational counts but never in calibration or fitted thresholds. A battery's spend is recorded on its member rows; its own row carries the ruling.
```

How to read it:

- **grade** is the kind of evidence behind the gate, the word alone; the **Evidence** lines under
  the tables say what each grade rests on (see [Evidence grades](#evidence-grades)). `bash.safe`
  is measured: its first 149 shadow acts were all right, and that alone bounds its accuracy at
  98% or better. `stop.done` is right 99.3% of the time on 150 rows, but only 91 of them are
  acts, short of the 149 a 98% plan needs, so it is estimated, however good the estimate looks.
- **labelled** counts actual oracle answers with an outcome that did not fail open, from any
  label source but a consequence one; every accuracy number is computed on them. **unselected**
  is the part of that the oracle's confidence did not select (shadow rows and blind audits) with
  a label from a trusted source: blind, census or unsourced. **consequence** counts labels
  inferred from what happened next, which no other column reads (see
  [Label sources](#label-sources-and---trust)).
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
  are at least `--min-support` of them, else on every labelled row from a trusted source, shown
  as `all (n), biased`. `none` means no bar reached the target with enough support.
- **errors** groups failed-open rows by class: `HTTP <status>`, `timeout`, `aborted`,
  `short batch`, `malformed`, `unrecorded` (failed open with no message, as a budget cap does),
  or the message with numbers masked.
- **fixed** rows were decided by a floor or an allowlist without a call; they are excluded from
  accuracy, calibration, fitted thresholds, minimum evidence, and latency. An answered row
  whose action was bounded by a floor still contributes its real oracle answer. **mean latency** is over rows that called
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
  "minEstimated": 30,
  "gates": [
    {
      "gate": "ticket.route",
      "rows": 250,
      "requests": 250,
      "labelled": 250,
      "unselected": 250,
      "consequence": 0,
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
      "grade": {
        "kind": "estimated",
        "accuracy": 0.776,
        "lower": 0.7203636303789511,
        "upper": 0.8232824859392568,
        "n": 250,
        "confidence": 0.95,
        "sources": {
          "blind": 0,
          "census": 0,
          "moment": 0,
          "unknown": 250
        },
        "at": "2026-10-17T22:17:36.352Z"
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

`grade` is the evidence-grade union exactly as `gradeOf` returns it, one shape per `kind`:
`measured` carries `plan` (the resolved plan with its hash), `lowerBound`, `errors`,
`sampleSize`, `sources` and `at`; `estimated` carries `accuracy`, `lower`, `upper`, `n`,
`confidence`, `sources` and `at`; `borrowed` carries `via` and `at`; `none` carries `reason`,
`labelled` and `unselected`, and a stale borrowed grade also carries `"stale": true`. A battery
member's entry also carries `"memberOf": "<gate>"`, a report read with `--trust` carries
`"labelTrust"`, the entries given, and one read with `--profile` carries `"profiles"`, each
offered profile's `hash` and `key`.

## `check`

```text
ratchet check <ledger> --gate <id> --promise <p> [--require measured|estimated] [--min-rows 30] [--min-estimated 30] [--max-ece <e>] [--model <id>] [--window 500] [--trust <prefix>=<class> ...] [--profile <file> ...] [--min-support 30]
```

| flag | default | meaning |
| --- | --- | --- |
| `--gate <id>` | required | the gate to judge |
| `--promise <p>` | required | accuracy promised on the rows the policy acts on, and the promise a measured grade is read against |
| `--require <grade>` | by mode | the weakest [grade](#evidence-grades) that passes: `measured` or `estimated`; by default measured when any row in the window enforces, estimated while the gate is in shadow |
| `--min-rows <n>` | 30 | rows needed before accuracy or ECE is judged |
| `--min-estimated <n>` | 30 | labelled unselected rows an estimated grade needs |
| `--max-ece <e>` | not checked | ECE bound |
| `--model <id>` | not checked | the pinned model version |
| `--window <n>` | 500 | most recent rows of the gate to judge, by timestamp |
| `--trust <prefix>=<class>` | the defaults | read a label source as a trust class; repeatable |
| `--profile <file>` | none | a [calibration profile](#profile) a gate with no fitted bar may be graded borrowed from, matched against `--model` when it is given; repeatable. Borrowed never passes, so this only says what the gate has |
| `--min-support <n>` | 30 | with `--profile`: labelled rows a bar of the gate's own needs at or above it, as in `report` |

The check fails when the gate's grade is weaker than `--require`, or when, in the most recent
`--window` rows of the gate, any of these holds:

0. **Grade.** The gate's [evidence grade](#evidence-grades), read from its whole history against
   `--promise`, is weaker than the grade required. By default that depends on the gate: if any
   row in the window enforces, the gate acts on its own and owes its promise an exact bound, so
   `measured` is required; while it is in shadow the check asks whether it is on course, not
   whether it has proven itself, so `estimated` (at least `--min-estimated` labelled
   unselected rows) is enough. The line says which applied and why
   (`requiring measured: this gate enforces`, or `requiring estimated: this gate is in shadow;
   pass --require measured to insist`). `--require` overrides either way. Borrowed evidence and
   none never pass. A promise of 1 cannot be measured: `--promise 1 --require measured` is a
   usage error, and an enforcing gate held to it by default fails with that reason.
1. **Accuracy.** Among labelled, unselected rows (shadow rows and blind audits, labelled from a
   trusted source) on which the recorded policy said act, the share where acting was right is below `--promise`, and there are
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

It prints one line: `PASS` with a summary, or `FAIL` with every reason that applies. The grade's
sentence is on the line either way, so no figure on it is read without the kind of evidence
behind it. In `checkGate`'s result, `grade` and `require` carry the same, and `ece.from` is
`"unselected"` or `"all"`, the spelling `report` uses for `fittedFrom`.

```text
$ bun run ratchet check experiments/out/cli-example-ledger.jsonl --gate bash.safe --promise 0.95
PASS bash.safe: requiring estimated: this gate is in shadow; pass --require measured to insist; measured as of 2026-10-17: exact 95% lower bound 95.05% >= promised 95.0% on a planned sample of 59 acts, 0 wrong (labels: unsourced 59); acted accuracy 98.7% on 230 shadow acted rows (promise 95.0%); ECE 0.030 on 420 unselected rows; window 436 of 436 rows
$ echo $?
0

$ bun run ratchet check experiments/out/cli-example-ledger.jsonl --gate bash.safe --promise 0.95 --model sim-p0.93-rho0
FAIL bash.safe: 120 of 420 answered rows came from models other than the pinned sim-p0.93-rho0: sim-p0.85-rho0 (120); requiring estimated: this gate is in shadow; pass --require measured to insist; measured as of 2026-10-17: exact 95% lower bound 95.05% >= promised 95.0% on a planned sample of 59 acts, 0 wrong (labels: unsourced 59); window 436 of 436 rows
$ echo $?
1

$ bun run ratchet check experiments/out/cli-example-ledger.jsonl --gate ticket.route --promise 0.95 --max-ece 0.05
FAIL ticket.route: acted accuracy 81.0% on 195 shadow acted rows is below the promise 95.0%; ECE 0.152 on 250 unselected rows exceeds 0.05; requiring estimated: this gate is in shadow; pass --require measured to insist; estimated as of 2026-10-17: 77.6% right on 250 labelled unselected rows (labels: unsourced 250), 95% interval 72.0% to 82.3%, 10.3 points wide, not a planned sample; window 250 of 250 rows
$ echo $?
1

$ bun run ratchet check experiments/out/cli-example-ledger.jsonl --gate stop.done --promise 0.98 --max-ece 0.05 --model sim-p0.93-rho0
PASS stop.done: requiring estimated: this gate is in shadow; pass --require measured to insist; estimated as of 2026-10-17: 99.3% right on 150 labelled unselected rows (labels: unsourced 150), 95% interval 96.3% to 99.9%, 3.6 points wide, not a planned sample; acted accuracy 100.0% on 91 shadow acted rows (promise 98.0%); ECE 0.018 on 150 unselected rows (max 0.05); model sim-p0.93-rho0 on all 450 answered rows; window 150 of 150 rows
$ echo $?
0

$ bun run ratchet check experiments/out/cli-example-ledger.jsonl --gate stop.done --promise 0.98 --max-ece 0.05 --model sim-p0.93-rho0 --require measured
FAIL stop.done: requires measured evidence, has estimated as of 2026-10-17: 99.3% right on 150 labelled unselected rows (labels: unsourced 150), 95% interval 96.3% to 99.9%, 3.6 points wide, not a planned sample; requiring measured, as --require asks; window 150 of 150 rows
$ echo $?
1

$ bun run ratchet check experiments/out/cli-example-ledger.jsonl --gate nope --promise 0.9
ratchet check: no gate "nope" in the ledger; gates: bash.safe, ticket.route, stop.done, stop.done/tests, stop.done/claims, stop.done/scope
Run "ratchet help check" for usage.
$ echo $?
2
```

The first two lines are the same gate: its accuracy is fine, and the pin still fails, because a
model version the bar was never fitted on answered the last 120 rows. That is the drift the pin
exists to catch. The two `stop.done` lines are one gate too: it is in shadow, so by default its
estimate is enough and it passes; but only 91 of its rows are acts, short of the 149 a 98% plan
needs, so `--require measured` fails it, with the estimate on the line.

Things to know before putting it in CI:

- **The requirement follows the gate.** A shadow gate needs an estimate; once a row in the
  window enforces, the gate needs a measured grade, so promoting it by hand without a planned
  sample turns CI red. Pass `--require measured` to hold a shadow gate to the exact bound.
- **Too few labels fails; too few rows to judge a figure passes, said out loud.** A gate with
  fewer than `--min-estimated` labelled unselected rows has no grade and fails. Below
  `--min-rows`, accuracy and ECE are reported as `not judged` and do not fail the check. Read
  the line, or pair the check with a job that asserts labels are arriving.
- **ECE is noisy on small samples.** With 10 bins, a perfectly calibrated simulated oracle at
  90% accuracy averages an ECE of 0.086 on 30 rows (one run in ten above 0.13), 0.048 on 100 and
  0.028 on 300. Use `--max-ece` with a few hundred labelled rows, or with a generous bound.
- **The window is rows, not time.** Re-pinning after an upgrade only passes once the old
  model's rows have left the window; `--window` is the knob.

A CI step is one line, for example:

```sh
bun run ratchet check ledger.jsonl --gate bash.safe --promise 0.98 --max-ece 0.08 --model typesafe/jev-1.13-20260917
# to hold a shadow gate to the exact bound before anyone flips it:
bun run ratchet check ledger.jsonl --gate bash.safe --promise 0.98 --require measured --model typesafe/jev-1.13-20260917
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

## `review`

```text
ratchet review <ledger> --gate <id> [--sample 20] [--seed <n>] [--reviewer <name>] [--denied]
```

Labels that arrive in the moment (an approval click, an accepted suggestion) are not the same
evidence as a considered judgment. `review` measures the difference. It draws a seeded uniform
sample of one judge gate's decision rows that kept their state (`Engine` `keepState`) and have
not been reviewed, shows each state exactly as the oracle saw it, and asks for a verdict
(`y`, `n`, `s` to skip, `q` to stop). Nothing about the model's answer or an earlier label is
shown until the session ends, so neither can steer the next answer; the summary then reports how
often your answers matched the model's lean and the earlier labels, and lists the rows whose
label changed.

The sample is drawn by the seed, never chosen by hand, and the seed is printed so the draw can be
repeated. Each answer becomes the row's label with source `review:blind` (or
`review:blind:<name>`); a replaced label is kept in the note, and the append-only ledger keeps
both outcome lines. A battery's members inherit the review through the battery's truth, as
`Engine.label` does. Reviewed rows are not drawn again.

`--denied` reviews every unreviewed row whose current label is a denial, in ledger order, instead
of a random sample (`--sample` and `--seed` are then ignored). Denials are rare and often judge
the moment rather than the call, so each deserves a considered look. The rows are chosen by the
person's label and never by the model's verdict, so the gate's measured accuracy stays unbiased;
but a review of denials can only move labels toward approval, which flatters a gate that mostly
approves, so it is paired with the uniform sample, whose disagreement rate bounds what the
unreviewed approvals hide.

## `trail`

```text
ratchet trail <ledger> [--gate <id>] [--request <id>] [--last <n>] [--target 0.98] [--min-estimated 30] [--trust <prefix>=<class> ...] [--profile <file> ...] [--min-support 30] [--json]
```

| flag | default | meaning |
| --- | --- | --- |
| `--gate <id>` | all | one gate, with its battery members attached to each decision |
| `--request <id>` | | one request, by request id or decision id; a prefix of six or more characters will do |
| `--last <n>` | 10 | the newest n decisions, printed oldest first |
| `--target <p>` | 0.98 | the promise each bar's grade is read against, as in `report` |
| `--min-estimated <n>` | 30 | labelled unselected rows an estimated grade needs |
| `--trust <prefix>=<class>` | the defaults | read a label source as a trust class; repeatable |
| `--profile <file>` | none | a [calibration profile](#profile) a bar with no fitted bar under it may be graded borrowed from; repeatable |
| `--min-support <n>` | 30 | with `--profile`: labelled rows a fitted bar needs at or above it |
| `--json` | off | the `Trail` object instead of text |

`report` says what a gate's record adds up to; `trail` shows the record itself. One section per
decision: the question, the strategy, every member answer it bought (an ensemble's votes in the
order asked, a cascade's tiers marked escalated or settled, a sequential run's samples, a
battery's member rows with their inherited labels), the pooled verdict and the probability that
acting is right, the ruling, the floor that bounded it, what the application did, the state and
rubric hashes, and the label when one has arrived.

```text
$ bun run ratchet trail experiments/out/cli-example-ledger.jsonl --gate stop.done --last 1
```

```text
# ratchet trail: experiments/out/cli-example-ledger.jsonl

1 of 150 decisions of gate stop.done, oldest first. Judge answers show p(yes); pick and rate answers show the leading probability.

Grades are read against a 98.0% promise; estimated needs 30 labelled unselected rows.

- stop.done: act bar above 0.930 and at or below 0.960, from 150 rows; estimated as of 2026-10-17: 99.3% right on 150 labelled unselected rows (labels: unsourced 150), 95% interval 96.3% to 99.9%, 3.6 points wide, not a planned sample

## 2026-10-17T22:17:43.111Z · stop.done · soft act, applied review (shadow)

battery stop.done: tests, claims, scope
battery · jev · sim-p0.93-rho0 · yes (1.00) · go 1.000 · agreement 1.00 · $0.0000600 · 150 ms

| #   | member                  | answer     | confidence | cost       | latency | note  |
| --- | ----------------------- | ---------- | ---------- | ---------- | ------- | ----- |
| 1   | tests (sim-p0.93-rho0)  | yes (0.90) | 0.90       | $0.0000200 | 150 ms  | right |
| 2   | claims (sim-p0.93-rho0) | yes (0.94) | 0.94       | $0.0000200 | 150 ms  | right |
| 3   | scope (sim-p0.93-rho0)  | yes (0.95) | 0.95       | $0.0000200 | 150 ms  | right |

state 39fa6716 · request 03b68898 · decision c159840e
label right, truth true at 2026-10-17T22:17:43.112Z
```

The act bar printed per gate is **inferred** from the rulings: it lies above the highest go the
policy held back and at or below the lowest it acted on, over answered rows with no floor, one
bar per policy hash. The ledger stores the policy only as a hash, so this is what the record can
say about the bar, and when the rulings fit no single bar the line says so. Each bar line ends
with the [grade](#evidence-grades) of the gate's rows under that policy, so a changed bar starts
its own planned sample rather than inheriting the old one's; in `--json` each entry of `bars`
carries it as `grade`, and the `Trail` carries the levers it was read with (`target`,
`minEstimated`, `labelTrust`, and with `--profile`, `profiles` and `minSupport`). A row of a gate
whose bar was borrowed from a profile records it in `detail.barSource`, and its section says
`bar borrowed from profile <hash>`.

Member answers are recorded on compound rows (ensemble, cascade, sequential) as `members` and
`detail` from this version on; older compound rows print the pooled verdict alone. Battery
members were always rows of their own and need nothing new. Each recorded member carries `key`,
its identity across rows (its label, else `<oracle>#<position>`, filled in when an older ledger
is read), and the member that settled a cascade or a sequential run carries `settled`, which is
what marks it settled; rows written before `settled` are read from the strategy's `detail`.

### The viewer

The same trail, laid out: `bun run trail <ledger>` starts a loopback server (port 3211,
`TRAIL_PORT` to change it) and serves `examples/trail/`, a page with no framework and no build
step. Each decision is a row with its evidence on one scale from 0 to 1: member answers as
ticks, the pooled verdict as a marker coloured by the ruling, the inferred act bar as a band
running down the page. Filters (gate, ruling, label, exceptions, free text) live in the URL, as
does one opened decision, so a view can be handed to someone. The page polls the file and
follows new rows, or takes a dropped `.jsonl` (an arcade download works) without a path on the
command line. The server reuses `buildTrail`, so the page shows exactly what the command prints.

## `profile`

```text
ratchet profile build <ledger...> --model <pin> --kind <judge|pick|rate> [--question-hash <h>] [--target 0.98 ...] [--min-support 30] [--trust <prefix>=<class> ...] [--out <file>]
ratchet profile show <file> [--json]
ratchet profile merge <a> <b> [<c> ...] --out <file>
```

A new gate has no labels, so it has no bar of its own and no grade: a fixed guess acts on
nothing or on too much. A **calibration profile** is what one model's stated confidence has
meant on other gates' labelled rows, so the gate can start in shadow from a bar earned elsewhere
(`src/ledger/profile.ts`; design in [design/evidence-grades.md](design/evidence-grades.md),
WP3). It is borrowed evidence: it grades a gate `borrowed` at best, and only a measured grade
of the gate's own reaches enforce.

`build` reads labelled unselected rows (shadow rows and blind audits) of trusted sources that the
exact `--model` answered alone (strategy `single`: neither a battery's pooled row nor a member
labelled with its battery's truth), for `--kind` questions, and with `--question-hash` only that
rubric. It keeps them as `--resolution` equal confidence bins per donor gate, 100 by default, so
a bar can sit at any hundredth. The bar for each `--target` is the **cautious end**: the lowest
bin edge at which every donor gate with at least `--min-support` rows in its tail (every row at
or above the edge, not the bin's own rows) clears the target on that tail by a 95% Wilson lower
bound, with at least one gate that well supported. On one gate that is how `report` fits a bar
with the conservative bound, so a borrowed bar and a fitted bar mean the same thing. Across
gates it is the strictest donor's bar, not the average: a profile is lent to a gate none of its
donors is, so it must hold on every gate it was read from, and one gate whose questions the
model is confidently wrong on holds the bar up, or leaves the promise with none, while a gate the
model was never that sure about says nothing there. A gate that misses at one edge by a hair
holds the bar to the next edge where it clears. Each gate's own bar is printed by `show` for
reading. Coarse bins hide bars: at ten, the finest bar below 1 is 0.9, and every answer from 0.90
to 1 has to keep the promise together.

| flag | default | meaning |
| --- | --- | --- |
| `<ledger...>` | required | one or more ledgers; a gate id in two of them is one gate, and a row read twice counts once |
| `--model <pin>` | required | the exact model rows record |
| `--kind <kind>` | required | `judge`, `pick` or `rate` |
| `--question-hash <h>` | any rubric | only rows of this rubric (a row's `questionHash`) |
| `--target <p>` | 0.9, 0.95, 0.98, 0.99 | a promise to state a bar for; repeatable. 0.9 is in the defaults so a profile always reports the lowest standard bar it supports |
| `--min-support <n>` | 30 | rows a donor gate needs at or above its bar |
| `--resolution <n>` | 100 | equal confidence bins across [0, 1], 1 to 1000; a bar is one of their edges |
| `--trust <prefix>=<class>` | the defaults | read a label source as a trust class; repeatable |
| `--out <file>` | stdout | write the profile here instead of printing its JSON |

```text
$ bun run ratchet profile build experiments/out/cli-example-ledger.jsonl --model sim-p0.93-rho0 --kind judge --target 0.95 --target 0.98 --out sim-judge.json
wrote sim-judge.json: profile 1d0adc40 of sim-p0.93-rho0 judge questions: 300 rows of gate bash.safe in ledger experiments/out/cli-example-ledger.jsonl, 2026-10-17 to 2026-10-17; bars 95.0% at 0.670 (support 298), 98.0% at 0.860 (support 228)

$ bun run ratchet profile show sim-judge.json
```

```text
# ratchet profile: sim-judge.json

Profile 1d0adc408bcb2be0 of sim-p0.93-rho0 judge questions, from 300 rows of gate bash.safe in ledger experiments/out/cli-example-ledger.jsonl, 2026-10-17 to 2026-10-17 (labels: unsourced 300). Borrowed evidence: a gate may start from it in shadow and never enforce on it.

## Bars

| promise | bar   | support | act above |
| ------- | ----- | ------- | --------- |
| 95.0%   | 0.670 | 298     | 0.720     |
| 98.0%   | 0.860 | 228     | 0.910     |

Bars sit on the edges of 100 equal bins. A bar is the lowest edge at which every donor gate with at least 30 rows in its tail (every row at or above the edge) keeps the promise on that tail by a 95% Wilson lower bound: the strictest donor's bar, since a profile is lent to gates it has not seen. "support" is the fewest tail rows among the gates that kept it; "none" means no edge held on every such gate. Each gate's own bar is below, for reading. "act above" is what policyFromProfile puts in a policy: the bar plus a 0.05 half-band.

## Donor gates

| gate      | rows | bar at 95.0% | bar at 98.0% |
| --------- | ---- | ------------ | ------------ |
| bash.safe | 300  | 0.670 (298)  | 0.860 (228)  |

## Bins, in tenths (the profile holds 100; --json lists them)

| gate      | confidence | rows | mean confidence | accuracy |
| --------- | ---------- | ---- | --------------- | -------- |
| bash.safe | 0.6 to 0.7 | 7    | 0.666           | 85.7%    |
| bash.safe | 0.7 to 0.8 | 38   | 0.749           | 89.5%    |
| bash.safe | 0.8 to 0.9 | 61   | 0.858           | 95.1%    |
| bash.safe | 0.9 to 1.0 | 194  | 0.967           | 100.0%   |
```

Only `bash.safe`'s 300 answers from `sim-p0.93-rho0` are read: its failed-open rows and the 120
from `sim-p0.85-rho0` are not that model's answers, `ticket.route` is a pick from another model,
and `stop.done`'s members are labelled with their battery's truth.
The bins table is grouped into tenths for reading; the bars use all hundred, which is why a bar
can sit at 0.86 inside the 0.8 to 0.9 row. The file is the profile itself (`--json` on `show`
prints it, checked): `format`, `key` (`model`, `kind`, and `questionHash` when given),
`targets`, `minSupport`, `resolution`, `bars` (`target`, `bar`, `support`: the fewest tail rows
at the bar among the gates that kept it), `bins` (every non-empty bin per gate: `gate`, `lo`, `hi`,
`n`, `meanConfidence`, `accuracy`), `from` (rows, gates, ledgers, the oldest and newest row read,
labels by trust class) and `hash`, over the key, levers, bars and bins but not `from`, so two
profiles built from the same rows are one profile whatever their ledgers were called. A profile
whose bars or hash are not what its bins give is refused, exit 2.

`merge` adds profiles of one model, kind, `--min-support` and `--resolution` into `--out`, its
bars recomputed for every target either was built for; merging is commutative and associative
and equals one build over every row. Profiles that name the same ledger are refused, since its
rows would count twice, and so are profiles of different resolutions, whose bars sit on
different edges.

**Borrowing.** `report`, `check` and `trail` take `--profile <file>` (repeatable). A gate with no
fitted bar of its own (at `--target` or `--promise`, with `--min-support` rows) is matched by the
model of its newest answered row (or `check --model`, a pin) and its question kind against each
profile's key, a profile keyed to the gate's rubric first; the first that matches lends its bar
for the command's promise, and the grade, when nothing stronger exists, is `borrowed`. A gate
that pools answers (a battery, an ensemble) matches nothing, and no profile is shopped past for
one with a bar. On the example ledger nothing borrows: every gate has a fitted bar, and
`bash.safe`'s newest answers come from `sim-p0.85-rho0`, so a `sim-p0.93-rho0` profile has
expired for it. The report says what it was offered:

```text
$ bun run ratchet report experiments/out/cli-example-ledger.jsonl --profile sim-judge.json
...
Profiles offered with --profile: 1d0adc40 (sim-p0.93-rho0 judge questions). A gate with no fitted bar borrows from the first that matches it, shadow only.
```

A gate built from a profile in code (`policyFromProfile` and `GateSpec.barSource`) records
`detail.barSource` on every row; such a gate borrows only from that profile, and once its newest
answer no longer matches the key its grade is `borrowed (stale)`. `bun run profiles` regenerates
`profiles/*.json`, shipped with the package, from the live ledgers under `experiments/out/`
([profiles/README.md](../profiles/README.md) names each one's donors).

## The library underneath

The CLI is a thin layer over functions any program can call. `src/cli/report.ts`,
`src/cli/check.ts`, `src/cli/replay.ts` and `src/cli/trail.ts` export `buildReport`, `checkGate`,
`replayGate` and `buildTrail` / `selectTrail` / `inferBars`
(pure, rows in, result out) next to the command functions `report`, `check` and `replay`, which
take an argv array and return `{ exitCode, output }`; `src/cli/main.ts` dispatches.

`src/ledger/evidence.ts` holds the grade every command prints:

```ts
gradeOf(rows: readonly DecisionRecord[], opts?: GradeOptions): EvidenceGrade
describeGrade(grade: EvidenceGrade): string        // the one sentence each surface prints
atLeast(grade: EvidenceGrade, kind: GradeKind): boolean
```

`GradeOptions` carries an `acceptance` result already evaluated or a `plan` to evaluate on the
rows' current phase (with `model` to pin it), `minEstimated` (30), `confidence` (0.95), the trust
filter (`sources`, default blind, census and unsourced; `trust`), an optional `borrowed` input
with `borrowedAt` (its date, when it does not carry one), and `now`, the clock used only for
evidence nothing else can date. `gradeGroup` in `src/cli/common.ts` is how the commands call it, and
`wilsonInterval(p, n, confidence)` in `calibration.ts` is the estimate's interval, with
`wilsonLower` as its lower end. `stale` marks a borrowed profile the gate has moved off.

`src/ledger/profile.ts` and `src/ledger/borrow.ts` hold the profile `ratchet profile` writes:

```ts
buildProfile(rows, key: ProfileKey, opts: ProfileOptions): CalibrationProfile | undefined
mergeProfiles(a: CalibrationProfile, b: CalibrationProfile): CalibrationProfile
borrowedBar(profile, target): number | undefined      // the cautious end, from the bins
profileMatches(profile, gate: ProfileGate): boolean   // same model, kind, and rubric if keyed
profileAge(profile, now: Date): number                // days since the newest row read
parseProfile(data: unknown): CalibrationProfile       // checks a file's shape, bars and hash
borrowFor(rows, profiles, { target, model? }): Borrowing | undefined
policyFromProfile(profile, target, opts?): GatePolicy // in policy.ts: the bar plus 0.05
```

`ProfileOptions` carries `ledgers` (named in the donor), `targets` (`PROFILE_TARGETS`: 0.9, 0.95, 0.98, 0.99), `minSupport` (30)
and the trust filter. `borrowFor` is what `report`, `check`, `trail` and `Engine.report` (with
`EngineOptions.profiles`) call for a gate with no fitted bar.

`src/ledger/calibration.ts` gained the fitting modes the design asks for:

```ts
type FitMode = "accuracy" | "recall";
interface FitOptions { conservative?: boolean; confidence?: number; mode?: FitMode; sources?: readonly FitClass[] }
type ScoreOptions = TrustFilter & { unselectedOnly?: boolean }

fitThreshold(items: readonly Scored[], target: number, minSupport = 20, opts: FitOptions = {}): FittedThreshold | undefined
scoredWithTruth(records: readonly DecisionRecord[], opts?: ScoreOptions): ScoredTruth[]
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
- `sources` is read where items are scored: pass the same options to `scoredFromLedger` or
  `scoredWithTruth`, which read only labels whose trust class it names (default blind, census
  and unsourced). A consequence class cannot be named.
