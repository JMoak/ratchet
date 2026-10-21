# Pebble: earning a second and third visit

Research and design recommendations, 2026-10-20. This note changes no application code.
It focuses on repeat-session experience and evaluation; tactile implementation and detailed
relationship memory are separate workstreams. The intended outcome is compelling, voluntary
return with an easy stopping point. It is not maximum time spent.

## Recommendation

Make the next slice a **small co-play pet**: one satisfying, repeatable game using the ball,
stones and box, followed by one recognizable shared routine that survives a return. Preserve
the quiet, self-sufficient creature around that game. Test whether people want the experience
again before adding more objects, currencies, rooms, dialogue, or unlock trees.

The useful progression is from **seeing a response**, to **making something together**, to
**recognizing something that is ours**. That is a design hypothesis, not an established
retention formula. A few excellent visits can also be a successful small toy; perpetual use
is a separate product ambition requiring longer evidence.

## What the current prototype does and where it may run out

Reviewed `C:/src/pebble/README.md`, `src/world.ts`, `docs/character-audit.md`, its `AGENTS.md`,
and [the original proposal](virtual-pet.md), against Ratchet's vision and architecture.

- There are six intentions, two authored personalities, three themes, three variants per
  intention and seven discoveries. The discoveries record completed categories; they do not
  open a new interaction. `completed` supplies no substantial progression.
- The last twelve observed action/target pairs discourage repetition. They are a short
  behavioral context, not a developing relationship. The new arrange/present and inspect/play
  pairs improve continuity within a visit.
- Scene positions and the stone arrangement persist. This already provides a useful anchor
  for returning. Pausing when absent and self-care make occasional visits viable.
- Most prop effects remain separate. Moving stones does not yet make the ball game behave
  differently. A memory of a shallow interaction can preserve its repetition without making
  it more enjoyable.
- The character audit establishes more connected completed action pairs and saved trajectory
  fidelity. It explicitly does not establish recognizable personalities, fun, attachment or
  voluntary return.

**Likely failure mechanism:** a player tests the buttons, recognizes the animation families,
collects some labels, and cannot answer “what would I try next?” A second session can feel
like replaying the first. This may happen within a few visits for an exploratory player, but
there is no measured Pebble timeline. A person enjoying calm ambient company may value the
same familiar repertoire, so repetition alone is not failure.

## Evidence and limits

The sources below support questions to test. None measures Pebble or proves a recipe for an
“addictive” pet. Creator accounts describe intent and experience, not controlled effects.

| Source and evidence type | What it establishes | Use for Pebble, with the boundary |
| --- | --- | --- |
| Ryan, Rigby and Przybylski, 2006, [The Motivational Pull of Video Games](https://selfdeterminationtheory.org/SDT/documents/2006_RyanRigbyPrzybylski_MandE.pdf). Four empirical studies, chiefly associations between measured experience and outcomes. | Perceived autonomy and competence relate to enjoyment and preference; one study includes an immediate free choice to continue a game. The multiplayer survey's future-play measure is intended future months, not observed long-term retention. | Test whether players understand their influence and choose their own experiments. Do not claim that adding a choice causes retention. Relatedness toward other human players is not a validated measure of attachment to this creature. |
| Mekler et al., 2017, [Towards understanding the effects of individual gamification elements on intrinsic motivation and performance](https://edoc.unibas.ch/entities/publication/ccec8ccc-aa54-417d-b205-334b518d6eed). Controlled online experiment on an image-annotation task. | Points, levels and leaderboards increased output quantity; the study did not find corresponding significant gains in intrinsic motivation or competence. | More inputs or completed discoveries can reflect incentives rather than enjoyment. This does not prove rewards never help a game; it is a reason to measure experience separately from activity. |
| Tyack and Mekler, 2024, [Self-Determination Theory and HCI Games Research: Unfulfilled Promises and Unquestioned Paradigms](https://arxiv.org/html/2405.12639v1). Critical review of 259 HCI papers plus practitioner discourse; cited version is a preprint. | The review identifies shallow theory use, untested causal design claims and measurement problems, including conflating PENS constructs with intrinsic motivation. | Use autonomy, competence and relatedness as prompts for inquiry, not a checklist that certifies fun. Ask specific questions and observe behavior; do not produce a single “motivation score” or claim our custom questions are validated PENS. |
| de Jong et al., 2024, [Children's Acceptance of a Domestic Social Robot](https://dare.uva.nl/id/c6ac85b7-724e-4e07-9fc0-9b94e7afe8f5). Longitudinal observational panel: 321 children aged eight to nine, Cozmo at home for eight weeks. | Acceptance declined, particularly after two to four weeks; discontinuing and resuming both occurred. Observed and reported use differed. Competing toys and lacking motivation were prominent non-use reasons. | Collect actual returns, include non-users, and ask what displaced Pebble. Do not import the decline timetable or effect size into an adult browser toy. Scheduled research participation is also different from organic adoption. |
| Abendschein, Edwards and Edwards, 2022, [Novelty Experience in Prolonged Interaction](https://www.frontiersin.org/journals/robotics-and-ai/articles/10.3389/frobt.2022.733078/full). Qualitative interviews with nine adults after six weeks with a robot kitten during pandemic isolation. | Novelty and familiarity were not a simple one-way decline. Social encounters could renew or diminish interest, and some participants valued simplicity and predictability. | Ask whether a repeated routine is comforting or stale. Do not assume every session needs new content, infer health benefits, or generalize a small, unusual-context interview sample to retention rates. |
| Nintendo, 2012, [Iwata Asks: A Fresh Start for Animal Crossing](https://www.nintendo.com/en-za/Iwata-Asks/Iwata-Asks-Animal-Crossing-New-Leaf/Animal-Crossing-New-Leaf/1-A-Fresh-Start-for-Animal-Crossing-738583.html). Official creator interview. | The creators describe expanding customization so players can express themselves through an entire town and make others' towns interesting to visit. | A player-authored arrangement can carry more meaning than another collectible count. This is a design precedent; it does not show which feature caused the game's success or justify reproducing its content scale. |
| Adam Robinson-Yu, 2021, [Crafting a tiny open world](https://blog.playstation.com/2021/08/05/crafting-a-tiny-open-world-a-look-behind-the-scenes-at-the-creation-of-a-short-hike/). Creator's own account. | The creator describes a clear destination, freedom to take other paths, rewarded curiosity, and small activities that vary the pace. | Give a visit a satisfying small completion while leaving optional experiments available. This is an existence example of focused authorship, not evidence that a short game and a returning desktop pet share retention mechanisms. |

## Small progression without a content treadmill

The concrete candidate from the tactile workstream is **ball + stones that affect its path +
box that can catch it**. Its exact rules need playtesting. The longitudinal design should use
that shared physical game instead of placing a reward economy around existing disconnected
buttons.

1. **Discover an affordance.** The player learns that moving a stone changes a result. Keep
   consequences legible and reproducible enough to invite a deliberate second experiment.
   A random outcome with a new caption is not equivalent.
2. **Choose a little project.** The player makes a simple course, a doorway or a box goal.
   There is no prescribed optimum, score requirement or grind. Use a very small set of
   supported arrangements and reactions before considering general-purpose physics.
3. **Make it familiar.** Preserve the actual layout. After an observed shared success, Pebble
   can later make one grounded invitation using that course, or repeat a familiar opening
   move. Remember completed world events and explicit player choices, not inferred feelings.
   This can be a bounded authored rule; do not market it as general learning.
4. **Reinterpret it.** The player can change one prop or theme and see a meaningful variation.
   The moon/ocean themes are useful only when they change a visible play beat or framing the
   player enjoys. Text permutations alone do not provide deep replayability.

Keep the remembered routine small: one current course or ritual is sufficient for the first
test. The memory workstream should define exactly what earns it, how the player changes it,
and how incorrect recall is prevented. No relationship level, weakening bond, obedience
upgrade, emotional profiling, or increased care requirement is needed. The pet should still
have its authored personality and sometimes choose an appropriate quiet response.

Discoveries can become optional records of things that actually happened, with a small scene
thumbnail or a concise event description. Do not lead with seven empty slots, a completion
percentage or a promise of infinite discoveries. Do not expand a journal into a second feed
the player must maintain. A preserved room and one visible routine may be sufficient.

All opportunities can be available in one visit. The following arc describes likely learning,
not content locked behind visit counts or elapsed days.

| Moment | Player experience to aim for | Evidence that would count |
| --- | --- | --- |
| First minute | One obvious invitation: try rolling the ball. Pebble visibly notices, a coherent response completes, and the player can alter something to try again. If the player watches instead, one quiet demonstration makes the possibility legible. | The player can explain what their action changed and initiates a second experiment without coaching. A smile is useful context, not the sole measure. |
| First session, roughly 3–8 minutes if wanted | The player completes a tiny self-chosen course or arrangement. Pebble contributes a specific response. The scene visibly retains the result, and stopping now feels complete. | They describe a particular enjoyable moment, deliberately repeat or change a setup, and can leave without believing that progress or pet welfare is at risk. |
| Third voluntary session, whenever it occurs | The familiar scene is immediately recognizable. Pebble makes an earned reference in action to the shared course. The player can enjoy the ritual, change one element, or simply sit with the pet. | They recognize the connection without an explanatory prompt and choose a familiar or modified interaction. A peaceful short visit is a valid outcome. |

The central uncertainty is whether familiarity has acquired value. No amount of seeded
sampling guarantees this. If the same game is pleasant only once, more recall text will not
fix it. If the game is enjoyable repeatedly but the memory is unnoticed, ship the game and
defer the memory system.

## Graceful stopping

Keep the existing absence pause and self-care. Closing midway remains safe and resumable.
After a completed exchange, allow a natural settling beat with no immediately urgent next
request. A player may keep playing; the system does not need to announce that a session is
over. Preserve the room and optionally acknowledge the finished shared activity once.

Do not use streaks, expiration, absence guilt, lost progress, hunger alarms, time-gated gifts,
paid randomness, artificial scarcity, escalating rewards, or reminders to create return.
Do not present an incomplete objective at the exact point a player tries to leave. A curiosity
cue should describe something available to try now or later, with no cost to ignoring it.

## Co-play pet or passive desk companion?

**Prefer co-play as the next build target**, because a small physical system can give the
player influence over repeatable outcomes without requiring endless authored content. It
also gives relationship memory a concrete shared event to refer to. The current browser room
and pause-when-hidden behavior make this more directly testable than a permanently present
desktop companion.

That does not settle the product direction. Passive company has a different success condition:
the person likes having this creature nearby, it does not disrupt their main activity, and
its familiarity is welcome. Low interaction frequency can be entirely appropriate. A quiet
person who returns to watch the same wiggle is not less successful than someone building a
new course.

The hybrid fails if every ambient moment advertises a task, or if every playful invitation
requires watching a long routine before anything happens. Keep the ambient tone and test
whether invitations fit it. Ask existing companion enthusiasts specifically whether the
new game makes the room feel more alive or more demanding.

Resolve the focus with observed use in context: do participants deliberately open Pebble for
a short break, keep it visible beside their real work, or do neither? At interview, examine
the actual returns and ask what they wanted on each occasion. Strong satisfaction with calm
presence and little course replay is evidence for a companion direction, not proof of a
failed product. Conversely, long unattended browser uptime is not evidence of companionship.
Do not add a focus timer or productivity system merely to justify passive presence.

**Strongest objection to the combined proposal:** a causal toy followed by a learned ritual
may optimize the wrong pleasure. A pet can be appealing because it seems to have a small
life of its own; a course-building puzzle can make it feel like a tool that performs the
player's solution. Repeated success can then become mastery work, and a “personal” ritual
can simply automate an already-solved puzzle. More causal depth is not automatically more
companionship. Keep one playful exchange optional, preserve independent behavior, and accept
an ambient-first result if that is what people actually enjoy. Do not require course mastery
to earn the creature's warmth or familiar greeting.

## Lean research protocol

Recruit **six adults**, allowing five to eight if recruiting is constrained. Include people
who enjoy small interactive games and people who already like ambient companions; do not
recruit only developers or friends invested in pleasing the team. This is a formative study,
not a representative retention estimate. If compensated, payment is fixed and independent
of opening the app, duration, positive feedback or returning for optional play.

### Phase 1: isolate immediate play, about 20 minutes per person

Compare the present interaction with the small causal ball/course candidate. Keep appearance,
personality, available controls and content as similar as possible; disable developing
relationship behavior in both. Alternate order across people and use neutral version labels.
Allow about four minutes per version, shorter if they want to stop. Give the same minimal
instruction: explore as much or as little as desired. Observe before asking for explanation;
constant think-aloud can destroy the rhythm being tested.

Then offer a genuine choice: revisit either version briefly, or finish. Record the choice
and what they do, not just which they say they prefer. Ask which moment was enjoyable,
confusing or disappointing and have them show one intended change to the ball outcome.
Order and fresh-feature novelty remain confounds; this comparison screens a candidate,
not long-term preference.

If the candidate does not improve intentional play or enjoyment, revise it before fielding
memory. Do not spend a week measuring retention for a mechanically weaker toy.

### Phase 2: ten days available, several visits only if wanted

Give everyone the same frozen tactile build that passed Phase 1. Keep one room per person
and preserve the scene in every condition. Randomly allocate half to the one earned shared
routine and half to the same play with ordinary scene persistence but no developing routine.
Keep the amount and quality of unrelated content equal. Do not tell participants that one
condition is smarter or more personal. This small split is for mechanism diagnosis: three
people per condition cannot establish a reliable memory effect.

Setup and the exit interview are scheduled research contacts. All intermediate app use is
optional: explicitly say that never reopening is useful feedback. No daily tasks, quotas,
study reminders, bonus compensation, content drops, or request to “try session three.” The
researcher may resolve a reported technical problem; mark any resulting use as prompted.
Do not replace a non-returner with a more enthusiastic recruit.

Use consented, minimal local event logging: app opens, visibility changes, inputs, completed
physical outcomes, remembered-routine presentations, resets, and save/restore failures.
Distinguish user-initiated openings from refreshes, automatic loads and research contacts;
review ambiguous openings with the participant at exit. A session boundary of 30 minutes
away is a reporting convention, not a rule the product enforces. Keep short greetings;
do not require an interaction to count an intentional companion visit.

Do not record other applications, keystrokes outside Pebble, raw personal cue text, or infer
the person's mood, attachment vulnerability or behavioral profile. Logging opens provides
no reliable observation of gaze. Mark data missing when logging fails.

Offer an optional short study note after actual visits, never as an invitation to return.
Ask how enjoyable the visit was and whether anything specific was pleasant, dull or
confusing. If using 1–7 items, keep enjoyment, control and pressure to continue separate;
these are exploratory custom items, not validated scales. Notes themselves can influence
behavior, so record their use and rely also on the exit interview and event history.

### What to collect and what it means

| Question | Observable or elicited evidence | Avoid this mistaken proxy |
| --- | --- | --- |
| Did the toy feel good immediately? | An intentional second attempt; a chosen variation; explanation of the result; version chosen when stopping is allowed; a specific enjoyable moment. | Number of clicks or speed of completing instructions. |
| Did it earn returns? | Counts of people making a second and third unprompted visit, their days and lengths, plus non-return reasons. Distinguish quick greetings, active play and reported ambient use. | “I would use it,” automatic reloads, researcher-requested play or background uptime. |
| Did persistence matter? | Unprompted recognition of the preserved scene/routine; intentional return to a shared setup; a correctly recalled moment tied to an actual event; explanation that this influenced a return. | Generic “cute,” noticing a new sentence, or the researcher explaining the memory. |
| Did the pet become particular? | Their own description of this Pebble's habit and a concrete incident; optionally, their preference to keep this scene versus start fresh, with no actual deletion. | A demanded affection rating, willingness to keep caring for it, or naming alone. |
| Is familiarity welcome? | Whether a repeated response is called pleasant, comforting, predictable, boring or irritating, with an example. | Assuming every repeated animation is a defect. |
| Is stopping comfortable? | Their reason for ending; whether they believed anything bad would happen; reports of staying longer than wanted; immediate ability to close safely. | Treating the longest session as best. |
| Which product fits? | Purpose of each intentional visit; actual use alongside work; specific reports of delight or interruption from ambient behavior. | Treating non-interaction as disinterest, or uptime as attention. |

At exit, ask for a remembered event before showing the log, then compare it with the log.
Ask non-returners what they expected and what they chose instead. Ask everyone what one
thing they would remove. A participant who liked Pebble but forgot it is different from
one who found it repetitive, one who wanted passive presence, and one whose save failed.

### Freeze go/change/stop decisions before the sessions

These are pragmatic investment rules for a six-person pilot, not statistical significance
thresholds or published benchmarks. If the cohort size changes, choose the count targets
before inspecting outcomes. Report individual trajectories and denominators, not p-values
or a precise population retention percentage.

- **Proceed with the tactile candidate** if at least four of six can deliberately produce
  and vary a meaningful result without coaching and at least four choose to revisit it over
  the baseline or stopping. Check their reasons: selecting a new-looking version alone is
  weak evidence. If choices are mixed, prefer the simpler version until a specific cause is
  clear.
- **Continue one more iteration on voluntary co-play** if at least four of six make two
  later unprompted visits on at least two distinct days, and at least three describe a
  specific enjoyable act they deliberately repeated or varied. This is evidence worth
  investigating, not proof of durable demand. Short satisfied visits qualify.
- **Keep the memory investment small** unless at least two people exposed to it recognize
  the correct shared routine without explanation and demonstrate why it matters. Compare
  their accounts with the ordinary-persistence group, but make no causal claim from this
  tiny split. If it is invisible, confusing or merely decorative, fix or cut it before
  adding more memory categories. Wrong recall is a defect, not creative personality.
- **Change the product emphasis** if people willingly keep returning for ambient comfort
  while rarely replaying the course. Test whether the play controls can remain unobtrusive;
  do not fail them against the co-play repetition target. If both contexts attract distinct
  people, choose a primary audience before adding a new mode or feature set.
- **Stop adding content and diagnose** if at most one person makes a third voluntary visit,
  or most can offer no enjoyable moment after the first encounter. Investigate setup friction,
  unclear control, repetition and competing uses separately. Repair a dominant fault and
  rerun a focused slice; adding ten discoveries is not the default response.
- **Remove a pressure mechanism immediately** if it causes a participant to believe absence
  harms Pebble, costs progress, or requires attention they do not want to give. One clear
  counterexample warrants a design correction; no significance test is necessary.

A ten-day pilot detects obvious friction and early loss of interest. It cannot establish
months of attachment. If the mechanisms look promising, offer a separate four-week
continuation with the same voluntary-use terms and no feature drip. Make no automation or
reminder for that continuation without a separate request. Logs and interviews should retain
periods of non-use and resumption instead of declaring a person permanently “churned.”

## Ranked investments and cuts

| Rank | Investment | What earns the next expenditure |
| --- | --- | --- |
| 1 | One satisfying causal exchange with existing props; legible acknowledgement, response and completion. | People deliberately repeat it and can change the outcome. |
| 2 | A tiny, consented observation protocol and six-person first/return-session study. | Identify the actual failure mechanism and whether the core use is play or presence. |
| 3 | Preserve one shared course and one grounded familiar routine. | People recognize it, value it, and retain an easy way to change the activity. |
| 4 | A few authored contextual variations or an optional record of a real moment. | Existing returns show a specific desire to reinterpret or revisit something, rather than merely requests for “more.” |
| 5 | Broader progression or larger content repertoire. | A later study shows a retained audience exhausting a core interaction it already enjoys. |

Cut from the next slice: XP, relationship meters, currencies, shops, streaks, calendar
rewards, daily quests, collection completion pressure, new rooms, pet breeding, social
leaderboards, user profiling, a general memory/reinforcement-learning framework, and an
open-ended chat interface. Defer further model work as a retention strategy until it beats
the scripted experience on a specific observed need. Preserve the audits for mechanical
quality, but stop treating action diversity or a longer decision ledger as evidence of fun.

The smallest useful success is a person returning by choice and saying, with an event to
point to, “I wanted to do that little thing with this Pebble again.”
