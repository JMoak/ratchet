# Recipe forge: one command, one task, a measured draft

The first executable slice is built for SKUby supplier-reply findings. It ingests reviewed
cases, records their evidence and labels in a local ledger, asks a flagship model for a small
rubric, compiles a draft recipe, and compares it on separate cases. No runtime dependency,
background collector, production adapter or new orchestration framework was added.

## Run the fixture

```powershell
bun run forge --demo --offline
```

This exercises capture, compilation, floors and reporting without a key. The draft is
hand-authored and every oracle abstains; the offline report makes no model-quality claim.

For one live teacher job and the comparison, using the existing Windows credential:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\decision-pack-key.ps1 -Action Run -Experiment forge -Budget 5
```

The demo has **8 teaching cases and 16 test cases**, grouped by source scenario. All are
assistant-authored fixtures, not the owner's mail or independently reviewed real outcomes.
Default teacher: `openai/gpt-6-astra`, high reasoning effort, with the actual returned model
recorded. The provider's public model catalogue was checked before the first run.

The four comparison arms are bare Jev, Jev with the existing procurement pack, Jev with the
forged recipe, and the flagship with the forged recipe. The procurement pack is a generic
Ratchet baseline; SKUby's existing second-look provider is not integrated into this runner.
Every arm uses shadow mode, the same provisional 0.98 bar and the existing hard floors.
There is no fitting, promotion, purchasing action or model-weight training.

First live run, 2026-11-17: the teacher produced seven rules and selected six ledger-linked
examples. All four arms classified all 12 non-floored test cases correctly; four additional
cases were held by code without a model call. Jev's Brier loss was 0.0107 bare, 0.0086 with the
generic pack, and 0.0062 with the forged recipe. All three Jev arms deferred every case at the
0.98 bar. The flagship proposed six supported annotations and zero unsupported annotations.
The complete run cost $0.306364 across 49 requests, including the teacher, with no failed
judgments. This is a small probability-score improvement on easy authored cases, not evidence
of improved classification accuracy, increased cheap-model automation or real review savings.
The exact report and frozen recipe are under
`experiments/out/forge/2026-11-17T09-54-03-836Z-live/`.

## Bring reviewed cases

Use `-Cases C:\path\reviewed.jsonl` with the secure launcher. Alternatively, when a key is
already available in the process environment:

```powershell
bun run forge --cases=reviewed.jsonl --live --budget=5
```

This explicitly sends that export's teaching and test inputs to the configured provider in
their respective stages. Export only material permitted for that use. The runner does not
connect to a mailbox or inherit a source application's permission checks.

Each JSONL line follows this shape (the example is synthetic):

```json
{"schema":"ratchet.forge-case/1","id":"order-01/claim-1","group":"order-01","split":"teach","input":{"sourceVerified":true,"numericChecksPass":true,"draftOnly":true,"policy":"Check only support for a draft supplier finding.","evidence":"Supplier: We expect Friday, subject to stock.","candidate":"Delivery is unconditionally confirmed for Friday."},"label":{"supported":false,"why":"The source retains a stock condition.","source":"curriculum:authored"}}
```

Supply 2-24 teaching cases with both supported and unsupported findings, plus separate `test`
cases; the pilot accepts at most 100 cases. All messages and variants from an order or authored
template belong to one `group`. Duplicate IDs and shared teaching/test groups or exact source
text are rejected. Semantic duplication and correct family assignment still need review.

Use `review:blind:<reviewer>` only for an actual review completed before seeing the model's
answer. The importer cannot authenticate that assertion. Authored fixtures keep
`curriculum:authored`, which cannot qualify a gate. Clicks, silence, teacher guesses and
assisted approvals are rejected as truth sources. Application code must supply the three
control booleans from real checks; they are not fields to copy from supplier documents.

## What the command preserves

Each run gets a new directory under `experiments/out/forge/` with the case export, source
snapshots, capture ledger, exact teacher request/response, frozen `recipe.json`, observation
ledger, scores, purchase receipts and report. An interrupted run retains its partial records
and failure reason. The credential never enters these files.

The teacher sees only teaching cases, their explicit policies/checks and reviewed ledger
labels. It returns **rules plus existing example IDs**. The compiler copies example facts
and labels from those records, rejecting unknown IDs, relabelling fields and policy/floor
overrides. Rules and examples receive a content-derived evidence version before test calls.
The teacher's natural-language rules still need empirical evaluation; structural validation
does not prove that a rule is good.

The report separates answer quality, supported/unsupported hypothetical acts, handoffs, hard
holds and unavailable judgments. Hard holds and failures cannot inflate answer accuracy or
Brier scores. Total provider cost includes the teacher and all comparison calls. The existing
purchase cutoff stops after unknown billing; it is not a prepaid or guaranteed maximum bill.

For offline replay of an authored or reviewed draft on custom cases, use
`--offline --draft=path.json`; the draft contains only `rubric` and `exampleIds`. Offline
oracles remain unassessed. Reusing an inspected test set creates an exploratory rerun, not a
fresh confirmation.

The next useful increment is SKUby's application-owned export of real reviewed findings.
Keep that adapter small and retain its existing source permissions. Broader collection and
the review inbox remain in the [design](design/recipe-forge.md).
