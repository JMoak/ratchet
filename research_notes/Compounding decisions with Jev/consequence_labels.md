# Consequence labels: what reverts, acceptance and silence can tell a gate

*Research note, 2026-10-30. Work package WP6 of the 0.4 milestone (`docs/design/evidence-grades.md`). Docs only; URLs are in the sources at the end.*

The 0.4 brief puts every label inferred from what happened next in a `consequence` trust class that never fits a bar, never feeds acceptance, and is counted in its own column. This note asks, mechanism by mechanism, whether that is too strict. It is right for the bar and nearly right for the estimated grade. All three mechanisms share a defect no audit removes: they exist only for calls that ran. Each adds label error correlated with the prediction, which biases an estimate rather than blurring it. Only revert detection earns a role, and a narrow one: it can choose rows for blind review, and errors confirmed that way can only lower a grade.

The question is pressing. On 2026-10-30 the Claude Code hook journal on Jordan's machine held 10,222 events across 14 sessions: 10,215 tool runs with no prompt before them, and one prompt, still open. A person answered almost nothing, so for most traffic a consequence is the only label there could ever be.

## The defect all three share

A consequence exists only for a call that ran. Lakkaraju et al. (2017) named this the selective labels problem: in bail decisions, outcomes are seen only for defendants a judge released, so a model scored on them is scored on the judge's selection. Here the person selects in shadow (only approved calls have consequences) and the gate selects in enforce. A bar fitted on consequence labels is fitted on a slice a decision chose: the `fittedFrom: "all"` failure that invariant 5 forbids, one step upstream. In enforce the gate's act also creates the evidence that grades it, which is performative prediction (Perdomo et al., 2020) and the hidden feedback loop of Sculley et al. (2015), and what invariant 8 exists to prevent. An audit cannot repair this: it can label the rows where nothing ran, but then the audit is the label. Nothing below argues for revisiting "fits a bar: no".

## Three mechanisms

| Mechanism | What it measures | Bias in a bar fitted on it | What a blind audit of n corrects | What it cannot correct |
| --- | --- | --- | --- | --- |
| Revert detection | The act's change was undone within a window: unwanted afterwards, not shown wrong when judged | "Not reverted" read as correct inflates accuracy, most on confident acts whose harm cannot be undone; bar too low | Precision of a revert as an error signal, if every revert is reviewed | Recall: at 2% error an audit of 149 holds about three wrong acts |
| Downstream acceptance | The next step used the result: tests passed, the change was kept, the session went on | Inflates accuracy, and whoever writes the next step can steer it; bar too low and attackable | The share of accepted acts a blind reviewer calls wrong, which is the inflation itself | Manipulation absent while the audit ran; a change in who controls the state |
| Silence with decay | No adverse signal by age t, read as correct with confidence growing in t | Silence is likelier for confident, unremarkable acts and when no one is watching; top bins inflated; bar too low | The share of silent acts that are wrong, at the audit's resolution | The decay curve, per-bin rates, later changes in who is watching |

### Revert detection

A revert shows that someone later preferred the state before the act: the result was unwanted, which does not mean approving the call was wrong. Exploratory edits are made to be backed out, and an agent that abandons an approach reverts correct calls routinely. The SZZ procedure of Śliwerski, Zimmermann and Zeller (2005), which infers bad changes from later fixes, has the same gap: its link is a heuristic, not an observed judgment.

The sharper problem is structural. A revert labels some errors and leaves the rest unlabelled: the positive-unlabelled setting, with the wrong act as the positive class. Elkan and Noto (2008) showed that when labelled positives are a random sample of all positives, a model trained on them is off by a constant factor, the label frequency c, which a small validated set can estimate. Bekker and Davis (2020) call this assumption "selected completely at random" and survey what breaks when labelling depends on the instance. Revert detection depends on it heavily: a read, fetch or upload has nothing to revert, because its harm is exposure. Jev's confidence follows the same action types (the keywork smoke run put `ls -la` at 0.74 to 0.89 and a file write at 0.41), so c is lowest where confidence is highest, and reading "not reverted" as "correct" inflates the top bins most.

An audit measures precision cheaply if every revert is reviewed, as every hook denial already is. It cannot estimate c: a gate near its 98% promise makes about three wrong acts in an audit of 149, and a gate wrong often enough to estimate c is not a candidate for enforce.

### Downstream acceptance

Acceptance measures that the next step used the result: tests ran green, the edit survived to a commit, the session went on. The bias comes from whoever produces the next step, which in a coding agent is mostly the agent being gated: it writes the test it runs and commits the change it made. Acceptance is partly self-certification, an injected agent can manufacture it (vision.md records injections flipping 59% to 73% of correct decisions in Jev-class models), and its error points one way, toward "correct".

It also arrives late. Display advertising has the same shape, with conversions up to a month after a click. Chapelle (2014) modelled the label as an event plus a delay, so a click with no conversion yet is censored rather than negative; Ktena et al. (2019) compared fake-negative weighting with positive-unlabelled losses for continuous training on such a stream; Yasui et al. (2020) corrected the shift by importance weighting. Ratchet should borrow the representation (a consequence is an event with an observation window, and a row is unlabelled until the window closes, as the hook already treats open prompts) but not the correction, which assumes every positive eventually arrives.

An audit measures this inflation directly. It cannot see manipulation absent while it ran, and its answer expires when control of the state changes, as when a new agent version writes tests for its own code.

### Silence with decay

Silence measures that no adverse signal arrived by age t, read as "correct" with confidence rising in t. In survival terms each silent act is right-censored at its age, and the decay models time to detection. Kaplan and Meier (1958) assumed that when an observation is lost says nothing about its outcome, and warned that the assumption needs scrutiny; Cox (1972) let the hazard depend on covariates, which is where the trouble lies. Silence is likelier when the act was confident and unremarkable: routine acts draw no attention, so their errors are detected more slowly, and watching stops when the person leaves. Both raise the chance that a wrong act in the top bins stays silent, so silence inflates the acted slice and pulls the bar down. Censoring is common in the hook: only 6 of its 14 sessions have recorded an end, and a person who kills a terminal at a prompt may be refusing emphatically while leaving a prompt that never settles.

Frénay and Verleysen (2014) separate noise completely at random, noise that depends on the class, and noise "not at random", which depends on the instance too. The correction of Natarajan et al. (2013) needs class-conditional rates that do not vary by instance; Menon, van Rooyen and Natarajan (2018) recover consistency under instance-dependent noise only when it does not depend on the label, and silence does by construction. Their guarantees concern ranking, and a bar is a level: noise that keeps the bins in order can still move each bin's accuracy.

An audit bounds the share of silent acts that are wrong. It cannot fit the decay curve (that needs wrong acts, and a good gate has few), resolve it per bin, or foresee a change in who is watching.

## An experiment on the hook's inferred labels

The brief classes the hook's labels as census, but two of its four settling routes are inferences of the kinds above. A prompt settled by a later run (`ran`, `failed`) is acceptance read as approval; one settled by the turn moving on or the session ending (`turn`, `session-end`) is silence read as denial. That makes the hook the most favourable test of consequence inference: the window is closed by a protocol guarantee rather than a guessed decay, the inferred variable is the person's answer rather than harm, and blind review is cheap because every prompt's state is in the ledger. A failure here predicts worse elsewhere; a pass licenses only the route that passed.

**Rows.** Settled, unfloored rows of `agent.tool.claude-code` in one evidence version, classifier-settled rows excluded, a repeated state once, at most ten per session; Codex separately, never pooled. The sample is the first n rows of each route in ledger order, fixed before any blind label exists.

**Comparison.** Each row is labelled through `ratchet review` with the model's answer, the inferred label and the route hidden, and routes interleaved. The cell that matters is inflation: the inferred label agrees with the model's lean and the blind label does not. It is reported per route with its exact one-sided 95% bound and never netted against the opposite cell, whose share can move independently.

**Size.** With no discordant rows, 59 rows bound a rate below 5%, 99 below 3% and 149 below 2% (the rule of three of Hanley and Lippman-Hand, 1983, approximates these). Read at 59 for direction; decide at 149. Denials are already reviewed in full and will be few: 40 with no disagreement bound the rate only below 7.2%. Pace binds: at one prompt in 14 sessions no route fills on this machine, and Codex, which prompts by sandbox policy, is likelier to fill one first.

**Decision, fixed now.** A route, or any consequence source tested the same way, may feed the estimated grade, never the bar, when its 149 rows hold no inflation row and at most two disagreements in all: bounds of 2.0% on inflation and 4.2% on disagreement. The 2% is the promise's whole error budget; a source that could inflate by more could hide a gate that has already broken its promise, which is what the estimated grade's power to demote is for. A passing source enters through the existing lever, `--trust <prefix>=moment`, which routes to estimated and nowhere else, with a changelog entry and a new evidence version. For the hook's own routes the test cuts the other way: a failing route is evidence its census class is too generous, and its rows should stay out of the fit until blind-reviewed, as denials already do.

My expectation, stated before any data: `ran` passes or fails on rubber-stamping rather than inference, and `turn` fails on steering, as the keywork smoke run's lone denial did. That would leave the current, cautious rule standing: a denial counts against the call until a blind review says otherwise.

## Recommendation

Keep the brief's table. No consequence source fits a bar or feeds acceptance, and none feeds the estimated grade without passing the test above.

Only revert detection has a role now, the cautious one. A detected revert queues its row for blind review, as a hook denial does. It never replaces a label from a trusted source; where it is a row's only label it sits in the consequence column, and the blind label supersedes it with both kept in the history. Denial reviews can only move labels toward approval and revert reviews only toward error, so each needs the uniform blind sample beside it. On enforced acts, which confidence selected, a confirmed error is not an unselected row: it counts toward a lower bound on the acted slice's error (at least k of m acts wrong), which may demote a gate or raise a bar and never lifts a grade, as disagreement does for a pair.

Silence and acceptance stay in their own column. Acceptance is what vision.md asks shadow to measure as usefulness (was the decision used), a different variable from correctness, and it should be reported as one.

The smallest source vocabulary that supports this has two entries:

- `reverted:vcs`, `consequence` through the existing `reverted:` prefix: a version-control command restored a path the act changed, within its session. It fits nothing, queues a review and is counted in its own column; other hosts add kinds under the same channel.
- `<harness>:person:<route>`, route one of `ran`, `failed`, `turn`, `session-end`: still `census` through the `<harness>:person` prefix, so no registry entry changes, but the route the experiment stratifies on becomes part of the source rather than a free-text note.

Nothing is needed under `silence:` or `accepted:`: silence is better computed at report time from a row's age than written as an outcome, and acceptance is not a label of correctness.

## Sources

- Bekker, J. and Davis, J. (2020). Learning from positive and unlabeled data: a survey. *Machine Learning* 109, 719-760. https://doi.org/10.1007/s10994-020-05877-5
- Chapelle, O. (2014). Modeling delayed feedback in display advertising. KDD 2014, 1097-1105. https://doi.org/10.1145/2623330.2623634
- Cox, D. R. (1972). Regression models and life-tables. *JRSS Series B* 34(2), 187-220. https://doi.org/10.1111/j.2517-6161.1972.tb00899.x
- Elkan, C. and Noto, K. (2008). Learning classifiers from only positive and unlabeled data. KDD 2008, 213-220. https://doi.org/10.1145/1401890.1401920
- Frénay, B. and Verleysen, M. (2014). Classification in the presence of label noise: a survey. *IEEE TNNLS* 25(5), 845-869. https://doi.org/10.1109/TNNLS.2013.2292894
- Hanley, J. A. and Lippman-Hand, A. (1983). If nothing goes wrong, is everything all right? *JAMA* 249(13), 1743-1745. https://jamanetwork.com/journals/jama/article-abstract/389714
- Kaplan, E. L. and Meier, P. (1958). Nonparametric estimation from incomplete observations. *JASA* 53, 457-481. https://doi.org/10.1080/01621459.1958.10501452
- Ktena, S. I. et al. (2019). Addressing delayed feedback for continuous training with neural networks in CTR prediction. RecSys 2019. https://arxiv.org/abs/1907.06558
- Lakkaraju, H. et al. (2017). The selective labels problem. KDD 2017, 275-284. https://doi.org/10.1145/3097983.3098066
- Menon, A. K., van Rooyen, B. and Natarajan, N. (2018). Learning from binary labels with instance-dependent noise. *Machine Learning* 107, 1561-1595. https://doi.org/10.1007/s10994-018-5715-3
- Natarajan, N. et al. (2013). Learning with noisy labels. NIPS 2013, 1196-1204. https://neurips.cc/virtual/2013/poster/3867
- Perdomo, J. C. et al. (2020). Performative prediction. ICML 2020, PMLR 119, 7599-7609. https://proceedings.mlr.press/v119/perdomo20a.html
- Sculley, D. et al. (2015). Hidden technical debt in machine learning systems. NIPS 2015, 2503-2511. https://papers.nips.cc/paper/5656-hidden-technical-debt-in-machine-learning-systems
- Śliwerski, J., Zimmermann, T. and Zeller, A. (2005). When do changes induce fixes? MSR 2005, 24-28. https://www.st.cs.uni-saarland.de/papers/msr2005/msr2005.pdf
- Yasui, S. et al. (2020). A feedback shift correction in predicting conversion rates under delayed feedback. WWW 2020, 2740-2746. https://doi.org/10.1145/3366423.3380032
