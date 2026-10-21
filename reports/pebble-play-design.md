# Pebble: a little game that becomes ours

Research synthesis, 2026-10-20. Three Astra research assignments covered attachment,
play and repeat visits, followed by integration review. This is a proposed next design,
not an implemented feature or evidence of Pebble retention.

**Current direction:** the user subsequently prioritized watching Pebble pursue its own small
ideas and seeing taught lessons applied independently. The [growth map](pebble-growth-map.md)
supersedes this document's reciprocal-return-first ordering; the research and technical
comparisons below remain supporting material.

## Recommendation

Build **one small physical game that Pebble can play with you, remember and initiate**.
First establish that the interaction itself is enjoyable. Then test whether a genuinely
shared history makes the same toy worth revisiting.

The intended feeling is: “What if we try it this way?” followed later by “It remembered
our thing.” The product remains a self-sufficient companion in one room. Short visits,
quiet observation and leaving satisfied are successful outcomes too.

Following the depth review below, the first candidate is a reciprocal ball exchange with
one explicitly taught return convention. Test whether the player's influence transfers to
another position and makes playing with this creature more appealing. The existing stones
and cardboard box are later candidates for extending the physical rules, contingent on
that result. These are design hypotheses, not demonstrated depth or enduring demand.

## Why the present loop runs out of depth

The source currently chooses a ball destination independently of the other props. Stones
change among authored arrangements, and box play mostly changes the performance around
the box. The player cannot learn many transferable relationships between these objects.
The six intentions, short recency memory and two personality presets offer variety but
little player-authored consequence. Typical activities last 10–14 active seconds; an
invitation can acknowledge immediately while still waiting for a meaningful response.

Our earlier audits establish implementation behavior, not enjoyment. More remembered
generic actions would preserve the existing repetition. More animation variants would
increase presentation variety without necessarily creating something interesting to do.

## Depth requirement: the creature must change the game

The user's concern is correct: a bank shot and a later callback could still exhaust
themselves quickly. Clear cause and effect is necessary for this proposal, but it does not
establish lasting depth. Nor does an adaptive algorithm establish enjoyment. The next
experiment should test a consequential way of playing with Pebble before expanding the toy.

Three observable properties would justify further investment:

1. **Influence:** explicit demonstrations change later physical behavior. Two otherwise
   identical saves with different teaching histories produce different, understandable
   returns in the same situation. Changed captions do not count.
2. **Transfer:** a taught convention still works when the player marker and starting ball
   position move. Replaying an old endpoint does not count. Define which changes are
   supported; a clear-floor return does not imply understanding of obstacles.
3. **Reciprocity:** the player enjoys responding to Pebble's consequential turn, and Pebble
   can later offer the same game on its own. A retrieval animation that only delays the
   player's next interesting action does not count.

**Concrete first experiment: a return that becomes ours.** The player rolls the ball to
Pebble, demonstrates a receiving position and explicitly selects “Like that.” Pebble uses
the demonstrated spatial relationship on its next return. Move both the player marker and
the ball; it adjusts direction and strength while preserving the taught convention. Later,
when free and rested, it can approach the ball, offer that familiar exchange and wait for
participation. The player may redirect it or leave. This routine uses the same small state
as the skill; it does not require a separate relationship or progression subsystem.

Store a bounded offset relative to the player and the ball-to-player direction, with an
explicit confirmation event. This is narrow preference learning. An ordinary placement or
an autonomous repetition must not silently rewrite the preference. Validate space and path
before attempting it; a blocked return prompts a visible pause or reposition invitation.

If improving motor skill is itself enjoyable, it can also be real and very small. For an
unobstructed roll on the initial uniform floor, the game can use `distance = k * strength^2`.
The creature estimates its own coefficient from a bounded set of completed physical rolls:

```text
estimatedK = (priorWeight * initialK + sum(strength^2 * distance))
             / (priorWeight + sum(strength^4))
nextStrength = sqrt(desiredDistance / estimatedK)
```

Use positive bounded coefficients and strengths, a usable initial prior, and up to eight
observations. Exclude collisions, captures, interruptions and manual displacement: those
do not reveal an unobstructed stopping distance. The controller must use its estimate;
it cannot secretly query the exact solver for a perfect shot and stage a learning animation.
This is a proposed constrained estimator, not an implemented or validated learning system.
First compare preference alone with preference plus motor learning; omit motor learning if
it adds waiting, frustration or no valued difference. No mandatory clumsiness is needed.

There is a technical precedent for gameplay built around teaching agents: the NERO research
demonstrated real-time adaptation through player-created exercises. That supports feasibility,
not the fun or retention of this pet, and does not justify adopting its neuroevolution
architecture. [Primary paper](https://nn.cs.utexas.edu/downloads/papers/stanley.cig05.pdf)

**Verification has two separate jobs.** First, test untouched layouts against frozen and
literal-replay controllers: measure return error and preservation of the taught relation.
Hold physical conditions and random seeds fixed while exchanging the teaching history.
Second, compare human play with an equally capable fixed pet. Otherwise a preference for
the learner may only reflect improved accuracy. Observe whether people recognize their
influence and voluntarily adapt their own play around it. Neither test substitutes for
the other.

**The ceiling remains real.** One return convention and one learned scalar can be mastered
quickly. Do not add hidden coefficients, artificial forgetting or repetition requirements
to stretch them out. A successful experiment earns one extension using the same capabilities
in a new situation, such as an obstacle-dependent return; it does not establish weeks of
play. Stop this direction if the understandable version feels like training an input device,
if Pebble's turn remains unwelcome waiting, or if players prefer the equally capable fixed
pet. A small charming companion is still possible without a deep training game.

## What the evidence supports—and where it stops

| Evidence | Useful implication | Limit |
| --- | --- | --- |
| Kao et al., CHI 2024, preregistered action-RPG experiment with 1,699 participants: success-dependent feedback supported the measured motives; extra amplification sometimes hurt; varied feedback did not establish the expected curiosity benefit. [Paper](https://publikationen.bibliothek.kit.edu/1000171104/152952099) | Make the connection between a player's action and the outcome legible. Test uncertainty about an achievable outcome before adding spectacle. | One experimental action game; not a virtual-pet retention study or a universal optimum for feedback. |
| Nintendo's Echoes of Wisdom developers describe changing companion actions because merely watching them work made players wait. They emphasized immediate effects and understandable object roles. [Developer interview](https://www.nintendo.com/us/whatsnew/ask-the-developer-vol-13-the-legend-of-zelda-echoes-of-wisdom-part-2/) | Player agency and character autonomy must work together. Give the player something consequential to do. | Developer account, not a controlled experiment. Pebble should not inherit Zelda's enormous systems scope. |
| Nintendogs + Cats creators describe individuality through different approaches, movement and preferences. [Developer interview](https://www.nintendo.com/en-gb/Iwata-Asks/Iwata-Asks-Nintendo-3DS/Vol-4-nintendogs-cats/2-Adding-Kittens-Doubled-the-Work/2-Adding-Kittens-Doubled-the-Work-204778.html) | Personality should be visible in how the same situation is handled. | Precedent and craft knowledge, not proof that two utility presets create attachment. |
| Ligthart et al., HRI 2022: 46 children, five sessions over two months; bundled memory-based personalization supported continuity and some relationship measures. [Institutional record](https://research.tudelft.nl/en/publications/memory-based-personalization-for-fostering-a-long-term-child-robo/) | A shared activity recalled through behavior is worth testing. | Personalization bundled several mechanisms. It does not isolate memory, prove voluntary return, or directly generalize from children with physical robots to adults with a browser pet. |
| Leite et al., IDC 2017: 67 children and four conversations; memory effects differed by age, and measures did not uniformly favor memory. [Paper](https://studios.disneyresearch.com/wp-content/uploads/2019/04/Persistent-Memory-in-Repeated-Child-Robot-Conversations-1.pdf) | Memory must earn its place through the experience it changes. | Short structured interactions; no basis for promising enduring attachment. |
| de Jong et al., 2024: 321 children with Cozmo at home for eight weeks; acceptance declined, use sometimes resumed, and self-report differed from observed use. [Institutional record](https://dare.uva.nl/id/c6ac85b7-724e-4e07-9fc0-9b94e7afe8f5) | Observe optional returns and ask non-returners what they chose instead. | An observational child/robot study does not predict an adult browser pet's retention curve. |
| Abendschein et al., 2022: nine interviews after six weeks with a simple robot kitten; familiarity and renewed novelty could coexist. [Paper](https://www.frontiersin.org/journals/robotics-and-ai/articles/10.3389/frobt.2022.733078/full) | Familiar, quiet company can be valuable without constantly adding content. | A small availability sample during pandemic isolation; no causal or population retention estimate. |
| Tyack and Mekler's review critiques superficial use of self-determination theory in games research. [Paper](https://arxiv.org/abs/2405.12639) | Autonomy, competence and relatedness can frame questions; they are not a recipe guaranteeing fun. | A critique of theory use, not evidence against every motivation-informed design. |

## Investment order

| Priority | Change | What the player gains | Main failure mode |
| --- | --- | --- | --- |
| 1 | One reciprocal return with quick, controllable turns | “We can actually play together.” | The pet's turn is merely waiting or retrieval. |
| 2 | Explicitly teach a return convention that transfers | “Our previous play changes what it does here.” | A saved coordinate or staged improvement passes for learning. |
| 3 | Pebble offers the familiar exchange using that same state | “It wants to play our game.” | Repetitive invitations or a second unnecessary memory system. |
| 4 | Small contextual variations and discoverable uses | “That familiar toy can do something else.” | Random outcomes destroy trust in the rules; authored content becomes a treadmill. |
| Later | A few tangible mementos, if players value them | A visible history of their particular room | A completion checklist displaces play. |

These priorities are judgments, not measured effect-size rankings. Do not start with more
rooms, many new props, a skill tree, arbitrary generated conversation, a general agent
planner or a larger memory service. Preserve the existing art and expressive reactions.
Tune those reactions to show attention, anticipation and actual outcomes.

## A later physical extension: the trick we discovered together

The following ball/stone/box vignette was the original first-slice proposal. After the depth
review, treat it as a candidate extension only if reciprocal play has earned its place.
Do not bundle collisions, motor learning and long-term recall into one confounded prototype.

**First thirty seconds.** The player rolls the ball. A stone redirects it and the ball
misses the box. Pebble tracks the actual path, looks toward the stone and returns the ball.
Moving the stone or changing the roll produces an understandable difference. A miss can be
amusing without an artificial near-miss generator or a punishment.

**The next few minutes.** The player creates a small setup and can take another turn or
invite Pebble to try. Pebble inspects before choosing a bounded roll, or offers one small
adjustment. It never silently rearranges the player's course. Different personality styles
show up in approach, initiative and choice among valid variations. The pet should contribute
to the interaction, not just animate beside a generic ball puzzle.

Keep free play available: returning the ball, making a silly path or watching Pebble try
its own idea can be as worthwhile as a box catch. Do not withhold useful player controls
to manufacture a need for the pet. Its attention, recognizable attempt and specific reaction
should make the exchange enjoyable. Preserve its independent, leisurely behavior around
the optional game; no course mastery is required to receive a warm response.

**A later visit.** After a genuinely completed, player-participated discovery, Pebble can
bring the ball to that familiar setup and look toward the player. Accepting resumes their
game. Ignoring it leaves Pebble content to do something else. It can offer one variation
after another shared attempt; it does not endlessly replay the saved trick.

Recall offers a shared activity; it does not automatically rebuild a saved course or
overwrite the player's layout. A success can be accidental, and an amusing miss can be
worth remembering. Save what happened without inventing enjoyment or affection.

The room does not advance a daily obligation while closed. Recalls depend on relevant
context and recorded physical events, not an attendance streak. Quiet visits remain valid.

If people enjoy the creature's reactions but tire of aiming, the next candidate is a small
hide-and-peek exchange: hide the ball behind the box, let Pebble search from its last observed
location, then reveal it. This needs clear visibility rules and readable searching, so it is
a later alternative rather than another mechanic bundled into the first test.

## Keep implementation proportional

- Use a small deterministic 2D motion model: one moving ball, a few fixed colliders,
  friction, bounded collisions, and a finite end. Test whether one deflection is already
  enough before extending it. A general rigid-body engine is not a prerequisite.
- Support drag/aim and equivalent keyboard or tap controls. Offer clear aim and strength
  adjustments without requiring quick reflexes. Reduced motion must preserve outcome
  information.
- Separate leisurely autonomous activities from direct play turns. Acknowledgment alone
  is insufficient; a response needs a visible causal effect. Test shorter play beats and
  clean settle/cancel boundaries instead of forcing every interaction through a full
  10–14-second dwell. Specific timing values are prototype choices, not established facts.
- Start with one bounded shared memory: participating object IDs, setup, roll parameters,
  observed outcome and a link to the completed event. Expand only if one feels too narrow.
  No embeddings or personal biography are needed.
- Completed player-participated activity is eligible history, not proof of enjoyment.
  An explicit request to repeat is stronger preference evidence. Start with that signal;
  autonomous repetition and a tab remaining open do not prove preference.
- Saved preferences influence choices among eligible behaviors. Care, current invitations,
  cancellations and user control retain priority. Changing the room invalidates incompatible
  plans rather than forcing a remembered outcome.

Ratchet's current role remains semantic judgment and a decision ledger. Game code owns
geometry, outcomes, timing, preference updates and capability limits. A future narrow model
experiment could interpret “try it gently without moving my stones” against a few typed
candidate actions. It must demonstrate visible value over the same rules baseline. Neither
physics nor the first shared ritual needs a model request. Future model-visible state may
contain actual actions and outcomes, never prior verdicts, confidence or generated rationales.
Preference learning is application behavior; it is not evidence for calibrating the judge.

## Test fun and continuity separately

Use a formative study of roughly six adults who plausibly want a cozy pet, including people
who enjoy active play and people who prefer quiet companionship. This is a usability and
design decision sample, not enough to establish a population retention rate.

1. **Immediate play:** compare current interaction and the causal toy without new persistence,
   counterbalancing order. After brief familiarization, allow a free-choice period. Observe
   voluntary retries, deliberate changes to a setup, ability to explain the outcome, waiting
   frustration, and whether Pebble felt like a partner. Record actual counts and observations.
   Then briefly compare the same toy with and without Pebble's participation. If people
   prefer playing alone, the toy may work while the companion design still fails. Treat
   this as a diagnostic comparison with remaining presentation/order confounds documented.
2. **Continuity:** only if play is promising, hold mechanics and presentation stable while
   trying contingent shared recall across optional visits over about a week. Distinguish
   setup sessions from voluntary visits. Ask what specific event changed later behavior.
   A small matched nonpersonal recall comparison can probe the mechanism, but its results
   remain exploratory and order/novelty effects must be reported.
3. **Graceful stopping:** ask whether people felt satisfied leaving and whether they wanted
   quiet company rather than active play. Separate “pleasant to have around” from a long
   foreground session. Avoid treating dwell time or obligatory study attendance as success.

Before recruiting, agree concrete iteration criteria. Useful qualitative signals are several
participants independently experimenting again, describing their own action's consequence,
and recognizing a specific shared event later without being told what to look for. Report
the denominator; do not turn these observations into a statistical guarantee.

If players cannot understand the toy, improve control and feedback first. If it is clear but
they do not want another turn, replace the mechanic before adding memory. If the toy works
but the pet feels decorative, redesign its complementary role. If recall is unseen or
annoying, change or remove recall. If users mainly value ambient company, reconsider the
product emphasis instead of forcing skill-based engagement into every session.

## Research files and delivery boundary

- [Attachment, individuality and shared history](../research_notes/pebble-attachment-research.md)
- [Causal play, game feel and bounded implementation](../research_notes/pebble-play-research.md)
- [Return visits, progression and formative testing](../research_notes/pebble-return-research.md)

This pass produces research and a prioritized experiment. It does not change Pebble's
behavior, collect participant data, recruit people, publish the app or make paid model calls.
The next implementation should prove the causal toy and the pet's role before growing the
long-term progression system.
