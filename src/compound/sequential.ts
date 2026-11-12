import { modelFamily } from "../ledger/calibration.ts";
import { neutralVerdict } from "../questions.ts";
import type { Decision, Question, Verdict } from "../types.ts";
import { type PoolOptions, pool } from "./aggregate.ts";
import { type CompoundDecision, compoundOf, memberKey } from "./compound.ts";
import { identity, type Member, untransform } from "./ensemble.ts";

export interface SequentialOptions extends PoolOptions {
  /**
   * Members are sampled in order and cycled if more samples are needed than members. Sample i
   * is keyed by member i % members.length, with `~<round>` added from that member's second
   * sampling on (`jev#1`, `jev#2`, `jev#1~2`): a repeat draw is the same member asked again,
   * whose agreement with its first answer is exactly what the design effect discounts, so it
   * gets its own key rather than sharing one that would make a row hold the key twice.
   * A `negated` member's answer is flipped back before pooling, as in `ensemble`.
   *
   * Order matters for early stopping: put the member most different from the first (another
   * model family, not another pin or replica of the same model) second, so that the earliest
   * possible stop rests on two different voices.
   */
  readonly members: readonly Member[];
  /** Stop once the pooled verdict's confidence reaches this. A number; above 1 never settles. */
  readonly settleAbove: number;
  /**
   * Alternatively stop once the leading answer is ahead of the runner-up by this many votes
   * (first-to-ahead-by-k, the rule MAKER used to run a million steps without an error).
   * Either condition settles. The rule assumes independent votes, so votes are counted per
   * model family (`independentLead`): replicas of one model, two pins of one model (jev-1.13 and
   * jev-1.14), or one member sampled again, are one vote however often they agree; the
   * runner-up's are counted per model, so that merging can only delay a stop. With a single
   * family the lead never exceeds 1. A positive integer.
   */
  readonly settleLead?: number;
  /** Answered samples needed before either rule may settle; an integer of at least 1. */
  readonly minSamples?: number;
  /** The most samples bought; a finite integer of at least 1, checked before the first. */
  readonly maxSamples: number;
  /**
   * Samples that may fail open before the run does, an integer of at least 0. Default 0: the
   * first failed sample ends the run, neutral and failed open, as an ensemble or a battery
   * missing a member does. Dropping a failed sample and sampling on lets the members that did
   * answer settle alone, and the member that failed may be the cautious one (a 0.30 member down
   * leaves a 0.97 member to act). Raise it to sample through a member's outage, at that price.
   */
  readonly maxFailedSamples?: number;
}

export interface SequentialDecision extends CompoundDecision {
  readonly detail: {
    readonly samples: number;
    readonly settled: boolean;
    readonly trajectory: readonly number[];
    /** Samples that failed open, when any did. */
    readonly failedSamples?: number;
  };
}

/** The answer a verdict votes for: yes/no for a judge, the choice or the level otherwise. */
const voteOf = (v: Verdict): string =>
  v.kind === "judge" ? (v.pYes >= 0.5 ? "yes" : "no") : v.kind === "pick" ? v.choice : v.level;

/** The margin between the two largest counts. */
function margin(counts: ReadonlyMap<string, number>): number {
  const sorted = [...counts.values()].sort((a, b) => b - a);
  return (sorted[0] ?? 0) - (sorted[1] ?? 0);
}

/** Votes for the leading answer minus votes for the runner-up, one vote per verdict. */
export function voteLead(vs: readonly Verdict[]): number {
  const counts = new Map<string, number>();
  for (const v of vs) counts.set(voteOf(v), (counts.get(voteOf(v)) ?? 0) + 1);
  return margin(counts);
}

/**
 * The model a decision speaks for: its pinned model when it reports a non-blank one, else its
 * oracle id. A blank pin (`model: ""`) names nothing, so it must not merge every oracle that
 * reports one into a single voter.
 */
export function voterModel(d: Decision): string {
  const model: unknown = d.model;
  return typeof model === "string" && model.trim() !== "" ? model : d.oracle;
}

/**
 * The voice a decision speaks with, for counting independent votes: the family (`modelFamily`)
 * of `voterModel`. Replicas of one oracle (`replicate`) share it, and so do two pins of one
 * model: jev-1.13 and jev-1.14 shared 89% of their errors (phi 0.785), so their agreeing is one
 * vote, not two.
 */
export const voterKey = (d: Decision): string => modelFamily(voterModel(d));

/** Votes per answer when decisions are grouped by `key`: each group votes its majority answer. */
function votesBy(ds: readonly Decision[], key: (d: Decision) => string): Map<string, number> {
  const groups = new Map<string, Map<string, number>>();
  for (const d of ds) {
    if (d.failedOpen) continue;
    const k = key(d);
    const counts = groups.get(k) ?? new Map<string, number>();
    const vote = voteOf(d.verdict);
    counts.set(vote, (counts.get(vote) ?? 0) + 1);
    groups.set(k, counts);
  }
  const votes = new Map<string, number>();
  for (const counts of groups.values()) {
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const [top, next] = ranked;
    if (!top || (next && next[1] === top[1])) continue;
    votes.set(top[0], (votes.get(top[0]) ?? 0) + 1);
  }
  return votes;
}

/**
 * The lead counted in independent votes, asymmetrically, so that treating models as one voice
 * can only delay a stop. Each group of decisions votes its own majority answer (none on a tie
 * within the group); failed-open decisions carry no vote. The leading answer's votes are counted
 * by model family (`voterKey`): correlated replicas or pins of one model agreeing is one voice,
 * not k (two Jev pins that agreed stopped a lead-by-2 run on 178 of 260 items and were wrong on
 * 26 of them). The runner-up's votes are counted by distinct model (`voterModel`): merging the
 * dissenters into one family would remove a vote from the side that says stop, and a lead-by-2
 * run whose two "no" answers came from gpt-4o and gpt-5 then acted a sample before the member
 * that would have said no. Each side takes the reading that keeps the lead smaller (the fewer
 * votes for the leader, the more for any other answer), so the lead is never larger than the one
 * counted per model, and grouping more models into a family never brings a stop forward.
 */
export function independentLead(ds: readonly Decision[]): number {
  const byFamily = votesBy(ds, voterKey);
  const byModel = votesBy(ds, voterModel);
  const answers = new Set([...byFamily.keys(), ...byModel.keys()]);
  let lead = 0;
  for (const answer of answers) {
    const mine = Math.min(byFamily.get(answer) ?? 0, byModel.get(answer) ?? 0);
    let rival = 0;
    for (const other of answers) {
      if (other === answer) continue;
      rival = Math.max(rival, byFamily.get(other) ?? 0, byModel.get(other) ?? 0);
    }
    lead = Math.max(lead, mine - rival);
  }
  return lead;
}

/** A count option, checked before anything is bought: an integer of at least `min`. */
function count(name: string, value: unknown, min: number): number {
  if (!(typeof value === "number" && Number.isInteger(value) && value >= min)) {
    throw new Error(`${name} must be an integer of at least ${min}, not ${String(value)}`);
  }
  return value;
}

/**
 * Keep buying cheap independent-ish samples until the pooled evidence is strong enough,
 * then stop. With calibrated members pooled in log-odds this is Wald's sequential
 * probability ratio test with symmetric bounds at +/- logit(settleAbove): easy items settle
 * in one sample, hard items get more, and the expected sample count is far below the fixed
 * ensemble size that would reach the same accuracy.
 */
export async function sequential(
  state: string,
  question: Question,
  opts: SequentialOptions,
): Promise<SequentialDecision> {
  if (opts.members.length === 0) throw new Error("sequential needs at least one member");
  // Every count is checked here, not only where a gate is registered: a strategy passed per ask
  // reaches this directly, and maxSamples: Infinity bought 501 answers against a $0.01 budget.
  const maxSamples = count("maxSamples", opts.maxSamples, 1);
  const minSamples = count("minSamples", opts.minSamples ?? 1, 1);
  const maxFailed = count("maxFailedSamples", opts.maxFailedSamples ?? 0, 0);
  if (opts.settleLead !== undefined) count("settleLead", opts.settleLead, 1);
  if (typeof opts.settleAbove !== "number" || Number.isNaN(opts.settleAbove)) {
    throw new Error(`settleAbove must be a number, not ${String(opts.settleAbove)}`);
  }
  let failedSamples = 0;
  let failure: string | undefined;
  const members: Decision[] = [];
  const memberKeys: string[] = [];
  // Each sample's member key without its round: a member sampled again is the same member, so a
  // correlation matrix (`PoolOptions.correlations`) reads the repeat as one voice asked twice.
  const poolKeys: string[] = [];
  const trajectory: number[] = [];
  let verdict: Verdict = neutralVerdict(question);
  let settled = false;
  for (let i = 0; i < maxSamples; i++) {
    const j = i % opts.members.length;
    const round = Math.floor(i / opts.members.length);
    const m = opts.members[j] as Member;
    const seen = (m.transform ?? identity)(state, question);
    const [d] = await m.oracle.decide(seen.state, [seen.question]);
    if (!d) throw new Error(`member ${m.label ?? m.oracle.id} returned nothing`);
    // The member record keeps the answer in the original question's terms, so the ledger and
    // `memberCorrelation` read a negated member's answer the way it was pooled.
    members.push({ ...d, verdict: untransform(question, d.verdict, m.negated === true) });
    const key = memberKey(m.oracle.id, j, m.label);
    memberKeys.push(round === 0 ? key : `${key}~${round + 1}`);
    poolKeys.push(key);
    if (d.failedOpen) {
      failedSamples++;
      if (failedSamples > maxFailed) {
        const cause = d.error !== undefined ? `: ${d.error}` : "";
        failure = `sample ${i + 1} (${m.label ?? m.oracle.id}) failed open${cause}; maxFailedSamples is ${maxFailed}`;
        break;
      }
    }
    const live = members.filter((x) => !x.failedOpen);
    if (live.length > 0) {
      verdict = pool(
        question,
        live.map((x) => x.verdict),
        { ...opts, memberKeys: poolKeys.filter((_, k) => members[k]?.failedOpen !== true) },
      );
    }
    trajectory.push(verdict.confidence);
    const lead = opts.settleLead !== undefined ? independentLead(live) : 0;
    if (
      live.length >= minSamples &&
      (verdict.confidence >= opts.settleAbove ||
        (opts.settleLead !== undefined && lead >= opts.settleLead))
    ) {
      settled = true;
      break;
    }
  }
  const base = compoundOf(
    "sequential",
    failure === undefined ? verdict : neutralVerdict(question),
    members,
    {
      parallel: false,
      oracle: `sequential(${opts.members.map((m) => m.label ?? m.oracle.id).join(",")})`,
      memberKeys,
    },
  );
  const allFailed = members.every((d) => d.failedOpen);
  return {
    ...base,
    detail: {
      samples: members.length,
      settled,
      trajectory,
      ...(failedSamples > 0 ? { failedSamples } : {}),
    },
    ...(allFailed || failure !== undefined ? { failedOpen: true } : {}),
    ...(failure !== undefined ? { error: failure.slice(0, 160) } : {}),
  };
}
