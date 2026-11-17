# Repair tournament: controlled pilot

No fitted selector met the predeclared development criterion: at least four correct task
acceptances and zero wrong task acceptances on the fit set. Unsupported bars stayed null;
the fitted policies therefore handed off every evaluation and challenge task. This is a
failed usefulness result, not a successful accuracy claim.

The fit diagnostic explains the refusal:

| Threshold | Cheap correct / wrong | Strong correct / wrong |
| --- | ---: | ---: |
| 0.95 | 0 / 0 | 5 / 1 |
| 0.90 | 2 / 0 | 8 / 1 |
| 0.80 | 7 / 3 | 11 / 1 |
| 0.70 | 7 / 3 | 12 / 1 |
| 0.50 | 10 / 3 | 12 / 1 |

One concrete fit failure: the stronger judge gave probability 0.97 to
`xs.filter((x,i)=>xs.lastIndexOf(x)===i)` for a requirement to preserve **first** occurrence
order. For `[1,2,1]`, it returns `[2,1]` instead of `[1,2]`. Jev scored that candidate 0.31.
This is a useful disagreement to investigate on a fresh set, not permission to tune the
current held-out results. The two-key diagnostic here inherits unsupported individual bars;
it does not evaluate a separately fitted conjunction.

The public tests were intentionally sparse. Their 7 correct and 29 wrong acceptances across
36 non-fit tasks do not represent normal repository test-suite performance. The hindsight
ceiling was 24 correctly solvable tasks, with 12 deliberately unsolvable candidate pools.

Mode: **live models**. 54 tasks; 18 authored families.
Four authored candidates per task; one third of tasks deliberately have no correct candidate. This is a controlled selection experiment, not a coding-model or production benchmark.

Frozen bars: {"cheap":null,"strong":null,"cascadeCheap":null,"cascadeStrong":null}. Unsupported fits are null and hand off.
Protocol hash: 666bc016d131b3417802b060d8eb0e6b5663a414949dd5cb2c35095d1abb178a.
Acquisition cost for the complete paired matrix: $0.030422; failed judgments: 0/432.
The arm costs below replay only the judgments each policy would consume. They exclude candidate generation, test execution, human review, and application integration. Latencies are recorded-call estimates, not an online timing benchmark.

## evaluation

| Approach | Correct / tasks | Wrong accepted | Handoffs | Accepted precision | Missed solvable | Judge calls | Judge cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| first | 4/18 | 14 | 0 | 22.2% | 0 | 0 | $0.000000 |
| tests | 4/18 | 14 | 0 | 22.2% | 0 | 0 | $0.000000 |
| cheap-fixed | 0/18 | 0 | 18 | n/a | 12 | 54 | $0.000994 |
| cheap-fit | 0/18 | 0 | 18 | n/a | 12 | 0 | $0.000000 |
| strong-fit | 0/18 | 0 | 18 | n/a | 12 | 0 | $0.000000 |
| cascade | 0/18 | 0 | 18 | n/a | 12 | 0 | $0.000000 |
| two-keys | 0/18 | 0 | 18 | n/a | 12 | 0 | $0.000000 |
| ceiling | 12/18 | 0 | 6 | 100.0% | 0 | 0 | $0.000000 |

Cascade minus tests, correct completion: -22.2%; exploratory paired family-bootstrap interval [-33.3%, -11.1%], 6 family clusters. With this few clusters, the interval is descriptive and cannot support a deployment guarantee.

| Domain | Cascade correct | Wrong | Handoffs |
| --- | ---: | ---: | ---: |
| boundaries | 0/6 | 0 | 6 |
| transforms | 0/6 | 0 | 6 |
| sql | 0/6 | 0 | 6 |

Review-cost sensitivity (wrong acceptance costs 5, 20, or 100 reviews; each handoff costs one review):

| Approach | 5:1 | 20:1 | 100:1 |
| --- | ---: | ---: | ---: |
| first | 70 | 280 | 1400 |
| tests | 70 | 280 | 1400 |
| cheap-fixed | 18 | 18 | 18 |
| cheap-fit | 18 | 18 | 18 |
| strong-fit | 18 | 18 | 18 |
| cascade | 18 | 18 | 18 |
| two-keys | 18 | 18 | 18 |

## challenge

| Approach | Correct / tasks | Wrong accepted | Handoffs | Accepted precision | Missed solvable | Judge calls | Judge cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| first | 3/18 | 15 | 0 | 16.7% | 0 | 0 | $0.000000 |
| tests | 3/18 | 15 | 0 | 16.7% | 0 | 0 | $0.000000 |
| cheap-fixed | 0/18 | 0 | 18 | n/a | 12 | 63 | $0.001128 |
| cheap-fit | 0/18 | 0 | 18 | n/a | 12 | 0 | $0.000000 |
| strong-fit | 0/18 | 0 | 18 | n/a | 12 | 0 | $0.000000 |
| cascade | 0/18 | 0 | 18 | n/a | 12 | 0 | $0.000000 |
| two-keys | 0/18 | 0 | 18 | n/a | 12 | 0 | $0.000000 |
| ceiling | 12/18 | 0 | 6 | 100.0% | 0 | 0 | $0.000000 |

Cascade minus tests, correct completion: -16.7%; exploratory paired family-bootstrap interval [-22.2%, -11.1%], 6 family clusters. With this few clusters, the interval is descriptive and cannot support a deployment guarantee.

| Domain | Cascade correct | Wrong | Handoffs |
| --- | ---: | ---: | ---: |
| boundaries | 0/6 | 0 | 6 |
| transforms | 0/6 | 0 | 6 |
| sql | 0/6 | 0 | 6 |

Review-cost sensitivity (wrong acceptance costs 5, 20, or 100 reviews; each handoff costs one review):

| Approach | 5:1 | 20:1 | 100:1 |
| --- | ---: | ---: | ---: |
| first | 75 | 300 | 1500 |
| tests | 75 | 300 | 1500 |
| cheap-fixed | 18 | 18 | 18 |
| cheap-fit | 18 | 18 | 18 |
| strong-fit | 18 | 18 | 18 |
| cascade | 18 | 18 | 18 |
| two-keys | 18 | 18 | 18 |

## Interpretation

A simulation verifies wiring under stipulated error rates; it is not evidence that any live model improves. Live results here test authored candidates with small hidden suites, not naturally generated repairs. Hidden tests are evidence over their finite cases, not proofs over all inputs.
No gate is promoted. Recipes require a separate, frozen acceptance plan on representative independent real cases. Related variants count as a family; repeated calls and replayed candidates never add independent evidence.
Next: independently review the specifications and labels; add naturally generated candidates and new held-out families; then run the frozen selectors at equal generation and review budgets. Keep later revisions and replication sets separate from this evaluation.

Provider-billed acquisition total (including failed answers): $0.030422. If any answer failed after billing, replay arm costs are lower bounds and the comparison is incomplete.

## Run provenance

Run directory: `experiments/out/tournament/2026-11-17T08-47-30-753Z-live/`. Source snapshots, the fixed corpus, frozen fit settings, complete shadow ledgers and purchase receipts are preserved there. This is an exploratory controlled pilot; no deployment was promoted.
