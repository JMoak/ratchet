# Live recipes: Jev through OpenRouter

Run on 2026-10-16 against `typesafe/jev-1.13`. Costs are billed amounts.


## 1. Speculative decision-tree flattening: one request versus two round trips

Twelve hand-written browser states, each with a goal, clickable elements and input fields. The root question picks an operation; a follow-up picks the target for that operation. Speculative: root plus every branch follow-up in one request. Sequential: root first, then only the chosen branch.

| approach                       | operation right | operation and target right | requests per step | mean latency per step | mean cost per step |
| ------------------------------ | --------------- | -------------------------- | ----------------- | --------------------- | ------------------ |
| speculative (one request)      | 12/12           | 12/12                      | 1                 | 138 ms                | $0.000021          |
| sequential (root, then branch) | 12/12           | 12/12                      | 1 to 2            | 239 ms                | $0.000030          |

| goal                                   | truth                     | speculative answer               | spec | seq |
| -------------------------------------- | ------------------------- | -------------------------------- | ---- | --- |
| Log in with the saved credentials      | type -> email             | type (0.79) -> email             | ok   | ok  |
| Log in with the saved credentials      | click -> sign-in          | click (1.00) -> sign-in          | ok   | ok  |
| Find the cheapest flight to Lisbon on  | type -> to                | type (1.00) -> to                | ok   | ok  |
| Find the cheapest flight to Lisbon on  | click -> search           | click (1.00) -> search           | ok   | ok  |
| Find the cheapest flight to Lisbon on  | click -> sort-by-price    | click (0.97) -> sort-by-price    | ok   | ok  |
| Accept the cookie banner and continue  | click -> accept-all       | click (1.00) -> accept-all       | ok   | ok  |
| Read the terms section near the end of | scroll -> down            | scroll (1.00) -> down            | ok   | ok  |
| Unsubscribe from the marketing newslet | click -> toggle-marketing | click (1.00) -> toggle-marketing | ok   | ok  |
| Unsubscribe from the marketing newslet | click -> save-preferences | click (0.98) -> save-preferences | ok   | ok  |
| Unsubscribe from the marketing newslet | done                      | done (0.99)                      | ok   | ok  |
| Search the documentation for 'rate lim | type -> search-box        | type (1.00) -> search-box        | ok   | ok  |
| Add the blue medium t-shirt to the car | click -> size-medium      | click (1.00) -> size-medium      | ok   | ok  |


## 2. Context compaction: which earlier tool results are still needed

A coding-agent transcript summarised as 40 tool calls (10 about the billing bug, 30 unrelated), judged in one request of 40 questions. The model sees only the task and one-line summaries, never the tool outputs.

| keep above | kept | precision | recall | context removed |
| ---------- | ---- | --------- | ------ | --------------- |
| 0.3        | 7    | 100.0%    | 70.0%  | 82.5%           |
| 0.5        | 6    | 100.0%    | 60.0%  | 85.0%           |
| 0.7        | 1    | 100.0%    | 10.0%  | 97.5%           |

One request, 40 judgments, $0.000084. Highest-scored irrelevant: t02 0.15, t16 0.13, t24 0.13. Lowest-scored relevant: t27 0.22, t33 0.20, t22 0.19.


## 3. Chunk location: which of eight passages answers the question

100 BoolQ questions. Each state holds the question's own passage plus seven other BoolQ passages in a seeded shuffle, labelled c1 to c8. A pick over chunk ids locates the answer; a second pass on 40 items removes the true passage and adds a 'none' option.

Located the answering chunk 100.0% of the time (chance 12.5%); in the top two 100.0%. Among the 100 picks at confidence >= 0.9, 100.0% were right. Mean cost $0.000060 and latency 140 ms per eight-chunk state (about 1421 input tokens).

With the true passage removed and a 'none' option offered (40 items): answered 'none' 100.0% of the time; mean p(none) 0.978; mean confidence of the wrong chunk picks 0.000.


**Total spend: $0.0091 over 175 calls.**


## 4. Recipes measured again in the end-to-end evaluation (2026-11-12)

The end-to-end evaluation ([e2e/](e2e/findings.md)) ran on new, authored corpora with labels
fixed before the first call. It did not re-run sections 1 to 3; it measured these:

| recipe | result |
| --- | --- |
| digest: `compare`, `daysBetween`, `count` | The largest effect measured. Refund and expense approvals 66.7% raw to 99.1% digested (T3, jev-1.13, 219 paired items, 71 to 0 discordant); a two-condition policy check 83.3% to 100% on jev-1.13 and 89.6% to 100% on jev-1.14 (T4, 48 paired items). |
| digest: `relativeTime` | Unsafe at a window. It read 31 to 44 days as "1 month ago" (fixed: it now floors, in days below 120 days); against a 30-day refund window 10 of 37 auto-approvals were wrong (T3). Use `compare(daysBetween(...), window)` for windows. |
| digest: `compare` float noise | `compare` printed differences such as "by 4.200000000000003 USD" (fixed: it rounds to the inputs' precision). No measured cost: 98.9% against 99.2% on states with and without it (T3), and rounding it changed no answer (T4, 0 discordant). |
| `shortlist()` | Top two held the truth for 100% of 256 routing tickets and 99.6% of urgency ratings (T3). |
| `relevance` + `prune` | Offline, a failed-open item scored 0.5 and was pruned at a 0.6 bar, so a failure removed context (T4-07; fixed: `prune` keeps items with no bought answer). |
| `sequential` with `settleLead` | With two Jev pins first, lead-by-2 stopped on their agreement on 178 of 260 items and lost 7.3 points against the fixed ensemble (T5). The lead now counts one vote per model family, so replicas or pins of one model (such as those two) never settle it. |
| `speculate`, `screenMany`, `locateWith` | Not re-measured live. Offline, like every path, they acted on malformed adapter answers in the red team's fault matrix (T4-01; fixed in `failOpen`). |

