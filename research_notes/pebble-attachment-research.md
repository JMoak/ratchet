# Pebble: attachment through something worth remembering

Research, 2026-10-20. Scope: attachment, character, learned preferences and shared history.
No application changes or live-model calls. Read against Pebble's `README.md`,
`src/world.ts`, `docs/character-audit.md`, both repositories' instructions, and
[the original proposal](virtual-pet.md). Recommendations below are design hypotheses,
not measured results for Pebble.

**Make one play interaction worth repeating, then let Pebble remember one thing the two
of you discovered.** A broad memory system is premature. A learned favorite attached to
the present shallow actions could simply make repetition more obvious. The first proof
should be a causal play event with a later, recognizable callback.

## What the present pet is missing

Pebble already has useful foundations: readable action phases, responsive invitations,
gentle refusals, persistent physical state, self-care and no absence penalty. Its latest
audit demonstrates more connected action pairs and exact saved trajectories. It explicitly
does not demonstrate human recognition, preference or attachment.

The twelve recent observations support recency and an immediate second beat. The seven
discoveries recognize authored categories. Neither represents a developing relationship:
there is no distinction between a prop Pebble happened to touch and a game the player
deliberately enjoyed with it. The two personalities exist before the player arrives and
do not acquire individual history.

More fundamentally, the existing ball endpoint does not depend on the other props;
arranging stones selects an authored pattern. Remembering these interactions does not
give the player a new reason to explore them. The play research's proposed causal
ball/stone/box interaction is a better foundation for attachment than an isolated
favorite-object counter.

## Evidence, with the boundaries kept intact

### Demonstrated findings

**Personalization can help continuity across sessions, but its effect is neither universal
nor separable from the experience it personalizes.** Ligthart, Neerincx and Hindriks studied
46 children aged 8–10 in five approximately fifteen-minute robot conversations over two
months. Their treatment combined persistent narrative choices, personal references,
interest-based topics, a co-created secret handshake and other manipulations. Controls used
generic alternatives; session durations matched. Final-session willingness to continue and
closeness favored personalization. Closeness nevertheless declined in both groups, less
steeply in the personalized group. Self-disclosure, familiarity and similarity did not show
the corresponding significant benefits. These were scheduled school interactions with a
conversational robot, not voluntary revisits to a desktop pet. The study supports testing
a coherent package of visible continuity; it does not isolate a memory store or establish
commercial retention. [Full paper, HRI 2022](https://robotdesign.studio/assets/robo-reflections/pdfs/Memory2022HRI.pdf),
[institutional record](https://research.tudelft.nl/en/publications/memory-based-personalization-for-fostering-a-long-term-child-robo/).

**An especially relevant memory study is more mixed than its abstract sounds.** Leite,
Pereira and Lehman's PIPER study analyzed 67 children aged 4–10 across four conversations,
comparing no persistent memory, references to prior events, and proactive memory-based
opinions. Results varied with age. Overall liking increased, but the conversation-by-condition
interaction for liking was not significant; neither were the overall favorite or fun
comparisons. Positive affect decreased across conversations. Older and younger children
responded differently to the memory treatments. Therefore “it remembers, so people will
love it” is an unsupported inference. The manner, audience and timing of recall matter.
[Full paper, IDC 2017](https://studios.disneyresearch.com/wp-content/uploads/2019/04/Persistent-Memory-in-Repeated-Child-Robot-Conversations-1.pdf).

**Relational behavior predates generative dialogue.** Bickmore, Gruber and Picard compared
33 users of a relational exercise-support system with 27 using the corresponding system
without those behaviors, near-daily for thirty days. The relational bundle increased
working alliance and desire to continue. It included empathy, social dialogue and nonverbal
behaviors, not memory alone. A health intervention and stated continuation desire are
different from recreational play and unsolicited return. This is evidence that deliberate
interaction design can support a relationship, not an argument that Pebble needs humanlike
conversation. [Primary article abstract, 2005](https://pubmed.ncbi.nlm.nih.gov/16198215/).

**Stored knowledge can become stale, and people may want control over it.** A 2026 HRI
Companion paper reports a one-year follow-up with fifty children from a reading-robot
study: closeness was lower and roughly half the profile content was outdated or missing.
Its authors propose transparent, jointly maintained memory and report improvement after a
brief reconnect activity. Only the institutional abstract was accessible here, so the
strength and causal interpretation of that improvement remain unverified. It still makes
an appropriate design warning: do not convert a temporary choice into an invisible,
permanent assertion about the person. [University of Twente research record](https://research.utwente.nl/en/publications/making-memories-together-toward-transparent-and-co-constructed-ro/).

### Developer evidence, not controlled user research

Nintendo's designers describe making dogs distinguishable through individual proportions
and preferences, and describe personality as difficult to express in behavior. Their cat
example is concrete: attention, apparent hesitation and a pounce, rather than a dog's
direct chase. The relevant lesson is that recognizable character lives in the execution
of an interaction. This interview does not quantify attachment or prove any individual
feature causes it. [Iwata Asks: Nintendogs + Cats](https://www.nintendo.com/en-gb/Iwata-Asks/Iwata-Asks-Nintendo-3DS/Vol-4-nintendogs-cats/2-Adding-Kittens-Doubled-the-Work/2-Adding-Kittens-Doubled-the-Work-204778.html).

Cozmo/Vector behavior developer Kevin Karol describes clear goals, authored animations,
programmatic actions and reactions to progress or interruption. His account also describes
the growing burden of transitions as behaviors accumulated. This supports small,
well-authored behavioral arcs and warns against adding a catalog of disconnected tricks.
It is a developer retrospective, not evidence that a particular architecture caused
engagement. [First-person development account](https://kevinmkarol.com/case-study/cozmo).

The transfer to Pebble is necessarily uncertain: most of the direct studies concern
children, physical robots and conversation. None tests this pet, its intended audience,
or a nonverbal shared trick. Use the evidence to choose a falsifiable prototype.

## Three attachment mechanics worth considering

These are a ranked sequence, not a recommendation to build all three now. Causal play is
the prerequisite; the first mechanic is the first attachment experiment.

| Mechanic | What the player actually experiences | Smallest implementation and main failure mode |
| --- | --- | --- |
| **One remembered shared trick** | After a player-created physical success, Pebble later looks toward the relevant setup and offers to try it again. Recognition precedes explanation. | One typed episode and one authored callback. Count only committed player-participated outcomes. Failure: recalling a generic action, a failed/cancelled event, or something the player never noticed. |
| **A slowly shaped way of playing** | Repeated explicit choices influence how Pebble approaches an existing game, while its original temperament remains recognizable. | At most one preference over two or three authored variants. A capped evidence count and a small bounded selection bias suffice. Failure: passive dwell or autonomous repetition trains a self-reinforcing habit; instant mirroring erases character; a permanent favorite traps an old preference. |
| **One shared creation that remains in the room** | A particular arrangement survives and Pebble occasionally returns to admire or use it. The player can change or discard it. | One existing scene arrangement plus its causal provenance; a tiny snapshot only if useful. Failure: an achievement gallery replaces play, every event becomes precious, or the pet repeatedly restores a layout against the player's wishes. |

A greeting should express one of these mechanics rather than become a fourth subsystem.
Pebble can acknowledge the player and glance toward their remembered game. It should not
recite a biography, claim it was lonely, or manufacture activities while the room was paused.

Keep three concepts separate. **Temperament** is the stable authored character.
**Preference** is a narrow, revisable tendency inferred from explicit play choices.
**Episode** is something that actually happened. None requires a numerical love meter.
“Pebble remembers this game” is a supportable statement; “Pebble knows you are a quiet
person” is not supported by selecting quiet mode once.

## Strongest vertical slice: the trick we discovered together

Use the causal toy proposed by the play research only if it stays small: the player can
change a ball's path using the existing stone and box, and Pebble reacts to an actual
deflection or catch. The physical interaction must be enjoyable before adding persistence.

1. The player adjusts the setup and tries a roll. Pebble follows the actual result with
   attention, then an outcome-specific reaction. A miss remains pleasant and legible.
2. A successful, player-participated outcome produces a short shared celebration. A
   deliberate repeat provides stronger evidence that this is a game worth recalling than
   a high click count or long open tab. The room remembers one successful setup and outcome.
3. On a later visit, after acknowledgment and when its needs permit, Pebble briefly
   indicates the relevant ball/box relationship and offers one repeat. The ordinary play
   control accepts; doing something else simply moves on. There is no penalty or pleading.
4. The next roll uses the current scene. If the player changed the geometry, Pebble adapts
   to the new result. It does not promise the old outcome or silently teleport props back.

This makes the relationship observable: the player's contribution created the event;
Pebble's later behavior refers to that contribution. The surprise is “you remembered our
thing.” A text entry saying the game was remembered is insufficient.

### The pet must be a partner in the trick

Causal physics could produce a pleasant ball puzzle with an animated spectator. That is
not yet a compelling pet. Give Pebble one indispensable, readable turn: the player
arranges and invites; Pebble considers, launches or returns the ball in its characteristic
way; the player responds or changes the setup. Pebble occasionally proposes a turn and
waits. Its reaction follows the actual result and checks back toward the player.

Do not create arbitrary friction by withholding direct controls just to make the pet
necessary. Its contribution should be a pleasurable reciprocal action with a little
bounded initiative, not a compulsory animation before the player's real game. Nor should
it perfectly solve every arrangement, removing the player's role. Character can appear
in anticipation, a cautious versus eager return, and the response to a miss without
changing the world's physical rules.

A useful diagnostic is to remove Pebble's turn temporarily in a research build. If the
interaction is effectively unchanged except for applause, the companion is decorative.
Ask people whether they were playing with Pebble or operating a toy beside it. Delayed
memory should recall an episode both participated in, not congratulate the player's
score. This is a separate design hypothesis from both pleasant physics and recall.

Start with one good callback and one decline/redirect response. Use the existing six
intentions and their authored phases where possible. General dialogue, freeform plans,
embeddings, model-written memories and a new decision framework add no demonstrated value
to this slice. Ratchet remains the existing gate and ledger boundary; it does not decide
whether the player enjoyed a moment from its own past judgments.

## Exactly what needs to persist

These are proposed bounds for the slice, not research-derived constants.

| Data | Proposed bound and reason |
| --- | --- |
| Remembered episode | Zero or one record: fixed game ID, authoritative outcome enum, existing object IDs, numeric positions at launch and any bounded launch parameter needed to identify the setup. No freeform narrative. |
| Provenance | Source completed activity/event ID, player invitation/input ID and content version. A proposal, accepted invitation or gate approval cannot create a memory. Preserve provenance at activity start so a later invitation cannot rewrite participation. |
| Familiarity evidence | One small saturating count of deliberate repeats, deduplicated by completion/input identity. Do not infer enjoyment from absence, window visibility, need relief or autonomous attempts. The first prototype can omit learning and use explicit repeat alone. |
| Recall bookkeeping | Last offered active-time position and a per-visit offered flag. One opportunity per genuine visit, plus an active-time cooldown; reloads cannot strengthen preference. Care, stop and fresh input outrank recall. |
| Optional play preference | Only if the second mechanic is justified: one enum and capped evidence for two or three variants. No general user profile, inferred emotion or interest taxonomy. |
| Optional keepsake | Only if the third mechanic is justified: one scene snapshot; replace through an understandable player action. Existing saved geometry may already be enough. |

Keep the twelve recent physical observations for short-term control; do not expand them
into a biography. Read persistent play state from application-owned facts, not the
decision ledger, rationales, confidence or explanatory notebook. Retain the original
no-absence-punishment semantics. A memory can survive absence without its strength or the
pet's affection changing while the application is closed.

Version and validate the finite record when restoring. Unknown game IDs or impossible
coordinates discard the optional callback safely, not the whole pet. Persist the memory
with the authoritative world snapshot; make completion processing idempotent. A reset
should clearly include the remembered game. There is no need to reconstruct relationship
state by replaying an unbounded audit log.

## Evaluation: separate fun from remembering

**First test causal play in one session.** With roughly 8–12 intended users, compare the
current interaction with the small causal toy in counterbalanced order. Give the same
short introduction, then allow unprompted play. Observe whether people intentionally
alter the setup, can predict what changing it will do, retry for a reason, and stop
satisfied. Ask what they were trying to make happen. A longer session caused by confusion
is a failure, not engagement. This formative sample finds problems; it cannot establish
a population retention effect.

**Then test persistence across visits.** Recruit a separate small formative group, for
example 12–16 people, for two short scheduled visits separated by at least a day, followed
by a week of optional access and a final interview. Randomize people between the same
causal toy with contingent recall and a version with equally rich generic invitations,
keeping pet appearance, motion, controls and available outcomes matched. Counterbalance
temperament. Do not give the memory version extra content or easier gameplay. Research
compensation must not depend on optional opens; no reminders to play during that period.

At the second visit, first let people interpret behavior without being told that memory
is the feature. Then ask them to identify the prior event it refers to. Log exposure
opportunities, actual callbacks, acceptance, redirection and subsequent play separately.
The core diagnostic chain is:

`a shared event happened -> its callback was seen -> the player recognized it -> it improved the visit`

If people cannot recognize their own event, repair the expression before enlarging memory.
If they recognize it but do not enjoy the game, repair play. If recognition and enjoyment
improve but voluntary returns do not, do not claim a retention result.

Use consented local interaction logs to distinguish optional visits from scheduled ones,
reloads and background tabs. Record reasons for returning, memorable moments, felt
pressure/obligation, annoyance from repetition, and willingness to keep this particular
pet. Ask participants what would feel different about a fresh one; never threaten to
delete their pet to measure attachment. Report counts and individual trajectories,
including non-returners and people who enjoyed a short visit without returning.

With a small sample, treat between-group differences as exploratory. A later confirmatory
study needs a predeclared practical effect, adequate sample size and participant-level
analysis; repeated sessions are not independent people. Neither simulated action breadth
nor an LLM's charm score substitutes for these human observations.

The smallest success is modest and concrete: after a delay, someone recognizes an actual
shared discovery in Pebble's behavior and voluntarily starts playing with it again.
