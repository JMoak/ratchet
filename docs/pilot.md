# Shadow pilot: tool approval and output verification

This is a small, runnable experiment through the real engine: scenario -> trusted/untrusted
state -> gate and floors -> persisted ledger -> labels -> fitted candidate -> frozen
validation -> report. It exercises the application boundary without executing any proposed
command, sending a message, transferring money, or publishing an artifact.

The default is offline. The live option calls the pinned Jev adapter using the existing
OpenRouter key. Both remain in shadow; neither can authorize enforcement.

See the [first live results and graphs](pilot-results.md) for a completed run.

```sh
bun run pilot
bun run pilot --live
```

Each command prints a new directory under `experiments/out/pilot/`. Runs are never appended
to an old ledger or silently combined. The files are:

- `ledger.jsonl`: decisions and subsequently attached outcomes.
- `manifest.json`: candidate policies saved before validation calls, requested and fit-observed
  models, rubric/threshold hashes, floor and strategy versions, corpus hash, and policy hash.
- `results.json`: metrics computed from rereading the ledger, with per-case diagnostics.
- `evidence.json`: a separate seeded IID experiment about promotion rules.
- `sources.json`: the primary sources underlying the authored scenarios.

## What the scenarios establish

There are 54 original fixtures and 18 families, split equally into fit, validation and
challenge. Related variants stay in the same split. They cover imagined repository
maintenance, release work, customer-support drafts, financial-operation boundaries, and
candidate outputs that overstate what their evidence proves. See
[scenario provenance](pilot-sources.md) for sources and reference labels.

These are agent-authored fixtures, not independent human labels, randomly sampled traffic,
or a published benchmark. The supplied tool receipts are fictional trusted inputs of the
imagined application. A real application must obtain them from authenticated records.
The model never receives reference labels, label reasons, split IDs, or expected floors.

The application supplies known one-way-door and forbidden-operation metadata. Code
enforces those boundaries. Other uncertain cases go to the model. This demonstrates the
division of responsibility; it does not demonstrate that a model can safely discover all
security boundaries from prose.

Candidate thresholds use affirmative action probability, not confidence in whichever answer
leads. They are fitted once on fit rows only, excluding floor placeholders and failed-open
answers. The illustrative target is 98%, with three supporting fit answers required.
That deliberately small fit is exploratory, not a certification rule. Both candidates are
frozen before validation calls. Challenge results are reported separately and never refitted.

Metrics distinguish recommendations from actual actions. “Potential review savings” means
the share of shadow rows where the policy would have acted; all actual actions remain
review. Failure rows stay in coverage denominators. Floor rows count as operational
decisions but are excluded from oracle calibration. The calibration plot compares predicted
affirmative probability with the observed eligible share, not leading-answer accuracy.
Held-out threshold curves are diagnostics; they must not be used to retune the reported
frozen operating point and then call that same sample validation again.

## What the statistical experiment establishes

The evidence experiment generates independent Bernoulli action-correctness outcomes with
known accuracy. It compares point estimates, one planned exact-binomial evaluation, and
uncorrected repeated evaluations at matched label budgets. It does not use the scenario
labels or estimate the live model's accuracy.

`validateFixedPolicy()` is an experiment-local helper, not a new public library API. It
returns counts, an observed proportion, an exact one-sided lower bound, and an explicit
supported / insufficient-evidence / below-target status. Its interpretation requires a
fixed policy, independent representative outcomes, and one predetermined evaluation.
The helper cannot verify those assumptions or change a gate's mode.

The exact bounds follow [NIST's binomial interval guidance](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm).
Repeated inspection needs a different statistical contract, such as the
[time-uniform approach described by Howard et al.](https://arxiv.org/abs/1810.08240).

## Plotting and inspecting a run

Charts are generated with Matplotlib, an optional experiment tool; Ratchet still has no
runtime dependencies. Install it into an isolated environment or the ignored output folder:

```powershell
python -m pip install --target experiments/out/plot-libs matplotlib==3.11.2
$env:PYTHONPATH = (Resolve-Path experiments/out/plot-libs).Path
python experiments/pilot/plot.py <run-directory>
```

The plotter writes a local `report.html` and PNG/SVG figures. It reads saved JSON and makes
no model or network calls. Graphs separate fixture observations from the IID simulation;
they do not attach population confidence intervals to the correlated authored scenarios.

The live runner makes serial requests with no transport retries, a 15-second transport
timeout, a bounded corpus, and a $0.25 recorded-spend cutoff beneath the existing $0.50
experiment envelope. It stops contacting a backend after three consecutive failures while
preserving review records for the remaining cases. This is not a prepaid hard cap: a final
call's cost is known afterward, and failed responses may have unreported costs.

## Next evidence

Replace the authored fixtures with a representative shadow sample from one application.
Have independent reviewers label it without seeing model confidence. Choose the
wrong-action target and minimum useful review savings from the actual error costs.
Fit on one set, freeze the complete policy, then validate on untouched sessions at a planned
evaluation point. The current corpus remains a regression suite after it informs any change.
