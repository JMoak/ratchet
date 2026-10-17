# Ask less, pool softly, log everything

In its first month, from 15 September to 16 October 2026, the community put TypeSafe's Jev and its Jev-compatible rivals (Cloudflare Clef, OpenAI's Decisions API, Microsoft Decision-1, Perplexity's decider, Strands Decider and a dozen open clones) on more than twenty agent-harness interception points and into dozens of non-agent domains. The projects that kept their gains converged, without coordinating, on one design. Deterministic code decides whether a question is worth asking. One batched request asks a narrow battery of factual questions about a state that code has already pre-digested. Answers stay as probabilities, which code pools, thresholds and audits. Hard rules bound the damage, and every new gate starts in shadow mode behind an explicit activation bar. The best-measured ideas all have that shape. Systematic-review screening ranked records at **AUC 0.966 against 0.831 for embeddings**. A five-signal phishing battery with a fitted logistic combiner reached **95.1% where Jev's own verdict got 62.6%**. Invoice coding gated at 0.8 auto-applied **71% of bills with zero errors**. Banding and pruning state lifted an NPC task from **74.3% to 100%**. A narrow "claimed done without running tests" Stop hook reached **AUROC 0.976**, while generic rule hooks sat at 0.60. At least a dozen projects narrowed or removed a Jev feature after real use, for four reasons:

- the question was broader than the evidence in the state;
- the loop re-decided at every fork until round-trip latency dominated;
- offline catch rates did not become live benefit;
- the fallback was a correlated LLM that made the same mistakes.

Almost none of this is a controlled production comparison. Most numbers come from authors replaying their own logs offline, with proxy labels, small n or synthetic data, and every one is graded below. For a generic, oracle-agnostic compounding engine, the conclusion is that its primitives are the right ones. The gaps are eight things the community keeps hand-building, and they come first:

1. a replayable ledger of full distributions, keyed by everything that moves a probability;
2. soft pooling operators plus a fitted combiner;
3. shadow per decision point, with activation bars and automatic demotion;
4. value-of-information ask suppression;
5. review bands sized to measured drift;
6. threshold fitting on confidence bounds rather than point estimates, reported as coverage at an error budget;
7. schema and wire-quirk validation;
8. taint tracking that keeps untrusted text and the engine's own past verdicts out of the state.

Equally clear is what not to build: thresholded-AND rubrics, same-model self-consistency, LLM-escalation cascades by default, label-free prior correction, prompt-level injection defences, summarising compaction, per-tick re-decision, or any head distilled from Jev output.

## Harness builders found twenty interception points and one survivor shape

**Evidence grades used in every table:**
- **Measured:** a stated method, labelled data and a reported n.
- **Small:** n under about 50, one run, synthetic data, or labels produced by another model (proxy labels).
- **Unmeasured:** working code or a design with no accuracy numbers.
- **Negative:** a measured loss, or the feature was removed.

**What Jev is.** Jev answers typed questions about one shared `state` in a single request:
- **Noul:** a yes/no probability.
- **Choice:** one of up to 255 options, with the full distribution.
- **Score:** 2 to 10 rubric levels.
- **Box:** an experimental bounding box, added in 1.14.

The limits are 64k tokens per request and 32k per question, at $0.042 per million input tokens with output free ([Models](https://docs.typesafe.ai/models); [Jev 1.14](https://typesafe.ai/blog/jev-1-14)). A week after launch an ecosystem survey counted 2,170 public repositories. Model and tool routing held 32.6% of all stars, and Choice appeared in 81.0% of projects ([arXiv 2609.30216](https://arxiv.org/html/2609.30216)).

### Stop hooks: narrow evidence questions beat generic rules

The densest new cluster is the Claude Code and Codex `Stop` hook, which asks "did the agent really finish?". Its spread of results is the clearest lesson in the corpus.

- **jev-belay** only consults Jev when local "belts" detect a completion claim, changed files and no passing test runner, so **only 17.7% of stops (477 of 2,694) ever reach Jev**. One pinned call then asks four questions. On 100 stops with 12 false "done" claims, AUROC rose from 0.777 (wording alone) to 0.886 (with the evidence gate) to **0.976**, once a `verification_applies` question let docs-only tasks drop out. Each check cost $0.00005 at a 346 ms median. The labels were Sonnet judgments, not human ones ([jev-belay](https://github.com/valentynkit/jev-belay)).
- **limpet** turns each user-written rule into one Noul over the last 40 tool calls. On 2,645 stops that a human later replied to, it scored **AUROC 0.60 to 0.62**, and 0.51 (no signal) on a language-taste rule. It fits each rule's threshold at a 5% false-positive rate, drops rules below AUROC 0.55, and calls itself "a nudge, not a wall" ([limpet](https://github.com/noplan-inc/limpet)).
- **stingray** reached 81.8% precision but 14.1% recall on 124 turns. It refuses to enforce a rule until the rule has 40 shadow records, 70% precision and at most three false nudges per 100 stops ([stingray](https://github.com/Nanako0129/stingray)).
- **jev-gates'** claims gate blocked all 14 false sentences and passed all 12 true ones on 73 replayed turns. After a week it dropped every broader gate from the defaults ([jev-gates](https://github.com/rashedInt32/jev-gates)).

The spread from 0.60 to 0.976 comes from how broad the question is and whether the state contains the evidence, not from the model. For the engine, this is the verify-then-commit chain runner applied to an agent turn. It implies a claims-versus-evidence recipe with these parts:
- the verifier reads tool output, never the agent's description of it;
- code belts settle most stops without calling the model;
- at most one block per prompt;
- a per-rule activation bar before anything is enforced.

### Mid-loop monitors and referees

Inside the loop, the monitors that published numbers pair deterministic triggers with an advisory scorer.

- **Edward** triggers on an error rate above 40% over eight calls, three identical retries, 80% of the token budget spent, or twelve reads with no write. Adding a Jev probe reached **59.3% recall at a 10.2% false-positive rate on 216 held-out StepShield trajectories**. Rules alone reached 7.4% recall, and a local 4B probe 58.3% recall at 17.6%. The authors abandoned a fine-tuned scorer under a preregistered protocol ([Edward](https://github.com/VeridicalTech/Edward)).
- **Referees work when the decision model sits outside the producing agent's context.** agent-handoff-gate judges a worker's PASS or BLOCKED claim before the lead sees it. On RelayLedger-40 it scored 38 and 37 of 40 raw, with **22 decisive answers at a preregistered 0.80 and zero errors** ([agent-handoff-gate](https://github.com/zsoXi/agent-handoff-gate)).
- **Offline catch did not become live benefit.** The community TypeSafeAI harness caught 25 of 25 scripted bad proposals offline. Live, it "observed no live recovery benefit" across 171 outcomes and "lost tool use on multi-step tasks" ([TypeSafeAI/jev-harness](https://github.com/TypeSafeAI/jev-harness)).
- **stepwarden** checks each tool call against the first prompt, stored verbatim as the plan. It notes that repeated calls shift probabilities "by a few points" and declares itself "not a security boundary" ([stepwarden](https://github.com/getexcited/stepwarden)).

Because offline catch rates do not predict live benefit, the engine's shadow rows need outcomes, not just verdicts.

### Context and memory: select, never summarise

Context and memory produced the sharpest split between selecting and summarising.

- **mu's tool-output admission** first folds exact repeats in code. That alone removed 51.0% of seven failing Vitest logs. Jev then omits a chunk only when "not needed" scores at least 0.9. Selection cut **40.2% with 0 of 72 required lines lost on 29 tuned goals, and 46.4% with 0 of 19 lost on nine held-out goals**. A failures-only heuristic cut 61.9% but lost nine lines. The 282 live requests cost about $0.017 ([mu](https://github.com/qybaihe/mu)).
- **jevkit's** compaction kept only 58% of relevant log lines until error lines were pinned in code, after which it kept all of them ([jevkit](https://github.com/walidboulanouar/jev-agent-kit)).
- **pi-jev-context** hides old history instead of deleting it, keeps anything above 0.8, and exposes `/rejev` to judge again ([pi-jev-context](https://github.com/kevinpita/pi-jev-context)).
- **Summarising lost.** hermes-jev-skills measured a Jev keep/summarise/drop digest at **58.7% recall (75.0% with one search), worse than a handoff written from the plain transcript**, and stopped using Jev for handoffs. Its selection-only `compact-select` beat recency 11 questions to 4 ([hermes-jev-skills](https://github.com/kerpopule/hermes-jev-skills)).
- **Jev-Mem's** memory controller reached 0.777 on LoCoMo against 0.700 for MAGMA. Building its memory took 158 s against Nemori's 1,044 s ([Jev-Mem](https://github.com/libingzheren/Jev-Mem)).
- **jevcrawl** removed the LLM from the crawl loop entirely. It answered 40% of 50 WebWalkerQA tasks correctly, against 30% when Claude picked every link and 8% for breadth-first search. That is **$0.06 per correct answer against $0.65** ([jevcrawl](https://github.com/RayenMlayeh/jevcrawl)). A personal log of 629 code-search decisions over two weeks cost $0.0888 ([james-carr.org](https://james-carr.org/posts/2026-10-13-what-i-actually-use-jev-for/)).

The engine implication: a "hide with pointer, re-judge on demand" primitive, with lossless code transforms ahead of the model. A summarising compaction recipe should not exist.

### Effort routing, wake gating and streaming gates

Effort routing became viable once two mechanics appeared:
- **Leases.** Jev returns an effort level plus a lease of 1, 2, 5 or 10 generations; new user input or a tool failure ends the lease early ([Astra-Ares](https://github.com/miuuyy/Astra-Ares)).
- **Cache-preserving injection.** The effort change rides in a replayed message rather than the request prefix, so the provider's prompt cache survives ([jev-opus](https://github.com/WXK-AI/jev-opus)).

Evidence on routing:
- **reasoning-router** is the only effort router with a controlled result: **44 of 44 tasks solved both routed and at fixed high effort, with 14% fewer output tokens and 9% less time** ([opencode-jev-router](https://github.com/robertn702/opencode-jev-router)).
- **Halv's** 57.1% cost cut is confounded: three other optimisations ran at the same time, and the system used 3.49x more total tokens ([Halv](https://halv.ai/blog/halv-swe-rebench-astra-42-pairs/)).
- **Kilo Code** merged the only production harness PR. It replaced an LLM route classifier with one Choice, deleting the JSON-repair parser, invalid-output retry and heuristic fallback. Route-key accuracy on 72 golden cases rose from 0.785 to about 0.93 ([Kilo PR 7223](https://github.com/Kilo-Org/cloud/pull/7223)).
- **The DoGMaTiiC skill router** reached 95% top-1 on 76 labelled requests and reported that "every loss came from the gate" ([Hermes docs](https://hermes-agent.nousresearch.com/docs/plugins/jev-skill-router)). The one published week-long shadow run of a skill router, by contrast, ended in removal: only 28 of 539 picks (about 5%) were used within 30 minutes ([dev.to](https://dev.to/shimo4228/is-there-any-point-to-this-removing-the-jev-plugins-i-added-to-claude-code-after-one-week-49eh)).

Gating evidence:
- **wakegate** decides whether a sleeping agent's timer deserves a full LLM turn. It uses a three-way Choice in which a 0.2 to 0.5 "unsure" band still wakes the agent. A yes/no version scored 16 of 21; the three-way version scored 21 of 21, and two of the correct wakes came only from the unsure band ([wakegate](https://github.com/shitianfang/wakegate)).
- **jev-model-tokengate** gates streamed output in sliding token windows. It reported **zero leaked tokens across 15 scenario-engine runs, adding 0.11 s to a 19.3 s response**, where post-hoc guardrails had left 18 to 35 sensitive tokens visible ([jev-model-tokengate](https://github.com/Thanh-Mathieu95/jev-model-tokengate)).

### Permission gates hold the most rigorous field numbers

- **construct-auto-classifier** certified backends on 1,300 decisions each (181 main plus 79 blind cases, five passes). **Jev allowed 0 dangerous commands, at 98.9% correct and $0.112 per 1,000 decisions.** DeepSeek 4.1 Flash allowed 25, Qwen3.8 27B allowed 7, and gpt-oss-20b allowed 73 ([construct-auto-classifier](https://github.com/godspede/construct-auto-classifier)).
- **pi-warden's early run**, built in the first 48 hours, held 42 of about 17,000 commands, with roughly 88% of holds judged correct and false negatives unreported ([viblo write-up](https://viblo.asia/p/dung-jev-lam-guardrail-cho-coding-agent-case-study-pi-warden-voi-17000-luot-phan-doan-that-RlL5eP0GLbB)).
- **pi-warden's later field period (1,168 sessions)** produced the most important cost result in the harness corpus:
  - code decides offline when no answer could change what the agent sees, **cutting requests by 48.9% (28,036 to 14,326) while still asking 327 of the 338 outcome-changing questions**;
  - releasing a held action now requires two Nouls at 0.7 or above, which cut questions per 1,000 judged calls from 90.0 to 0.7 and wrong releases from 45 to 1 ([pi-warden](https://github.com/DevMortimer/pi-warden)).
- **hermes-jev-approvals** routes six typed answers through an ordered deterministic ladder: escalate if the request argues for its own approval, deny if it both reads secrets and sends data outbound, and so on ([hermes-jev-approvals](https://github.com/anpicasso/hermes-jev-approvals)).
- **Anthropic's own two-stage classifier** (not Jev) shows the trade a cascade inside a gate makes. The false-positive rate fell from 8.5% to 0.4% while the miss rate on real overeager actions rose from 6.6% to 17% ([Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode)).
- **A robustness aggregator is the counterweight:**
  - a claimed human approval let up to 3 of 30 dangerous commands through;
  - one appended, unverified opinion flipped 12.1% of decisions;
  - a tuned auto-merge threshold produced 15 unsafe merges on 185 out-of-distribution cases ([awesome-jev-robustness](https://github.com/Yifan-Lan/awesome-jev-robustness)).

Three engine primitives follow:
1. **Value-of-information suppression:** do not ask when floors or policy already fix the action.
2. **Conjunctive release conditions:** an action is released only when several probabilities all clear their bars.
3. **One-use permits bound to the decision's digest at the executor boundary.** PermitMCP issues them with a one-minute expiry ([PermitMCP](https://github.com/qinpei-dev/permit-mcp)). This is the environment-enforced shape that cut irreversible harm to 2.5% in GateArena ([GateArena](https://neurips.cc/virtual/2026/168290)).

### Infrastructure projects are the engine's nearest neighbours

- **metajev** stores the full answer distribution under a hash of state, question, provider and model, so policies can be replayed with no new calls. On 500 tickets, moving the accept boundary from 0.70 to 0.90 moved 75 wrong answers off accept and 158 right ones into review ([metajev](https://github.com/YYTbit/metajev)).
- **jevcal** fits per-question thresholds on half the labels and verifies on the other half. It offers a conservative mode that uses the 95% lower bound, and a CI lock that fails on drift or a changed model version. It warns that below about 100 labelled rows per question, thresholds will not hold ([jevcal](https://github.com/abhixhek/jevcal)).
- **stuntd** trains a local head per decision site from the provider's answers. Each site moves through collect, train, shadow and live, and is demoted when rolling agreement over 100 decisions falls below 0.99. On unseen ticket templates its heads were confident on 69% of inputs but right on only 42% of those; its novelty gate stopped 99.7% ([stuntd](https://github.com/bladedevoff/stuntd)).
- **mu** declares 38 decision points, each switchable between active, shadow and off, with per-point judge routing ([mu](https://github.com/qybaihe/mu)).
- **agentgateway** translates OpenAI's `/v1/decisions` to Jev's `/v1/systemone` and states that "the gateway never thresholds" ([agentgateway](https://agentgateway.dev/blog/2026-10-12-openai-decisions-api-jev-agentgateway/)).
- **Hev** offers "a Jev-compatible API, answered by humans" ([HN](https://news.ycombinator.com/item?id=50075774)). That is exactly the shape a blind-audit reviewer should have.

| Pattern (exemplar) | Evidence | Grade | Engine implication |
| --- | --- | --- | --- |
| Claims-vs-evidence Stop gate (jev-belay) | AUROC 0.777 to 0.886 to 0.976 on 100 stops; 17.7% of stops reach Jev; $0.00005, 346 ms ([jev-belay](https://github.com/valentynkit/jev-belay)) | small, proxy labels | Recipe: code belts, then one batched call, one block per prompt; ledger rule-settled stops as `source: rule` |
| User-rule Stop nudges (limpet) | AUROC 0.60 to 0.62 on 2,645 stops; taste rule 0.51; per-rule fit at 5% FPR, drop below 0.55 ([limpet](https://github.com/noplan-inc/limpet)) | measured, weak signal | Per-rule activation bar and automatic retirement |
| Half-done-turn shapes (stingray) | Precision 81.8%, recall 14.1% on 124 turns; enforce only after 40 shadow rows, 70% precision, 3 or fewer false nudges per 100 ([stingray](https://github.com/Nanako0129/stingray)) | small | Activation bar as a first-class policy object |
| Sentence-level claim checking (clear-head) | 1,309 replayed claims; local Kev-4b agreed with Jev on only 12% of contradicted claims, 44 s vs 1 s ([clear-head](https://github.com/VladyslavHontar/clear-head)) | measured (agreement, not truth) | Verifier retrieves evidence from tool output, never generator text |
| Narrowed claims gate (jev-gates) | 14/14 false blocked, 12/12 true passed on 73 turns; warm broker 1,100 to 450 ms; five broader gates removed ([jev-gates](https://github.com/rashedInt32/jev-gates)) | small; negative for broad gates | Warm pooled connections; narrow defaults |
| Done-check nudge (pi-warden) | Agent re-verified 94 of 124 unverified claims, 76% ([pi-warden](https://github.com/DevMortimer/pi-warden)) | field, no truth labels | Log nudges as outcomes |
| Trajectory monitor (Edward) | StepShield 216: Jev 59.3% recall / 10.2% FPR; rules 7.4%; local 4B 58.3% / 17.6%; fine-tune abandoned ([Edward](https://github.com/VeridicalTech/Edward)) | measured | Deterministic triggers plus an advisory scorer that never gates actions |
| Dead-end circuit breaker (jev-harness) | Abort at 0.70; effort leases; `degraded_reason` labels; no precision or recall ([jev-harness](https://github.com/ismaelsoilet/jev-harness)) | unmeasured | Degraded-mode labels in the ledger |
| Plan drift per tool call (stepwarden) | Five questions against the verbatim first prompt; allow/ask/block at 0.6/0.9; about 0.5 s ([stepwarden](https://github.com/getexcited/stepwarden)) | unmeasured | Anchor state to the verbatim request; band at least as wide as drift |
| Proposal review (TypeSafeAI/jev-harness) | 25/25 offline (scripted), 20/20 synthetic; "no live recovery benefit" over 171 ([repo](https://github.com/TypeSafeAI/jev-harness)) | negative live | Offline catch is not live benefit; require an outcome comparison |
| Handoff gate (agent-handoff-gate) | 38/40 and 37/40 raw; 22 decisive at 0.80 with 0 errors ([repo](https://github.com/zsoXi/agent-handoff-gate)) | small | Selective prediction at a preregistered bar; lead keeps final review |
| Sub-agent model and effort routing (Halv) | -57.1% cost at equal 25/42, confounded by three other optimisations and 3.49x tokens ([Halv](https://halv.ai/blog/halv-swe-rebench-astra-42-pairs/)) | confounded | Attribute savings by ablation |
| Skill routing (DoGMaTiiC; Shimomoto) | 95% top-1 on 76 requests, every loss from the gate; a week-long shadow run used 28 of 539 picks and was removed ([Hermes docs](https://hermes-agent.nousresearch.com/docs/plugins/jev-skill-router); [dev.to](https://dev.to/shimo4228/is-there-any-point-to-this-removing-the-jev-plugins-i-added-to-claude-code-after-one-week-49eh)) | small; negative in the loop | Shadow must measure downstream uptake, not just verdict accuracy |
| Memory controller (Jev-Mem) | LoCoMo 0.777 vs 0.700; build 158 s vs 1,044 s ([Jev-Mem](https://github.com/libingzheren/Jev-Mem)) | measured, one benchmark | Budgeted traversal (capped calls per query) |
| Reversible pruning (pi-jev-context) | Keep above 0.8; hide, not delete; rejudge; no numbers ([repo](https://github.com/kevinpita/pi-jev-context)) | unmeasured | Hide-with-pointer plus rejudge |
| Summarising handoff (hermes-jev-skills) | 58.7% recall (75.0% with search), below the plain transcript; dropped ([repo](https://github.com/kerpopule/hermes-jev-skills)) | negative | Do not build digest compaction |
| Tool-output admission (mu, jevkit) | Folding 51.0%; Jev cut 40.2% with 0/72 lines lost, held-out 46.4% with 0/19; jevkit 58% to 100% of relevant lines once errors were pinned ([mu](https://github.com/qybaihe/mu); [jevkit](https://github.com/walidboulanouar/jev-agent-kit)) | measured, small | Lossless code transform and pinning first; omit only at 0.9 or above; archive behind a pointer |
| LLM-free crawl (jevcrawl) | 40% vs 30% vs 8% correct; $0.025 vs $0.194 per task ([jevcrawl](https://github.com/RayenMlayeh/jevcrawl)) | measured, author-run | Budgets, typed stop reasons, labelled degraded mode |
| Speculative taxonomy descent (r6i) | 9.62 to 1.38 s (overstated: 5 threads); path score rejected 1/50 vs 14 for the judge and approved an out-of-taxonomy item at 0.65 ([r6i](https://blog.r6i.it/typesafe-jev-vs-agentic-loop.html)) | measured; negative for the path score | Speculative heads are fine; a geometric path score is not a verifier |
| Weakest-probability action gate (SystemOneHarness) | Required probability by risk: read 0.5, write 0.6, destructive 0.8; a refusal becomes a handoff record; 5/5 tiny tasks ([repo](https://github.com/HarnessRouter/SystemOneHarness)) | small | Per-action-class bars; a refusal carries state, questions and the failed bar |
| Decision at every fork (JevLoop) | Decisions took 79% of wall clock; 5.9 s vs 3.4 s for ReAct; 6/7 vs 7/7 accepted ([JevLoop](https://github.com/zjunlp/JevLoop)) | negative | No hosted call on every fork; recompute confidence per option count |
| Effort lease, cache-preserving (reasoning-router) | 44/44 both arms; 14% fewer output tokens, 9% less time ([repo](https://github.com/robertn702/opencode-jev-router)) | small, controlled | Lease plus re-ask triggers |
| Production router swap (Kilo Code) | 72 golden cases 0.785 to 0.93; repair and retry code deleted; p50 530 ms ([PR 7223](https://github.com/Kilo-Org/cloud/pull/7223)) | small, production | Typed answers remove repair code; a deadline per attempt |
| Wake gating (wakegate) | Yes/no 16/21, three-way 21/21; unsure band wakes ([wakegate](https://github.com/shitianfang/wakegate)) | small, author eval | Asymmetric unsure band that defaults to the safe branch |
| Mid-stream token gate (tokengate) | 0 leaked tokens; +0.11 s on 19.3 s; FPR unmeasured ([repo](https://github.com/Thanh-Mathieu95/jev-model-tokengate)) | small | Windowed evaluation with in-order commit |
| Permission certification (construct-auto-classifier) | 1,300 decisions per model; Jev 0 dangerous allowed, 98.9% correct ([repo](https://github.com/godspede/construct-auto-classifier)) | measured | A certification suite per backend before enforce |
| Ask suppression plus conjunctive release (pi-warden) | 48.9% fewer requests while keeping 327/338 outcome-changing asks; wrong releases 45 to 1 ([pi-warden](https://github.com/DevMortimer/pi-warden)) | measured, field | Value-of-information suppression; an AND of probabilities for releases |
| Ordered approval ladder (hermes-jev-approvals) | Six typed answers through a first-match rule ladder; "8.7x faster, 4.4x fewer prompts" on 153 commands ([repo](https://github.com/anpicasso/hermes-jev-approvals)) | small | DMN-style first-hit ladder over probabilities |
| Allow-only auto-approve (jev-auto-approve) | Allow at 0.95 or above, else silent; 0 of 8 state-changing commands approved ([repo](https://github.com/BasmaAbouzied0/jev-auto-approve)) | small | One-sided gates that can only skip a prompt |
| One-use permits and receipts (PermitMCP, Edward) | Permit binds the proposal digest and expires in 1 minute; hash-chained receipts ([PermitMCP](https://github.com/qinpei-dev/permit-mcp); [Edward](https://github.com/VeridicalTech/Edward)) | unmeasured | `act` emits a permit bound to the record digest |
| Evidence admission (r2r-jev) | 99.9% from a low-reliability source rejected; 76% with no corroboration held, accepted with two corroborators ([repo](https://github.com/Thneoly/r2r-jev)) | unmeasured | Source reliability as a pooling parameter |
| Red-team policy loop (siege) | Gate v1 33% catch, v2 100% catch at 92% benign allow ([repo](https://github.com/vnmoorthy/siege)) | small, synthetic | Accept policy candidates on catch rate and benign-allow rate together |
| Advice-only adversarial reviewer (omp-typesafe) | Never blocks; notes per turn capped; templated text only ([repo](https://github.com/siddicky/omp-typesafe)) | unmeasured | Advisory mode distinct from gating |
| Distribution replay (metajev) | Moving the bar from 0.70 to 0.90 shifted 75 wrong answers off accept and 158 right ones to review ([metajev](https://github.com/YYTbit/metajev)) | small | `replay(policy)` over stored distributions |
| CI threshold lock (jevcal) | Half-split fit; 95% lower-bound mode; exits 1 on drift ([jevcal](https://github.com/abhixhek/jevcal)) | unmeasured on Jev | A lock file per decision definition |
| Local heads with novelty gate (stuntd) | 22 ms vs 376 to 389 ms; confident on 69% of unseen inputs, right on 42% of those; gate stops 99.7% ([stuntd](https://github.com/bladedevoff/stuntd)) | measured, demo | A novelty gate is mandatory on any local tier |
| Wire-contract gateway (agentgateway, LiteLLM) | `/v1/decisions` and `/v1/systemone` translated into each other; `refusal` entry; "the gateway never thresholds" ([agentgateway](https://agentgateway.dev/blog/2026-10-12-openai-decisions-api-jev-agentgateway/); [LiteLLM](https://docs.litellm.ai/docs/decisions)) | unmeasured | Target the wire contract, not an SDK |
| Human-answered backend (Hev) | Show HN, 2 points; no latency or pricing ([HN](https://news.ycombinator.com/item?id=50075774)) | unmeasured | The human reviewer exposed as an `Oracle` |

## Pre-digested state and soft pooling moved accuracy more than wording did

### Decomposition helps only when recombination stays soft

TypeSafe calls decomposition "probably the most important concept" and documents a weighted sum computed in code, with an explicit uncertain band ([How to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)). The only controlled study found that the recombination rule matters more than the decomposition itself ([arXiv 2609.29429](https://arxiv.org/html/2609.29429)):

- Across 44 benchmarks, rubrics that threshold each atomic question at 0.5 and then combine with AND or OR **lost to the best single targeted question on 9 of 10 benchmarks, by a median of 0.137 AUROC**. The study's explanation: "each atom's error survives the 0.5 threshold and the composition discards Jev's probabilities".
- Soft combinations over raw probabilities were the best strategies on their own benchmarks: max over disclosure atoms, products, a difference of per-option probabilities, and a ratio.
- The best multi-question strategy beat the best single question by a median of 0.000 AUROC.

Two other studies point the same way. A radiology study found a seven-question battery tied a single three-option Choice: Kendall tau of 0.582 against 0.573, and 0.397 against 0.398. The single Choice used 43 to 45% fewer input tokens ([arXiv 2609.27607](https://arxiv.org/html/2609.27607)). FlowX saw one breached rubric dimension drag four others wrongly low in the same request, so battery members share a forward pass and are not independent ([FlowX](https://www.flowx.ai/blog/jev-the-good-the-bad-and-the-ugly)).

Decomposition pays when a fitted combiner, rather than a threshold, consumes the probabilities:

- **Phishing.** Five signal Nouls fed to a cross-validated logistic regression reached **95.1%, where Jev's own single verdict got 62.6%**. Two caveats: the emails were LLM-generated, and a two-feature regex reached 91.8% ([jev-phishing-bench](https://github.com/anisselbd/jev-phishing-bench)).
- **Wine reviews.** TypeSafe's feature-discovery cookbook cut held-out RMSE from 2.145 (asking Jev for the score directly) to 1.772, by using 38 Jev answers as CatBoost features ([AutoResearch cookbook](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery.md)).
- **Email triage.** In an open DSPy PR, an LM rewrites a decision into a few narrow questions. That lifted three-way email triage from 0.649 to 0.816 ([DSPy PR #10536](https://github.com/stanfordnlp/dspy/pull/10536)).

So the engine needs a richer pooling vocabulary, each operator matched to a situation:
- **weighted sum,** when the parts trade off against each other;
- **min,** when "one wrong argument is enough to spoil the result" ([function calling cookbook](https://docs.typesafe.ai/cookbooks/function_calling.md));
- **any-fires max,** for batteries where any single flag should escalate;
- **geometric mean,** for sequential path factors ([hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification.md));
- **products and differences.**

It also needs a fitted-combiner slot trained only on unselected ledger rows, and it should refuse to threshold before pooling.

### Batching questions is safe; packing items is not

For map-reduce, the community separated two shapes that look alike.

**Many questions about one state is safe and nearly free:**
- 13 questions over a 53,777-character article were 12.2x cheaper and 10.0x faster batched, with identical answers ([parallel questions cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions.md)).
- A 2,976-request benchmark found a fixed overhead of about 261 input tokens per request and 76 to 86% input-token savings at eight questions per call. Answer differences between batched and single calls were no larger than repeat noise, and 1,000 questions in one call succeeded ([jev-fanout-bench](https://github.com/blowxian/jev-fanout-bench)).

**Many items packed into one state is not safe:**
- Packing similar items into one array cut accuracy from 96% to 72% at gc.ai's hack day ([gc.ai](https://gc.ai/blog/what-we-learned-building-38-projects-with-jev-in-12-hours)).
- Packing PII records roughly halved accuracy ([jev-pii-test](https://github.com/phubbard/jev-pii-test)).
- In the systematic-review study, ten-record batches put 143 of 1,405 excluded records on the other side of the stopping threshold compared with single-record calls ([medRxiv](https://www.medrxiv.org/content/10.64898/2026.10.09.26365173v1.full)).

The cheapest correct shape is "fixed state, variable question":
- Put per-item data in each question's `instructions`, as TypeSafe's duplicate-record example does ([Noul](https://docs.typesafe.ai/primitives/noul)).
- Or index lines as Choice options and pair them with a "does any line answer?" Noul. A Choice always sums to one: its top line scored 0.86 on a query whose existence Noul scored 0.14 ([semantic find](https://docs.typesafe.ai/cookbooks/semantic_find.md)).

**Listwise ranking beat pointwise wherever the two were compared.** A Choice over the whole candidate pool reached recall@1 of 0.94, against 0.87 for per-candidate Nouls, at about a thirtieth of the calls ([Hindsight](https://hindsight.vectorize.io/blog/2026/09/24/adding-jev-reranker-what-we-learned)). Escape options inside the ranking backfired, and both were removed:
- a "none of these" option emptied 35 of 200 queries;
- a "nothing relevant" Score level dropped gold retention from 0.81 to 0.65.

Escape options belong in classification Choices and in separate existence Nouls, never inside ranking lists.

**The state a gate sees must belong to the unit that acts.** A coding agent's read gate produced 58 false skips in 174 verdicts. 52 of them were subagent reads judged against the parent's task ([paseo PR #21](https://github.com/funkmastert/paseo/pull/21)).

### State engineering is the largest measured lever

The single largest accuracy lever measured in the window was pre-digesting the state in code. jev-state's transforms band numbers against their range, count lists into none/one/a few/several/many, turn timestamps into relative phrases, and prune and project fields. On 70 seeded NPC scenarios ([jev-state](https://github.com/suranjaychandra/jev-state)):
- accuracy went from **74.3% to 100%**;
- scenarios whose answer changed across three reruns fell from 6 to 0;
- input tokens fell 43%;
- every raw-state miss was an arithmetic rule.

"Just Ask Jev" found that which fields are present moves AUROC far more than wording does ([arXiv 2609.29429](https://arxiv.org/html/2609.29429)):
- adding fields that define the label raised generic-question AUROC by +0.157 to +0.361;
- a distilled reference cut MASK input tokens from 8,647 to 2,504 with AUROC unchanged;
- showing the model its own stated confidence added nothing (-0.004);
- the best targeted wording beat the best generic readout by only +0.006 out of sample;
- a reference field can also invert a result (0.712 to 0.288 on a corrected label), because it steers toward whatever label it defines.

Two other results back the rule that arithmetic belongs in code. Akita's 23-model benchmark summarised it as "Numeric thresholds and severity policies were handled better by `if` statements" ([Akita](https://akitaonrails.com/en/2026/10/10/which-jev-like-ai-decision-classifier-model-is-best/)). Every one of the nine errors in a 90-question quiz benchmark was multi-step arithmetic, seven of them at confidence 0.26 to 0.49 ([QuizPilot](https://dev.to/jack9999/how-we-use-jev-to-answer-quiz-questions-a-90-question-benchmark-7ho)).

The catalogue argues for a state-pipeline stage with banding, counting, relative time, projection onto the paths each question declares, and a strict mode, plus a per-field ablation runner in the evaluation harness.

### Criteria craft is schema discipline that can be checked before any call

- **Describe each Score level.** In TypeSafe's own examples, numeric-only levels returned 0.55 at confidence 0.33, where descriptive levels returned 0.0 at 1.0. Eleven Score levels returned a server error ([Score](https://docs.typesafe.ai/primitives/score); [AutoResearch cookbook](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery.md)).
- **Use examples that resemble real inputs.** A matching example moved an answer from 1.43 at 0.35 to 1.03 at 0.96; an unrelated example changed nothing ([Score](https://docs.typesafe.ai/primitives/score)).
- **Read answers soft.** Argmax readouts lost to soft ones on 28 of 30 Choice and 24 of 31 Score benchmarks, by 0.06 to 0.09 AUROC ([arXiv 2609.29429](https://arxiv.org/html/2609.29429)).
- **Phrase questions positively, and check that per backend.** On Arize's 1,338-row wording test, Jev scored AUROC 0.93 on both "Is every claim supported?" and "Does it contain an unsupported claim?". On the negated form, Liquid d1 fell to 0.17, Strands Decider to 0.26 and Kev 9B to 0.54 ([Arize](https://arize.com/blog/decision-model-benchmark/)).
- **Compute "uncertain" in code.** An `uncertain` outcome triggered whenever the top probability is below 0.60 raised plurality-label agreement from 90.8% to 99.2%, while still deciding 74.2% of items automatically ([consistency choice cookbook](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook)).
- **Fall back to a coarser label.** Above 255 options, falling back to the parent label when confidence dropped below 0.9 turned 65% accuracy into 80% ([classification using confidence](https://docs.typesafe.ai/cookbooks/classification_using_confidence.md)).
- **Keep questions short.** Longer, more qualified questions raised one author's calibration error from 0.040 to 0.116 ([Lindfors](https://lindfors.no/blog/a-first-look-at-typesafes-jev/)).

### Order and repeat drift flip thresholds, not labels

On hosted Jev, reordering options flips decisions near a threshold more than it flips labels:
- three orderings changed 0 of 6 labels on 20 September and again on 3 October, but confidence moved 0.13 to 0.16 across orderings against at most 0.04 between identical repeats ([jev-position-test](https://github.com/imaddde867/jev-position-test));
- a 346,009-request study found accuracy unchanged under rotation ([arXiv 2609.37647](https://arxiv.org/abs/2609.37647));
- a survey measured 7.0% of 16-option answers changing under reordering ([redreamality](https://redreamality.com/blog/open-decision-models-2026-survey-benchmarks/)).

Identical requests are not identical either:
- up to 0.08 apart in the position test;
- up to 0.12 over ten runs, with only 4 of 21 questions identical, at FlowX ([FlowX](https://www.flowx.ai/blog/jev-the-good-the-bad-and-the-ugly));
- 0.62 to 0.91 across five calls for one CI-triage case ([jev-ci-triage](https://github.com/criguex/jev-ci-triage)).

This qualifies the 0.0102 standard deviation TypeSafe measured on easy items ([consistency noul cookbook](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook)). Variance concentrates on near-flat distributions, exactly where thresholds sit. Averaging over option rotations has been measured only on open clones, where it cut reversal flips from 23.0% to 7.3% ([AnyJev](https://wavect.io/blog/anyjev-calibration-option-order-bias/)).

Ten labelled items raised median F1 from 0.706 to 0.793, and the median optimal threshold was 0.35. On validated labels, though, a 10-label threshold cost about 0.025 against the default 0.5 ([arXiv 2609.29429](https://arxiv.org/html/2609.29429)), so small-n fits need a guard rather than blind trust.

### Box, multilingual criteria, injection and wire quirks

**Box and images (Jev 1.14, 14 October):**
- The experimental `box` type "always returns a box". An absent bicycle was still boxed, at confidence 0.03 ([1023 Jack](https://1023jack.com/news/jev-can-see-now-i-pointed-it-at-30-of-my-own-images/)).
- TypeSafe's own containment test caught 30 of 36 cut-offs with four per-edge Nouls, against 26 for one "all inside?" Noul and 20 for drawing the outline ([Box](https://docs.typesafe.ai/primitives/box)).
- The same image test found 1.14 more conservative than 1.13. The correct headline scored 0.5 or above on 15 of 30 images against 23 of 30, at AUC 0.91 against 0.89. Thresholds fit on 1.13 will under-fire when the alias moves.

**Multilingual:** keep criteria in the engine's canonical language. Translating the questions cost up to 13 points on toxicity (97.8% to 84.4%), while English questions over Spanish text lost nothing ([Galtea](https://galtea.ai/blog/multilingual-llm-judge-benchmark)).

**Injection:** framing inside the request is not a control.
- A counterfeit policy prepended to the untrusted message, with the trusted instructions unchanged, dropped Noul recall from **82.90% to 3.88%** ([Datadog Security Labs](https://securitylabs.datadoghq.com/articles/jev-as-a-judge-how-counterfeit-policy-steers-jev/)).
- Typed input, "untrusted" markers and anti-injection instructions were noise in Check Point's test ([Check Point](https://blog.checkpoint.com/ai-security/jev-is-not-a-language-model-but-it-breaks-like-one-prompt-injection-against-a-typed-decision-model/)).
- Decisions within 0.1 of the boundary flipped in 12 of 12 attacks, against 1 of 468 elsewhere ([arXiv 2609.28613](https://arxiv.org/html/2609.28613)).

**Wire quirks the engine must validate:**
- `choice` can sit 0.01 below another option on near-ties, which TypeSafe called "a problem in our API" ([typesafe-sdk-python #15](https://github.com/typesafe-ai/typesafe-sdk-python/issues/15)).
- Sums of 0.99 appeared in 9 of 120 fourteen-option responses. That prompted a tolerance of 0.005 per option, without silent renormalisation ([jev-polls PR #134](https://github.com/gm2211/jev-polls/pull/134)).

| Pattern | Evidence | Grade | Engine implication |
| --- | --- | --- | --- |
| Atomic Noul battery with a code-owned weighted sum and uncertain band | Spam weights 0.45/0.30/0.25; review band 0.4 to 0.6 ([How to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)) | official, unmeasured | `weightedSum` pooling with an explicit band |
| Thresholded-AND rubric | Lost on 9 of 10 benchmarks, median -0.137 AUROC ([arXiv 2609.29429](https://arxiv.org/html/2609.29429)) | negative, measured | Forbid thresholding before pooling |
| Soft combinations (max, product, difference, ratio) | Best on PrivacyLens, MASK, MACHIAVELLI; best multi minus best single = median 0.000 ([arXiv 2609.29429](https://arxiv.org/html/2609.29429)) | measured | Add operators; decomposition buys inspectability, not accuracy |
| One 3-way Choice vs a 7-question battery | tau 0.573 vs 0.582 and 0.398 vs 0.397; single Choice uses 43 to 45% fewer tokens ([arXiv 2609.27607](https://arxiv.org/html/2609.27607)) | measured | Prefer one targeted Choice with "not addressed" |
| Correlation within a request | One breached dimension dragged four other scores low ([FlowX](https://www.flowx.ai/blog/jev-the-good-the-bad-and-the-ugly)) | small | A correlation parameter for batteries; a single-dimension perturbation test |
| Min, any-fires and geometric-mean gates | Least-certain argument; `REVIEW_BELOW` 0.60; any flag above 0.7; path geometric mean ([function calling](https://docs.typesafe.ai/cookbooks/function_calling.md); [SDE cascade](https://docs.typesafe.ai/cookbooks/sde_cascade.md); [hierarchical](https://docs.typesafe.ai/cookbooks/hierarchical_classification.md)) | official | `min`, `max` and `geomean` operators |
| Mean of oriented Nouls as an abstain gate | Wrong skill loads 16.8% to 7.3%, needless 9.8% to 4.0% ([skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion.md)) | official, measured | An `orient(p, inverted)` helper so inversion lives in code |
| Answers as features for a trained model | RMSE 2.145 (direct) to 1.869 (18 questions) to 1.772 (38) ([AutoResearch](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery.md)); phishing 62.6% to 95.1% ([bench](https://github.com/anisselbd/jev-phishing-bench)) | measured | Feature encoder (expected level, SD); combiner fit on unselected rows |
| LM-proposed decomposition | Email triage 0.649 to 0.816 at $0.049/1k vs GEPA 0.798 at $0.272 ([PR #10536](https://github.com/stanfordnlp/dspy/pull/10536)) | measured, open PR | Decomposition search with held-out acceptance |
| Many questions, one state | 12.2x cheaper, 10.0x faster; ~261-token overhead; batched differences = repeat noise ([cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions.md); [fanout-bench](https://github.com/blowxian/jev-fanout-bench)) | measured | Batch per state (exists) |
| Records in instructions, fixed state | Duplicate-record example; question ids carry DB ids the model never sees ([Noul](https://docs.typesafe.ai/primitives/noul)) | official | A record-in-question template; ids as routing metadata |
| Lines as Choice options plus an exists Noul | 218 lines; FOUND/ABSENT 0.7/0.35; top line 0.86 while exists was 0.14 ([semantic find](https://docs.typesafe.ai/cookbooks/semantic_find.md)) | official | `locate` always pairs an existence question |
| Packing many items into one state | 96% to 72% ([gc.ai](https://gc.ai/blog/what-we-learned-building-38-projects-with-jev-in-12-hours)); PII accuracy halved ([pii-test](https://github.com/phubbard/jev-pii-test)); 143/1,405 moved across the bar ([medRxiv](https://www.medrxiv.org/content/10.64898/2026.10.09.26365173v1.full)) | negative, measured | Items-per-request is a calibration key; fit at production packing |
| Listwise Choice over the pool | recall@1 0.94 vs 0.87 at ~1/30 the calls; "none" emptied 35/200 ([Hindsight](https://hindsight.vectorize.io/blog/2026/09/24/adding-jev-reranker-what-we-learned)) | measured | `rankByChoice` with rounds above 250; no escape option in rankings |
| Cheap reads | Two file questions $0.00049 vs $0.091 (~187x) ([ten-levels](https://github.com/disler/ten-levels-of-jev)) | small | File-to-state loader with size and 255-item caps |
| Read-gate scoping | 58/174 false skips; 52 were subagent reads judged on the parent task ([paseo #21](https://github.com/funkmastert/paseo/pull/21)) | measured, negative | Build state from the acting unit's brief |
| Tiered reading with a band | 64/72 alone; escalating 0.2 to 0.8 gave 72/72; a rerun error at 0.82 fell outside the band ([MLflow](https://mlflow.org/blog/jev-llm-judge-part-2/)) | small | Fit the band from data; log escalations as their own path |
| Chunking limits | 64k/32k; the 262k header is "slower and less accurate"; latency ~73 ms + 6 ms per 1k tokens ([Models](https://docs.typesafe.ai/models); [JevResearch](https://raw.githubusercontent.com/JevResearch/Jev-Research/main/README.md)) | official, measured | Token estimator; chunk questions before state |
| Band, count, relativise, prune | 74.3% to 100%; unstable 6/70 to 0/70; tokens -43% ([jev-state](https://github.com/suranjaychandra/jev-state)) | measured, synthetic, one domain | A state-transform stage with strict projection |
| Label-defining fields over wording | +0.157 to +0.361 AUROC; self-confidence field -0.004; reference 8,647 to 2,504 tokens at no loss; can invert 0.712 to 0.288 ([arXiv 2609.29429](https://arxiv.org/html/2609.29429)) | measured | A reference slot plus a per-field ablation runner |
| Arithmetic, counting and dates in code | "handled better by `if` statements" ([Akita](https://akitaonrails.com/en/2026/10/10/which-jev-like-ai-decision-classifier-model-is-best/)); 7 Choices for date parts ([date cookbook](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook.md)) | official, measured | Candidate-proposal hooks; compare in code |
| Transcript as records, newest user message pinned | AutoMode's 30-message window drops the request around tool call 16 ([Towards AI](https://towardsai.com/?p=53905)) | small | A transcript-to-record transform |
| Descriptive Score levels | Numeric-only 0.55 at 0.33 vs descriptive 0.0 at 1.0; 11 levels errors ([Score](https://docs.typesafe.ai/primitives/score)) | official | Lint: 2 to 10 levels, no numeric-only text |
| Matching examples only | 1.43 at 0.35 to 1.03 at 0.96; an unrelated example had no effect ([Score](https://docs.typesafe.ai/primitives/score)) | official | Examples as versioned data with a held-out check |
| Expected value over argmax | Argmax lost 28/30 Choice and 24/31 Score comparisons ([arXiv 2609.29429](https://arxiv.org/html/2609.29429)) | measured | Store distributions; default to the expected value |
| Escape options in classification | No `other`: cafeteria hours went to `sales` at 0.31 ([video summary](https://openclawdatabase.com/news/videos/2026-09-17-jev-tested-browser-use-classification/index.md)); code-side `uncertain` 90.8% to 99.2% ([cookbook](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook)) | official, anecdote | Auto-append `other` to classification, never to ranking |
| Positive polarity | Jev 0.93/0.93 on negated wording; d1 0.17, Strands 0.26, Kev 0.54 ([Arize](https://arize.com/blog/decision-model-benchmark/)) | measured | A polarity lint, enforced per backend |
| Wording vs structure | Targeted vs generic +0.006 AUROC ([arXiv 2609.29429](https://arxiv.org/html/2609.29429)); "picks up mid-sentence?" fixed block structure ([autoformat](https://docs.typesafe.ai/cookbooks/autoformat.md)) | measured | Wording changes are A/B hypotheses, not tuning knobs |
| More than 255 options | Two-stage; beam 4/4 vs greedy 2/4 (demo); coarse fallback 65% to 80% ([hierarchical](https://docs.typesafe.ai/cookbooks/hierarchical_classification.md); [confidence](https://docs.typesafe.ai/cookbooks/classification_using_confidence.md)) | official | A `choiceOver` planner plus a coarse-fallback map |
| Option order | 0/6 labels changed but confidence moved 0.13 to 0.16 ([position test](https://github.com/imaddde867/jev-position-test)); 7.0% of 16-option answers changed ([redreamality](https://redreamality.com/blog/open-decision-models-2026-survey-benchmarks/)) | measured | Re-ask reversed only on near-ties; log display order |
| Rerank fused with the retriever | RRF +0.090 NDCG@10 vs Jev alone +0.012 (not significant); label circularity +0.053 vs -0.028 ([rerank eval](https://raw.githubusercontent.com/zhuyansen/jev-search-rerank-eval/main/README.md)) | measured | An `rrf` helper; tag each label's source |
| RAG passage ladder | Injection > contradiction > relevance > evidence, first match wins ([RAG cookbook](https://docs.typesafe.ai/cookbooks/classifying_rag_passages.md)) | official, no metric | An ordered first-hit rule ladder |
| Thresholds from about 10 labels | F1 0.706 to 0.793; median optimum 0.35; on validated labels costs about 0.025 ([arXiv 2609.29429](https://arxiv.org/html/2609.29429)) | measured | `fitThreshold` with CV and a minimum-N guard |
| Selective prediction | Keeping the half farthest from 0.5 lifted accuracy 0.793 to 0.933 ([arXiv 2609.29429](https://arxiv.org/html/2609.29429)); 758/758 correct at 0.9 or above, and escalating to Qwen did not beat Jev ([orca forge](https://dev.to/orca_forge/jev-vs-local-models-where-japanese-intent-routing-stands-after-1000-utterances-50j2)) | measured | A coverage curve per question |
| Box paired with a presence Noul | Absent bicycle boxed at 0.03; edge Nouls 30/36 vs 26 vs 20 ([1023 Jack](https://1023jack.com/news/jev-can-see-now-i-pointed-it-at-30-of-my-own-images/); [Box](https://docs.typesafe.ai/primitives/box)) | small | Model Box as box plus an existence Noul |
| English rubric over non-English state | Translated questions cost up to 13 points ([Galtea](https://galtea.ai/blog/multilingual-llm-judge-benchmark)) | measured | Canonical-language criteria |
| In-request injection framing | Recall 82.90% to 3.88% ([Datadog](https://securitylabs.datadoghq.com/articles/jev-as-a-judge-how-counterfeit-policy-steers-jev/)); markers were noise ([Check Point](https://blog.checkpoint.com/ai-security/jev-is-not-a-language-model-but-it-breaks-like-one-prompt-injection-against-a-typed-decision-model/)) | negative, measured | Taint tags plus floors, never prompts |
| Wire quirks | `choice` 0.01 below the top ([#15](https://github.com/typesafe-ai/typesafe-sdk-python/issues/15)); 9/120 sums of 0.99 ([PR #134](https://github.com/gm2211/jev-polls/pull/134)) | measured | Validate; recompute argmax; a mismatch means a near-tie, so review |

## In real-time loops, code owns timing and validity while Jev picks from a shrinking menu

### Games: code reflexes, a Jev menu pick, milestone planning

Every working game, robot and GUI loop splits control three ways:
- code runs reflexes at engine rate (20 to 500 Hz);
- Jev picks one option from a code-filtered menu at 1 to 10 Hz;
- any generative planner runs only at milestones.

The Minecraft Ender Dragon reproduction ran 119 Jev decisions and 35 planner calls in 7 min 45 s, costing $0.010 of Jev and $0.953 of Astra. Planning was gated to milestones and "Never per step". A general LLM emulating Jev was about 8x slower and 20x the cost ([teknium1](https://github.com/teknium1/hermes-and-jev-play-minecraft)).

Where a baseline exists, it often ties or wins:
- a random policy out-peaked Jev at RuneScape: 235 against 197 XP per minute ([jevscape](https://github.com/Skyvern-AI/jevscape));
- a NetHack baseline that always takes the first option reached the same dungeon level 11 ([jev-nethack](https://github.com/statico/jev-nethack));
- in a MuJoCo pick-and-place study, "Jev chose exactly the same action sequence as the rules controller in all 20 episodes" ([jev-pick-and-place-study](https://github.com/tryaksh/jev-pick-and-place-study)).

A grid benchmark found about 90% of single moves optimal but only 57 of 100 games won ([System-One-Control-Bench](https://github.com/Exemocaro/System-One-Control-Bench)). That is chain-decay arithmetic in miniature: small per-step error compounds into many lost games.

The reliability fixes all lived in code:
- **Shrink the menu.** Stop offering `mine_dirt` once the target is met; offer `wait` only when nothing else is valid ([teknium1](https://github.com/teknium1/hermes-and-jev-play-minecraft)).
- **Let code hold discrete targets.** Direct steering by Jev gave a DNF with nine off-track excursions. Choosing a racing line and pedal at 3.5 Hz, with code steering at 120 Hz, gave none ([jev-grand-prix](https://github.com/enoyola/jev-grand-prix)).
- **Use digit-free relative phrases** in the state ([pong-jev](https://github.com/safzanpirani/pong-jev)).

### Robots and latency: the vehicle is the bottleneck, not the model

All embodied uses found are simulations. jev-drone layers control by rate ([jev-drone](https://github.com/RomanSlack/jev-drone)):
- a 500 Hz controller;
- a 50 Hz reflex that overrides Jev;
- 15 Hz perception;
- Jev as an advisory layer at 2.5 to 3 Hz.

Code refuses `climb` unless the measured top edge allows it, and reuses the last judgment when a scene fingerprint is unchanged. The budget table puts the model at 13% of the loop and the airframe at 80%. The headline run hit a pacing bug: 152 of 182 requests queued, so "the model influenced nothing".

Hosted latency sets the frequency ceiling:
- median latency is about 80 to 125 ms at 1,000 to 2,000 input tokens, about 220 ms at 4,000, and 245 to 335 ms at 6,500;
- the first call pays about 500 ms of TLS setup ([jev-launcher](https://github.com/dabit3/jev-experiments/tree/main/jev-launcher));
- gateways add 75 to 500 ms;
- overlapping requests cut pong's decision age from 196 to 111 ms, at an unchanged 379 ms per call ([pong-jev](https://github.com/safzanpirani/pong-jev)).

Hao AI Lab's 24 ms figure for Minecraft PvP came from a self-served open model on the lab's own GPU cluster, not hosted Jev. Even there, a laptop tunnel cost about 330 ms ([Hao AI Lab](https://haoailab.com/blogs/mcjev/)).

### Browser and GUI agents

Browser and GUI agents converged on one design. Each step is one request: an operation Choice plus speculative target Choices, each restricted to compatible elements, over a numbered element table with no screenshot. Code executes only the head that matches the chosen operation, and re-checks freshness before acting.

- **jev-ultrafast** cut browser-protocol calls from 1,092 to 101 and median task time from 9.45 to 7.09 s. It insists that "A `DONE` choice still requires independent outcome verification" and that "Model output never becomes selectors, coordinates, shell commands, or executable JavaScript" ([jev-ultrafast](https://github.com/browser-use/jev-ultrafast)).
- **A macOS agent** priced a decision at $0.0002, against $0.032 for a screenshot-reading frontier model, and a step at 1.5 against 5.5 s ([typesafe-computer-use](https://github.com/awlevin/typesafe-computer-use)).

Two gaps remain. No task-success rate exists on WebArena, OSWorld or AndroidWorld. None of these projects rotates element order despite Jev's documented first-option lean, so DOM order systematically favours top-of-page controls.

### Keystroke, voice and streaming loops

At keystroke rate, five mechanisms recur:
- an optimistic local result shown first;
- one request per input change;
- cancellation of superseded requests, with late answers rejected;
- probability bands rather than argmax;
- a code-owned blend of signals.

Measured examples:
- **judge-sheets** fills a 300-row column at 57 to 85 rows per second, with a 114 to 120 ms median per request ([judge-sheets](https://github.com/dabit3/jev-experiments/tree/main/judge-sheets)).
- **jev-voice-turn** declares end of turn at 0.85 after a 250 ms pause. On a simulated microphone it cut mean assistant delay from 1,000 to 351 ms ([jev-voice-turn](https://github.com/dabit3/jev-experiments/tree/main/jev-voice-turn)).
- **The Home Assistant agent** asks every plausible branch speculatively, because an extra question costs about 97 tokens against about 250 ms for a second round trip. It acts only above a confidence band and a 0.15 top-two margin, and confirms risky actions "however sure the model is" ([HA agent](https://github.com/the-sof/home-assistant-typesafe-conversation-agent)).
- **Very Good Ventures** cut median dashboard render from 29 s to 3.8 s by sending closed questions to Jev and answers below 50% confidence to an LLM ([The New Stack](https://r.jina.ai/https://thenewstack.io/workday-is-using-typesafes-jev-to-build-user-interfaces-on-the-fly/)).
- **jev-firehose** sustained streaming moderation at 300 messages per second, with a 122 ms median. At 400 per second it hit 2,351 HTTP 429 retries in 20 s and shed 12.6% of traffic to a regex labelled `HEURISTIC` ([jev-firehose](https://github.com/dabit3/jev-experiments/tree/main/jev-firehose)).
- **log-sentinel** measured eight events per request as 8x throughput at an unchanged median ([log-sentinel](https://github.com/dabit3/jev-experiments/tree/main/log-sentinel)), though the packing caveat above applies to anything thresholded.

### What these loops rebuild by hand

These loops all rebuild the same facilities:
- a deadline with a keep-current default;
- a sequence number to drop out-of-order replies, and a state fingerprint to reject stale ones;
- cancel-on-supersede and debounce;
- hysteresis with a minimum hold, such as exit only on two consecutive checks, or no close in the first 45 s ([jev-realtime-trading](https://github.com/rthomas24/jev-realtime-trading));
- a model-suggested re-poll interval that code clamps ([jevscape](https://github.com/Skyvern-AI/jevscape));
- change-triggered re-ask;
- labelled load shedding;
- a decision-age metric;
- halt on a failed ledger write, because "an unaudited delivery is worse than none" ([jevbus](https://github.com/zkjoie/jevbus)).

These belong in a loop kit beside the engine, not in its core. The core lessons that transfer are fingerprint-keyed caching, change-triggered re-ask, and a baseline runner that always reports random, first-option and rules policies beside the model.

| Pattern | Evidence | Grade | Engine implication |
| --- | --- | --- | --- |
| Three-layer control (reflex code, Jev menu, milestone planner) | Dragon run 7:45, $0.010 Jev + $0.953 Astra; Jev-emulating LLM 8x slower, 20x cost ([teknium1](https://github.com/teknium1/hermes-and-jev-play-minecraft)) | small, single runs | The engine sits at the menu-pick layer; the planner is a separate caller |
| Baselines that tie or win | Random 235 vs Jev 197 XP/min ([jevscape](https://github.com/Skyvern-AI/jevscape)); first-option reaches the same depth ([nethack](https://github.com/statico/jev-nethack)); identical to rules 20/20 ([pick-and-place](https://github.com/tryaksh/jev-pick-and-place-study)) | measured, negative | A mandatory baseline runner |
| Single decision vs whole episode | ~90% optimal moves, 57/100 games ([Control-Bench](https://github.com/Exemocaro/System-One-Control-Bench)) | measured | Chain-level q^n accounting |
| Menu shrinking | Stopped offering `mine_dirt`; `wait` only when nothing else is valid ([teknium1](https://github.com/teknium1/hermes-and-jev-play-minecraft)) | anecdotal fix | Options computed per state by code |
| Discrete targets, code actuates | Direct steering DNF with 9 off-tracks; line plus pedal gave 0, best lap 50.9 s vs code-only 50.4 s ([grand-prix](https://github.com/enoyola/jev-grand-prix)) | small | Never let the model own continuous control |
| Model-chosen re-poll interval | `poll_again_in_ticks`; a late answer keeps the current action; $2.22 for 3.04 h ([jevscape](https://github.com/Skyvern-AI/jevscape)) | small | Scheduler hint clamped in code |
| Predictive state and overlap | Without `--aim`, stale state lost points; concurrency 3 cut decision age 196 to 111 ms ([pong-jev](https://github.com/safzanpirani/pong-jev)) | small | Decision-age metric; sequence numbers |
| Advisory drone layer | 77.5 m vs 17.7 m in one 65 s run; 152/182 requests queued in the bug; model is 13% of the loop ([jev-drone](https://github.com/RomanSlack/jev-drone)) | small, single run | A reflex override; fingerprint reuse |
| Robot manipulation | 10/10 identical to rules at $0.0035 per success vs Haiku 4/10 ([study](https://github.com/tryaksh/jev-pick-and-place-study)); gated pick-and-place 5/10 vs rules 8/10 ([RoboJEV](https://github.com/lykycy123/RoboJEV)) | small | Rules win when geometry fully specifies the task |
| Element table plus speculative heads | Protocol calls 1,092 to 101; 9.45 to 7.09 s ([jev-ultrafast](https://github.com/browser-use/jev-ultrafast)) | small | `speculate`; executor freshness checks; independent DONE verification |
| Screenshot-free GUI agents | $0.0002 vs $0.032 per decision; step 1.5 vs 5.5 s ([awlevin](https://github.com/awlevin/typesafe-computer-use)); Jev p50 82 to 126 ms ([ax-pilot](https://github.com/dabit3/jev-experiments/tree/main/jev-ax-pilot)) | small | State builders that pass code-evaluated facts |
| Small model trained to the interface | JevForge 0.8B Mind2Web top-1 0.579/0.637 vs Jev 0.543/0.610 ([JevForge](https://github.com/zwliJay/jev-forge)) | measured | Open backends can match at element level |
| Component-catalogue UI selection | 29 s to 3.8 s, with answers below 50% sent to an LLM; Workday unmeasured ([The New Stack](https://r.jina.ai/https://thenewstack.io/workday-is-using-typesafes-jev-to-build-user-interfaces-on-the-fly/)) | small | Fallback by band |
| Keystroke-rate decisions | 57 to 85 rows/s ([judge-sheets](https://github.com/dabit3/jev-experiments/tree/main/judge-sheets)); cancel superseded, reject late, "canceled requests may still be billed" ([launcher](https://github.com/dabit3/jev-experiments/tree/main/jev-launcher)) | small | Cancel and reject-stale; debounce; count billed cancellations |
| Two signals that fail differently | Suggest only if top Choice is 0.3 or above and the Noul 0.5 or above ([shell-history](https://github.com/mrnugget/jev-shell-history)) | unmeasured | Conjunctive Choice-plus-exists gates |
| Voice turn end | Fire at 0.85 after 250 ms; delay 351 vs 1,000 ms; fired on 8/9 turns ([voice-turn](https://github.com/dabit3/jev-experiments/tree/main/jev-voice-turn)) | small | Hysteresis bands |
| Speculative branches in a home agent | +97 tokens vs ~250 ms per round trip; 0.15 top-two margin; risky actions always confirmed ([HA agent](https://github.com/the-sof/home-assistant-typesafe-conversation-agent)) | unmeasured | Margin on the top two; risky-action floor |
| Per-event streaming moderation | 300 msg/s at 122 ms p50; at 400 msg/s, 2,351 429s and 12.6% shed ([firehose](https://github.com/dabit3/jev-experiments/tree/main/jev-firehose)) | measured | Load shedding with labels |
| Micro-batching events | 8 events per request = 8x throughput; Jev P/R 100% vs regex 11%/26% on synthetic logs ([log-sentinel](https://github.com/dabit3/jev-experiments/tree/main/log-sentinel)) | measured, synthetic | Use only where packing has been calibrated |
| Event bus | One request per event; "Thresholds are policy, not model"; a ledger failure stops the run ([jevbus](https://github.com/zkjoie/jevbus)) | unmeasured | Halt on ledger-write failure |
| Change-triggered re-ask | Re-ask after a 0.02% price move or 10 s; scene-fingerprint reuse ([trading](https://github.com/rthomas24/jev-realtime-trading); [drone](https://github.com/RomanSlack/jev-drone)) | unmeasured | Fingerprint cache key with re-ask triggers |
| Image sensor loop | Doorbell 23/23 people vs 14/23 before, ~200 ms; no code ([madewithjev](https://madewithjev.com/builds/doorbell-cam-jev-box)) | anecdotal | Presence Noul, then Box, then describer |
| Hosted vs colocated latency | 24 ms only on a self-served open model; laptop tunnel ~330 ms ([Hao AI Lab](https://haoailab.com/blogs/mcjev/)) | measured | Plan on 100 ms-class hosted loops |

## Calibration is per customer, bounds beat point estimates, and nobody joins probability to outcome

### Raw probabilities rank well but are miscalibrated per task

Six independent groups agree: hosted Jev's probabilities rank cases well, but they are not calibrated against any particular user's data.

- **Recalibration works, and its learning curve sizes the label budget.** AnthusAI's 8,801-item sentiment study took Noul expected calibration error (ECE) from 0.117 to 0.052 with Platt scaling and to **0.008 with isotonic regression**, with AUC unchanged. On the learning curve, Platt and isotonic scored 0.100 and 0.089 at 20 labels, 0.063 and 0.048 at 100, and 0.057 and 0.038 at 200 ([AnthusAI](https://github.com/AnthusAI/Jev-Calibration)).
- **Base rate is the dominant mechanism.** An insult Noul had ECE 0.157 at 19.2% positives and 0.209 at 2.9%, and Platt fixed both (0.023 and 0.007). Rewording moved the mean predicted probability anywhere from 0.26 to 0.57 while AUC stayed between 0.88 and 0.91 ([Adilmp](https://github.com/Adilmp/does-jev-confidence-mean-anything)).
- **The structural reason.** In "Jev can't be calibrated", Alex Molas points out that one set of probabilities serves every customer ([alexmolas.com](https://www.alexmolas.com/2026/09/23/jev-cant-be-calibrated.html)).
- **Jev cannot restate probabilities.** A hidden fair die drew a stated 82.9% on face 1 in all 400 trials. A document stating a 30% shortage risk came back as 5.3% ([Jev Does Not Play Dice](https://kantahayashiai.github.io/posts/jev-does-not-play-dice/)).
- **Synthetic tasks mislead.** Deterministic synthetic tasks look calibrated (ECE 0.041 on 180 generated Nouls), which makes them the wrong calibration set ([Nautilus](https://github.com/chunxiaoxx/nautilus-compass/blob/main/docs/wall/GENESIS_HOSTED_JEV_CALIBRATION.md)).

Engine consequences:
- a recalibration layer per question, criteria version, backend and model version;
- Platt below roughly 100 to 200 labels, isotonic above;
- a live positive-rate monitor;
- any criteria edit or model-alias move invalidates the calibration map.

### Threshold-fitting tools converged on held-out acceptance and bounds

- **DSPy's ReAnchor** is now fully specified in source. Candidates are midpoints between observed probabilities, at most 40. Choice and Score fields are fitted by coordinate descent. A setting is accepted only if it beats the starting setting on the full training set and on a deterministic five-fold held-out sum; otherwise the original is restored ([calibrate.py](https://raw.githubusercontent.com/stanfordnlp/dspy/main/dspy/teleprompt/reanchor/calibrate.py)). Its author reported gains from 0.692 to 0.749 and from 0.813 to 0.874, while a downstream reimplementation found "no fitted setting beat the hard-coded one" ([PR #10475](https://github.com/stanfordnlp/dspy/pull/10475)).
- **jev-eval** refuses to fit below 50 rows and calls anything under 200 provisional. It reported a 0.82 gate auto-handling 58.7% of items at 94.6% out-of-bag accuracy, with a 95% range of 0.76 to 0.88 for the gate itself ([jev-eval](https://raw.githubusercontent.com/CMaintz/jev-eval/main/README.md)).
- **Jevstiller's** local student uses a Clopper-Pearson confidence bound with Learn-Then-Test (a method that tests candidate thresholds in a fixed order and keeps the last one whose bound passes). It stayed within a 2% disagreement budget at 74.9% coverage on Banking77. The point-estimate rule went over budget in 9 of 20 splits ([Jevstiller](https://jevstiller.pages.dev/posts/the-guarantee/)).
- **jev-utility** derives the cutoff as C_fp / (C_fp + C_fn). It labels the result "optimal under stated costs, assuming calibration" until a calibration report passes ([jev-utility](https://github.com/gbesse/jev-utility)).
- **Conformal abstention** exists only on a small local clone, which answered 55% of items at a 10% error budget ([poorjev](https://github.com/rupeshpoojary9/poorjev)).
- **Coverage at an error budget** has become the reporting convention. One benchmark reported coverage of 0.830 on AG News, 0.860 on Banking77 and 0.000 on an emotion set, where Jev gave exactly zero probability to the true label on 16% of items ([jev-benchmarks](https://github.com/AbdelStark/jev-benchmarks)).
- **Point estimates overshoot.** Vals' earlier 1% error budget, set with a point estimate, realised 1.6% ([Vals AI](https://www.vals.ai/blogs/independent-evaluation-of-jev)).

So `fitThreshold` should offer a bound-based mode, report the interval around the fitted bar, and publish coverage at a declared error budget as its headline number.

### Label-free correction failed; drift is small but real

Label-free correction failed every time it was measured:
- EM prior-shift correction on hosted Jev lowered F1 to between 0.571 and 0.690 ([arXiv 2609.29429](https://arxiv.org/html/2609.29429));
- prior correction on an open clone made option-order flips worse ([jev-position-test](https://github.com/imaddde867/jev-position-test));
- AnyJev's label-prior division helped balanced tasks and hurt skewed ones ([AnyJev](https://github.com/MorrisZJ/AnyJev)).

Drift is real but small:
- 20 multiple-choice answers changed between a 19 September run and an October snapshot ([redreamality](https://redreamality.com/blog/open-decision-models-2026-survey-benchmarks/));
- hosted runs varied on up to 3.5% of answers at temperature zero ([privatemode](https://www.privatemode.ai/blog/system-one-from-glm-flash));
- criteria tuned for one backend raised Laya by 17.83 points while lowering Jev by 3.67 ([Red Hat](https://developers.redhat.com/articles/2026/10/02/benchmarking-ai-decision-models-against-traditional-guardrails)).

### Ledgers, blind audits and control arms

Observability vendors stop at "probability in metadata". Braintrust and Arize log per-option probabilities, and LiteLLM exposes both wire formats with a vendor-neutral `refusal` entry. None of them joins a later outcome to the probability ([Braintrust](https://www.braintrust.dev/blog/evaluate-agent-responses-with-jev); [LiteLLM](https://docs.litellm.ai/docs/decisions)). The real ledger work is in small open tools:

- **toolgate** blind-labelled 455 of 1,369 decisions. The gate and the reviewer disagreed 268 times in the cautious direction and 12 times in the permissive one. It brought its ask rate down from 20.9% to 13.8% across three windows, toward a 1.0 release criterion of three windows under 10% with zero permissive misses ([toolgate](https://github.com/RiskAverseTech/toolgate)).
- **wow-overseer** writes an outcome row for every disagreement between an active backend and a comparison backend, plus a 10% sample of agreements, with an `acted` column naming which mechanism decided. The explicit aim is the control arm its scorecard lacked after Jev "acted for weeks with no evidence of harm". The trigger was Jev returning HTTP 402 on every call from 10 October ([wow-overseer #821](https://github.com/quadseven/wow-overseer/issues/821)).
- **jev-trust** signs its append-only log with ed25519, and asks each question in both polarities in one call ([jev-trust](https://github.com/chunxiaoxx/nautilus-compass/tree/main/sdks/jev-trust)).
- **Arcjet** found that including its own prior verdicts in the state created a feedback loop, and fixed it by excluding them ([Arcjet](https://arcjet.com/blog/how-we-built-ai-agent-behavior-drift-analysis-with-cloudflare-clef)).

The engine's ledger therefore needs:
- an `acted-by` mechanism column;
- a control-arm sample of agreements;
- a signable digest chain;
- a hard separation between model-visible state and the engine's own outputs.

### Reliability constructions: code exists, gains are unproven

Every reliability construction now has code, except lead-by-k on hosted Jev:
- **flock** merged cross-model voting (`majority`, `unanimous`, `mean`) on the rule that "a refusal is no vote", routing disagreement to an UNSURE inbox. It published no accuracy numbers ([flock #530](https://github.com/whiteducksoftware/flock/issues/530)).
- **TetraJev** routes on unanimity across four open-model readings. It matched or trailed Jev at lower coverage: 85.9% against Jev's 92.4% on one suite, at 75.0% coverage ([TetraJev](https://github.com/FeiLiuEM/tetrajev)).
- **AnyJev's rotation budget** stops rotating options once agreement with the full-cycle answer is reached. On an open model it averaged 7.2 of 18 rotations at a 1% target ([AnyJev](https://github.com/MorrisZJ/AnyJev)).

Cascades remain correlated:
- a cheap-first rubric cascade added at most about 1.5 points ([redreamality](https://redreamality.com/blog/open-decision-models-2026-survey-benchmarks/));
- LLM fallbacks repeated over 85% of Jev's most confident errors, capping cascade gains at 2.7 points ([arXiv 2609.29769](https://arxiv.org/abs/2609.29769));
- a knowledge-graph pipeline that escalated to Haiku scored F1 0.400, against 0.404 for the Jev gate alone ([Lyon](https://lyonwj.com/blog/typesafe-jev-knowledge-graph-extraction));
- escalating Japanese routing to Qwen3.6 did not beat Jev alone ([orca forge](https://dev.to/orca_forge/jev-vs-local-models-where-japanese-intent-routing-stands-after-1000-utterances-50j2)).

Measured disagreement between backends is the precondition for any of this. On one 250-item test, Clef scored 78.6% against Jev's 79.8% with different misses, at about 5.2x the cost and a 1.9 s median against 350 ms ([HN](https://hn.algolia.com/api/v1/items/49923692)).

### Rivals, open weights, distillation and cost

The rivals matter mainly as decorrelated voters and as local tiers. On independent suites:

- **Accuracy.** The 27B open deciders now match or beat hosted Jev. Perplexity's decider and vLLM's d3 reached 99.4% against Jev's 97.6% on Akita's AI-generated cases ([Akita](https://akitaonrails.com/en/2026/10/10/which-jev-like-ai-decision-classifier-model-is-best/)).
- **Transfer to new domains.** Clef's public Decision Index score of 61.7 collapses to 53.1 once private new-domain tasks count, against a three-point gap for Jev. The index also counts abstention as wrong ([redreamality](https://redreamality.com/blog/open-decision-models-2026-survey-benchmarks/); [Decision Index](https://huggingface.co/spaces/multimodalart/jev-decision-index/raw/main/README.md)).
- **Calibration.** Arize found Jev's calibration error the lowest of eight models, at 0.023 ([Arize](https://arize.com/blog/decision-model-benchmark/)).
- **Production search.** Parallel ranked Jev first on average over four production search tasks, while its own fine-tuned reranker beat every decision model ([Parallel](https://parallel.ai/blog/are-all-system-one-models-created-equal)).
- **Guardrails.** Red Hat "did not find that decision models produced faster, cheaper, or higher-quality answers" than LLM judges on guardrail tasks ([Red Hat](https://developers.redhat.com/articles/2026/10/02/benchmarking-ai-decision-models-against-traditional-guardrails)).

Backend limits differ in ways policies must know:
- Ollama's Clef endpoint allows 26 options and breaks ties by option order ([Ollama](https://ollama.com/library/clef));
- Perplexity's decider rejects inputs over 8,192 tokens ([pplx card](https://huggingface.co/perplexity-ai/pplx-decider-v1.1-27b));
- hosted Clef-flash cut its context window to 24k tokens ([Cloudflare](https://blog.cloudflare.com/clef-faster-cheaper-multimodal/));
- quantising Clef-flash's backbone to Q5_K_M kept 99.8% top-choice agreement, while the decision head must stay BF16 ([home-k8s #142](https://github.com/dbirks/home-k8s/issues/142)).

**Distillation is happening openly.** AutoTrust's JEV-9B was trained on 498,010 Jev-labelled rows, reaching KL 0.019 to its teacher ([AutoTrust](https://huggingface.co/autotrust/JEV-9B)), despite the Master Customer Agreement's ban on using Output to train an imitating model ([MCA](https://typesafe.ai/legal/mca)). Separately, a Strands Decider domain fine-tune went from 0.493 to 0.979 strict accuracy (0.545 to 0.864 on held-out chapters). It used half-weight duplicate rows to teach abstention on ambiguous cases ([cfried123 PR #1](https://github.com/cfried123/strands-decider/pull/1)).

**Cost.** A content-addressed cache that never caches errors or partial responses took a repeated campaign to zero calls, with mean answer drift of 0.0107 ([gotorque PR #20](https://github.com/asaf-shitrit/gotorque/pull/20)). Nobody has shipped request coalescing on a shared state digest.

| Pattern | Evidence | Grade | Engine implication |
| --- | --- | --- | --- |
| ReAnchor acceptance rule | Observed-midpoint candidates; five-fold strict improvement; 0.692 to 0.749, 0.813 to 0.874; a reimplementation found no win ([calibrate.py](https://raw.githubusercontent.com/stanfordnlp/dspy/main/dspy/teleprompt/reanchor/calibrate.py); [PR #10475](https://github.com/stanfordnlp/dspy/pull/10475)) | measured by author; one negative | Reuse the acceptance rule on ledger fits, including Score cuts and Choice weights |
| Platt vs isotonic by label count | ECE: at n=20 0.100/0.089, at n=100 0.063/0.048, at full set 0.052/0.008 ([AnthusAI](https://github.com/AnthusAI/Jev-Calibration)) | measured | Switch method by n; refit per wording and version |
| Base rate drives miscalibration | ECE 0.157 at 19.2% positives, 0.209 at 2.9%; wording moved mean p 0.26 to 0.57 at constant AUC ([Adilmp](https://github.com/Adilmp/does-jev-confidence-mean-anything)) | measured | Track the live positive rate; criteria edits invalidate maps |
| Probability restatement | Fair die 82.9% on face 1; a stated 30% risk returned 5.3% ([die test](https://kantahayashiai.github.io/posts/jev-does-not-play-dice/)) | measured | Never let the oracle restate or forecast probabilities |
| Synthetic calibration sets | ECE 0.041 on 180 generated Nouls ([Nautilus](https://github.com/chunxiaoxx/nautilus-compass/blob/main/docs/wall/GENESIS_HOSTED_JEV_CALIBRATION.md)) | measured, synthetic | Calibrate only on real traffic |
| Cost-derived cutoff, gated on calibration | p* = C_fp/(C_fp+C_fn), "assuming calibration" ([jev-utility](https://github.com/gbesse/jev-utility)) | unmeasured | Apply cost cutoffs only after recalibration passes |
| Half-split, lower bound, CI lock | Under ~100 rows "unlikely to hold"; `check --strict` exits 1 ([jevcal](https://github.com/abhixhek/jevcal)) | unmeasured on Jev | A `check` command in CI |
| Bootstrap gate with interval | Fewer than 50 rows refused; gate 0.82, range 0.76 to 0.88 ([jev-eval](https://raw.githubusercontent.com/CMaintz/jev-eval/main/README.md)) | measured | Report the interval of every fitted bar |
| Learn-Then-Test bound | Point-estimate rule over budget in 9/20 splits; bound held ([Jevstiller](https://jevstiller.pages.dev/posts/the-guarantee/)) | measured | Bound-based threshold fitting |
| Conformal abstention | Local clone only: 55% answered at a 10% budget ([poorjev](https://github.com/rupeshpoojary9/poorjev)) | small | Conformal sets as an option |
| Coverage at an error budget | AG News 0.830, Banking77 0.860, emotion 0.000; true label at exactly zero probability on 16% ([jev-benchmarks](https://github.com/AbdelStark/jev-benchmarks)) | measured | The headline metric; clamp zeros in log-odds |
| Label-free prior correction | F1 down to 0.571 to 0.690 ([arXiv 2609.29429](https://arxiv.org/html/2609.29429)) | negative | Do not build |
| Drift across time and backends | 20 answers changed in a month ([redreamality](https://redreamality.com/blog/open-decision-models-2026-survey-benchmarks/)); up to 3.5% run-to-run ([privatemode](https://www.privatemode.ai/blog/system-one-from-glm-flash)); +17.83 Laya vs -3.67 Jev ([Red Hat](https://developers.redhat.com/articles/2026/10/02/benchmarking-ai-decision-models-against-traditional-guardrails)) | measured | Version criteria per backend |
| Probability in observability metadata | No vendor joins outcomes ([Braintrust](https://www.braintrust.dev/blog/evaluate-agent-responses-with-jev); [Arize](https://arize.com/blog/decision-model-benchmark/)) | n/a | Own the ledger; export spans |
| Signed and hash-chained ledgers | ed25519 log plus both-polarity asks ([jev-trust](https://github.com/chunxiaoxx/nautilus-compass/tree/main/sdks/jev-trust)); hash chain ([Edward](https://github.com/VeridicalTech/Edward)) | unmeasured | Content-addressed, signable records |
| Blind audit with release criterion | 455/1,369 blind-labelled; ask rate 20.9% to 13.8% ([toolgate](https://github.com/RiskAverseTech/toolgate)) | measured | Release criterion stated as an audit-window rule |
| Control arm across backends | Disagreement rows plus a 10% agreement sample; `acted` column ([wow-overseer](https://github.com/quadseven/wow-overseer/issues/821)) | unmeasured | An `actedBy` column and agreement sampling |
| Shadow-to-live state machine | 24 h shadow; 0.99 rolling agreement; 2% check share; novelty gate ([stuntd](https://github.com/bladedevoff/stuntd)) | unmeasured outcomes | Guarded rollout for thresholds, criteria and backends |
| Cross-model voting | Majority, unanimous or mean; "a refusal is no vote" ([flock](https://github.com/whiteducksoftware/flock/issues/530)) | unmeasured | Explicit refusal semantics in pooling |
| Unanimity routing | 85.9% vs Jev 92.4% at 75.0% coverage ([TetraJev](https://github.com/FeiLiuEM/tetrajev)) | measured | Unanimity trades coverage for little gain |
| Rotation budget (lead-by-k) | 7.2 of 18 rotations at a 1% target; flips 0.230 to 0.073 on a clone ([AnyJev](https://github.com/MorrisZJ/AnyJev)) | measured, clone | Early stopping over transforms, not repeats |
| Feedback-loop hygiene | Own prior verdicts in state caused a loop ([Arcjet](https://arcjet.com/blog/how-we-built-ai-agent-behavior-drift-analysis-with-cloudflare-clef)); reviewers cannot alter arguments ([OpenRouter cookbook](https://openrouter.ai/docs/cookbook/building-agents/gate-tool-calls-with-jev)) | anecdotal | Separate model-visible state from engine outputs |
| Correlated cascades | At most ~1.5 points ([redreamality](https://redreamality.com/blog/open-decision-models-2026-survey-benchmarks/)); at most 2.7 points, over 85% repeated errors ([arXiv 2609.29769](https://arxiv.org/abs/2609.29769)) | measured, negative | No default LLM escalation |
| Leaderboards | Abstention counted wrong; Clef 61.7 public vs 53.1 overall ([Decision Index](https://huggingface.co/spaces/multimodalart/jev-decision-index/raw/main/README.md); [redreamality](https://redreamality.com/blog/open-decision-models-2026-survey-benchmarks/)) | measured | Run your own coverage-at-budget evaluation |
| Rival accuracy and calibration | 99.4% vs 97.6% ([Akita](https://akitaonrails.com/en/2026/10/10/which-jev-like-ai-decision-classifier-model-is-best/)); Jev calibration error 0.023, best of 8 ([Arize](https://arize.com/blog/decision-model-benchmark/)); fine-tuned reranker beat all ([Parallel](https://parallel.ai/blog/are-all-system-one-models-created-equal)) | measured | Calibration and limits recorded per backend |
| Open-weight serving | 26-option cap, ties broken by order ([Ollama](https://ollama.com/library/clef)); Q5 99.8% agreement, head stays BF16 ([home-k8s](https://github.com/dbirks/home-k8s/issues/142)) | measured | Replay the calibration set on any precision change |
| Distillation from Jev | 498,010 rows; KL 0.019 measures closeness to the teacher, not truth ([AutoTrust](https://huggingface.co/autotrust/JEV-9B); [MCA](https://typesafe.ai/legal/mca)) | legal risk | Train only on human outcomes or Apache-licensed teachers |
| Domain fine-tune of an open decider | 0.493 to 0.979 (0.545 to 0.864 held out); half-weight rows teach abstention ([PR #1](https://github.com/cfried123/strands-decider/pull/1)) | measured, synthetic | Export reviewer disagreements as half-weight rows |
| Criteria optimisation with a held-out gate | Prompt tuning +1.0 AP for Jev vs +13.4 for GLiNER ([Parallel](https://parallel.ai/blog/are-all-system-one-models-created-equal)); `optimize` keeps a rewrite only if held-out coverage rises ([jevcal](https://github.com/abhixhek/jevcal)) | measured | Criteria as versioned parameters with rollout |
| Content-addressed cache | Zero calls on repeat; mean drift 0.0107; never cache errors ([gotorque](https://github.com/asaf-shitrit/gotorque/pull/20)); redact before hashing ([jevcache](https://jevcache.sh/)) | measured | Key on model, criteria, option order and packing |
| Spend and rate governors | 80% of 960 rpm, $0.20 per day ([decision-gate](https://github.com/zachlandes/decision-gate)); 17/126 calls succeeded on one day ([jev-ci-triage](https://github.com/criguex/jev-ci-triage)) | measured | 402 and 429 treated as availability events; a governor shared across processes |

## Outside agents, attribute judgment wins; severity, forecasting and morality lose

### Screening and entity resolution are the best-evidenced domains

**Systematic-review screening.** A 28-page preprint ranked 168,969 records, one question per record in ten-record batches ([medRxiv](https://www.medrxiv.org/content/10.64898/2026.10.09.26365173v1.full)). It reached:
- **mean AUC 0.966 on 23 held-out reviews, against 0.831 for bge-base embeddings**, and higher in all 23;
- WSS@95 (the share of screening work saved at 95% recall) of 0.806 for a Jev-plus-SVM hybrid, against 0.659 for ASReview;
- at least 95% recall in all 23 held-out reviews at a fixed threshold of 0.07, reading 58.9% of records, for $0.020 per 1,000 records.

Its probabilities were badly miscalibrated, though: observed over expected was 0.13. The author concludes that "stopping safely still required screening decisions".

**Entity resolution** is the most replicated domain:
- **jlink's** blocked pairwise Nouls beat the best string baseline on four of five datasets: DBLP-ACM 0.996 against 0.975, and Abt-Buy 0.92 against 0.86. It lost on typo-heavy FEBRL4, 0.96 against 0.998. Pairs scored above 0.8 were true matches 95 to 98% of the time, but the 0.5 to 0.8 band only 39% ([jlink](https://github.com/keltokhy/jlink)).
- **Iozzo's identity resolution** reached F1 0.948 against 0.911 for Sonnet 5, and 0.918 against 0.702 for Fellegi-Sunter on a messy lab dataset, at $0.62 against $28.86 per 1,000 accounts. Flips across runs concentrated at 0.5 ([Iozzo](https://vincenzoiozzo.com/blog/jev-identity-resolution)).
- **Lyon's "soft-type clones"** copy each mention into every type block that holds at least 25% of its probability mass, so blocking by type stops splitting true duplicates. That took knowledge-graph resolution from B-cubed F1 0.946 to 1.000 on a small synthetic set ([Lyon](https://lyonwj.com/blog/typesafe-jev-knowledge-graph-extraction)).

### In search, the value is deciding what the LLM never sees

- **Relevance filtering.** A relevance filter raised nDCG@10 from 0.833 to 0.975 while discarding 92% of candidates and keeping all 97 labelled positives ([hotchpotch](https://huggingface.co/blog/hotchpotch/introducing-jev-reranker)).
- **Production memory selection.** Unblocked's memory selector, one Noul per note with 20 notes per request, was measured on 292 production questions ([Unblocked](https://getunblocked.com/blog/jev-in-production-vs-cross-encoder/)). Precision rose from 34.8% to 46.4%, recall from 63.8% to 77.6%, and correct silence (answering nothing when nothing is relevant) from 48.4% to 59.4%. Cost was slightly lower; median latency was 0.35 s against 0.20 s. Scoring each pair in isolation lost 0.033 nDCG@5.
- **Abstaining page picker.** A voice receptionist's page picker handed over a wrong page 3% of the time, against 33% for embeddings. It correctly said "not on the website" 38 of 40 times, against 9 ([Sayora](https://sayora.ai/many-hands/jev-vs-embeddings/)).

In trust and safety, the phishing battery above is the template. Red Hat found Jev at 86.35% on injection and 86.20% on content safety, within a point of a 35B judge and of a 200M DeBERTa that runs in 54 ms ([Red Hat](https://developers.redhat.com/articles/2026/10/02/benchmarking-ai-decision-models-against-traditional-guardrails)).

### Operations and commerce

Operations produced the most new builds, and one shared contract:
- Jev classifies, but never reruns, masks, merges or pages on its own;
- rules run first;
- errors fall to "unknown" or "run everything";
- nothing becomes a required check before a soak period.

Measured results:
- **CI triage.** jev-ci-triage resolved 5 of 6 seeded failures, deferring 1 correctly and getting none wrong. But the same case scored 0.62 to 0.91 across five calls, and only 17 of 126 HTTP calls succeeded on its measurement day, mostly 429s ([jev-ci-triage](https://github.com/criguex/jev-ci-triage)).
- **SRE diagnosis.** In SREGym, Jev picked the origin component, cause category and key evidence from a programmatic collector. It passed 76.2% of 105 attempts, against 77.8% for GPT-5.6 Sol, at about 7x the speed and 200x lower cost. It failed exactly when the collector never surfaced the evidence ([SREGym](https://www.sregym.com/blog/jev-driven-sre-diagnosis)).
- **Voice turn-end detection.** Veris replaced a 0.8 s silence timer with turn-end classification. In a controlled 300-task comparison, caller interruptions fell from 52% to 11% (p < 1e-7). But tasks passed rose only from 50 to 53, and median reply time doubled to 4.6 s: "calls got calmer, but no more correct" ([Veris](https://veris.ai/blog/jev-turn-detection)).
- **Severity scoring is the weak spot.** Jev ranked 7th of 8 on CVSS scoring, with a mean signed error of +3.30, and promoted 20.9% of sub-critical findings to critical ([Casco](https://casco.com/blog/jev-cvss-benchmark)). Cribl's 28-class logtype Choice made 2 to 3x more errors than a purpose-built classifier, mostly by dumping known types into "other" ([Cribl](https://cribl.io/blog/what-typesafes-jev-means-for-telemetry/)).

In commerce:
- **Invoice coding.** Invoice GL coding over 244 accounts tied Sonnet 5 within noise on individual lines. Gated at confidence 0.8, it **auto-applied 71% of whole bills with zero errors**; at 0.5, accuracy was 96.5%. Its biggest failure was health-insurance lines that need an employee identity not present on the invoice: right 5% of the time ([Looming](https://www.looming.tech/post/typesafe-jev-invoice-classification)).
- **Revenue accounting.** ASC 606 clause review reached 94% with the rule written into the question, and 20 of 20 with comparisons computed in code. Answers between 0.5 and 0.7 were right only about half the time ([finance-decision-evals](https://github.com/vicwlau/finance-decision-evals)).

### People-facing and regulated uses: the engine must supply what the vendor does not

- **Policy gap.** TypeSafe's Acceptable Use Policy has no clause on consequential decisions about people, while its use-case map markets recruiting and underwriting ([AUP](https://typesafe.ai/legal/acceptable-use-policy); [use-case map](https://docs.typesafe.ai/concepts/use-case-map.md)).
- **Builds at both extremes.** One resume tool generates rejection notices and claims "Zero" compliance risk ([jev-resume-disqualifier](https://github.com/AiPersonacademy/jev-resume-disqualifier)). By contrast, a clinical-note conflict checker refuses protected health information because no BAA (the HIPAA business associate agreement) exists, and never blocks a clinician from signing ([medplum-provider-jev](https://github.com/vintasoftware/medplum-provider-jev)).
- **Accessibility.** Accessibility-tree repair reached 85.1%, against 87.8% for Claude Opus 5.5 and 73.9% for rules, at $0.0056 against $1.30 per page ([jev-accessibility-tree](https://github.com/vandenbogart/jev-accessibility-tree)).

Three measured cautions bound the domain map:
- the order of the track descriptions alone flipped Jev's trolley-problem choice in 370 of 2,620 pairs ([Landes](https://zachlandes.com/trolley-problem/));
- news after the model's knowledge boundary drew 51% accuracy at 82% confidence ([Synthpop](https://www.synthpop.ai/resources/does-a-decision-model-know-when-it-is-guessing-post-1));
- verdicts on Reddit's "Am I the Asshole?" posts barely beat always answering "not the asshole" (75.4% against 74.0%), until a logistic adjustment fitted on 300 older posts reached 78.6% ([jev-aita](https://github.com/dchristopoulos/jev-aita)).

Jev reads. It should not forecast, restate probabilities, or rule on people.

| Domain and pattern | Evidence | Grade | Engine implication |
| --- | --- | --- | --- |
| Systematic-review screening (rank, then stop on labels) | AUC 0.966 vs 0.831; WSS@95 0.806 vs 0.659; 95% recall in 23/23 at 58.9% read; O/E 0.13 ([medRxiv](https://www.medrxiv.org/content/10.64898/2026.10.09.26365173v1.full)) | measured, retrospective | Jev prioritises; a labelled statistical stop is the floor |
| Criterion-per-Noul screening tool | include at 0.7 or above, exclude at 0.3 or below; first failing criterion recorded; no benchmark ([jev-screen](https://github.com/gbesse/jev-screen)) | unmeasured | Min pooling over inclusion criteria with a reason |
| Pairwise entity resolution with blocking | Four of five sets won; FEBRL4 lost; 0.5 to 0.8 band only 39% true ([jlink](https://github.com/keltokhy/jlink)) | measured | Blocking, an audit band, anti-chaining clustering |
| Identity resolution | F1 0.948 vs Sonnet 0.911; 0.918 vs Fellegi-Sunter 0.702; hybrid second opinion mixed ([Iozzo](https://vincenzoiozzo.com/blog/jev-identity-resolution)) | measured | Fit per dataset; flips cluster at 0.5 |
| Soft-type clones for KG dedup | B-cubed 0.946 to 1.000; Haiku escalation 0.400 < 0.404 ([Lyon](https://lyonwj.com/blog/typesafe-jev-knowledge-graph-extraction)) | small, synthetic | Enumerate every label holding at least 25% mass before blocking |
| Three-level link Score for catalogue alignment | 450 pairs, 11.1% to a curator queue; no accuracy reported ([entity alignment](https://docs.typesafe.ai/cookbooks/entity_alignment.md)) | official, unmeasured | A middle level when false merges cost more than misses |
| PII detection | Record F1 96.5%, span 98.9% on synthetic data; packing halves accuracy ([jev-pii-test](https://github.com/phubbard/jev-pii-test)) | small, synthetic | One record per request |
| Columnar and SQL operators | 464 states/s through an Arrow proxy, still one call per state ([Columnar](https://columnar.tech/blog/what-if-jev-spoke-arrow/)); JSON Schema compiled to questions ([Kiln](https://github.com/Kiln-AI/jev_jsonschema)) | unmeasured | A schema-to-questions compiler is cheap to add |
| Jev labels a tiny student, with a bound | 74.9% local coverage at 1.15% disagreement; recovered from silent teacher drift in 49 min ([Jevstiller](https://jevstiller.pages.dev/posts/the-guarantee/)) | measured | Bounds agreement, not truth; MCA risk with Jev as teacher |
| Phishing signal battery plus combiner | 62.6% to 95.1%; one signal alone AUROC 0.96; regex 91.8% ([bench](https://github.com/anisselbd/jev-phishing-bench)) | measured, LLM-generated data | Questions are features; fit the combiner |
| Relevance filtering | nDCG@10 0.833 to 0.975 with 92% removed, all positives kept ([hotchpotch](https://huggingface.co/blog/hotchpotch/introducing-jev-reranker)) | measured | Filter before generation |
| Production memory selection | Precision 34.8% to 46.4%, recall 63.8% to 77.6%; per-pair scoring -0.033 ([Unblocked](https://getunblocked.com/blog/jev-in-production-vs-cross-encoder/)) | measured, production | Fan out 20 per request; match the incumbent's admission rate |
| Abstaining page picker | Wrong page 3% vs 33%; "not on site" 38/40 vs 9/40; a literal-reading miss at 96% ([Sayora](https://sayora.ai/many-hands/jev-vs-embeddings/)) | measured | Log every "none" as a content gap |
| Semantic HTTP routing | Routes as Nouls; "should not be used for authentication or authorization" ([hono-jev-router](https://github.com/yusukebe/hono-jev-router)) | unmeasured | The sender controls the state; never authorise on it |
| Guardrail moderation | 86.35% / 86.20%, within a point of a 54 ms DeBERTa ([Red Hat](https://developers.redhat.com/articles/2026/10/02/benchmarking-ai-decision-models-against-traditional-guardrails)) | measured, negative for advantage | The edge is operational, not accuracy |
| CI failure triage, rules first | 5/6 right, 1 deferred, 0 wrong; repeat confidence 0.62 to 0.91 ([jev-ci-triage](https://github.com/criguex/jev-ci-triage)) | small | A wide band; "never reruns, skips, or masks" |
| SRE root-cause component selection | 76.2% vs 77.8% at ~200x lower cost ([SREGym](https://www.sregym.com/blog/jev-driven-sre-diagnosis)) | measured | Pick from collector output; fails when evidence is missing |
| On-call decision swaps | 39.1% lower cost; p90 4,752 to 508 ms; no accuracy reported ([Polylane](https://polylane.com/blog/we-swapped-our-llms-for-jev/)) | unmeasured accuracy | Report accuracy beside cost |
| CVSS severity | MAE 3.40, 7th of 8; +3.30 bias ([Casco](https://casco.com/blog/jev-cvss-benchmark)) | negative | Decompose severity into impact Choices; compute the score in code |
| Large-taxonomy logtype | 2 to 3x more errors, dumped to "other" ([Cribl](https://cribl.io/blog/what-typesafes-jev-means-for-telemetry/)) | negative | Measure the escape option's share |
| Alert triage with policy floors | Runbook tier Choice; nonprod never pages; Jev unreachable means L3 (the top escalation tier); no results ([AWS Builder](https://builder.aws.com/content/3JpdH4acDKLD3Mta05sZ1xQOpVt/jev-as-an-alert-triage-typed-decisions-for-opensearch-on-call-with-bedrock-and-agentcore)) | unmeasured | Fail safe to the most cautious tier |
| SCA prioritisation design | Seven typed questions; KEV listing as a deterministic floor (the design lets the model soften it, which monotone floors forbid); steering-text canary ([Yazdani](https://asecurityengineer.com/posts/jev-sca-prioritization/)) | proposed | A canary Noul for text aimed at automated reviewers |
| Convention lint with tested margins | A rule ships only at margin 0.5 or above; vague rules scored 0.97 before and after a fix ([a7ul](https://blog.a7ul.com/agents-code-your-way.html)) | small | A per-rule margin test before enforce |
| Test selection from a diff | 3/110 selected for $0.001; 8 vs 7 on repeat; "never a correctness gate" ([jev-test-filter](https://github.com/mizchi/jev-test-filter)) | small | Errors fall back to running everything |
| Voice turn detection | Interruptions 52% to 11%; tasks 50 to 53 of 300; reply 2.1 to 4.6 s ([Veris](https://veris.ai/blog/jev-turn-detection)) | measured, controlled | Measure the task outcome, not just the proxy |
| Invoice GL coding | 71% auto at 0.8 with zero errors; HMO lines 5% ([Looming](https://www.looming.tech/post/typesafe-jev-invoice-classification)) | measured | Coverage at an error budget is the product |
| Fraud ambiguous band | Code settles 0 and 3 to 4 flags; Jev cleared 10/28 ambiguous cases correctly, 0 wrong ([jev-fraud-shield](https://github.com/jonny5isalive5/jev-fraud-shield)) | small, synthetic | Consult the oracle only in the band |
| ASC 606 clause review | 94% with the rule written out; 0.5 to 0.7 right about half the time ([vicwlau](https://github.com/vicwlau/finance-decision-evals)) | small | Rules in the question; computed facts in state |
| Accessibility repair | 85.1% vs 87.8% (Opus) vs 73.9% (rules); $0.0056 vs $1.30 per page ([repo](https://github.com/vandenbogart/jev-accessibility-tree)) | measured | Structural rules in code |
| Quiz answering | 85 to 86/90; all errors multi-step arithmetic at low confidence ([QuizPilot](https://dev.to/jack9999/how-we-use-jev-to-answer-quiz-questions-a-90-question-benchmark-7ho)) | small | Low confidence flags arithmetic |
| Memory-worthiness before extraction | 75% lower cost, 38% fewer wrongly suggested updates ([elvex](https://www.elvex.com/blog/early-experimentation-using-jev-to-rethink-harness-ux)) | measured, internal | A cheap gate before an expensive LLM step |
| Engineering result triage | Asked to do arithmetic, confidence was 0.04 to 0.28, so the check moved to code; "one global confidence threshold is inadequate" ([jev-for-engineers](https://github.com/Foadsf/jev-for-engineers)) | small | Per-action-class thresholds |
| Clinical-note conflict detection | No PHI, no BAA, never blocks signing; no numbers ([medplum](https://github.com/vintasoftware/medplum-provider-jev)) | unmeasured | Advisory-only mode for regulated domains |
| Earlier-catalogued deployments | Claim verification 0.975 but last on LegalBench ([Vals](https://www.vals.ai/blogs/independent-evaluation-of-jev)); AG News 89% at 2,484 rows/s ([Composio](https://composio.dev/blog/typesafe-jev-guide-and-best-practical-usecases)); linter 6/7 defects ([Every](https://every.to/vibe-check/mini-vibe-check-typesafe-s-jev-judged-everything-i-ve-written-in-0-7-seconds)); screening parity at $0.092 vs $0.755 per 1,000 ([Jack & Jill](https://typesafe.ai/blog/jack-jill-jev-case-study)) | measured | Bounded classification over builder-designed answer sets |
| Moral and social judgment | Order flips in 370/2,620 ([trolley](https://zachlandes.com/trolley-problem/)); AITA 75.4% vs 74.0% base ([jev-aita](https://github.com/dchristopoulos/jev-aita)) | negative | `oneWayDoor`; never automate |
| Forecasting | Post-boundary news 51% at 82% confidence ([Synthpop](https://www.synthpop.ai/resources/does-a-decision-model-know-when-it-is-guessing-post-1)); "a thermometer, not an analyst" ([Vidovich](https://alexvidovich.com/papers/text-judge)) | negative | Read, never forecast |
| Hiring knockout with auto-rejection | "Zero" compliance risk claimed; no bias testing ([repo](https://github.com/AiPersonacademy/jev-resume-disqualifier)) | excluded for risk | Consequential decisions about people go to review at most |

## A dozen removals trace to one cause: questions broader than the evidence in state

The removals and narrowings fall into five groups, and each group teaches one engine rule.

1. **Broad questions without crisp evidence produced interruptions near the threshold**: rule files, "in scope?", "is this test useless?", generic Stop rules, and skill suggestions in a live loop. Engine rule: an activation bar per rule, enforced from shadow evidence.
2. **Generation-like jobs failed**: summarising a transcript, or treating a geometric path score as a verifier. Engine rule: the oracle selects and judges; it does not produce or verify its own artefacts.
3. **Deciding at every fork cost more than it saved** once a round trip took 300 to 400 ms. Engine rule: value-of-information suppression and leases.
4. **Escalation to a stronger LLM bought almost nothing**, because its errors were the same errors. Engine rule: a cascade only behind measured disagreement.
5. **Offline catch rates did not become live benefit.** Engine rule: shadow rows need outcomes, and promotion needs an outcome comparison.

A sixth, smaller group were not failures of Jev but of integration: state scoped to the wrong unit, escape options inside rankings, and a single backend that became unavailable.

| What was removed or narrowed | Who | Stated or measured reason | Engine lesson |
| --- | --- | --- | --- |
| Rule, scope, intent, done and proof gates cut from the defaults | jev-gates 0.9.0 ([repo](https://github.com/rashedInt32/jev-gates)) | "interrupted far more often than it caught"; in-scope edits "near its threshold"; intent gate +650 ms | Per-rule activation bar; ship only narrow gates by default |
| Jev handoff digest | hermes-jev-skills ([repo](https://github.com/kerpopule/hermes-jev-skills)) | 58.7% recall, below the plain transcript | Select, never summarise |
| Intent steer demoted to trace-only; relevance compaction turned off | pi-warden 0.76.0 and 0.78.0 ([repo](https://github.com/DevMortimer/pi-warden)) | Reasons not published | Demotion needs a trace-only mode, not just on or off |
| Keyword pre-screen; wording-only rule | jev-belay; limpet ([belay](https://github.com/valentynkit/jev-belay); [limpet](https://github.com/noplan-inc/limpet)) | Caught 41.7% of false dones; AUROC 0.50 | Pre-gates must test evidence, not wording |
| Scorer fine-tune | Edward ([repo](https://github.com/VeridicalTech/Edward)) | Abandoned under a preregistered protocol | Preregister acceptance criteria for learned refinements |
| Fitted calibration settings | openagents reimplementation of ReAnchor ([PR #10475](https://github.com/stanfordnlp/dspy/pull/10475)) | "no fitted setting beat the hard-coded one" | Strict-improvement acceptance keeps the incumbent |
| Skill router in Claude Code | Shimomoto ([dev.to](https://dev.to/shimo4228/is-there-any-point-to-this-removing-the-jev-plugins-i-added-to-claude-code-after-one-week-49eh)) | 28 of 539 picks used; agent text read as user text | Measure downstream uptake in shadow; scope state to the user |
| Decision at every fork; MCTS routing | JevLoop; Harness Router ([JevLoop](https://github.com/zjunlp/JevLoop); [harness-router](https://github.com/Protocol-Lattice/harness-router)) | Decisions took 79% of wall clock; more tokens and time on obvious choices | Value-of-information suppression and leases |
| Geometric path score as judge | r6i ([blog](https://blog.r6i.it/typesafe-jev-vs-agentic-loop.html)) | Rejected 1/50 vs 14 for the LLM judge; approved an out-of-taxonomy item at 0.65 | A path score is not a verifier |
| Proposal review before action | TypeSafeAI/jev-harness ([repo](https://github.com/TypeSafeAI/jev-harness)) | "no live recovery benefit"; "lost tool use on multi-step tasks" | Require a live outcome comparison before enforce |
| "None of these" option and "nothing relevant" level in rankings | Hindsight ([blog](https://hindsight.vectorize.io/blog/2026/09/24/adding-jev-reranker-what-we-learned)) | 35/200 queries emptied; gold retention 0.81 to 0.65 | Abstention as a separate Noul |
| Read gate judged against the parent's task | paseo ([PR #21](https://github.com/funkmastert/paseo/pull/21)) | 33% false skips, 52 of 58 from subagents | Build state from the acting unit |
| LLM second opinion or escalation | Lyon; orca forge; Iozzo ([Lyon](https://lyonwj.com/blog/typesafe-jev-knowledge-graph-extraction); [orca](https://dev.to/orca_forge/jev-vs-local-models-where-japanese-intent-routing-stands-after-1000-utterances-50j2); [Iozzo](https://vincenzoiozzo.com/blog/jev-identity-resolution)) | F1 0.400 < 0.404; no gain; helped one organisation only | Cascade only on measured, uncorrelated disagreement |
| Yes/no wake question | wakegate ([repo](https://github.com/shitianfang/wakegate)) | 16/21, replaced by a three-way Choice at 21/21 | Three outcomes with an unsure band |
| Direct steering | jev-grand-prix ([repo](https://github.com/enoyola/jev-grand-prix)) | DNF with 9 off-tracks | Discrete targets; code actuates |
| `mine_dirt` and `wait` menu options | teknium1 ([repo](https://github.com/teknium1/hermes-and-jev-play-minecraft)) | Chosen after the goal was met; `wait` chosen five times | Compute the menu per state in code |
| Broad "useless test" question | gc.ai ([blog](https://gc.ai/blog/what-we-learned-building-38-projects-with-jev-in-12-hours)) | AUC 0.54, rising to 0.72 with eight factual questions | Narrow factual decomposition |
| Model-only log compaction and per-line grep | jevkit ([repo](https://github.com/walidboulanouar/jev-agent-kit)) | Compaction kept 58% of relevant lines until error lines were pinned; grep recall 33% | Pin structural lines in code |
| Prompt-level injection defences | Check Point; Datadog ([Check Point](https://blog.checkpoint.com/ai-security/jev-is-not-a-language-model-but-it-breaks-like-one-prompt-injection-against-a-typed-decision-model/); [Datadog](https://securitylabs.datadoghq.com/articles/jev-as-a-judge-how-counterfeit-policy-steers-jev/)) | Noise; recall 82.9% to 3.88% | Controls outside the model |
| Long qualified questions; value-laden phrasings | Lindfors; backnotprop ([Lindfors](https://lindfors.no/blog/a-first-look-at-typesafes-jev/); [poker](https://backnotprop.com/blog/jev-poker/)) | Calibration error 0.040 to 0.116; value-laden wording pushed Jev toward bigger bets | Short, neutral criteria |
| A 30-message window in a gate | LangChain AutoMode critique ([Towards AI](https://towardsai.com/?p=53905)) | The user's request drops out around tool call 16; criteria overwritten; no retry | Pin the newest user message |
| Jev as the moderation backend | EmDash ([blog](https://emdashcms.com/blog/how-emdash-uses-clef-to-moderate-the-plugin-registry)) | Chose Clef because "Jev underperformed their baseline" | Choose the backend per task from your own ledger |
| Jev as the only backend | wow-overseer ([#821](https://github.com/quadseven/wow-overseer/issues/821)) | HTTP 402 on every call from 10 October | A second backend plus a control arm |
| An LLM classifier with JSON repair and retries (removed in Jev's favour) | Kilo Code ([PR 7223](https://github.com/Kilo-Org/cloud/pull/7223)) | Route-key accuracy 0.785 to 0.93; repair code deleted | Typed outputs remove whole failure classes |

## Eight P0 capabilities close the gap between the engine and what builders hand-roll

**Baseline.** The brief's engine already has:
- typed pick, rate and judge questions;
- act, review and refuse policies, and hard floors;
- ensembles with correlation correction, sequential sampling with lead-by-k, and cascades;
- a verify-then-commit chain runner;
- a ledger with per-question calibration and threshold fitting on unselected rows;
- blind audits and spend caps;
- four recipes: speculative fan-out, relevance batteries, map-reduce screening and chunk location.

The community's month validates every one of those primitives; no project found a pattern that needs a different core.

**How the priorities were set.** Each item is ranked by three things:
1. how many independent projects rebuilt it by hand;
2. how large its measured effect is;
3. how costly it is to get wrong.

**Note on repo status.** The repository's own [idea catalogue](../docs/idea-catalog.md) and [architecture map](../docs/architecture.md), written alongside this research, already list several items as built:
- `max`, `min` and `geomean` pooling;
- `fitLogistic` and `poolLearned`;
- the `digest` state helpers;
- `fitIsotonic` and `fitThresholdByCost`;
- the `Rollout` controller;
- `Hysteresis` and `Freshness`;
- `RuleOracle` and `withFallback`.

For those rows, the work is checking the build against the evidence cited here, not new construction. The "Against the brief" column is stated against the brief's feature list.

| Priority | Capability | Patterns that need it, and the evidence | Against the brief |
| --- | --- | --- | --- |
| P0 | **A replayable ledger of full distributions with complete keys**: criteria version, option order, items per request, backend and model version, mode, and an `actedBy` source (oracle, rule, cache, fallback, human) | Replaying policies with no new calls ([metajev](https://github.com/YYTbit/metajev)); argmax loses information ([arXiv 2609.29429](https://arxiv.org/html/2609.29429)); packing moved 143/1,405 across the bar ([medRxiv](https://www.medrxiv.org/content/10.64898/2026.10.09.26365173v1.full)); the 1.14 alias shifted scores ([1023 Jack](https://1023jack.com/news/jev-can-see-now-i-pointed-it-at-30-of-my-own-images/)); control arms need `acted` ([wow-overseer](https://github.com/quadseven/wow-overseer/issues/821)) | Extend the ledger; add `replay(policy)` |
| P0 | **Soft pooling operators plus a fitted combiner, and a refusal to threshold before pooling** | Thresholded-AND -0.137 AUROC on 9/10; soft max, product and difference won ([arXiv 2609.29429](https://arxiv.org/html/2609.29429)); phishing 62.6% to 95.1% ([bench](https://github.com/anisselbd/jev-phishing-bench)); min for arguments, geometric mean for paths ([cookbooks](https://docs.typesafe.ai/cookbooks/function_calling.md)) | Extend pooling (repo lists most of this as built) |
| P0 | **Per-decision-point modes (off, shadow, trace-only, active), activation bars, guarded promotion and automatic demotion** | Activation bar ([stingray](https://github.com/Nanako0129/stingray)); per-rule fit and retirement ([limpet](https://github.com/noplan-inc/limpet)); 0.99 rolling-agreement demotion ([stuntd](https://github.com/bladedevoff/stuntd)); 38 switchable points ([mu](https://github.com/qybaihe/mu)); broad gates removed after a week ([jev-gates](https://github.com/rashedInt32/jev-gates)) | Extend shadow mode and audits (repo: `Rollout`) |
| P0 | **Value-of-information ask suppression**: skip the oracle when floors or policy fix the action regardless of the answer, and tag rule-settled rows; code-side pre-settlement may only ever lead to `review` or `refuse` unless it is audited | 48.9% fewer requests while keeping 327/338 outcome-changing asks ([pi-warden](https://github.com/DevMortimer/pi-warden)); only 17.7% of stops reach Jev ([jev-belay](https://github.com/valentynkit/jev-belay)); per-fork calls dominated wall clock ([JevLoop](https://github.com/zjunlp/JevLoop)) | New |
| P0 | **Review bands defined by margin and measured drift, with a reversed-order re-ask only on near-ties** | Order drift 0.13 to 0.16 ([position test](https://github.com/imaddde867/jev-position-test)); repeats 0.62 to 0.91 ([ci-triage](https://github.com/criguex/jev-ci-triage)); margins of 0.1 or less flipped 12/12 ([arXiv 2609.28613](https://arxiv.org/html/2609.28613)); 0.15 top-two margin ([HA agent](https://github.com/the-sof/home-assistant-typesafe-conversation-agent)) | Extend the policy |
| P0 | **Schema lint and wire validation**: Score 2 to 10 descriptive levels; option caps per backend (255, Ollama 26); polarity lint per backend; `other` only in classification and an exists Noul beside every locate or Box; `choice` versus recomputed argmax; sum tolerance without renormalisation | 11 levels error ([AutoResearch](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery.md)); negated wording collapses open models ([Arize](https://arize.com/blog/decision-model-benchmark/)); argmax mismatch ([#15](https://github.com/typesafe-ai/typesafe-sdk-python/issues/15)); 26-option cap ([Ollama](https://ollama.com/library/clef)); Box always answers ([Box](https://docs.typesafe.ai/primitives/box)) | Extend `validateVerdict`; add a pre-send lint |
| P0 | **Taint and feedback separation**: untrusted fields are tagged, widen the review band and are routed to floors; the engine's own outputs never enter model-visible state | Counterfeit policy took recall from 82.90% to 3.88% ([Datadog](https://securitylabs.datadoghq.com/articles/jev-as-a-judge-how-counterfeit-policy-steers-jev/)); a claimed approval let 3/30 through ([robustness list](https://github.com/Yifan-Lan/awesome-jev-robustness)); own-verdict feedback loop ([Arcjet](https://arcjet.com/blog/how-we-built-ai-agent-behavior-drift-analysis-with-cloudflare-clef)) | New (now an AGENTS.md invariant) |
| P0 | **Availability semantics**: 402 and 429 as first-class outcomes; a rate and spend governor shared across processes; a daily cap derived from the ledger; labelled degraded verdicts; an exception in the engine's own hook becomes failed-open, never a silent pass | 402 on every call ([wow-overseer](https://github.com/quadseven/wow-overseer/issues/821)); 17/126 calls succeeded ([ci-triage](https://github.com/criguex/jev-ci-triage)); collapse at 400 msg/s ([firehose](https://github.com/dabit3/jev-experiments/tree/main/jev-firehose)); "a hook that throws is skipped and the tool runs" ([stepwarden](https://github.com/getexcited/stepwarden)); shared governor ([decision-gate](https://github.com/zachlandes/decision-gate)) | Extend fail-open and spend caps |
| P1 | **Bound-based threshold fitting** (Clopper-Pearson, Learn-Then-Test or a 95% lower bound), with an interval on every bar and coverage at a declared error budget as the headline report; fitted Score cuts and Choice weights under ReAnchor acceptance | Point-estimate rule over budget in 9/20 splits ([Jevstiller](https://jevstiller.pages.dev/posts/the-guarantee/)); 1.6% realised at a 1% budget ([Vals](https://www.vals.ai/blogs/independent-evaluation-of-jev)); gate interval 0.76 to 0.88 ([jev-eval](https://raw.githubusercontent.com/CMaintz/jev-eval/main/README.md)); 71% at zero errors ([Looming](https://www.looming.tech/post/typesafe-jev-invoice-classification)) | Extend `fitThreshold` |
| P1 | **A recalibration layer** keyed per question, criteria version, backend, model and packing; Platt below about 100 to 200 labels, isotonic above; a base-rate monitor; maps invalidated on any edit or alias move; a CI `check` that fails on drift | ECE curve by n ([AnthusAI](https://github.com/AnthusAI/Jev-Calibration)); base-rate effect ([Adilmp](https://github.com/Adilmp/does-jev-confidence-mean-anything)); CI lock ([jevcal](https://github.com/abhixhek/jevcal)) | New (repo: `fitIsotonic`; `check` missing) |
| P1 | **A state pipeline**: band, count, relative time and prune transforms; projection onto declared paths with a strict mode; state built from the acting unit; candidate-proposal hooks; a per-field ablation runner | 74.3% to 100% ([jev-state](https://github.com/suranjaychandra/jev-state)); label-defining fields +0.157 to +0.361 ([arXiv 2609.29429](https://arxiv.org/html/2609.29429)); 33% false skips from mis-scoped state ([paseo](https://github.com/funkmastert/paseo/pull/21)) | New (repo: `digest` helpers) |
| P1 | **Decorrelating transforms with measured correlation**: polarity flip, reversed order, a second backend, decomposition; lead-by-k over transforms rather than repeats; "a refusal is no vote" made explicit | Rotation budget 7.2 of 18 ([AnyJev](https://github.com/MorrisZJ/AnyJev)); both-polarity asks ([jev-trust](https://github.com/chunxiaoxx/nautilus-compass/tree/main/sdks/jev-trust)); voting semantics ([flock](https://github.com/whiteducksoftware/flock/issues/530)); different misses across backends ([HN](https://hn.algolia.com/api/v1/items/49923692)) | Extend ensembles and sequential sampling |
| P1 | **Ranking and large-option recipes**: listwise rank with rounds above 250; RRF fusion with the retriever; an exists Noul beside every locate; a two-stage window-then-item pass; beam search with a coarse fallback | Listwise 0.94 vs 0.87 ([Hindsight](https://hindsight.vectorize.io/blog/2026/09/24/adding-jev-reranker-what-we-learned)); RRF +0.090 ([rerank eval](https://raw.githubusercontent.com/zhuyansen/jev-search-rerank-eval/main/README.md)); coarse fallback 65% to 80% ([cookbook](https://docs.typesafe.ai/cookbooks/classification_using_confidence.md)) | Extend recipes |
| P1 | **A claims-versus-evidence verifier recipe** for the chain runner, with a rule that a verifier reads ground-truth artefacts outside the producer's context | AUROC 0.976 ([jev-belay](https://github.com/valentynkit/jev-belay)); 14/14 ([jev-gates](https://github.com/rashedInt32/jev-gates)); "DONE still requires independent outcome verification" ([jev-ultrafast](https://github.com/browser-use/jev-ultrafast)) | Extend the chain runner |
| P1 | **Permits and receipts**: `act` returns a one-use permit bound to the decision record's digest for the executor to verify; the ledger is hash-chained and signable | One-use permits ([PermitMCP](https://github.com/qinpei-dev/permit-mcp)); locked tokens cut harm to 2.5% ([GateArena](https://neurips.cc/virtual/2026/168290)); signed logs ([Edward](https://github.com/VeridicalTech/Edward)) | New |
| P1 | **Leases, change-triggered re-ask, fingerprint cache keys, and coalescing of identical in-flight states** | 14% fewer output tokens ([reasoning-router](https://github.com/robertn702/opencode-jev-router)); fingerprint reuse ([jev-drone](https://github.com/RomanSlack/jev-drone)); no one coalesces yet ([gotorque](https://github.com/asaf-shitrit/gotorque/pull/20)) | Extend caching |
| P1 | **A baseline runner** (random, first-option, rules) reported beside every evaluation | Random beat Jev on peak XP ([jevscape](https://github.com/Skyvern-AI/jevscape)); rules identical to Jev ([pick-and-place](https://github.com/tryaksh/jev-pick-and-place-study)) | New (repo: `RuleOracle`) |
| P2 | **A loop kit**: deadlines with a keep-current default, sequence and fingerprint freshness, cancel-on-supersede, debounce, hysteresis with minimum hold, a decision-age metric, labelled load shedding | All loops in the real-time section ([jevscape](https://github.com/Skyvern-AI/jevscape); [pong-jev](https://github.com/safzanpirani/pong-jev); [firehose](https://github.com/dabit3/jev-experiments/tree/main/jev-firehose)) | New (repo: `Hysteresis`, `Freshness`) |
| P2 | **A local tier behind a novelty gate**, trained only on human outcomes or Apache-licensed teachers | 69% confident, 42% right on novel inputs without the gate ([stuntd](https://github.com/bladedevoff/stuntd)); MCA §2.3(b) ([MCA](https://typesafe.ai/legal/mca)) | New, with legal review |
| P2 | **A human-answered oracle for the audit queue**, recording blind judgment before revealing the model's answer | Human-backed Jev API ([Hev](https://news.ycombinator.com/item?id=50075774)); blind labelling ([toolgate](https://github.com/RiskAverseTech/toolgate)) | Extend blind audits |
| P2 | **Criteria optimisation with held-out acceptance**, versioned per backend | +1.0 AP for Jev vs +13.4 for weak models ([Parallel](https://parallel.ai/blog/are-all-system-one-models-created-equal)); Laya-tuned criteria hurt Jev by 3.67 ([Red Hat](https://developers.redhat.com/articles/2026/10/02/benchmarking-ai-decision-models-against-traditional-guardrails)) | New |
| P2 | **Images and Box** behind a presence Noul, with crop-then-verify | Box always answers; edge Nouls 30/36 ([Box](https://docs.typesafe.ai/primitives/box)) | New; experimental upstream |
| P2 | **A streaming token-window gate** | 0 leaked tokens, +0.11 s ([tokengate](https://github.com/Thanh-Mathieu95/jev-model-tokengate)) | New |

The deliberate omissions are as important as the backlog. Each entry below was measured to fail, or was rejected by its own authors.

| Do not build | Why (evidence) | Build instead |
| --- | --- | --- |
| Threshold-then-AND rubric composition | -0.137 AUROC on 9/10 benchmarks ([arXiv 2609.29429](https://arxiv.org/html/2609.29429)) | Soft pooling; fit the bar on the composite |
| Same-model self-consistency and replicas | Variance is near zero on easy items and concentrated at ties ([cookbook](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook); [FlowX](https://www.flowx.ai/blog/jev-the-good-the-bad-and-the-ugly)) | Decorrelating transforms, and only on near-ties |
| A default "escalate to a bigger LLM" cascade | At most 2.7 points, over 85% repeated errors ([arXiv 2609.29769](https://arxiv.org/abs/2609.29769)); 0.400 < 0.404 ([Lyon](https://lyonwj.com/blog/typesafe-jev-knowledge-graph-extraction)) | A human shortlist or deterministic check; a cascade only on measured, uncorrelated disagreement |
| Label-free base-rate or prior correction | F1 fell to 0.571 to 0.690 ([arXiv 2609.29429](https://arxiv.org/html/2609.29429)) | Labelled per-question fits |
| Prompt-level injection defences | Markers were noise; recall 82.9% to 3.88% ([Check Point](https://blog.checkpoint.com/ai-security/jev-is-not-a-language-model-but-it-breaks-like-one-prompt-injection-against-a-typed-decision-model/); [Datadog](https://securitylabs.datadoghq.com/articles/jev-as-a-judge-how-counterfeit-policy-steers-jev/)) | Taint tags, floors, wider margins |
| Summarising compaction | 58.7% recall, below the plain transcript ([hermes-jev-skills](https://github.com/kerpopule/hermes-jev-skills)) | Select, keep a pointer, rejudge |
| A decision at every fork or tick | 79% of wall clock ([JevLoop](https://github.com/zjunlp/JevLoop)); oscillation ([Blocks.ai](https://blocks.ai/blog/jev-open-model-doom)) | Leases, value-of-information suppression, change triggers |
| Model-owned continuous control | DNF with 9 off-tracks ([grand-prix](https://github.com/enoyola/jev-grand-prix)) | Discrete targets that code actuates |
| Broad virtue gates ("in scope", "useless", rule files) | 0.51 to 0.62 AUROC ([limpet](https://github.com/noplan-inc/limpet)); vague rules 0.97 before and after a fix ([a7ul](https://blog.a7ul.com/agents-code-your-way.html)) | Narrow factual batteries with a tested margin |
| `confidence` as a gate across option counts | Normalised entropy means "fixed thresholds mean different things at different option counts" ([JevLoop](https://github.com/zjunlp/JevLoop)); "adds no information" ([AnthusAI](https://github.com/AnthusAI/Jev-Calibration)) | Calibrated top probability plus margin |
| Choosing a backend from a leaderboard | Abstention counted wrong; Clef's 20-point new-domain drop ([redreamality](https://redreamality.com/blog/open-decision-models-2026-survey-benchmarks/)) | Coverage at an error budget on your own ledger |
| Heads trained on Jev output | MCA §2.3(b) ([MCA](https://typesafe.ai/legal/mca)); KL measures closeness to the teacher ([AutoTrust](https://huggingface.co/autotrust/JEV-9B)) | Human outcomes or Apache-licensed teachers |
| Forecasting or restating probabilities | Fair die 82.9%; 30% returned as 5.3% ([die test](https://kantahayashiai.github.io/posts/jev-does-not-play-dice/)) | Compute in code; the oracle reads only |
| Direct severity scores; large taxonomies with an `other` sink | +3.30 bias ([Casco](https://casco.com/blog/jev-cvss-benchmark)); dump into "other" ([Cribl](https://cribl.io/blog/what-typesafes-jev-means-for-telemetry/)) | Impact Choices plus a score computed in code; monitor the escape share |
| Automated consequential decisions about people | The AUP is silent ([AUP](https://typesafe.ai/legal/acceptable-use-policy)); order flips 370/2,620 ([trolley](https://zachlandes.com/trolley-problem/)) | `oneWayDoor`: review at most |
| An escape option inside a ranking list | 35/200 queries emptied ([Hindsight](https://hindsight.vectorize.io/blog/2026/09/24/adding-jev-reranker-what-we-learned)) | A separate existence Noul |
| Silent renormalisation of probability sums | It "could inflate confidence" ([#15](https://github.com/typesafe-ai/typesafe-sdk-python/issues/15)) | A tolerance, then reject or review |
| Packing many items into one state for thresholded decisions | 96% to 72%; PII accuracy halved ([gc.ai](https://gc.ai/blog/what-we-learned-building-38-projects-with-jev-in-12-hours); [pii-test](https://github.com/phubbard/jev-pii-test)) | One state per item, many questions per state |
| A geometric path score as a verifier | Did not separate correct from incorrect paths ([r6i](https://blog.r6i.it/typesafe-jev-vs-agentic-loop.html)) | An independent verifier |
| An agent loop runner or framework | Hosted per-fork decisions lost on latency ([JevLoop](https://github.com/zjunlp/JevLoop)); frameworks are converging on the wire contract ([agentgateway](https://agentgateway.dev/blog/2026-10-12-openai-decisions-api-jev-agentgateway/)) | Recipes and hooks over the wire contract |

## Conclusion

**The month's most valuable discovery was when not to call the oracle at all.** The biggest cost results came from suppressing asks in code, not from Jev's per-call price: 17.7% of stops reaching Jev, 48.9% fewer requests with 96.7% of outcome-changing asks kept, and hard wake rules that never ask. Value-of-information suppression has a clean statement inside a floors-only-raise-caution engine: do not ask when no answer can change the action. It belongs in the core as a first stage, not as a recipe.

**Whether a gate will survive is predictable before it ships.** Every surviving gate had a crisp signal in the state that matched a narrow question. Every removed gate asked something the state could not show. So the engine can refuse to enforce a decision definition that fails a margin test on labelled cases (the a7ul rule) or a shadow activation bar (the stingray rule), rather than discovering the failure in production.

**The thing the engine must version is the decision definition, not the threshold.** That definition bundles question text, criteria, option order, state transform, items per request, backend and model, calibration map, bar and activation bar. Every measured shift in this corpus came from changing one element of it:
- wording moved the probability scale from 0.26 to 0.57;
- packing moved 143 records across a bar;
- an alias move cut scores at 0.5 or above from 23 of 30 to 15 of 30;
- criteria tuned for one backend hurt another.

Content-addressing that bundle, and keying every ledger row, cache entry and fit to it, is the single change that makes the rest of the backlog sound.

**No project has yet published a controlled production outcome delta.** The engine's shadow mode with a sampled control arm is the cheapest way to produce one, and would make it the first system in this ecosystem able to say what its decisions are worth.
