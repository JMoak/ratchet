# End-to-end evaluation

Five tracks that run ratchet end to end, through the real engine and JSONL ledgers, on new
scenarios built to prove or disprove the claims in `docs/vision.md`. Results and findings are in
`docs/e2e/` (start with `docs/e2e/README.md` and the registry `docs/e2e/findings.md`).

Every label is fixed by one decider, under `DECIDER.md`, in a corpus file before the first live
call; each run's `manifest.json` records the corpus hash. Labels reach the ledger with source
`review:blind:decider`, most of them through the real `ratchet review` code path (`blindReview`
in `lib.ts`), so the review command is exercised along with the gate.

| track | what it tests | run |
| --- | --- | --- |
| `t1-toolgate` | the agent tool gate's whole lifecycle: fit, freeze, planned acceptance, enforce, audits, drift, CLI truthfulness, real hook traffic | `bun experiments/e2e/t1-toolgate/main.ts all [--offline]` |
| `t2-verifier` | an independent verifier over candidate outputs, `runChain`, battery decomposition | `bun experiments/e2e/t2-verifier/main.ts [--offline]` |
| `t3-triage` | approvals, routing and urgency, a moderation battery, multilingual rubrics, profiles and cold start | `bun experiments/e2e/t3-triage/main.ts [--offline]` |
| `t4-redteam` | fault injection on every path, budgets, invariants, ledger and CLI robustness, arithmetic and dates | `bun experiments/e2e/t4-redteam/main.ts --offline [--only faults\|budget\|invariants\|ledger]` |
| `t5-compound` | replicas, framings, model-diverse ensembles, cascades, sequential sampling, disagreement | `bun experiments/e2e/t5-compound/main.ts [--offline]` |

`--offline` swaps every backend for a seeded simulated oracle: the same wiring at no cost,
proving nothing about Jev. Live runs read `OPENROUTER_API_KEY` from `.env` and call `guard()`
from `lib.ts` before each live phase. The guard reads the provider's billed usage against a
ceiling for the whole evaluation, kept in `experiments/out/e2e/budget.json` (gitignored; write
`{"baselineUsd": <current usage>, "ceilingUsd": <cap>, "setAt": "<date>"}` before a live run).

Raw outputs, ledgers and the real-traffic slice of `t1-toolgate` (real hook-journal calls from
the operator's machine) live under `experiments/out/e2e/` and are never committed.
