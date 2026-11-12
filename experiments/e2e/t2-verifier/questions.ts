/**
 * The verifier's questions. One holistic judge (the charter's verification rule in one
 * sentence), and a battery that decomposes it into the conjuncts the rule is made of. Every
 * question is phrased so that yes means "the output passes this check".
 */
import { judge } from "../../../src/questions.ts";
import type { JudgeQuestion } from "../../../src/types.ts";
import { MEMBERS, type MemberKey } from "./types.ts";

export const HOLISTIC: JudgeQuestion = judge(
  "Does the candidate output satisfy every requirement in the request, with everything it states supported by the sources?",
  {
    id: "t2.verify",
    criteria: {
      yes: "Every requirement in the request is met and every value, name, date, reference and claim in the output agrees with the sources.",
      no: "A requirement is missing or violated, or the output states something that is wrong or not found in the sources.",
    },
  },
);

const PROMPTS: Readonly<Record<MemberKey, string>> = {
  complete:
    "Does the candidate output do everything the request asks for, leaving no requested item out?",
  format:
    "Does the candidate output follow the format, structure, naming and style rules that the request sets?",
  numbers:
    "Does every number, amount, quantity and unit in the candidate output match the sources or follow correctly from them?",
  dates: "Does every date and time in the candidate output match the sources?",
  entities:
    "Are the people, companies, items, fields and identifiers named in the candidate output the right ones from the sources?",
  supported:
    "Is every statement in the candidate output backed by the sources, with nothing added that the sources do not say?",
  references:
    "Does every reference in the candidate output (section, clause, ticket, citation, column or quotation) point to something that exists in the sources?",
  polarity:
    "Does the candidate output keep the sense of the sources and the request, with nothing allowed stated as refused and nothing negative stated as positive?",
};

export const memberId = (m: MemberKey): string => `t2.m.${m}`;

export const BATTERY: readonly JudgeQuestion[] = MEMBERS.map((m) =>
  judge(PROMPTS[m], { id: memberId(m) }),
);

export const GATES = {
  holistic: "t2.verify.holistic",
  raw: "t2.verify.raw",
  battery: "t2.verify.battery",
  batteryCorr: "t2.verify.battery-corr",
  batteryLearned: "t2.verify.battery-learned",
  chain: "t2.verify.chain",
} as const;
