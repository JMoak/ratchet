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

