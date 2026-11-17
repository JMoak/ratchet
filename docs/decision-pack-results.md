# Applied decision packs: teaching-transfer pilot

The first usable live pilot did **not** show a gain from the authored teaching examples.
Across the 32 non-fit cases, separately fitted bare Jev accepted 10 supported findings,
rubric-only accepted 9, taught Jev accepted 8, the strong judge accepted 4, and the taught
cascade accepted 8. All made zero unsupported acts on this small authored set. The other
cases went to review; this is not a 98% reliability guarantee. At the provisional fixed
0.98 bar, all three Jev prompts held every case.

The practical finding is that task-specific calibration matters, while additional examples
must earn their place through comparison. These examples are a starting curriculum, not
evidence that stronger-model reasoning has successfully transferred to a cheaper model.
Fit samples contain only two paired source families per domain; the stronger model's null
enterprise fit is a failed fit, not a finding that the model is generally inferior.

The earlier smoke run had 17 empty stronger-model completions with a 160-token allowance.
This corrected run uses 1024 tokens and has none. It retains the same authored cases and is
therefore an exploratory rerun. No curriculum labels were changed to match model answers.

Mode: **live models**. Four packs, 16 worked teaching examples and 48 separate labelled cases in 24 paired source families.
Labels and rationales were authored by the assistant before acquisition. They are provisional development labels, not independent expert adjudications or evidence of clinical/financial competence.
All measurement calls run in shadow. Policy comparisons replay the recorded judgments through real gates and trusted-entry floors in memory; no external action is executed.
The comparison is bare question versus rubric versus rubric plus worked examples at the same 0.98 threshold. Fitted arms and the cross-family cascade are secondary exploratory comparisons.
Complete-matrix provider-billed acquisition cost: $0.013405. Failed judgments: 0/192.
If any judgment failed after billing, per-arm costs are lower bounds; the acquisition figure includes all provider-reported charges. Runs with provider failures are incomplete comparisons.
Recorded models: typesafe/jev-1.13-20260917, anthropic/claude-haiku-5.5.
Per-arm costs below estimate consumed judgments from the recorded matrix, excluding expert authoring, generation, review, and integration. Synthetic runs measure wiring only; their teaching effects are not meaningful.

## Procurement evidence checks

Allowed use: Attach a reversible draft finding to a procurement review queue.
Exploratory frozen bars: {"bare":0.7,"rubric":0.7,"taught":0.7,"strong":null}.

### Judgment quality before policy floors (all non-fit cases)

| Prompt | Answer agreement | Brier loss | Mean p on supported | Mean p on unsupported |
| --- | ---: | ---: | ---: | ---: |
| bare | 7/8 (0 failed) | 0.0611 | 0.692 | 0.022 |
| rubric | 7/8 (0 failed) | 0.0616 | 0.682 | 0.020 |
| taught | 7/8 (0 failed) | 0.0529 | 0.720 | 0.020 |
| strong | 8/8 (0 failed) | 0.0306 | 0.768 | 0.040 |

### evaluation

| Approach | Supported draft acts | Unsupported acts | Handoffs | Supported held | Judge calls | Judge cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| review-all | 0/4 | 0 | 4 | 2 | 0 | $0.000000 |
| bare | 0/4 | 0 | 4 | 2 | 4 | $0.000077 |
| rubric | 0/4 | 0 | 4 | 2 | 4 | $0.000103 |
| taught-fixed | 0/4 | 0 | 4 | 2 | 4 | $0.000150 |
| bare-fit | 2/4 | 0 | 2 | 0 | 4 | $0.000077 |
| rubric-fit | 2/4 | 0 | 2 | 0 | 4 | $0.000103 |
| taught-fit | 2/4 | 0 | 2 | 0 | 4 | $0.000150 |
| strong-fit | 0/4 | 0 | 4 | 2 | 0 | $0.000000 |
| cascade | 2/4 | 0 | 2 | 0 | 4 | $0.000150 |

### challenge

| Approach | Supported draft acts | Unsupported acts | Handoffs | Supported held | Judge calls | Judge cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| review-all | 0/4 | 0 | 4 | 2 | 0 | $0.000000 |
| bare | 0/4 | 0 | 4 | 2 | 2 | $0.000037 |
| rubric | 0/4 | 0 | 4 | 2 | 2 | $0.000051 |
| taught-fixed | 0/4 | 0 | 4 | 2 | 2 | $0.000074 |
| bare-fit | 1/4 | 0 | 3 | 1 | 2 | $0.000037 |
| rubric-fit | 1/4 | 0 | 3 | 1 | 2 | $0.000051 |
| taught-fit | 1/4 | 0 | 3 | 1 | 2 | $0.000074 |
| strong-fit | 0/4 | 0 | 4 | 2 | 0 | $0.000000 |
| cascade | 1/4 | 0 | 3 | 1 | 2 | $0.000074 |

## Claim-to-evidence verification

Allowed use: Attach a reversible draft evidence annotation to a research note.
Exploratory frozen bars: {"bare":0.8,"rubric":0.8,"taught":0.8,"strong":0.8}.

### Judgment quality before policy floors (all non-fit cases)

| Prompt | Answer agreement | Brier loss | Mean p on supported | Mean p on unsupported |
| --- | ---: | ---: | ---: | ---: |
| bare | 8/8 (0 failed) | 0.0178 | 0.830 | 0.020 |
| rubric | 8/8 (0 failed) | 0.0197 | 0.823 | 0.018 |
| taught | 8/8 (0 failed) | 0.0099 | 0.875 | 0.018 |
| strong | 7/8 (0 failed) | 0.0893 | 0.693 | 0.035 |

### evaluation

| Approach | Supported draft acts | Unsupported acts | Handoffs | Supported held | Judge calls | Judge cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| review-all | 0/4 | 0 | 4 | 2 | 0 | $0.000000 |
| bare | 0/4 | 0 | 4 | 2 | 4 | $0.000073 |
| rubric | 0/4 | 0 | 4 | 2 | 4 | $0.000102 |
| taught-fixed | 0/4 | 0 | 4 | 2 | 4 | $0.000139 |
| bare-fit | 2/4 | 0 | 2 | 0 | 4 | $0.000073 |
| rubric-fit | 1/4 | 0 | 3 | 1 | 4 | $0.000102 |
| taught-fit | 2/4 | 0 | 2 | 0 | 4 | $0.000139 |
| strong-fit | 2/4 | 0 | 2 | 0 | 4 | $0.000795 |
| cascade | 2/4 | 0 | 2 | 0 | 6 | $0.000448 |

### challenge

| Approach | Supported draft acts | Unsupported acts | Handoffs | Supported held | Judge calls | Judge cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| review-all | 0/4 | 0 | 4 | 2 | 0 | $0.000000 |
| bare | 0/4 | 0 | 4 | 2 | 4 | $0.000074 |
| rubric | 0/4 | 0 | 4 | 2 | 4 | $0.000103 |
| taught-fixed | 0/4 | 0 | 4 | 2 | 4 | $0.000140 |
| bare-fit | 1/4 | 0 | 3 | 1 | 4 | $0.000074 |
| rubric-fit | 1/4 | 0 | 3 | 1 | 4 | $0.000103 |
| taught-fit | 1/4 | 0 | 3 | 1 | 4 | $0.000140 |
| strong-fit | 1/4 | 0 | 3 | 1 | 4 | $0.000623 |
| cascade | 1/4 | 0 | 3 | 1 | 7 | $0.000606 |

## Reconciliation exception evidence

Allowed use: Attach a reversible draft explanation to a reconciliation exception queue.
Exploratory frozen bars: {"bare":0.5,"rubric":0.5,"taught":null,"strong":null}.

### Judgment quality before policy floors (all non-fit cases)

| Prompt | Answer agreement | Brier loss | Mean p on supported | Mean p on unsupported |
| --- | ---: | ---: | ---: | ---: |
| bare | 8/8 (0 failed) | 0.0446 | 0.712 | 0.020 |
| rubric | 7/8 (0 failed) | 0.0880 | 0.603 | 0.017 |
| taught | 7/8 (0 failed) | 0.0710 | 0.660 | 0.017 |
| strong | 7/8 (0 failed) | 0.1269 | 0.605 | 0.040 |

### evaluation

| Approach | Supported draft acts | Unsupported acts | Handoffs | Supported held | Judge calls | Judge cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| review-all | 0/4 | 0 | 4 | 2 | 0 | $0.000000 |
| bare | 0/4 | 0 | 4 | 2 | 4 | $0.000075 |
| rubric | 0/4 | 0 | 4 | 2 | 4 | $0.000103 |
| taught-fixed | 0/4 | 0 | 4 | 2 | 4 | $0.000143 |
| bare-fit | 2/4 | 0 | 2 | 0 | 4 | $0.000075 |
| rubric-fit | 1/4 | 0 | 3 | 1 | 4 | $0.000103 |
| taught-fit | 0/4 | 0 | 4 | 2 | 0 | $0.000000 |
| strong-fit | 0/4 | 0 | 4 | 2 | 0 | $0.000000 |
| cascade | 0/4 | 0 | 4 | 2 | 0 | $0.000000 |

### challenge

| Approach | Supported draft acts | Unsupported acts | Handoffs | Supported held | Judge calls | Judge cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| review-all | 0/4 | 0 | 4 | 2 | 0 | $0.000000 |
| bare | 0/4 | 0 | 4 | 2 | 2 | $0.000037 |
| rubric | 0/4 | 0 | 4 | 2 | 2 | $0.000051 |
| taught-fixed | 0/4 | 0 | 4 | 2 | 2 | $0.000071 |
| bare-fit | 1/4 | 0 | 3 | 1 | 2 | $0.000037 |
| rubric-fit | 1/4 | 0 | 3 | 1 | 2 | $0.000051 |
| taught-fit | 0/4 | 0 | 4 | 2 | 0 | $0.000000 |
| strong-fit | 0/4 | 0 | 4 | 2 | 0 | $0.000000 |
| cascade | 0/4 | 0 | 4 | 2 | 0 | $0.000000 |

## Medical literature screening support

Allowed use: Attach a reversible draft eligibility annotation for independent human reviewers.
Exploratory frozen bars: {"bare":0.7,"rubric":0.7,"taught":0.7,"strong":0.8}.

### Judgment quality before policy floors (all non-fit cases)

| Prompt | Answer agreement | Brier loss | Mean p on supported | Mean p on unsupported |
| --- | ---: | ---: | ---: | ---: |
| bare | 8/8 (0 failed) | 0.0477 | 0.718 | 0.025 |
| rubric | 7/8 (0 failed) | 0.0481 | 0.740 | 0.020 |
| taught | 7/8 (0 failed) | 0.0388 | 0.777 | 0.017 |
| strong | 6/8 (0 failed) | 0.2341 | 0.410 | 0.055 |

### evaluation

| Approach | Supported draft acts | Unsupported acts | Handoffs | Supported held | Judge calls | Judge cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| review-all | 0/4 | 0 | 4 | 2 | 0 | $0.000000 |
| bare | 0/4 | 0 | 4 | 2 | 4 | $0.000076 |
| rubric | 0/4 | 0 | 4 | 2 | 4 | $0.000104 |
| taught-fixed | 0/4 | 0 | 4 | 2 | 4 | $0.000146 |
| bare-fit | 0/4 | 0 | 4 | 2 | 4 | $0.000076 |
| rubric-fit | 1/4 | 0 | 3 | 1 | 4 | $0.000104 |
| taught-fit | 1/4 | 0 | 3 | 1 | 4 | $0.000146 |
| strong-fit | 1/4 | 0 | 3 | 1 | 4 | $0.000986 |
| cascade | 1/4 | 0 | 3 | 1 | 7 | $0.000842 |

### challenge

| Approach | Supported draft acts | Unsupported acts | Handoffs | Supported held | Judge calls | Judge cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| review-all | 0/4 | 0 | 4 | 2 | 0 | $0.000000 |
| bare | 0/4 | 0 | 4 | 2 | 2 | $0.000037 |
| rubric | 0/4 | 0 | 4 | 2 | 2 | $0.000051 |
| taught-fixed | 0/4 | 0 | 4 | 2 | 2 | $0.000072 |
| bare-fit | 1/4 | 0 | 3 | 1 | 2 | $0.000037 |
| rubric-fit | 1/4 | 0 | 3 | 1 | 2 | $0.000051 |
| taught-fit | 1/4 | 0 | 3 | 1 | 2 | $0.000072 |
| strong-fit | 0/4 | 0 | 4 | 2 | 2 | $0.000325 |
| cascade | 1/4 | 0 | 3 | 1 | 3 | $0.000234 |

## What this can establish

This is a small curriculum and a working evaluation, not a validated domain model. Fit sets have four cases per pack and can only propose a bar. Positive/negative claims sharing a source form one family; neither repeated calls nor paired claims are independent trials. Do not pool these cases into a 98% reliability claim.
Next gate: domain specialists blind-review the labels and input contracts; freeze the recipe; acquire representative cases from different documents, institutions, entities and time periods; evaluate once under a planned sample. Production labels use independent blind/census sources. Curriculum labels deliberately remain unregistered and cannot promote these gates.
For medicine, draft screening annotations retain independent human final inclusion/exclusion. Finance drafts never authorize payments, trades, write-offs or journal postings. A source or arithmetic control failure, or any request beyond draft use, forces review even with a perfectly confident oracle.

## Run provenance

Run directory: `experiments/out/decision-packs/2026-11-17T08-47-31-128Z-live/`. Source snapshots, the fixed corpus, frozen fit settings, complete shadow ledgers and purchase receipts are preserved there. This is an exploratory controlled pilot; no deployment was promoted.
