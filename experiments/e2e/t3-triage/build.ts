/**
 * Fix track T3's corpora: generate every item, label it, and write the corpus files the runner
 * reads, plus `spotcheck.json` (25 seeded items without labels, for the coordinator's blind
 * relabel). Run once, before the first live call:
 *
 *   bun experiments/e2e/t3-triage/build.ts
 *
 * The runner hashes these files into each run's manifest, so a label cannot move after a model
 * has answered without the manifest showing it. Rebuilding is refused once a live run exists
 * unless `--force` is given, and a forced rebuild of a changed corpus is a new corpus.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { judge, pick, rate } from "../../../src/questions.ts";
import type { Question } from "../../../src/types.ts";
import { corpusHash, E2E_OUT, progress, writeJson } from "../lib.ts";
import { buildApprovals } from "./corpus/approvals.ts";
import { Draw } from "./corpus/common.ts";
import { buildModeration, SUB_QUESTIONS } from "./corpus/moderation.ts";
import { buildMultilingual, LANGS, RUBRICS } from "./corpus/multilingual.ts";
import {
  BRINDLE_CRITERIA,
  BRINDLE_QUEUES,
  buildRouting,
  buildSibling,
  FERNHILL_CRITERIA,
  FERNHILL_QUEUES,
  ROUTE_PROMPT,
  SIBLING_ROUTE_PROMPT,
  SIBLING_URGENCY_PROMPT,
  URGENCY_LEVELS,
  URGENCY_PROMPT,
} from "./corpus/routing.ts";

export const TRACK = "t3-triage";
export const CORPUS_DIR = join(import.meta.dirname, "corpus");

// ---------------------------------------------------------------------------
// The questions, fixed with the corpora so the hash covers their wording.
// ---------------------------------------------------------------------------

const APPROVE_CRITERIA = {
  yes: "Every rule of the policy that applies to this request is met.",
  no: "At least one rule of the policy that applies to this request is not met.",
};
export const APPROVAL_ARMS = ["raw", "digest", "relative"] as const;

export function approvalQuestion(arm: (typeof APPROVAL_ARMS)[number]): Question {
  return judge("Under the policy shown, should this request be approved?", {
    id: `approve.${arm}`,
    criteria: APPROVE_CRITERIA,
  });
}

export const routeQuestion = (): Question =>
  pick(ROUTE_PROMPT, BRINDLE_QUEUES, { id: "route", criteria: BRINDLE_CRITERIA });
export const urgencyQuestion = (): Question =>
  rate(URGENCY_PROMPT, URGENCY_LEVELS, { id: "urgency" });
export const siblingRouteQuestion = (): Question =>
  pick(SIBLING_ROUTE_PROMPT, FERNHILL_QUEUES, { id: "sib.route", criteria: FERNHILL_CRITERIA });
export const siblingUrgencyQuestion = (): Question =>
  rate(SIBLING_URGENCY_PROMPT, URGENCY_LEVELS, { id: "sib.urgency" });

export const MOD_QUESTIONS = {
  threat: judge("Does this post threaten violence or serious harm against a person or group?", {
    id: "threat",
    criteria: {
      yes: "It threatens to hurt, kill or attack someone or damage their property, including veiled threats or calls for others to do so.",
      no: "No threat; violent words used as a figure of speech (a lure that 'murders' fish, 'crushing it' at a tournament) are not threats.",
    },
  }),
  harass: judge(
    "Does this post insult, demean or bully a specific person, or attack people for who they are?",
    {
      id: "harass",
      criteria: {
        yes: "It attacks a named or @mentioned person, or a group for who they are, with insults, mockery or bullying.",
        no: "No personal attack; disagreeing with or criticising an idea or a technique is fine.",
      },
    },
  ),
  spam: judge(
    "Is this post spam: unsolicited advertising, a scam, phishing, or links pushing something unrelated to fishing?",
    {
      id: "spam",
      criteria: {
        yes: "It advertises or links something unrelated to the discussion, or tries to scam or phish readers.",
        no: "On-topic posts, including members selling their own used gear in the Classifieds board and links to their own trip reports.",
      },
    },
  ),
  selfharm: judge("Does the writer suggest they might harm themselves or end their life?", {
    id: "selfharm",
    criteria: {
      yes: "They talk about ending their life, not being around, saying goodbye, giving away possessions for that reason, or being better off gone.",
      no: "No such sign; ordinary disappointment, tiredness or jokes that are plainly about something else.",
    },
  }),
} as const;

export function multilingualQuestions(
  lang: "en" | (typeof LANGS)[number],
  arm: "en-rubric" | "translated",
): { route: Question; urgency: Question } {
  const r = RUBRICS[arm === "en-rubric" ? "en" : lang];
  const options = BRINDLE_QUEUES.map((q) => r.options[q]);
  const criteria = Object.fromEntries(BRINDLE_QUEUES.map((q) => [r.options[q], r.criteria[q]]));
  return {
    route: pick(r.routePrompt, options, { id: `ml.${lang}.${arm}.route`, criteria }),
    urgency: rate(r.urgencyPrompt, r.levels, { id: `ml.${lang}.${arm}.urgency` }),
  };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function share(xs: readonly unknown[], f: (x: never) => boolean): string {
  const k = xs.filter((x) => f(x as never)).length;
  return `${k}/${xs.length} (${((100 * k) / xs.length).toFixed(1)}%)`;
}

function tally<T>(xs: readonly T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}

function unique(name: string, states: readonly string[]): void {
  if (new Set(states).size !== states.length)
    throw new Error(`${name}: two items render the same state`);
}

export function build() {
  const approvals = buildApprovals();
  const routing = buildRouting();
  const sibling = buildSibling();
  const moderation = buildModeration();
  const multilingual = buildMultilingual();

  for (const arm of APPROVAL_ARMS)
    unique(
      `approvals.${arm}`,
      approvals.map((a) => a.states[arm]),
    );
  unique(
    "routing",
    routing.map((r) => r.state),
  );
  unique(
    "sibling",
    sibling.map((r) => r.state),
  );
  unique(
    "moderation",
    moderation.map((m) => m.state),
  );
  for (const l of ["en", ...LANGS] as const)
    unique(
      `multilingual.${l}`,
      multilingual.map((m) => m.states[l]),
    );
  // Routing tickets and the multilingual English tickets come from the same templates; they must not repeat.
  const overlap = multilingual.filter((m) => routing.some((r) => r.state === m.states.en));
  if (overlap.length > 0) throw new Error("a multilingual ticket repeats a routing ticket");

  const noisy = approvals.filter((a) =>
    /\d\.\d*0000000\d|\d\.\d*9999999\d/.test(a.states.digest),
  ).length;
  progress(
    `approvals: ${approvals.length} items, approve ${share(approvals, (a: (typeof approvals)[number]) => a.label.truth === true)}, ambiguous ${share(approvals, (a: (typeof approvals)[number]) => a.label.ambiguous === true)}, over hard limit ${share(approvals, (a: (typeof approvals)[number]) => a.floor.overLimit)}, wire ${share(approvals, (a: (typeof approvals)[number]) => a.floor.wire)}, digest states with float noise ${noisy}`,
  );
  progress(
    `routing: ${routing.length} tickets from ${new Set(routing.map((r) => r.template)).size} templates; routes ${JSON.stringify(tally(routing, (r) => r.route.truth))}; urgency ${JSON.stringify(tally(routing, (r) => r.urgency.truth))}; ambiguous route ${share(routing, (r: (typeof routing)[number]) => r.route.ambiguous === true)}, urgency ${share(routing, (r: (typeof routing)[number]) => r.urgency.ambiguous === true)}`,
  );
  progress(
    `sibling: ${sibling.length} tickets from ${new Set(sibling.map((r) => r.template)).size} templates; urgency ${JSON.stringify(tally(sibling, (r) => r.urgency.truth))}`,
  );
  progress(
    `moderation: ${moderation.length} posts; needs action ${share(moderation, (m: (typeof moderation)[number]) => m.label.truth)}; ambiguous ${share(moderation, (m: (typeof moderation)[number]) => m.label.ambiguous === true)}; floored ${share(moderation, (m: (typeof moderation)[number]) => m.floored)}; split ${JSON.stringify(tally(moderation, (m) => m.split))}`,
  );
  progress(
    `multilingual: ${multilingual.length} tickets x 4 languages from ${new Set(multilingual.map((m) => m.template)).size} templates; urgency ${JSON.stringify(tally(multilingual, (m) => m.urgency.truth))}`,
  );

  const questions = {
    approvals: Object.fromEntries(APPROVAL_ARMS.map((a) => [a, approvalQuestion(a)])),
    routing: { route: routeQuestion(), urgency: urgencyQuestion() },
    sibling: { route: siblingRouteQuestion(), urgency: siblingUrgencyQuestion() },
    moderation: MOD_QUESTIONS,
    multilingual: Object.fromEntries(
      (["en", ...LANGS] as const).flatMap((l) =>
        (["en-rubric", "translated"] as const)
          .filter((arm) => !(l === "en" && arm === "translated"))
          .map((arm) => [`${l}.${arm}`, multilingualQuestions(l, arm)]),
      ),
    ),
  };
  const corpora = {
    approvals: { set: "approvals", items: approvals, questions: questions.approvals },
    routing: { set: "routing", items: routing, questions: questions.routing },
    sibling: { set: "sibling", items: sibling, questions: questions.sibling },
    moderation: {
      set: "moderation",
      items: moderation,
      questions: { members: SUB_QUESTIONS.map((k) => questions.moderation[k]) },
    },
    multilingual: { set: "multilingual", items: multilingual, questions: questions.multilingual },
  };
  return { corpora, spotcheck: spotcheck(corpora) };
}

type Corpora = {
  approvals: { items: ReturnType<typeof buildApprovals>; questions: Record<string, Question> };
  routing: {
    items: ReturnType<typeof buildRouting>;
    questions: { route: Question; urgency: Question };
  };
  sibling: {
    items: ReturnType<typeof buildSibling>;
    questions: { route: Question; urgency: Question };
  };
  moderation: { items: ReturnType<typeof buildModeration> };
  multilingual: { items: ReturnType<typeof buildMultilingual> };
};

/** 25 seeded-random items across the sets, as the model saw them, without any label or why. */
function spotcheck(cs: Corpora): unknown {
  const d = new Draw(2026_11_12);
  const take = <T>(xs: readonly T[], n: number): T[] => d.shuffle(xs).slice(0, n);
  const out: unknown[] = [];
  for (const a of take(cs.approvals.items, 6)) {
    out.push({
      id: a.id,
      set: "approvals",
      state: a.states.raw,
      questions: [cs.approvals.questions.raw],
    });
  }
  for (const r of take(cs.routing.items, 6)) {
    out.push({
      id: r.id,
      set: "routing",
      state: r.state,
      questions: [cs.routing.questions.route, cs.routing.questions.urgency],
    });
  }
  for (const r of take(cs.sibling.items, 3)) {
    out.push({
      id: r.id,
      set: "sibling",
      state: r.state,
      questions: [cs.sibling.questions.route, cs.sibling.questions.urgency],
    });
  }
  for (const m of take(
    cs.moderation.items.filter((x) => !x.floored),
    6,
  )) {
    out.push({
      id: m.id,
      set: "moderation",
      state: m.state,
      questions: [
        {
          kind: "judge",
          id: "needs_action",
          prompt:
            "Does this post need moderator action (a threat, harassment, spam, or a self-harm cue)?",
        },
        ...SUB_QUESTIONS.map((k) => MOD_QUESTIONS[k]),
      ],
    });
  }
  for (const m of take(cs.multilingual.items, 4)) {
    const lang = d.pick(LANGS);
    out.push({
      id: `${m.id}.${lang}`,
      set: `multilingual.${lang}`,
      state: m.states[lang],
      questions: [routeQuestion(), urgencyQuestion()],
    });
  }
  return {
    track: TRACK,
    note: "Blind relabel sample: 25 seeded items as the model saw them, no labels. Label each question; for moderation, needs_action is the combined question.",
    seed: 2026_11_12,
    items: out,
  };
}

if (import.meta.main) {
  const force = process.argv.includes("--force");
  const outDir = join(E2E_OUT, TRACK);
  const liveRuns = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith("-live")) : [];
  if (liveRuns.length > 0 && !force) {
    throw new Error(
      `live runs exist (${liveRuns.join(", ")}); corpora are fixed. Pass --force to rebuild a new corpus.`,
    );
  }
  const { corpora, spotcheck: sc } = build();
  mkdirSync(CORPUS_DIR, { recursive: true });
  for (const [name, corpus] of Object.entries(corpora)) {
    writeJson(join(CORPUS_DIR, `${name}.json`), corpus);
    progress(`wrote corpus/${name}.json  hash ${corpusHash(corpus).slice(0, 16)}`);
  }
  writeJson(join(import.meta.dirname, "spotcheck.json"), sc);
  progress("wrote spotcheck.json");
}
