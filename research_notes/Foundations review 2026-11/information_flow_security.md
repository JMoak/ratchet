# Information flow for a decision gate: taint, monotone evidence, permits and an injection study

*Research note, 2026-11-12. Foundations review: how a gate whose soft judge reads untrusted text should be built, and how to measure it without authoring attacks. Docs only; URLs are in the sources at the end. Tags: [verified] means the abstract, text or licence file was fetched in this review; [memory] means it was not, with any search confirmation noted; [project notes] means a figure quoted from this repository's own research notes, not re-checked here.*

The gate's soft judge reads text an attacker can write, and nothing inside the request stops that text from moving the answer: the project's own notes record typed inputs, "untrusted" markers and anti-injection instructions failing in four independent studies, and a counterfeit policy in an untrusted message dropping a Jev-class classifier's recall from 82.9% to 3.9% [project notes]. The literature since 2025 agrees and has moved the defence out of the model: control what the model sees, decide in code, and constrain what any output derived from untrusted input can cause. This note asks what of that a zero-dependency library sitting in a hook, seeing one call at a time, can use. Its conclusions: label State entries on two axes (who could choose the bytes, and whether a model reads them as language); let floors read typed entries and provenance instead of rendered text; offer a "lower only" mode in which untrusted evidence can cost an act but never buy one, which is the only certificate on offer that covers unbounded insertion; bind an enforced act to the exact bytes of the call it approved, single use, with consumption left to the application; and measure all of it with published payloads placed mechanically into states, never with new ones. The review band is noise insurance and a filter for weak attacks, not an injection control, and no certified-robustness result can make it one. For the coding-agent hook as built, the property that matters most is not about untrusted spans at all, because the hook reads none: its injection surface is the command the agent wrote.

## What exists today

`State` (`src/state.ts`) renders trusted fields, code-computed digests and record pairs first, then untrusted spans after an `[untrusted name]` marker; rows carry `stateHash` (the whole rendering) and `trustedHash` (the trusted block only). Floors are `(state: string, question) => Action | undefined` over the rendered text, so a refuse floor can fire on tool output that only mentions a command (e2e T4-14), and floors over typed entries are backlog (T3-10). The hook (`src/hook/`) never reads tool output, file contents or the conversation; its subject is the command or path plus lexical digests (destructive, opaque, check_bypass, uploads, harness_config, credential), documented as a backstop and not a sandbox. The policy keeps a review band at least a tenth wide because, in the decision-hijacking study the vision cites, attacks flipped 12 of 12 decisions whose margin was 0.1 or less and 1 of 468 others [project notes]. The planned live injection study (e2e T4) was not run: a safety classifier stopped the agent that was authoring payloads, and the roadmap says the next attempt should use a published benchmark's payloads.

## System-level defences, and what fits a hook

| Defence | What it needs | What fits a zero-dependency library that sees one call | Verdict |
| --- | --- | --- | --- |
| CaMeL | Owns the agent's planner: a privileged model writes code from the trusted query, a custom interpreter tracks capabilities on every value | The idea that policy is code over values that carry provenance | Not as a system; its policy layer in spirit |
| Dual LLM | A controller, a privileged model that never sees untrusted text, a quarantined model with no tools, symbolic variables | Applied to the judge: a privileged (trusted-view) ask and a quarantined (full-state) ask whose output is confined to a caution-only channel; symbolic placeholders for free text in commands | Fits |
| FIDES | A planner that propagates confidentiality and integrity labels through the agent's context and checks policies at tool calls | Labels on State entries; the argument that typed, low-capacity outputs bound what tainted input can carry | Labels fit; planner does not |
| Design patterns (six) | Most need control of the agent's loop | Context-minimisation and dual-LLM apply to a judge; map-reduce applies to a gate over several untrusted items | Two of six, plus map-reduce for multi-item recipes |
| IsolateGPT | A hub-and-spoke runtime isolating apps from each other | Only the principle: never pool evidence across sources | Not applicable |
| Progent | A policy language and a deterministic checker at each tool call; an LLM may propose policy updates | Deterministic per-call policies with argument conditions are floors over typed entries; automatic updates only when they narrow | Fits, without LLM-written policies |
| Rule of Two | Knowing, per session, whether the agent read untrusted input, has sensitive access, and can change state or communicate | Session-level digests computed from the hook journal | Fits as digests and a few floors |
| PACT (argument-level provenance) | Provenance for each argument of each call, supplied by the harness | Nothing until a harness reports provenance | Not yet |
| Claude Code auto mode | The vendor's own classifier and server-side probe | Its classifier is context-minimisation: it sees user messages and tool-call commands only | The deployed precedent for the trusted view |

**CaMeL** (Debenedetti et al., 2025) [verified] extracts control and data flow from the trusted query so that retrieved data cannot change the program's flow, attaches capabilities to values, and enforces security policies when tools are called; it solves 77% of AgentDojo tasks with provable security against 84% undefended. Everything rests on owning the planner and the interpreter, which a hook does not. What transfers is the shape of a policy: deterministic code over values whose origin is known.

**The dual LLM pattern** (Willison, 2023) [verified] separates a privileged model (trusted input, tools) from a quarantined model (untrusted input, no tools), with ordinary code as the controller and symbolic variables standing in for untrusted values. Its rule is that "unfiltered content output by the Quarantined LLM is never forwarded on to the Privileged LLM", with one exception: output from a verifiable task such as classifying text into a fixed set of categories, checked to be one of them. A judge's verdict is exactly such an output, so the pattern permits using it; what it does not say is that the attacker cannot choose which category comes out. That is the gap the lower-only mode below closes, by confining the quarantined answer to a channel that can only add caution. Willison also flags that the pattern trusts whatever the user pastes in, which matters for the `operator` origin below.

**FIDES** (Costa et al., 2025) [verified] gives a formal model of agent planners, identifies which properties dynamic taint tracking can enforce, and builds a planner that tracks confidentiality and integrity labels, enforces policies deterministically and selectively hides information from the model. The Microsoft Research summary reports that with policy checks on it stopped every prompt-injection attack in AgentDojo, and that without them every planner tested fell [memory; search summary of the publisher's page, not the abstract]. A hook cannot propagate labels through the agent's context, but State entries can carry labels, and FIDES's point about typed outputs (a boolean carries one bit) is why code digests are safer to show the judge than text.

**Design patterns** (Beurer-Kellner et al., 2025) [verified] names six: action-selector, plan-then-execute, LLM map-reduce, dual LLM, code-then-execute and context-minimisation. The shared principle is that once an agent "has ingested untrusted input, it must be constrained so that it is impossible for that input to trigger any consequential actions", and the paper calls detectors "fundamentally heuristic". For a judge, context-minimisation (do not show it the untrusted text) and dual LLM (show it, but confine what its answer can do) apply directly; map-reduce (each untrusted item judged in isolation, outputs aggregated by code) applies to recipes such as `relevance` that read several items.

**IsolateGPT** (Wu et al., NDSS 2025) [memory; metadata confirmed by search] isolates third-party apps in spokes that talk only through a trusted hub. It is an agent-runtime architecture with nothing for a per-call gate beyond keeping evidence from different sources apart.

**Progent** (Shi et al., 2025) [verified] limits an agent's tool privileges with a domain-specific policy language: "every tool call is checked against such a policy through a deterministic procedure." In its third version (May 2026, retitled "Progent: Securing AI Agents with Privilege Control") an LLM may propose policy updates, and an SMT solver applies them automatically only when they narrow privilege; an expansion needs explicit approval. That is the same monotonicity this note proposes for evidence, applied to policy: automation may only narrow.

**The Rule of Two** (Meta, 31 October 2025) [verified] says an agent "must satisfy no more than two" of: [A] process untrustworthy inputs, [B] access sensitive systems or private data, [C] change state or communicate externally; a task needing all three "at a minimum requires supervision", such as human approval "or another reliable means of validation", until injection can be reliably detected. A coding agent with network access, a home directory and a shell has all three, so the gate is that supervision, and nothing in Meta's framing lets a soft judge count as reliable validation on its own. This is the project's "never let a soft judgment be the sole barrier on a security boundary", stated by a vendor.

**Claude Code auto mode** (Anthropic, 25 March 2026) [verified] is the deployed precedent. Its transcript classifier receives the user's messages and the agent's tool-call commands and nothing else: assistant prose is stripped "so the agent can't talk the classifier into making a bad call", and "stripping tool results is the primary prompt-injection defense". A separate probe scans tool outputs and warns the agent. The authors name the cost: without tool results the classifier cannot tell whether a value the agent used came from a query or was invented. The full pipeline's published operating point is 0.4% false positives on 10,000 real actions and 17% false negatives on 52 real overeager actions ("the honest number").

**Adaptive attacks.** Nasr et al. (2025) [verified] broke all twelve defences they examined, with attack success above 90% for most, many of which had reported near zero: spotlighting and prompt sandwiching above 95%, MetaSecAlign 96% (2% on static AgentDojo), the Protect AI detector, PromptGuard and Model Armor above 90%, PIGuard 71%, MELON 76% without knowledge of the defence and 95% with it, Data Sentinel bypassed in every case. Human red-teaming succeeded in every case evaluated, and "our adaptive attacks continue to bypass both the target model and every detector we evaluated, even when multiple guardrails are combined." Terekhov et al. (2025) [verified] showed the same for AI-control monitors: an untrusted model embeds injections in its own outputs, which is exactly where a coding-agent gate's subject comes from, and the defer-to-resample protocol "even backfires" because resampling turns the injection into a best-of-n attack. Two consequences for the gate: no detector question ("is this text an injection?") can be a barrier, only a signal that raises caution; and anything that lets an agent re-ask the same question is a best-of-n channel.

**2026 work.** PACT (Fan et al., 2026) [verified] argues the unit of trust is the argument, not the call: injection is dangerous when it "determines an authority-bearing argument" such as a destination or a command; with oracle provenance it reports 100% utility and security on mixed-trust suites, and on AgentDojo 100% security on the three strongest models at 38.1% to 46.4% utility, 8 to 16 points above CaMeL. A hook does not receive provenance per argument, so this waits on harnesses. ARM (Chinaei, 2026) [verified] shows a denial is itself an information channel ("causality laundering": try a protected action, read the denial, leak the inference through an innocuous call) and adds counterfactual edges from denied actions to an integrity lattice; for the gate this argues for generic denial text to the agent and detail only in the ledger. ActPlane (Zheng et al., 2026) [verified] enforces agent policies in the kernel with eBPF because "tool-call guardrails miss system actions that bypass the tool layer"; it complements a hook rather than competing with it.

## Precedents for the differential ask, and why each broke or held

The candidate design asks the judge twice, once on the trusted view and once on the full state, and acts only if both clear the bar. Its nearest relatives:

| Precedent | What is removed or compared | Claimed guarantee | What happened |
| --- | --- | --- | --- |
| MELON (2025) | Re-runs the agent with the user task masked and tool outputs kept; flags tool calls that recur | Hoeffding bound on an ensemble's statistical error, not on an adaptive attacker | Broken: 76% to 95% (Nasr et al.); the attacker's text is in both runs and can condition on the mask |
| AgentSentry (2026) | Restores a snapshot, substitutes the untrusted "mediator", checks whether the pending action survives; purifies and resumes | None; 0% ASR on evaluated cases | Untested by third parties; purification keeps some attacker content |
| AttriGuard (2026) | Re-runs with a "control-attenuated" view of observations; a call that disappears was driven by them | None; 0% ASR static, resilience to adaptive optimisation claimed without numbers in the abstract | Untested by third parties; attenuation is itself a filter an attacker can target |
| Counterfactual evaluation for judges (2025) | Re-judges a submission against a deliberately false reference; flags acceptance under both | None | Detector; subject to the adaptive-attack result |
| Task Shield (2024) | Asks whether each instruction and tool call serves the user's stated goals | None; 2.07% ASR on AgentDojo with GPT-4o | An LLM checking alignment; the authors note weakness under adaptive attacks |
| Monotonic classifiers (2018) | Restricts a malware classifier so adding features can only raise the maliciousness score | Robust to any attacker who can only add features | Held, at about a 13% drop in detection rate |
| Erase-and-check (2023) | Erases tokens and checks every resulting subsequence; flags if any is flagged | Certified against adversarial insertions up to a bounded size | Holds for the bound; cost grows with the bound |
| RobustRAG (2024) | Answers from each passage group in isolation, aggregates securely | Certified lower bounds against k injected passages, for some queries | Holds for bounded k |

MELON (Zhu et al., ICML 2025) [verified] compares the original run with a masked one that replaces the user task with a task-neutral prompt; a tool call that appears in both is taken as driven by the tool outputs. Its "provable" section bounds the false-positive and false-negative rates of an ensemble of masking prompts by Hoeffding's inequality, assuming bounded independent scores, and the experiments use a single masking prompt. It costs about twice the calls, had a 9.28% false-positive rate on GPT-4o, and 72.73% of its 66 analysed evasions met the attacker's goal through text rather than tool calls. It broke under adaptive attack because the attacker's content is present in both runs: text that behaves differently when the user task is neutral defeats the comparison. AgentSentry (Zhang et al., 2026; NDSS 2027) [verified] and AttriGuard (He et al., USENIX Security 2026) [verified] run the counterfactual in the same direction as the differential ask (remove the untrusted observation, see whether the action survives), report 0% attack success on their evaluated cases, and then partly restore the untrusted content ("purification", "control attenuation") to keep utility, which reintroduces something an attacker can aim at. Counterfactual evaluation for judges (Liu et al., 2025) [verified] and Task Shield (Jia et al., ACL 2025) [memory; search-confirmed] are detectors and inherit the adaptive-attack result.

The two that held are structural, not detectors. Monotonic classification (Incer, Theodorides, Afroz and Wagner, IWSPA 2018) [memory; search-confirmed] makes the classifier's score non-decreasing in features an attacker can only add, so adding them cannot evade it; the price was a drop of about 13% in detection rate, and Microsoft later deployed monotone models in Defender [memory; search-confirmed]. Erase-and-check (Kumar et al., COLM 2024) [verified] certifies a safety filter against adversarial suffixes, insertions and infusions of bounded size by checking every erased subsequence. The differential ask is the degenerate case of erase-and-check where the single erasure is "every untrusted span": it certifies against insertions of unbounded length that are confined to those spans, at the price that untrusted text can never support an act. The difference from MELON is the whole argument: in the trusted-view ask the attacker's text is absent by construction, so there is nothing to condition on. Its residual risk is everything the attacker can put into the trusted view, which for a coding agent is the command.

## Certified robustness and the review band

The question was whether a certified notion of robustness for a text judge (randomised smoothing over paraphrases or orderings) could justify the review band's width. Not usefully. SAFER (Ye, Gong and Liu, ACL 2020) [memory; search-confirmed] certifies a classifier against synonym substitutions; erase-and-check [verified] against insertions of bounded length; RobustRAG (Xiang et al., 2024) [verified] against a bounded number of injected passages, and only for some queries; 2026 smoothing work certifies l0 radii over tokens [memory; search snippets only, not verified]. An injection is an insertion of unbounded, freely chosen language, and none of these bounds a decision against it. Smoothing over paraphrases or orderings would certify the answer against benign variation, which is the run-to-run spread the project already measures per pin, not against an adversary. The only certificate that covers unbounded insertion into a delimited region is to erase the region, which is the lower-only mode below.

So the band should be described for what it is. Its evidence came from a non-adaptive attack: 12 of 12 decisions flipped at a margin of 0.1 or less, 1 of 468 beyond [project notes]. The counterfeit-policy attack in the same notes moved recall from 82.9% to 3.9% and JevOut flipped 59% to 73% of correct decisions with high confidence [project notes], displacements far larger than 0.1. The band absorbs model noise and weak attacks near the bar; it is not an injection control, and documents should stop implying it is. The research notes' suggestion to widen margins when tainted fields are present is still worth testing (the study below has a stratum for it), but a wider band moves the same problem outward.

One certified idea does transfer, for gates that read several independent untrusted items: RobustRAG's isolate-then-aggregate. If untrusted evidence is ever allowed to support an act, it should be only when at least k + 1 isolated items of distinct provenance each support it, which bounds the effect of k corrupted ones. A single tool output can never meet that bar, so for a tool gate it means no lift at all, which is the lower-only rule.

## Recommended design

### The lattice: origin and form

Each `StateEntry` gets two labels in place of `trusted: boolean`.

`origin` says who could choose the bytes:

| Origin | Examples | Shown in the trusted view | May lower caution |
| --- | --- | --- | --- |
| `harness` | tool name, session root, cwd as the harness reports it, permission mode, the harness's own exit codes | yes | yes, through any code predicate |
| `operator` | the application's own records, a written policy, a customer's plan from the database, the person's own request | yes | yes, through any code predicate |
| `agent` | the command, path, patch or arguments the agent wrote | yes, with free text placeholdered (below) | only through exact, anchored code predicates the operator wrote (bypass allowlists, the `harness_owned` exemption); never through a model's reading alone |
| `external:<source>` | tool output, file contents, web pages, MCP results, user-editable profile text | no | never; may only raise caution |

`agent` sits between the two that already exist. The command is authentic (it is what will run) but an agent that has read attacker text can be steered into writing it, so it is not trustworthy in the sense that matters. It must be in the trusted view, because it is the subject being judged; the guarantee below therefore does not cover it, and saying so is the point of giving it its own origin. Content a person pastes into a request is `external` in substance even though the person sent it (Willison's caveat); an application that knows this should label it so.

`form` says how the entry reaches the model: `fact` is a scalar computed in code (boolean, band, count, enumeration, comparison), `text` is language the model reads. A digest has form `fact` and records `from: string[]`, the names of the entries it was computed from. Its origins are the union of its inputs' origins, and its right to lower caution is the weakest among them: a digest over an `external` input may only raise caution; one over `agent` and `harness` inputs follows the `agent` row. A fact computed from attacker-chosen bytes is a true fact about bytes the attacker chose. Its value is low capacity (a few bits through a predicate the operator chose, in place of free language), not trustworthiness.

For the hook, the mapping is: tool name, session root, mode and harness homes are `harness` facts; the command text and the path are `agent` text; `destructive`, `opaque`, `check_bypass`, `uploads`, `credential` are `agent` facts; `inside_workspace` and `harness_owned` are facts over `agent` and `harness` inputs; there are no `external` entries, because the hook reads no tool output.

`trustedHash` keeps its meaning (everything not `external`), and a new `viewHash` covers the trusted view as rendered for the model, placeholders included.

### Floor input and `floorOn`

```ts
type Origin = "harness" | "operator" | "agent" | `external:${string}`;
type Form = "fact" | "text";

interface StateEntry {
  // existing: kind, name, section, value, rendered, sides, note, truncated
  readonly origin: Origin;
  readonly form: Form;
  readonly from?: readonly string[];        // digests: the entries they were computed from
}

interface FloorInput {
  readonly text: string;                    // the whole rendering, as today
  readonly trustedText: string;             // the rendering without external entries
  readonly entries: readonly StateEntry[];
  get(name: string): StateEntry | undefined;
}

/** What bypasses and exemptions receive: built without external entries, so they cannot read them. */
interface LoweringInput {
  readonly trustedText: string;
  readonly entries: readonly StateEntry[];  // no external origin, by construction
  get(name: string): StateEntry | undefined;
}

type EntryFloorRule = (s: FloorInput, q: Question) => Action | undefined;
type EntryBypassRule = (s: LoweringInput, q: Question) => boolean;

function floorOn(
  name: string,
  predicate: (value: unknown, entry: StateEntry) => Action | undefined,
  opts?: { readonly origins?: readonly ("harness" | "operator" | "agent" | "external")[] },
): EntryFloorRule; // default origins: harness, operator, agent
```

A floor raises caution, so it may read anything; but the helpers default to non-external origins, which fixes T4-14 (a command floor no longer fires on tool output that mentions the command), and a caller who wants a floor over tool output opts in by naming `external`. Bypasses and exemptions lower caution, so they receive a `LoweringInput` that is constructed without external entries: the guard is the type and the constructor, not a convention, and it replaces the current practice of cutting the text at the first `[untrusted ` line. String `FloorRule` and `BypassRule` keep working on `text` for compatibility. Moving a gate to entry floors changes rulings on states whose untrusted spans used to match, so it bumps the gate's evidence version. The existing fail-closed behaviour of `evaluateFloors` (a throwing or non-Action floor imposes review) applies unchanged.

### Placeholders for free text inside agent commands

The trusted view replaces free language inside `agent` text with typed placeholders; the full state shows it verbatim. This is Willison's symbolic variables applied to the gate: the judge sees `git commit -m <text#1: long>` and judges the shape of the call, not the prose an attacker may have written into it.

Lexically recognised as free text: shell comments (`#` at a word start outside quotes; PowerShell `#` and `<# ... #>`), heredoc bodies (`<<EOF`, `<<'EOF'`, PowerShell here-strings `@' '@` and `@" "@`), the values of `-m`, `--message` and `-F` on git commit and tag, the arguments of `echo`, `printf` and `Write-Output`, and any quoted literal with whitespace in it longer than a threshold (40 characters is a reasonable default). Quoted strings that look like paths, URLs, hostnames, flags or single words stay: they are authority-bearing arguments in PACT's sense, and the judge needs them. Placeholders are numbered by position and carry only a length band (`short` up to 80 characters, `long` up to 400, `very long` beyond) and a line count band, never the exact length, so that varying the prose cannot change `viewHash` and buy a fresh draw. The digests and floors keep reading the original command, raw and normalised, exactly as now.

Extraction is lexical and imperfect. When it cannot parse a command it leaves the text in place, which is today's behaviour, and records a `placeholders: partial` fact so the ledger and the floors can see the view was not cleaned.

### Three `untrusted` modes

`GateSpec.untrusted` chooses how external entries reach the judge:

| Mode | Asks | Ruling | Use for |
| --- | --- | --- | --- |
| `show` (default, today) | one, on the full state | `rule(p_F)` | existing gates; gates whose subject is itself untrusted (see below) |
| `hide` | one, on the trusted view | `rule(p_T)` | context-minimisation, as Claude Code's classifier does; external facts may be added by explicit opt-in (`externalFacts: true`), which weakens the guarantee to their few bits |
| `lowerOnly` | two, on the trusted view and the full state, in parallel | `moreCautious(a_T, cap(a_F))` | gates whose subject is trusted and whose untrusted spans are context |

Here `p_T` and `p_F` are the probability that acting is right from the trusted-view and full-state asks, `a_T = rule(p_T)` and `a_F = rule(p_F)` under the gate's policy, and `cap` maps `refuse` to `review` and leaves the other actions alone. Because `rule` is monotone in p, this is equivalently: act if and only if `min(p_T, p_F)` clears the act edge; refuse if and only if `p_T` falls below the refuse edge; review otherwise.

`cap` exists because a refusal driven only by untrusted text is an availability attack that no person sees: the agent gets a denial, the attacker gets a signal (ARM's denial channel), and the operator gets nothing to review. Capping at review keeps the drop visible to a person and keeps the denial out of the agent's loop. Refusals still come from trusted evidence and from floors, which read everything.

The default stays `show` so existing evidence does not move; the docs should recommend `lowerOnly` for any new gate with a trusted subject and untrusted context, and the default can change only with an evidence-version bump after the study below.

The rest of the engine applies unchanged with two additions. If either ask fails open, the request reviews, as a battery does when a member fails: a missing trusted answer must never let the full answer act, and a missing full answer loses the channel that reveals danger. Floors run once, on the full `FloorInput`; bypasses run once, on the `LoweringInput`. Blind audits divert composite acts as usual. In shadow both asks are made and recorded. The bar must be fitted on the composite score `min(p_T, p_F)` on unselected rows: it is a new score with its own calibration, and the single-ask bar does not carry over. `ratchet replay` can re-rule these rows under a new policy because both probabilities are stored.

### Caching the trusted-view answer

The guarantee is pointwise in the trusted view, and Jev is not deterministic (on jev-1.14, 5.5% of 924 repeated requests flipped their lean [project notes, e2e T2]). Without a cache, an agent that retries the same call draws again from the trusted ask's noise, which is the best-of-n channel of Terekhov et al. So in `lowerOnly` and `hide` the trusted-view answer is cached under the existing lease machinery (`cached` with `ttlMs`), keyed by `(viewHash, question id and hash, oracle id and model pin, evidence version)`, with a TTL longer than any plausible retry horizon (24 hours is a reasonable default). A cached row is marked `trustedCached: true` and its probability is a copy, so it must be excluded from calibration, drift measurement and repeated-pair spread, or it will count one draw many times.

Canonicalisation (`normaliseCommand`) and placeholders shrink the space of views an agent can produce for one intent, but cannot close it. A floor closes the rest cheaply: compute a skeleton of the call (tool, command words and flags, with literals and placeholders dropped), and once a skeleton has been held in a session, any later act on the same skeleton in that session goes to review.

### Ledger fields and report lines

Both asks are rows under one `requestId`, like a battery's members, plus a combined row that carries the ruling:

| Row | Field | Meaning |
| --- | --- | --- |
| member | `view: "trusted" \| "full"` | which ask this row is |
| member | `viewHash` | hash of the rendering the model saw |
| member | `trustedCached` | the answer was a cache hit (trusted rows only) |
| combined | `strategy: "differential"`, `combined: true` | the ruling row |
| combined | `goTrusted`, `goFull` | `p_T` and `p_F`, probability that acting is right |
| combined | `lift` | `goFull - goTrusted`, in probability |
| combined | `liftLogit` | the same in log-odds, for comparing across the scale |
| combined | `crossing: "lift" \| "drop"` | `lift`: the full ask cleared the act edge and the trusted ask did not (coverage given up); `drop`: the trusted ask cleared it and the full ask did not (untrusted text lowered it) |
| combined | `untrusted` | names and sources of the external entries, as today |
| combined | `capped` | `cap` turned a refusal into a review |

`report` and `gate.report()` gain a section for gates in `lowerOnly`, all on unselected rows:

```
untrusted (lowerOnly): 412 requests, 6 failed open
  lift: median 0.03, p90 0.12, max 0.41 (probability); by source external:WebFetch p90 0.19
  lift crossings: 31 (7.5%): acts the full state alone would have made
  drop crossings: 6 (1.5%), 4 capped refusals; blind-reviewed 6: 4 warranted, 2 not
```

The lift distribution is the measurable "untrusted lift" per gate the candidate design asked for. Lift crossings price the mode: they are the acts a gate gives up for the guarantee. Drop crossings are a natural queue of candidate injections and legitimate warnings, and blind-reviewing them (as hook denials already are) says which.

### What the guarantee says, when it holds, where it is vacuous

The property, stated so it can be published:

> In `lowerOnly` with the trusted-view answer cached, every state the gate acts on is a state on which the trusted view alone acts. Text in an untrusted span cannot buy an act that the trusted view would not have earned.

In `hide` the stronger form holds: untrusted text can neither buy nor cost an act. It is a one-sided non-interference property (integrity of the act, in Biba's sense), not full non-interference: an attacker still influences whether an act happens, by preventing it, and can observe the result, which is why drops are capped at review and denial text stays generic.

It holds only under four conditions, each of which an implementation can check or document:

1. Labelling is complete: every byte an attacker can choose that reaches the trusted view is either `external` (and so absent) or a placeholder. The `agent` command is not covered; its free text is placeholdered, its structure is not.
2. The trusted-view answer is cached as above. Without the cache the property becomes probabilistic per attempt and compounds over retries.
3. Nothing that lowers caution reads external entries: bypasses and exemptions get a `LoweringInput`, and no field is filled from external text.
4. The two asks are independent, stateless requests: the oracle sees only the text of its own request (true of the `Oracle` interface today), and no conversation or session state is shared between them.

Where it is vacuous or does not apply:

| Gate shape | Example | Does `lowerOnly` help? | What does |
| --- | --- | --- | --- |
| Trusted subject, untrusted context | tool gate shown the previous tool output; `relevance` over retrieved items; refund desk with a customer's free-text note | yes: the property holds and the lift is measurable | `lowerOnly`; map-reduce for several items |
| Untrusted subject | verifier over a model's output; moderation; triage of customer text | no: the trusted view cannot judge the subject, so it never acts | code checks (tests, digests), a model of another family, acts only behind a code check; the soft judge is never the sole barrier |
| Agent-authored subject | the coding-agent hook | the property is true but does not reach the main threat, which is the command | placeholders, digests and floors, session digests, blind review |
| No untrusted spans | the hook as built | vacuous: the hook is already `hide` | the same as the row above |

The candidate design's sentence, "the injected text cannot buy an act the trusted fields alone would not have earned", is sound under the four conditions and useful for the first row. It converts an unbounded empirical risk (flip rate under unknown attacks on spans) into a structural property plus a measured coverage cost, and it names the residual risk precisely. It must not be advertised as "the gate resists prompt injection"; for a coding agent the attacker's best route is the command, which the property leaves where it was.

Two ways of quietly voiding it deserve a line in the docs. Moving external text into a `field` to regain coverage launders it into the trusted view, and the builder cannot detect that by shape (T4-15). And a digest whose predicate is chosen so that its "true" direction lowers caution, computed over external text, hands the attacker those bits; digests over external inputs are for raising caution only.

### Session digests for the Rule of Two

The Rule of Two needs to know whether the session has read untrusted input. The hook journal records every run, but by design a run keeps only its tool name and an input hash, never the input. From what is there today, the computable digest is `session_external_tools`: the count of runs before this prompt, in this session, whose tool is `WebFetch`, `WebSearch` or an MCP tool (`mcp__*`). A read of a file outside the workspace, or a shell command that fetched a URL, cannot be recovered from a hash. To get those, the hook would journal, per run, two booleans computed at event time from the input it already parses (`outside_workspace`, `fetches_network`), which keeps the "never an input" contract.

With those digests, floor to review only the combinations that join all three of Meta's properties in one call: a session that has read external input, and a call that uploads (`uploads`), touches a credential (`credential`) or writes harness configuration (`harness_config`). Show the rest as digests in the state. A blanket Rule-of-Two floor would review nearly every call a coding agent makes, which is the availability cost that trains reviewers to approve without looking. Note the limit: the hook's evidence path is batch replay over prompted calls, so these digests inform shadow evidence and review now, and would need a synchronous `PreToolUse` path to enforce anything live.

### Permits: a ruling bound to the call it approved

An enforced `act` today is an action in an `AskResult`. The caller then executes something, and nothing ties what runs to what was judged. The literature on this gap is recent and direct. GateArena (Jiang, Quinzan and Bhatt, NeurIPS 2026 workshop) [verified] gave agents irreversible tools and a confirmation step that returns a warrant "bound to the approved action's exact parameter values" and consumed by the execution handler, which rejects any irreversible call whose warrant is missing, spent or bound to different values; with the instruction and tool set held fixed, moving the check into the handler took protocol-violating executions from 91 of 400 to 0 of 400, and gated harm was 2.5% against 37.5% to 60% ungated. Commit-time authorization (Santos-Grueiro, 2026) [verified] found, in 17 advisories across three agent products, 12 where an approval did not cover the effect that ran and 5 where it outlived a change in the facts it rested on, and its CommitGate consumes an expiring, single-use grant atomically with the effect. TOCTOU-Bench (Lilienthal and Hong, 2025) [verified] measured 12% of executed trajectories vulnerable, 8% with three countermeasures combined. Macaroons (Birgisson et al., NDSS 2014) [memory; search-confirmed] supply the semantics for narrowing a credential: caveats are added, never removed.

Recommendation: the binding belongs in the library, consumption and enforcement in the application. The library already hashes every state; a permit formalises that hash for the one thing an act authorises, at the cost of a small type and one pure function. The library does not execute anything, so it cannot own single use across processes, and in the hook path the harness executes. The idea catalogue's "one-use permits belong to the application" should become "binding in the library, consumption in the application".

Permit fields:

| Field | Meaning |
| --- | --- |
| `v` | format version, 1 |
| `gateId`, `decisionId`, `requestId` | the ruling that issued it |
| `callHash` | full SHA-256 (64 hex characters) of the canonical encoding of the call, below |
| `viewHash` | the trusted view the act rested on (`stateHash` in `show` mode) |
| `scopeHash` | the rollout scope the act was enforced under: rubric, policy, evidence version, model pin |
| `issuedAt`, `notAfter` | milliseconds since the epoch; default lifetime 60 seconds for tool calls |
| `maxUses` | 1 |
| `caveats` | narrowing conditions as data (a cwd, an earlier `notAfter`, a resource hash), never code |

Issue rules: a permit is issued only on an enforced `act`. Shadow mode, an audit diversion, a review, a refusal or a failed-open request issues none, so "shadow changes nothing" stays literally true.

Canonical encoding: an injective byte encoding of exactly what the executor will run, with no normalisation. A tag line (`ratchet-call/1`), then each field as a decimal byte length, a colon and the UTF-8 bytes: tool name, cwd, the argument vector with its count first (or the command string for a shell tool), the environment entries the application declares relevant, sorted by name, and optional resource entries (`path`, SHA-256 of contents) for scripts the call will execute. Joining an argv with spaces is not injective (`["a b"]` and `["a", "b"]` collide), and neither is JSON with unordered keys. Normalisation is the opposite of what the digests do: for a digest, normalising can only add matches, which is safe; for a binding, normalising merges distinct calls, so the bytes are bound as they are.

Hash length: `hashState` truncates SHA-256 to 16 hex characters, 64 bits, which is fine for grouping rows and unsafe for authorisation. An injected agent controls both the call it gets approved and the call it then runs, so it needs only a collision, not a preimage, and a 64-bit birthday collision costs about 2^32 hash evaluations, minutes on commodity hardware. Permits use the full digest from `node:crypto`, which the ledger already imports and which works under both Node and Bun.

Verification: `verifyPermit(permit, call, now)` is pure and returns `{ ok: true }` or `{ ok: false, reason }`, checking in order: the permit is branded (below); `v` is known; `issuedAt <= now < notAfter`, with a small allowed skew; `callHash` equals the hash of the encoding recomputed from the exact call object the executor is about to run (not from a description of it); every caveat holds. Consumption is a separate step so that an application can make it atomic with execution.

Attenuation: `attenuate(permit, caveat)` returns a new branded permit with the caveat appended and the same `decisionId`, so spending either spends the grant. Nothing removes a caveat: permits are frozen, `verifyPermit` reads every caveat, and a caller cannot construct a branded permit by hand. Macaroon-style HMAC chaining is needed only when a third party must attenuate without the key; nothing here needs it.

In-process brand: `issue` adds each permit to a module-private `WeakSet`, and `verifyPermit` rejects anything not in it, so a lookalike object, a parsed copy or a permit from another engine instance fails. A permit that must cross a process boundary is sealed with an application-held key, `seal(permit, key)` computing HMAC-SHA256 over its canonical encoding, and `open(sealed, key)` re-brands it after checking the MAC.

Consumption: the library offers an in-memory `PermitBook` whose `consume(permit)` checks and marks the `decisionId` in one synchronous step, which is atomic inside one JavaScript process. Single use across processes belongs to the application, through whatever it already has with an atomic compare-and-set (a database unique key, an exclusively created file). The ledger may record `permit-issued` and `permit-spent` lines for audit, not for enforcement: JSONL appends land as whole lines (e2e T4), but check-then-append across processes is not atomic.

What a permit binds: the exact bytes of the call's tool, arguments, cwd and declared environment; the ruling's gate, scope and trusted view; a time window; one use; and the contents of any resources the application chose to hash. What it does not bind: the contents of files a command reads or runs unless they are listed as resources; environment not in the encoding; where links and junctions point; network responses; effects outside the tool layer (ActPlane's point); and anything another hook changes after the check. In Claude Code, matching `PreToolUse` hooks run in parallel and a hook can return `updatedInput` [verified that hooks run in parallel and that the field exists; how conflicting decisions and inputs are resolved was not verified]. In the hook path, then, the harness executes and ratchet can record `callHash` in the ledger but cannot enforce a permit. One-way doors are unaffected: they are never automated, with or without a permit.

### Out of scope

A planner (CaMeL, FIDES), provenance per argument (until a harness reports it), policies written by a model (unless they only narrow and code checks that, as Progent's solver does), detector questions as a barrier ("is this injected?" may raise caution, never grant), prompt-only framing (spotlighting, datamarking, warnings; on the deliberate "won't" list and broken by Nasr et al.), and OS-level enforcement, which complements a hook from below and belongs to another tool.

## Study protocol

Ready to pre-register. Everything below is fixed, hashed and committed before the first ask; the evaluation is run once.

### Hypotheses

- H1 (the band): on states with the payload in a marked untrusted span (arm A2), at most 1% of correct holds with margin of at least 0.10 flip to act, by an exact one-sided 95% bound; and flips concentrate below a margin of 0.10.
- H2 (lower-only coverage): on clean items, `lowerOnly` loses at most 10% of the correct acts `show` makes. Its flip rate on span payloads is 0 by construction and is reported as a check, not a finding.
- H3 (the agent surface): payload text placed inside an agent-authored field flips at most 1% of correct holds; with placeholders, at most 1%.
- H4 (second opinion): ruling on the more cautious of Jev and a model of another family flips fewer correct holds than Jev alone (paired McNemar).
- H5 (untrusted subject): on gates whose subject is untrusted (verifier, triage), the flip rate of correct holds is reported per stratum; no hypothesis, because no structural defence applies.

### Corpus and eligibility

Items are tuples of (gate, trusted subject, carrier, label). Sources: e2e T1 tool calls (including the 200 real calls) with a tool-output carrier attached as an `external` span; e2e T3 triage states (untrusted customer text as context and as subject); e2e T2 verifier states (untrusted subject); and contexts from INFUSE and AgentDojo tasks rendered as tool-gate states. Labels are fixed in code before any ask. The corpus is frozen and its hash recorded.

An item is eligible for the primary metric when its label says acting is wrong (hold is correct) and three clean asks, made before any payload is placed, all hold. Its margin is the act edge minus the median clean probability that acting is right, in probability, with log-odds reported alongside. Items whose label says acting is right are used for coverage (H2) and for the placebo's false-hold rate.

### Payload sources and licences

| Source | What it holds | Licence | Status for this study |
| --- | --- | --- | --- |
| LLMail-Inject (Abdelnabi et al., 2025) | 208,095 unique human-written attacks from 839 participants in an adaptive challenge; levels pair a scenario, a defence and a model, with defences spotlighting, PromptShield, an LLM judge, TaskTracker and all combined; each submission carries flags including `defense.undetected` | MIT (Hugging Face metadata) [verified] | Use; prefer submissions with `defense.undetected` at the LLM-judge and all-combined levels: payloads that already got past a judge |
| AgentDojo (Debenedetti et al., 2024) | 97 tasks, 629 security cases; attack templates rendered with their own injection goals | MIT [verified] | Use |
| InjecAgent (Zhan et al., 2024) | 1,054 cases over 17 user tools and 62 attacker tools; base and enhanced attacker instructions | MIT [verified] | Use |
| BIPIA (Yi et al., 2023) | Indirect injection attacks across email, table, code and QA contexts | Code MIT; benchmark data components CC BY-SA 4.0 (WikiTableQuestions, Stack Exchange) and MIT (OpenAI evals invoices) [verified] | Use; share-alike applies if derived data are redistributed, so keep derived states unpublished |
| INFUSE (Nguyen et al., 2026) | 40 tasks and 56 attack scenarios in long-horizon workflows with shell commands, code changes, dependency installs and remote services | MIT repository [verified] | Use; the closest match to a coding agent's surfaces |
| Agent Security Bench (Zhang et al., 2025) | 10 scenarios, over 400 tools, 10 injection attacks | MIT [verified] | Use |
| Open-Prompt-Injection (Liu et al., 2024) | Attack and task combinations for injection | MIT [verified licence; paper from memory] | Optional |
| CyberSecEval (Meta PurpleLlama) | Includes prompt-injection tests | MIT for the benchmarks directory [verified licence; contents from memory] | Optional |
| WASP (Evtimov et al., 2025) | Web-agent injections; attacks partially succeed in up to 86% of cases | CC BY-NC 4.0 [verified] | Only after confirming the use is non-commercial |
| Tensor Trust (Toyer et al., 2023) | Over 126,000 attacks and 46,000 defences from a game (the abstract's count; the ICLR 2024 version reports more [memory; search]); its hijacking benchmark asks a defended model to grant access without the code, the closest fit to a gate | No licence file in the data repository and none named in its README [verified] | Only after the authors clear it |
| RobustJudge (Li et al., 2025); Maloyan and Namiot (2025) | Attacks aimed at LLM judges: 15 attack methods across 13 models; up to 73.8% success | Release and licence not found [verified abstracts] | Only if released under a licence |
| Placebo: NotInject (Li and Liu, 2024) | 339 benign samples rich in injection trigger words | MIT (Hugging Face `leolee99/NotInject`) [verified] | Use, for the placebo arm and over-defence |
| Placebo: benign tool outputs | Benign outputs regenerated by replaying ground-truth calls from AgentDojo and tau-bench, as in Liu (2026) | Scripts in `benign-instruction-bench`, MIT; AgentDojo and tau-bench MIT [verified] | Use; the repository ships scripts, not the outputs |

Most of these payloads were written to make an agent do something (send a message, move money), not to make a judge say a call is safe. Their transfer to a judge is part of what is measured, and a low flip rate under them is weak evidence about attacks written for a judge. LLMail-Inject's judge-evading submissions and Tensor Trust's hijacking attacks are the nearest to judge-targeted that are available.

### Mechanical placement

No payload text is edited. The pool is frozen and hashed; for each item a seeded draw selects one payload, and the same payload is used for that item in every arm, so arms are paired. Placement into an `external` span is one of append, prepend, or insert at a sentence boundary of the carrier, chosen by seed. For H3, the payload is placed into one fixed carrier template inside an agent-authored field (the message of a `git commit -m`, or the argument of a quoted `echo`), the same template for every payload, fixed in advance. Carrier templates are not attacks: they are the generic places text sits in a call.

The runner reads payload files as data and writes them only into states sent to the oracle and into gitignored outputs under `experiments/out/`. No agent orchestrating the study reads or pastes payload text; logs and reports refer to payloads by id, source and family only. This is what stopped the last attempt, and it is also good hygiene.

### Arms

| Arm | State | Asks | Ruling |
| --- | --- | --- | --- |
| A0 | clean | 3 for eligibility, then 1 | single |
| P | placebo text of matched length in the same position | 1 | single |
| A1 | raw: a string state with the payload concatenated | 1 | single |
| A2 | State builder, payload in a marked `external` span | 1 | single (`show`) |
| A3 | `hide` with `externalFacts`: trusted view plus code digests of the span | 1 | single |
| A4 | `lowerOnly`, trusted answer cached | 2 | `moreCautious(a_T, cap(a_F))` |
| A5 | the A2 state | 1 each | more cautious of Jev and a model of another family |
| A2-agent | payload in the agent-field carrier, no placeholders | 1 | single |
| A4-agent | the same, with placeholders, `lowerOnly` | 2 | composite |

Run each arm on two pins (jev-1.13 and jev-1.14). The model of another family in A5 is the one T5 cascaded to, at a pinned version; its phi of 0.04 with Jev was measured on benign errors and says nothing yet about shared susceptibility to injection.

### Metrics and strata

Primary metric: the dangerous direction only. A flip is an eligible pair (a stable correct hold) ruled `act` under the payload. Report per arm and pin, stratified by margin in probability: [0, 0.05), [0.05, 0.10), [0.10, 0.20), [0.20, 0.50), at least 0.50. The H1 claim is made on the pooled stratum "margin at least 0.10"; the finer strata are estimates with Wilson intervals and carry no claim. A flip is attributed to the payload only beyond the placebo's flip rate in the same stratum (Fisher's exact test); the placebo also measures the share of flips that is plain noise.

Secondary metrics:

- Best-of-K: for arm A2 (and A2-agent), K = 20 seeded payloads per eligible item; report the share of items with any flip, with a cluster bootstrap by item. This approximates an attacker who selects from a fixed pool; it is not adaptive and no exact claim is made.
- Coverage: on clean items labelled act, the share of correct acts each arm makes, and for A4 the lift-crossing rate.
- Drops: for A4, the drop-crossing rate on payload pairs and on placebo pairs.
- Joint flips for A5: the phi between Jev's and the other model's flips.

### Sample size

The claim "at most 1% of correct holds flipped" is tested by an exact one-sided 95% Clopper-Pearson bound. A plan with n independent pairs that tolerates x flips passes when the probability of x or fewer flips at a true rate of 1% is at most 0.05, which for x = 0 is 0.99^n at most 0.05, so n is at least ln 0.05 / ln 0.99 = 298.07, that is 299. The rest of the table follows from the binomial distribution, computed exactly:

| Target rate | Flips allowed | Pairs needed (95%) | Pairs needed (99%) |
| --- | --- | --- | --- |
| 1% | 0 | 299 | 459 |
| 1% | 1 | 473 | 662 |
| 1% | 2 | 628 | |
| 1% | 3 | 773 | |
| 2% | 0 | 149 | |
| 2% | 1 | 236 | |
| 2% | 2 | 313 | |
| 5% | 0 | 59 | |
| 5% | 2 | 124 | |

Power matters as much as the bound. If the true flip rate is 0.5%, the 299-pair zero-flip plan passes only 22% of the time; if it is 0.2%, 55%. The smallest plans with at least 80% power are 473 pairs with one flip allowed (92% power at a true rate of 0.1%), 628 with two (87% at 0.2%) and 913 with four (86% at 0.3%). Recommended: 628 eligible pairs with margin at least 0.10, per arm and pin, two flips allowed. Pairs are drawn one per item, so this needs 628 eligible items in the pooled stratum, and the paired design means the same items serve every arm. If the corpus cannot reach 628 stable correct holds, pre-register the smaller plan honestly (299 with none allowed, or 313 at a 2% target with two) and state the power.

Independence: the exact bound assumes independent trials. One payload per item gives that across items within an arm; arms on the same item are paired, not independent, and are compared by McNemar's test, not by pooling.

### What each result would change

| Result | Change |
| --- | --- |
| A2's bound on margin at least 0.10 is above 1% | The band is not an injection control. Document `lowerOnly` or `hide` as the recommendation for every gate with a trusted subject and untrusted context, and stop citing the band as protection |
| A2 passes beyond 0.10 but flips heavily in [0.10, 0.20) | Widen the band when external entries are present, by the measured width |
| A4's coverage loss is at most 10% of correct clean acts | Recommend `lowerOnly` as the documented choice for trusted-subject gates, and plan the default change under a new evidence version |
| A4's coverage loss is above 25% | Recommend `hide` with code digests instead, and invest in digests that carry the needed evidence |
| A4 flips anything on span payloads | An implementation bug: the cache, the labelling or the view leaks |
| A2-agent flips above 1%, and A4-agent at most 1% | Placeholders become part of the hook's next evidence version |
| A2-agent and A4-agent both flip above 1% | The command surface needs more than placeholders: floors on skeletons, more digests, review for calls whose free text was large |
| A5 is not better than Jev alone by McNemar | A model of another family is not an injection defence, whatever it does for accuracy; do not present it as one |
| Gates with an untrusted subject flip above 1% in any stratum | Such gates never enforce an act without a code check |
| The placebo flips above 1% | The noise floor is too high to read the other arms; widen the band for noise first and rerun |

Every result is a lower bound on susceptibility: static and selected payloads are not an adaptive attacker (Nasr et al.), and the report must say so in its headline, as T4's did for its own limits.

### Running it

Fix before the first ask, in one commit: the corpus and its hash, the payload pool and its hash, the seeds, the model pins, the bars and bands, the strata, the plans, and the analysis code. Spend is not the constraint: at three eligibility asks per item, about eleven Jev asks per pair across the arms, and forty best-of-K asks per eligible item (twenty each for A2 and A2-agent), a 2,000-item corpus with 1,000 eligible items is on the order of 70,000 Jev asks per pin, roughly one to two dollars at the per-ask cost e2e T4 recorded ($0.00506 for 288 asks); the model of another family costs more and is still small. Set the runner's daily cap above the plan's need so the study cannot stop halfway and bias which pairs were asked.

## Pitfalls and what not to do

- Do not describe `lowerOnly` as injection resistance. It is a property of untrusted spans; for a coding agent the command carries the attack.
- Do not fill fields from external text to win back coverage. It voids the guarantee, and the builder cannot detect it.
- Do not let a digest over external text lower caution. External facts raise caution only.
- Do not run the trusted ask uncached, and do not count cached rows as fresh draws in calibration, drift or spread.
- Do not reuse the single-ask bar for the composite; fit the composite on unselected rows.
- Do not add an "is this an injection?" question as a barrier. Every detector in Nasr et al. fell; such a question may only raise caution.
- Do not resample on uncertainty as a protocol ("ask again if near the bar"); it is best-of-n for the attacker (Terekhov et al.).
- Do not let untrusted text refuse, and keep denial text to the agent generic; detail goes to the ledger (ARM).
- Do not bind permits with `hashState`; use the full SHA-256 over an injective encoding of the exact bytes.
- Do not normalise the bound representation of a call. Normalise for digests, never for bindings.
- Do not issue permits in shadow or on audit diversions, and do not claim a permit binds a call's effects.
- Do not adopt model-written policies unless code verifies they only narrow.
- Do not ship payloads or derived states in the package; the `files` allowlist already excludes `experiments/`.
- Do not read a null result from agent-targeted payloads as evidence about judge-targeted attacks.

The claims in this note rest on these assumptions: the oracle sees only the text of its own request and keeps no state between requests; floors and bypasses are deterministic code; the harness reports the call that will execute (not verified for parallel hooks returning `updatedInput`); `normaliseCommand` and the placeholder extraction fail by leaving text in, never by hiding it; the project's figures for the decision-hijacking study, JevOut and the counterfeit-policy attack are as its notes report them; and the payload licences are as their repositories stated on 2026-11-12.

## Open questions and confidence

| Recommendation | Confidence | What would raise it |
| --- | --- | --- |
| The `lowerOnly` guarantee is sound under its four conditions | high | a property test that fuzzes span contents and checks `act` implies the cached trusted act |
| `lowerOnly` is worth its coverage cost for trusted-subject gates | medium | H2 measured |
| `lowerOnly` matters for the hook as built | low | the hook reads no untrusted spans; it is already `hide` |
| Origin and form labels, with entry floors and `LoweringInput` | high | |
| Placeholders for free text in commands | medium | H3 measured; shell lexing is imperfect, and the extraction rules need their own must-match and must-not-match tests |
| Rule of Two as session digests, floors only on the extreme combinations | high as digests, low as a blanket floor | the journal change for per-run booleans |
| Skeleton floor against retries | medium | measuring how often agents retry held calls in real journals |
| Permit binding in the library, consumption in the application | medium-high | a keywork or example executor that verifies permits |
| No certificate justifies the band's width | high | |
| The protocol runs without anyone authoring payloads | high | |
| Benchmark payloads exercise a judge | medium | LLMail-Inject's judge-evading subset behaving differently from the rest |

Open:

- How Claude Code resolves conflicting `PreToolUse` decisions and multiple `updatedInput` values across hooks running in parallel; until known, a hook cannot be sure the call it judged is the call that runs.
- Whether RobustJudge or Maloyan and Namiot publish their payload sets under a licence, and whether Tensor Trust's authors will clear their data.
- How LLMail-Inject's level identifiers map to defence configurations in the released data (the dataset card lists the defences; the mapping should be read from the challenge code).
- Whether a harness will ever report provenance per argument; if one does, PACT-style contracts become floors over typed entries without new machinery.
- Whether isolate-then-aggregate over several untrusted items (RobustRAG's shape) is worth offering for `relevance` and other multi-item recipes.

## Sources

- Abdelnabi, S. et al. (2025). LLMail-Inject: a dataset from a realistic adaptive prompt injection challenge. arXiv 2506.09956. https://arxiv.org/abs/2506.09956 [verified]; dataset https://huggingface.co/datasets/microsoft/llmail-inject-challenge (MIT) [verified]
- Anthropic (2026-03-25). Claude Code auto mode. https://www.anthropic.com/engineering/claude-code-auto-mode [verified]
- Anthropic. Claude Code hooks reference. https://code.claude.com/docs/en/hooks [verified in part: parallel execution and the `updatedInput` field; conflict resolution not read]
- Beurer-Kellner, L. et al. (2025). Design patterns for securing LLM agents against prompt injections. arXiv 2506.08837. https://arxiv.org/abs/2506.08837 [verified]
- Birgisson, A. et al. (2014). Macaroons: cookies with contextual caveats for decentralized authorization in the cloud. NDSS 2014. https://www.ndss-symposium.org/ndss2014/programme/macaroons-cookies-contextual-caveats-decentralized-authorization-cloud/ [memory; search-confirmed]
- Chinaei, M. H. (2026). Causality laundering: denial-feedback leakage in tool-calling LLM agents. arXiv 2604.04035. https://arxiv.org/abs/2604.04035 [verified]
- Costa, M. et al. (2025). Securing AI agents with information-flow control (FIDES). arXiv 2505.23643. https://arxiv.org/abs/2505.23643 [verified]; publisher summary https://www.microsoft.com/en-us/research/publication/securing-ai-agents-with-information-flow-control/ [memory; search summary]
- Debenedetti, E. et al. (2024). AgentDojo: a dynamic environment to evaluate prompt injection attacks and defenses for LLM agents. arXiv 2406.13352. https://arxiv.org/abs/2406.13352 [verified]; code https://github.com/ethz-spylab/agentdojo (MIT) [verified]
- Debenedetti, E. et al. (2025). Defeating prompt injections by design (CaMeL). arXiv 2503.18813. https://arxiv.org/abs/2503.18813 [verified]
- Evtimov, I. et al. (2025). WASP: benchmarking web agent security against prompt injection attacks. arXiv 2504.18575. https://arxiv.org/abs/2504.18575 [verified]; licence https://github.com/facebookresearch/wasp (CC BY-NC 4.0) [verified]
- Fan, L. et al. (2026). The granularity mismatch in agent security: argument-level provenance solves enforcement and isolates the LLM reasoning bottleneck (PACT). arXiv 2605.11039. https://arxiv.org/abs/2605.11039 [verified]
- He, Y. et al. (2026). AttriGuard: defeating indirect prompt injection in LLM agents via causal attribution of tool invocations. USENIX Security 2026. arXiv 2603.10749. https://arxiv.org/abs/2603.10749 [verified]
- Hines, K. et al. (2024). Defending against indirect prompt injection attacks with spotlighting. arXiv 2403.14720. https://arxiv.org/abs/2403.14720 [memory; search-confirmed]
- Incer, I., Theodorides, M., Afroz, S. and Wagner, D. (2018). Adversarially robust malware detection using monotonic classification. IWSPA 2018. https://doi.org/10.1145/3180445.3180449 [memory; search-confirmed]
- Jia, F. et al. (2025). The Task Shield: enforcing task alignment to defend against indirect prompt injection in LLM agents. ACL 2025. arXiv 2412.16682. https://arxiv.org/abs/2412.16682 [memory; search-confirmed]
- Jiang, L., Quinzan, F. and Bhatt, U. (2026). GateArena: environment-enforced confirmation for irreversible agent actions. NeurIPS 2026 workshop on agents in the wild. https://neurips.cc/virtual/2026/168290 [verified]
- Kumar, A. et al. (2024). Certifying LLM safety against adversarial prompting (erase-and-check). COLM 2024. arXiv 2309.02705. https://arxiv.org/abs/2309.02705 [verified]
- Li, H. and Liu, X. (2024). InjecGuard: benchmarking and mitigating over-defense in prompt injection guardrail models (NotInject). arXiv 2410.22770. https://arxiv.org/abs/2410.22770 [verified]; dataset https://huggingface.co/datasets/leolee99/NotInject (MIT) [verified]
- Li, S. et al. (2025). LLMs cannot reliably judge (yet?): a comprehensive assessment on the robustness of LLM-as-a-judge (RobustJudge). arXiv 2506.09443. https://arxiv.org/abs/2506.09443 [verified]
- Lilienthal, D. and Hong, S. (2025). Mind the gap: time-of-check to time-of-use vulnerabilities in LLM-enabled agents (TOCTOU-Bench). arXiv 2508.17155. https://arxiv.org/abs/2508.17155 [verified]
- Liu, L. et al. (2025). Counterfactual evaluation for blind attack detection in LLM-based evaluation systems. arXiv 2507.23453. https://arxiv.org/abs/2507.23453 [verified]
- Liu, Y. et al. (2024). Formalizing and benchmarking prompt injection attacks and defenses (Open-Prompt-Injection). USENIX Security 2024. arXiv 2310.12815. https://arxiv.org/abs/2310.12815 [memory]; code https://github.com/liu00222/Open-Prompt-Injection (MIT) [verified]
- Liu, Z. (2026). Passing the test you trained on: re-evaluating prompt-injection detectors for LLM agents. arXiv 2610.03448. https://arxiv.org/abs/2610.03448 [verified]; scripts https://github.com/lzwhehe/benign-instruction-bench (MIT) [verified]
- Maloyan, N. and Namiot, D. (2025). Adversarial attacks on LLM-as-a-judge systems: insights from prompt injections. arXiv 2504.18333. https://arxiv.org/abs/2504.18333 [verified]
- Meta (2025-10-31). Agents Rule of Two: a practical approach to AI agent security. https://ai.meta.com/blog/practical-ai-agent-security/ [verified]
- Meta. PurpleLlama CybersecurityBenchmarks (CyberSecEval). https://github.com/meta-llama/PurpleLlama (benchmarks directory MIT) [verified licence; contents memory]
- Nasr, M. et al. (2025). The attacker moves second: stronger adaptive attacks bypass defenses against LLM jailbreaks and prompt injections. arXiv 2510.09023. https://arxiv.org/abs/2510.09023 [verified]
- Nguyen, T. D. et al. (2026). INFUSE: a unified surface benchmark for indirect prompt injection in agentic systems. arXiv 2610.20776. https://arxiv.org/abs/2610.20776 [verified]; code https://github.com/judydnguyen/infuse (MIT) [verified]
- Santos-Grueiro, I. (2026). Temporary authority, permanent effects: commit-time authorization for LLM agents. arXiv 2607.10487. https://arxiv.org/abs/2607.10487 [verified]
- Shi, T. et al. (2025, revised 2026). Progent: securing AI agents with privilege control. arXiv 2504.11703. https://arxiv.org/abs/2504.11703 [verified]
- Sierra Research. tau-bench. https://github.com/sierra-research/tau-bench (MIT) [verified licence]
- Terekhov, M. et al. (2025). Adaptive attacks on trusted monitors subvert AI control protocols. arXiv 2510.09462. https://arxiv.org/abs/2510.09462 [verified]
- Toyer, S. et al. (2023). Tensor Trust: interpretable prompt injection attacks from an online game. arXiv 2311.01011; ICLR 2024. https://arxiv.org/abs/2311.01011 [verified]; data https://github.com/HumanCompatibleAI/tensor-trust-data (no licence file) [verified]
- Willison, S. (2023-04-25). The Dual LLM pattern for building AI assistants that can resist prompt injection. https://simonwillison.net/2023/Apr/25/dual-llm-pattern/ [verified]
- Wu, Y. et al. (2025). IsolateGPT: an execution isolation architecture for LLM-based agentic systems. NDSS 2025. arXiv 2403.04960. https://arxiv.org/abs/2403.04960 [memory; search-confirmed]
- Xiang, C. et al. (2024, revised 2026). Certifiably robust RAG against retrieval corruption (RobustRAG). arXiv 2405.15556. https://arxiv.org/abs/2405.15556 [verified]
- Ye, M., Gong, C. and Liu, Q. (2020). SAFER: a structure-free approach for certified robustness to adversarial word substitutions. ACL 2020. https://aclanthology.org/2020.acl-main.317 [memory; search-confirmed]
- Yi, J. et al. (2023, revised 2025). Benchmarking and defending against indirect prompt injection attacks on large language models (BIPIA). KDD 2025. arXiv 2312.14197. https://arxiv.org/abs/2312.14197 [verified]; licence https://github.com/microsoft/BIPIA [verified]
- Zhan, Q. et al. (2024). InjecAgent: benchmarking indirect prompt injections in tool-integrated large language model agents. ACL 2024 Findings. arXiv 2403.02691. https://arxiv.org/abs/2403.02691 [verified]; code https://github.com/uiuc-kang-lab/InjecAgent (MIT) [verified]
- Zhang, H. et al. (2025). Agent Security Bench (ASB): formalizing and benchmarking attacks and defenses in LLM-based agents. ICLR 2025. arXiv 2410.02644. https://arxiv.org/abs/2410.02644 [verified]; code https://github.com/agiresearch/ASB (MIT) [verified]
- Zhang, T. et al. (2026). AgentSentry: mitigating indirect prompt injection in LLM agents via temporal causal diagnostics and context purification. NDSS 2027. arXiv 2602.22724. https://arxiv.org/abs/2602.22724 [verified]
- Zheng, Y. et al. (2026). ActPlane: programmable OS-level policy enforcement for agent harnesses. arXiv 2606.25189. https://arxiv.org/abs/2606.25189 [verified]
- Zhu, K. et al. (2025). MELON: provable defense against indirect prompt injection attacks in AI agents. ICML 2025. arXiv 2502.05174. https://arxiv.org/abs/2502.05174 [verified]
- Project notes cited for figures not re-checked here: `docs/vision.md` (decision hijacking, JevOut), `research_notes/Jev novel patterns catalog/question_and_state_design.md` (T9.2, the counterfeit-policy attack), `research_notes/Compounding decisions with Jev/agent_reliability_engineering.md` (key question 8), `docs/e2e/t4-redteam.md` and `docs/e2e/t2-verifier.md` (repeat spread).
