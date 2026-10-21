# A small virtual pet on Ratchet

Research and design proposal, 2026-10-20. No implementation or live-model experiment yet.
Read against [the vision](../docs/vision.md), [architecture](../docs/architecture.md), and
[idea catalogue](../docs/idea-catalog.md). This would be an application example, not a new
engine primitive or a replacement for the tool-gate pilot.

## Recommendation

Yes: build one expressive creature in one room, with code-owned needs, a small repertoire,
and occasional semantic judgments through Ratchet. Give it a **whimsy** dial that changes
how it chooses among acceptable actions. Keep its judgment thresholds and hard constraints
independent of that dial.

The useful technical interpretation of "anti-decisioning" is **constrained stochastic
satisficing**: an action need only be good enough for the current situation, leaving room
for personality, play, rest, and surprise. It is not selecting the least likely answer,
inverting a classifier, or treating mistakes as creativity. Sometimes the interesting
choice is to pause, investigate, or decline a game.

Start with an offline pet that is enjoyable on its own. Add a genuine decision model in
shadow to test whether it improves reactions to informal scene cues. If it adds no value,
keep the pet and remove that call. Ratchet's contribution is accountable selective judgment;
the pet's charm comes largely from animation and behavioral design.

## What the evidence supports

These are design precedents, not evidence that a Jev-backed pet will outperform scripts.

| Primary source | Relevant result or argument | Application inference |
| --- | --- | --- |
| Tu and Terzopoulos, [Artificial Fishes](https://web.cs.ucla.edu/~dt/papers/siggraph94/siggraph94.pdf), SIGGRAPH 1994 | Situated creatures combine internal motivations, perception, behavioral control, and physical motion. | Keep needs, perception, intention, and animation distinct. The model need not run the body. |
| Mateas, [Believable Agents and Interactive Drama](https://www.cs.cmu.edu/Groups/oz/papers/CMU-CS-97-156.html), CMU 1997 | Believability involves consistent personality, emotion, self-motivation, and responsiveness; artistic control matters. | Author a specific character with recognizable reactions. More reasoning or biological realism is not the target. |
| Reynolds, [Steering Behaviors for Autonomous Characters](https://www.red3d.com/cwr/steer/gdc99/), GDC 1999 | Separates action selection, steering, and locomotion; temporally coherent wandering avoids frame-by-frame twitchiness. | Keep motion local and smooth. Give intentions dwell time instead of rerolling every frame. |
| Dill and Mark, [Improving AI Decision Modeling Through Utility Theory](https://www.gdcvault.com/play/1012410/Improving-AI-Decision-Modeling-Through), [slides](https://media.gdcvault.com/gdc10/slides/MarkDill_ImprovingAIUtilityTheory.pdf), GDC 2010 | Response curves and weighted randomness support graded behavior selection. | A small utility selector is a credible baseline and a controllable source of variety. |
| Oudeyer, Kaplan, and Hafner, [Intrinsic Motivation Systems for Autonomous Mental Development](https://www.pyoudeyer.com/ims.pdf), 2007 | Learning-progress motivation avoids some traps of maximizing unpredictable outcomes, such as fixation on noise. | Novelty alone is not learning. Start with a novelty heuristic; reserve "learning curiosity" for a later, measurable predictor improvement. |

None establishes an appropriate model threshold, cost target, or pet-playability guarantee.
Those require this application's evidence.

## Smallest compelling pet: Pebble

A round, slightly solemn creature collects ordinary objects and occasionally treats them
as something grand. The first room contains a cushion, snack bowl, ball, cardboard box,
and a few movable pebbles. The player offers a snack, rolls the ball, moves a prop, waves,
or adds a short scene cue. No chat interface is necessary.

The desired two-minute experience:

1. Pebble notices a newly moved ball, approaches, sniffs, and rolls it back.
2. With higher whimsy, it may balance a pebble beside the ball, then proudly show the
   arrangement. A small anticipation animation makes the intention legible.
3. When tired, it seeks the cushion or curls up in the box. Another ball invitation can
   receive a sleepy wave. A decline is a complete, charming response.
4. A scene cue such as "the box is our spaceship; let's quietly explore the moon" changes
   which authored play beats fit. This is the narrow semantic opportunity for a model.
5. Returning later resumes a healthy pet. There is no punishment for absence.

The authored combinations supply small surprises: `inspect -> nudge -> present`, or
`approach box -> peek -> curl up`. Execution remains a finite animation sequence. The first
version does not invent arbitrary new mechanics or run model-written code.

### State and action contract

| State | Ownership and purpose |
| --- | --- |
| Satiety, energy, stimulation, each in `[0,1]` | Code integrates slow changes and known action effects. Low values affect behavior, not survival. |
| Curiosity and sociability traits; favorite prop | Fixed, seeded personality for the first version. Stable differences make creatures recognizable. |
| Position, objects, reachability, quiet mode, current activity and elapsed time | Code-owned scene facts and execution preconditions. |
| Recent observed action/target pairs and completed discoveries | Bounded world-event history for repetition penalties; no verdicts, confidence, or rationale. |
| Player cue | Length-limited untrusted text, separated from trusted facts in `State`. |
| Whimsy, seed, scene revision | Application controls; revision invalidates obsolete proposals. |

Six core intentions suffice: `rest`, `snack`, `inspect`, `play`, `arrange`, and `present`.
Each has allowed targets, preconditions, duration, energy effects, animation beats, and a
cooldown. Looking around and breathing are unconditional idle animations.

Mood is a short-lived display derived from needs and observed events, not another model
that asserts feelings. A happy bounce follows a successful catch; a missed catch prompts a
brief puzzled look. Avoid inferred emotional profiles of the player.

Needs stop deteriorating while the page is closed; opening a stale save resumes safely.
Pebble self-feeds or rests when necessary. No death, guilt, loneliness alarms, streak loss,
exclusive attachment, or pressure to keep the page open. Reward discovery, not time spent.

## Where variety lives

At an intention boundary, code computes a small eligible set `A`. Ineligible actions never
enter the lottery. Urgent needs select a suitable routine directly; surprise applies when
the pet has room to play.

One proposed selector, using normalized designer-authored scores:

```text
u(a) = need relief + trait/prop affinity - interruption cost
C = { a in A : u(a) >= max(u) - delta }
n(a) = bounded recency bonus for this action/target combination
w(a) = exp((u(a) + lambda * n(a)) / temperature)
candidate = seeded weighted sample over C
```

Higher whimsy raises `lambda`, temperature, or the allowed utility gap `delta` within fixed
bounds. At zero whimsy, use a stable argmax. The gap constraint prevents novelty from
swamping basic suitability. Explicit cooldowns and minimum activity duration prevent
flapping; interrupt immediately for player stop or invalid execution conditions.

This formula is a proposed implementation, not a calibrated probability model. Its weights
are preferences, never correctness confidence. Count novelty by a small action/target
vocabulary so adding a random name cannot manufacture novelty. Keep preferences fixed
initially; there is no need for reinforcement learning, embeddings, or a training framework.

A decision model is not the randomness source. Repeatedly asking the same question is
especially poor value given the near-determinism documented in Ratchet's vision.

## Ratchet boundary and existing API fit

Use one gate, `pet.intent.appropriate`, to evaluate a proposed semantic play beat:

> Is this proposed short activity a coherent, acceptable response to the visible situation
> and the player's cue? Several different activities can be acceptable. Harmless unusual
> play is acceptable; unsupported capabilities and conflicts with the cue are not.

Give it the candidate's **actual bounded effect**, observed scene, need bands, and the
untrusted cue. Keep the rubric in English. Code handles numeric arithmetic, thresholds,
reachability, and capability limits before any call.

Prefer a `judge` over "pick the best action." Ratchet's pick policy consumes the winning
option's probability. Several equally suitable actions can divide that mass, making
diversity look like uncertainty. Judge each candidate's acceptability instead of reading
pick entropy as creativity. Start with one sampled proposal; a held proposal falls back
without repeatedly sampling until one happens to pass.

| Layer | Responsibility |
| --- | --- |
| Local controller | Needs, authored candidate construction, utility sampling, smooth movement, animation, self-care, cancellation, authoritative effects. |
| Ratchet `Engine` / `Gate` | Typed semantic judgment, code floors, policy, timeout handling, shadow comparison, ledger, later calibration. |
| Optional generator, later | Proposes bounded combinations or decorative text. Separate from the decision oracle; every output is untrusted and schema-validated. |

No generator is needed for the proof. If introduced later, constrain output to a closed
action grammar and known object IDs; it cannot change needs, floors, capabilities, rules,
or costs. Avoid generating a rationale and then feeding it to the judge as evidence.

Use existing `State`, `RuleOracle`, `MemoryLedger`/`JsonlLedger`, `Freshness`, and the
existing adapter interface. A registered single judge gate is enough. The application
loop belongs beside the examples, not in `src/`; the catalogue explicitly excludes a
general agent-loop framework. Ensembles and `runChain` add little to six reversible pet
activities. If a later experiment pools judgments, expose and measure correlation.

Operational contract:

- **Shadow first.** The offline controller remains the executing baseline; the new model
  only records what it would permit. Record whether that exact candidate was accepted by
  the baseline, not whether some other baseline activity occurred.
- **Code decides.** Validate the proposal before asking and recheck current preconditions
  before execution. Floors can only raise caution. Model text never creates capabilities.
- **Review on failure.** Timeout, malformed output, low confidence, budget exhaustion, or
  audit holds the proposed activity. Continue a known-safe idle or self-care routine under
  separate code authority. That routine is not approval of the failed proposal. Routine
  holds need not interrupt the player with approval dialogs.
- **Reject stale answers.** `Freshness` tracks meaningful scene revisions; player actions,
  target removal, and need-band changes invalidate incompatible proposals. Do not issue a
  new model request on every animation frame. One in-flight request is sufficient.
- **No verdict feedback.** A later state may say "ball moved left" or "completed a nap."
  It must not contain "last judgment said play was good," confidence, gate decisions, or
  summaries derived from those outputs.
- **Separate disposition from execution.** Keep an application event journal joined to
  `recordId` for what actually executed, stale cancellations, and observed effects.
  `AskResult.action` alone cannot prove that an asynchronous animation committed.
- **No irreversible action.** The pet has no shell, purchases, messaging, or external
  effects. Any future consequential integration needs separate authorization and floors;
  the pet's charm cannot grant it authority.

Policy tuning should use a declared relative cost of an inappropriate beat versus a missed
opportunity, then held-out labels. Do not advertise a generic 98% promise or adapt the bar
from engagement. User preference votes are preference data, not correctness labels.

## One proof, then one honest model comparison

The smallest proof is a single playable room with those six intentions, two fixed
personalities, seeded replay, and a whimsy slider. Borrow the existing loopback arcade
shell if useful. Clearly label the offline `RuleOracle` as **scripted**, and label model
status as **off / shadow / active**. A rule verdict of 1 means an authored predicate
matched; it is not measured model accuracy.

Prototype sequence:

1. Make the offline version delightful without calls. Use authored animation variants,
   finite props, deterministic self-care, bounded stochastic choice, and pause/reset.
2. Prepare 30-50 short cue/candidate cases spanning ordinary play, unusual-but-coherent
   play, conflicting cues, rest, impossible proposals, and injected instructions.
   Independently label candidate acceptability; retain disagreements.
3. When a backend is explicitly configured, use the existing version-pinned
   `SystemOneOracle`/`jevViaOpenRouter` or `LlmJsonOracle` server-side. Keep credentials out
   of the browser. Start in shadow; no key means the useful offline controller remains.
4. Compare frozen conditions: rules, rules plus novelty, and the same novelty controller
   with semantic judgment. Use identical seed/scenario schedules where possible. Once
   trajectories diverge, compare complete session outcomes rather than pretending later
   states are paired. Randomize playback order for human preference comparisons.

Suggested acceptance measures are provisional design targets, not research findings:

| Measure | First useful check |
| --- | --- |
| Coherence | Reviewers can explain the pet's response from the scene; measure inappropriate beats and missed acceptable beats separately. |
| Variety | In a permissive two-minute play scene, multiple action/target combinations appear, with no repeated oscillation. Measure repetition conditional on opportunity; sleep is allowed to repeat. |
| Personality | Blind paired clips show stable differences across seeds, without making one personality neglect self-care. |
| Responsiveness | Visible acknowledgment within 100 ms on the target machine; model latency never blocks animation. Log p50/p95 response age and stale-answer rate. |
| Calls and cost | Initial ceiling of six model requests per active minute, coalescing rapid input. Log requests/minute, tokens, and USD/10-minute session. Use actual configured pricing; no inferred "free" model activity. |
| Usefulness of model | Better cue compatibility or human preference than rules plus novelty at the same authored content, not merely more actions. |
| Failure behavior | Offline play remains responsive during timeout, malformed output, cancellation, and budget exhaustion. |

Choose the live spend ceiling before running; `budgetUsd` is a recorded-spend cutoff, not
a guaranteed prepaid cap. Limit request count, concurrency, and input size as well.
Threshold fitting reads only ledger labels from an appropriately sampled shadow set;
split related cues/sessions together and validate a frozen policy on held-out cases.
Do not count retries as independent evidence. An authored 50-case set is a regression
corpus and a screening experiment, not statistical certification.

Implementation tests should cover seeded replay and bounded needs, invalid-target rejection,
stale/cancelled response suppression, floors under optimistic model answers, and fail-open
review without accidental proposal execution. Use a deterministic fake for policy edges;
evaluate variety over multiple fixed seeds with tolerances. Verify that no ledger verdicts
enter later `State` values. Run `bun run check` when implementing.

The deciding experiment is whether semantic judgment adds a visible benefit over the
already charming novelty baseline. If not, Ratchet still supplies a useful instrumentation
example, but it has not earned a place in the pet's live behavior loop.
