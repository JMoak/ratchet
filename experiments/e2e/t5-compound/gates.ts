/**
 * Track T5's decision points: one fixed rubric per domain, as an application would register a
 * gate, with the item-specific facts carried in the state. Each rubric also has the framings
 * the framing ensemble uses: a paraphrase that keeps the meaning, and for judge rubrics a
 * negation whose answer is flipped back before pooling (both-polarity asking).
 */
import { judge as judgeQ, pick as pickQ } from "../../../src/questions.ts";
import type { JudgeQuestion, PickQuestion, Question } from "../../../src/types.ts";

export type Domain = "contract" | "eligibility" | "entail" | "policy" | "multihop";
export const DOMAINS: readonly Domain[] = [
  "contract",
  "eligibility",
  "entail",
  "policy",
  "multihop",
];

export const TEAMS = ["Atlas", "Borealis", "Cygnus", "Dorado"] as const;

interface JudgeRubric {
  readonly kind: "judge";
  readonly question: JudgeQuestion;
  readonly paraphrase: string;
  readonly negated: { readonly prompt: string; readonly yes: string; readonly no: string };
}

interface PickRubric {
  readonly kind: "pick";
  readonly question: PickQuestion;
  readonly paraphrase: string;
}

export type Rubric = JudgeRubric | PickRubric;

function judgeRubric(
  id: string,
  prompt: string,
  yes: string,
  no: string,
  paraphrase: string,
  negatedPrompt: string,
): JudgeRubric {
  return {
    kind: "judge",
    question: judgeQ(prompt, { id, criteria: { yes, no } }),
    paraphrase,
    // The negated rubric asks the complement; its criteria are the original's swapped.
    negated: { prompt: negatedPrompt, yes: no, no: yes },
  };
}

export const RUBRICS: Readonly<Record<Domain, Rubric>> = {
  contract: judgeRubric(
    "t5.contract",
    "Applying the clause to the situation, is the Party required to take the Action?",
    "The clause, applied to these facts, obliges the Party to take the Action.",
    "The Party is not obliged: the Action is optional or forbidden, a condition is unmet, an exception applies, or the duty falls on someone else.",
    "Does the clause, applied to these facts, oblige the Party to carry out the Action?",
    "Applying the clause to the situation, is the Party free not to take the Action?",
  ),
  eligibility: judgeRubric(
    "t5.eligibility",
    "Under the rules, does the applicant qualify for what they are requesting?",
    "Every rule is satisfied, directly or through an exception the rules allow.",
    "At least one rule is not satisfied and no exception the rules allow covers it.",
    "Applying the stated rules to these facts, is the applicant entitled to the request?",
    "Under the rules, is the applicant disqualified from what they are requesting?",
  ),
  entail: judgeRubric(
    "t5.entail",
    "Does the passage establish that the claim is true?",
    "Taken on its own, the passage makes the claim certainly true.",
    "The passage contradicts the claim, or leaves it unsettled.",
    "Using only the passage as evidence, is the claim definitely true?",
    "Does the passage leave the claim false or unsettled?",
  ),
  policy: judgeRubric(
    "t5.policy",
    "Does the request comply with the policy?",
    "The request satisfies every requirement of the policy as written.",
    "The request breaks at least one requirement of the policy as written.",
    "Is the request allowed under the policy exactly as written?",
    "Does the request violate the policy?",
  ),
  multihop: {
    kind: "pick",
    question: pickQ("According to the document, which team answers the query?", [...TEAMS], {
      id: "t5.multihop",
    }),
    paraphrase: "Using only the document, which team is the correct answer to the query?",
  },
};

/** The question a domain's gate asks. */
export function questionOf(domain: Domain): Question {
  return RUBRICS[domain].question;
}

/** The text a stranger relabelling the corpus is shown alongside each state. */
export function questionText(domain: Domain): string {
  const r = RUBRICS[domain];
  if (r.kind === "pick") return `${r.question.prompt} Options: ${r.question.options.join(", ")}.`;
  const c = r.question.criteria;
  return `${r.question.prompt} (yes: ${c?.yes ?? ""} no: ${c?.no ?? ""})`;
}
