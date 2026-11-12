/**
 * The strategies track T5 compares, each as the `strategy` of a registered gate so its rows
 * carry members and detail exactly as a user's would. Every strategy gets its own engine and
 * JSONL ledger, and every engine registers the same five gates (one per domain).
 */
import type { Member, Transform } from "../../../src/compound/ensemble.ts";
import { compose, reframe, shuffleOptions } from "../../../src/compound/ensemble.ts";
import type { StrategySpec } from "../../../src/engine.ts";
import { judge as judgeQ } from "../../../src/questions.ts";
import type { Oracle } from "../../../src/types.ts";
import { type Domain, RUBRICS } from "./gates.ts";

/** The four backends, built fresh per strategy so no instance state is shared. */
export interface Backends {
  readonly jev113: () => Oracle;
  readonly jev114: () => Oracle;
  readonly haiku: () => Oracle;
  readonly luna: () => Oracle;
}

/** Bars fitted on the fit split after phase 1 and frozen before phase 2. */
export interface Frozen {
  readonly cascadeHaikuBar: number;
  readonly cascadeLunaBar: number;
}

export interface StrategyDef {
  readonly name: string;
  readonly phase: 1 | 2;
  /** The engine's default oracle (the one a single gate and a replicated ensemble ask). */
  readonly primary: keyof Backends;
  readonly budgetUsd: number;
  readonly concurrency: number;
  /** Undefined for the single strategy. */
  readonly spec?: (domain: Domain, b: Backends, frozen: Frozen) => StrategySpec;
  readonly describe: string;
}

/** Sequential settles on the pooled confidence; pre-registered before any call. */
export const SEQ_SETTLE_ABOVE = 0.95;
export const SEQ_MAX_SAMPLES = 3;
export const SEQ_SETTLE_LEAD = 2;

/** The negated rubric: asked as the complement, and flipped back by the ensemble. */
function negate(domain: Domain): Transform {
  const r = RUBRICS[domain];
  if (r.kind !== "judge") throw new Error(`${domain} has no negated rubric`);
  const q = judgeQ(r.negated.prompt, {
    id: `${r.question.id}.neg`,
    criteria: { yes: r.negated.yes, no: r.negated.no },
  });
  return (state) => ({ state, question: q });
}

function framingMembers(domain: Domain, oracle: Oracle): Member[] {
  const r = RUBRICS[domain];
  const para = reframe(() => r.paraphrase);
  if (r.kind === "judge") {
    return [
      { oracle, label: "jev113.orig" },
      { oracle, label: "jev113.para", transform: para },
      { oracle, label: "jev113.neg", transform: negate(domain), negated: true },
    ];
  }
  return [
    { oracle, label: "jev113.orig" },
    { oracle, label: "jev113.para", transform: para },
    { oracle, label: "jev113.shuf", transform: compose(shuffleOptions(7)) },
  ];
}

/**
 * The engine's sequential spec does not declare `settleLead`, though `sequential()` takes it
 * and the engine passes unknown pool fields through. A user who wants lead-by-k through a gate
 * has to widen the type, as here; finding T5 reports it.
 */
type SequentialSpec = Extract<StrategySpec, { readonly sequential: unknown }>["sequential"];
type SequentialWithLead = { readonly sequential: SequentialSpec & { readonly settleLead: number } };

export const STRATEGIES: readonly StrategyDef[] = [
  {
    name: "single-jev113",
    phase: 1,
    primary: "jev113",
    budgetUsd: 0.1,
    concurrency: 16,
    describe: "jev-1.13 alone",
  },
  {
    name: "single-jev114",
    phase: 1,
    primary: "jev114",
    budgetUsd: 0.1,
    concurrency: 16,
    describe: "jev-1.14 alone",
  },
  {
    name: "single-haiku",
    phase: 1,
    primary: "haiku",
    budgetUsd: 0.5,
    concurrency: 6,
    describe: "claude-haiku-5.5 alone (generative model in the decision role)",
  },
  {
    name: "single-luna",
    phase: 1,
    primary: "luna",
    budgetUsd: 0.5,
    concurrency: 6,
    describe: "gpt-6-luna alone (generative model in the decision role)",
  },
  {
    name: "rep3-jev113",
    phase: 2,
    primary: "jev113",
    budgetUsd: 0.2,
    concurrency: 12,
    spec: () => ({ ensemble: { k: 3 } }),
    describe:
      "replicated ensemble: jev-1.13 x3 via { ensemble: { k: 3 } } (engine default correlation 0.75)",
  },
  {
    name: "framing3-jev113",
    phase: 2,
    primary: "jev113",
    budgetUsd: 0.2,
    concurrency: 12,
    spec: (domain, b) => ({ ensemble: { members: framingMembers(domain, b.jev113()) } }),
    describe:
      "framing ensemble on jev-1.13: original, paraphrase, negated (judge) or shuffled options (pick); explicit members, default correlation 0",
  },
  {
    name: "diverse2",
    phase: 2,
    primary: "jev113",
    budgetUsd: 0.2,
    concurrency: 12,
    spec: (_d, b) => ({
      ensemble: {
        members: [
          { oracle: b.jev113(), label: "jev113" },
          { oracle: b.jev114(), label: "jev114" },
        ],
      },
    }),
    describe: "model-diverse ensemble jev-1.13 + jev-1.14, default correlation 0",
  },
  {
    name: "diverse3",
    phase: 2,
    primary: "jev113",
    budgetUsd: 0.6,
    concurrency: 6,
    spec: (_d, b) => ({
      ensemble: {
        members: [
          { oracle: b.jev113(), label: "jev113" },
          { oracle: b.jev114(), label: "jev114" },
          { oracle: b.haiku(), label: "haiku55" },
        ],
      },
    }),
    describe: "model-diverse ensemble jev-1.13 + jev-1.14 + haiku-5.5, default correlation 0",
  },
  {
    name: "cascade-haiku",
    phase: 2,
    primary: "jev113",
    budgetUsd: 0.6,
    concurrency: 6,
    spec: (_d, b, f) => ({
      cascade: {
        tiers: [
          { oracle: b.jev113(), settleAbove: f.cascadeHaikuBar, label: "jev113" },
          { oracle: b.haiku(), settleAbove: 0, label: "haiku55" },
        ],
      },
    }),
    describe: "cascade jev-1.13 -> haiku-5.5, tier-1 bar fitted on the fit split (frozen.json)",
  },
  {
    name: "cascade-luna",
    phase: 2,
    primary: "jev113",
    budgetUsd: 0.6,
    concurrency: 6,
    spec: (_d, b, f) => ({
      cascade: {
        tiers: [
          { oracle: b.jev113(), settleAbove: f.cascadeLunaBar, label: "jev113" },
          { oracle: b.luna(), settleAbove: 0, label: "luna" },
        ],
      },
    }),
    describe: "cascade jev-1.13 -> gpt-6-luna, tier-1 bar fitted on the fit split (frozen.json)",
  },
  {
    name: "seq-bar",
    phase: 2,
    primary: "jev113",
    budgetUsd: 0.6,
    concurrency: 6,
    spec: (_d, b) => ({
      sequential: {
        members: [
          { oracle: b.jev113(), label: "jev113" },
          { oracle: b.jev114(), label: "jev114" },
          { oracle: b.haiku(), label: "haiku55" },
        ],
        settleAbove: SEQ_SETTLE_ABOVE,
        maxSamples: SEQ_MAX_SAMPLES,
      },
    }),
    describe: `sequential over jev-1.13, jev-1.14, haiku-5.5; settleAbove ${SEQ_SETTLE_ABOVE}, maxSamples ${SEQ_MAX_SAMPLES}, default correlation 0`,
  },
  {
    name: "seq-lead",
    phase: 2,
    primary: "jev113",
    budgetUsd: 0.6,
    concurrency: 6,
    spec: (_d, b) => {
      const spec: SequentialWithLead = {
        sequential: {
          members: [
            { oracle: b.jev113(), label: "jev113" },
            { oracle: b.jev114(), label: "jev114" },
            { oracle: b.haiku(), label: "haiku55" },
          ],
          settleAbove: SEQ_SETTLE_ABOVE,
          maxSamples: SEQ_MAX_SAMPLES,
          settleLead: SEQ_SETTLE_LEAD,
        },
      };
      return spec;
    },
    describe: `as seq-bar plus settleLead ${SEQ_SETTLE_LEAD} (first-to-ahead-by-2); settleLead is not in the engine's StrategySpec type`,
  },
];
