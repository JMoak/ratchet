/**
 * The safety invariants, stated once and swept over a grid: strategy x what each voter does x
 * floor x mode. The example tests beside this one pin the counterexamples the end-to-end
 * evaluation found; this one states the rule those examples are instances of, so a new strategy
 * or call path is held to it without anyone writing its counterexample first.
 *
 * Judge question, yes means go, act bar 0.9. The properties:
 *
 *  floor-monotone    the ruling is at least as cautious as every floor that fired; a floor that
 *                    throws or answers outside the vocabulary counts as review (invariant 2)
 *  add-a-floor       the same request with a floor never rules less cautiously than without
 *  fault-never-acts  if a voter the request relied on misbehaved, the ruling is not act
 *                    (invariant 3); "relied on" is spelled out per strategy in `relied`
 *  failed-open       a decision flagged failedOpen never rules act
 *  shadow-inert      in shadow the application action is the baseline (invariant 4)
 *  enforce-faithful  in enforce, with no audits, the application action is the ruling
 *  always-a-row      an ask never throws on a voter or floor fault, and leaves its ledger row
 *  lower-a-member    lowering one voter's p(yes) never makes the ruling less cautious
 *
 * Run on the tree before the evaluation's fixes, the same grid finds a mistyped floor ruling
 * act, malformed answers ruling act, and asks that throw with no row (e2e T4-01, T4-13).
 *
 * Two places where a failed voter is tolerated on purpose are named here, not hidden:
 * `minMembers` below the member count and `maxFailedSamples` above zero are the caller's own
 * opt-in, and a cascade escalates past a failed lower tier as it does past an unsure one, so
 * the tier that settles is the one it relied on. With `pool` set that last case leaves the
 * upper tier to act alone where the pooled pair might not have (the question e2e T4-04 settled
 * for ensembles); it is listed as an expectation below so that changing it is a visible edit.
 */
import { describe, expect, it } from "vitest";
import {
  type Action,
  CAUTION,
  concur,
  type Decision,
  Engine,
  type FloorRule,
  type GatePolicy,
  type JudgeVerdict,
  judge,
  MemoryLedger,
  type Mode,
  type Oracle,
  oneWayDoor,
  type Question,
  refuseIf,
  reviewIf,
  type StrategySpec,
} from "../src/index.ts";

type Behaviour = { readonly p: number } | { readonly fault: Fault };

const FAULTS = [
  "throw",
  "throw-unprintable",
  "reject-late",
  "nan",
  "above-one",
  "negative",
  "string-prob",
  "null-prob",
  "wrong-id",
  "wrong-kind",
  "empty-batch",
  "long-batch",
  "null-batch",
  "undefined-entry",
  "confidence-lie",
  "missing-verdict",
  "infinite-cost",
  "getter-throws",
] as const;
type Fault = (typeof FAULTS)[number];

const isFault = (b: Behaviour): b is { readonly fault: Fault } => "fault" in b;
const show = (b: Behaviour): string => (isFault(b) ? b.fault : `p=${b.p}`);

function answer(q: Question, p: number, id: string): Decision {
  return {
    verdict: { kind: "judge", questionId: q.id, pYes: p, confidence: Math.max(p, 1 - p) },
    oracle: id,
    model: `${id}-model`,
    latencyMs: 1,
    cost: 0.0001,
    at: "2026-11-12T00:00:00.000Z",
  };
}

/** Corrupt the first of a batch of confident yes answers, the way a broken adapter would. */
function corrupt(fault: Fault, questions: readonly Question[], id: string): unknown {
  const good = questions.map((q) => answer(q, 0.99, id));
  const first = good[0] as unknown as { verdict: Record<string, unknown>; cost: number };
  switch (fault) {
    case "throw":
      throw new Error("boom");
    case "throw-unprintable":
      throw {
        toString() {
          throw new Error("unprintable");
        },
      };
    case "reject-late":
      return new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 0));
    case "nan":
      first.verdict.pYes = Number.NaN;
      return good;
    case "above-one":
      first.verdict.pYes = 1.7;
      first.verdict.confidence = 1.7;
      return good;
    case "negative":
      first.verdict.pYes = -0.2;
      return good;
    case "string-prob":
      first.verdict.pYes = "0.99";
      return good;
    case "null-prob":
      first.verdict.pYes = null;
      return good;
    case "wrong-id":
      first.verdict.questionId = "someone-else";
      return good;
    case "wrong-kind":
      first.verdict = {
        kind: "pick",
        questionId: first.verdict.questionId,
        choice: "yes",
        probabilities: { yes: 1 },
        confidence: 1,
      };
      return good;
    case "empty-batch":
      return [];
    case "long-batch":
      return [...good, answer(questions[0] as Question, 0.99, id)];
    case "null-batch":
      return null;
    case "undefined-entry":
      return questions.map(() => undefined);
    case "confidence-lie":
      first.verdict.pYes = 0.55;
      first.verdict.confidence = 0.999;
      return good;
    case "missing-verdict":
      delete (first as { verdict?: unknown }).verdict;
      return good;
    case "infinite-cost":
      first.cost = Number.POSITIVE_INFINITY;
      return good;
    case "getter-throws":
      Object.defineProperty(first, "verdict", {
        get() {
          throw new Error("trap");
        },
      });
      return good;
  }
}

interface Probe {
  calls: number;
}

/** A voter with one behaviour. Distinct ids and models, so no shared-family default applies. */
function voter(id: string, b: Behaviour, probe: Probe): Oracle {
  return {
    id,
    async decide(_state, questions) {
      probe.calls++;
      if (!isFault(b)) return questions.map((q) => answer(q, b.p, id));
      return (await corrupt(b.fault, questions, id)) as Decision[];
    },
  };
}

const FLOORS = ["none", "review", "refuse", "door", "throws", "typo"] as const;
type FloorKind = (typeof FLOORS)[number];

/** The least cautious ruling each floor allows. */
const BOUND: Readonly<Record<FloorKind, Action>> = {
  none: "act",
  review: "review",
  refuse: "refuse",
  door: "review",
  throws: "review",
  typo: "review",
};

function floorsOf(kind: FloorKind): FloorRule[] {
  switch (kind) {
    case "none":
      return [];
    case "review":
      return [reviewIf(/call/)];
    case "refuse":
      return [refuseIf(/call/)];
    case "door":
      return [oneWayDoor(() => true)];
    case "throws":
      return [
        () => {
          throw new Error("floor broke");
        },
      ];
    case "typo":
      return [(() => "deny") as unknown as FloorRule];
  }
}

const STRATEGIES = [
  "single",
  "ensemble",
  "ensemble-min2",
  "ensemble-matrix",
  "sequential",
  "sequential-tolerant",
  "cascade",
  "cascade-pooled",
  "concur",
  "battery",
  "battery-any",
  "battery-fn",
] as const;
type Strategy = (typeof STRATEGIES)[number];

/** Voters a strategy takes. A battery's member questions share one voter. */
const ARITY: Readonly<Record<Strategy, 1 | 2 | 3>> = {
  single: 1,
  ensemble: 3,
  "ensemble-min2": 3,
  "ensemble-matrix": 3,
  sequential: 3,
  "sequential-tolerant": 3,
  cascade: 2,
  "cascade-pooled": 2,
  concur: 2,
  battery: 1,
  "battery-any": 1,
  "battery-fn": 1,
};

/** Strategies whose configuration says a failed voter may be left out. */
const TOLERATES_A_FAILED_VOTER: ReadonlySet<Strategy> = new Set([
  "ensemble-min2",
  "sequential-tolerant",
]);
const CASCADES: ReadonlySet<Strategy> = new Set(["cascade", "cascade-pooled"]);

const POLICY: GatePolicy = { actAbove: 0.9 };
const STATE = "tool call: git status";
const NAMES = ["alpha", "bravo", "charlie"] as const;

interface Run {
  readonly ruling: Action;
  readonly action: Action;
  readonly failedOpen: boolean;
  /** Per voter: was it asked at all. */
  readonly called: readonly boolean[];
  readonly rowAction: Action | undefined;
  readonly threw?: string;
}

function strategyOf(
  strategy: Strategy,
  members: readonly { oracle: Oracle; label: string }[],
): StrategySpec | undefined {
  switch (strategy) {
    case "ensemble":
      return { ensemble: { members } };
    case "ensemble-min2":
      return { ensemble: { members, minMembers: 2 } };
    case "ensemble-matrix":
      return {
        ensemble: {
          members,
          correlations: {
            alpha: { bravo: 0.6, charlie: 0 },
            bravo: { alpha: 0.6, charlie: 0 },
            charlie: { alpha: 0, bravo: 0 },
          },
        },
      };
    case "sequential":
      return { sequential: { members, settleAbove: 0.95, maxSamples: 3 } };
    case "sequential-tolerant":
      return { sequential: { members, settleAbove: 0.95, maxSamples: 3, maxFailedSamples: 1 } };
    case "cascade":
      return { cascade: { tiers: members.map((m) => ({ ...m, settleAbove: 0.9 })) } };
    case "cascade-pooled":
      return { cascade: { tiers: members.map((m) => ({ ...m, settleAbove: 0.9 })), pool: {} } };
    case "concur":
      return concur(members, { goIsYes: true });
    default:
      return undefined;
  }
}

async function run(
  strategy: Strategy,
  behaviours: readonly Behaviour[],
  floor: FloorKind,
  mode: Mode,
): Promise<Run> {
  const probes = behaviours.map(() => ({ calls: 0 }));
  const oracles = behaviours.map((b, i) => voter(NAMES[i] as string, b, probes[i] as Probe));
  const members = oracles.map((oracle, i) => ({ oracle, label: NAMES[i] as string }));
  const ledger = new MemoryLedger();
  const engine = new Engine({
    oracle: oracles[0] as Oracle,
    ledger,
    mode,
    auditRate: 0,
    seed: 7,
  });
  const base = { id: "g", policy: POLICY, floors: floorsOf(floor), mode };
  const called = (): boolean[] => probes.map((p) => p.calls > 0);
  try {
    const spec = strategyOf(strategy, members);
    const battery = [
      judge("Is it read-only?", { id: "ro" }),
      judge("Is it in the workspace?", { id: "ws" }),
    ];
    const gate = strategy.startsWith("battery")
      ? engine.gate({
          ...base,
          question: battery,
          ...(strategy === "battery-any" ? { combine: "any" as const } : {}),
          ...(strategy === "battery-fn"
            ? {
                combine: (vs: readonly JudgeVerdict[]): JudgeVerdict => ({
                  kind: "judge",
                  questionId: "g",
                  pYes: Math.min(...vs.map((v) => v.pYes)),
                  confidence: 0.5,
                }),
              }
            : {}),
        })
      : engine.gate({
          ...base,
          question: judge("Is this call safe to run?", { id: "safe" }),
          ...(spec !== undefined ? { strategy: spec } : {}),
        });
    const r = await gate.ask(STATE);
    const row = (await ledger.all()).find((x) => x.id === r.recordId);
    return {
      ruling: r.ruling.action,
      action: r.action,
      failedOpen: r.decision.failedOpen === true,
      called: called(),
      rowAction: row?.action,
    };
  } catch (error) {
    return {
      ruling: "review",
      action: "review",
      failedOpen: false,
      called: called(),
      rowAction: undefined,
      threw: error instanceof Error ? error.message : "a non-error",
    };
  }
}

/**
 * Did the request rely on a voter that misbehaved? Every strategy relies on every voter it
 * asked, except a cascade, which relies on the tier that settled: the last one it asked.
 */
function relied(strategy: Strategy, behaviours: readonly Behaviour[], r: Run): boolean {
  if (CASCADES.has(strategy)) {
    const last = r.called.lastIndexOf(true);
    const b = behaviours[last];
    return b !== undefined && isFault(b);
  }
  return behaviours.some((b, i) => isFault(b) && r.called[i] === true);
}

const GOOD: readonly Behaviour[] = [{ p: 0.99 }, { p: 0.6 }, { p: 0.02 }];
const BAD: readonly Behaviour[] = FAULTS.map((fault) => ({ fault }));

/** Every tuple of honest voters, plus every tuple with exactly one misbehaving voter. */
function tuples(n: number): Behaviour[][] {
  const honest = (k: number): Behaviour[][] =>
    k === 0 ? [[]] : honest(k - 1).flatMap((rest) => GOOD.map((g) => [g, ...rest]));
  const out = honest(n);
  for (let slot = 0; slot < n; slot++) {
    for (const others of honest(n - 1)) {
      for (const bad of BAD) out.push([...others.slice(0, slot), bad, ...others.slice(slot)]);
    }
  }
  return out;
}

async function sweep(strategy: Strategy): Promise<{ cells: number; broken: string[] }> {
  const broken: string[] = [];
  let cells = 0;
  for (const behaviours of tuples(ARITY[strategy])) {
    for (const mode of ["shadow", "enforce"] as const) {
      let bare: Run | undefined;
      for (const floor of FLOORS) {
        cells++;
        const r = await run(strategy, behaviours, floor, mode);
        if (floor === "none") bare = r;
        const cell = `[${behaviours.map(show).join(", ")}] floor=${floor} ${mode}`;
        const say = (property: string, what: string) => broken.push(`${property}: ${cell} ${what}`);
        if (r.threw !== undefined) {
          say("always-a-row", `threw "${r.threw}"`);
          continue;
        }
        if (r.rowAction === undefined) say("always-a-row", "left no ledger row");
        else if (r.rowAction !== r.action) say("always-a-row", `row says ${r.rowAction}`);
        if (CAUTION[r.ruling] < CAUTION[BOUND[floor]]) say("floor-monotone", `ruled ${r.ruling}`);
        if (bare !== undefined && CAUTION[r.ruling] < CAUTION[bare.ruling]) {
          say("add-a-floor", `ruled ${r.ruling}, ${bare.ruling} without the floor`);
        }
        if (r.failedOpen && r.ruling === "act") say("failed-open", "ruled act");
        if (
          !TOLERATES_A_FAILED_VOTER.has(strategy) &&
          relied(strategy, behaviours, r) &&
          r.ruling === "act"
        ) {
          say("fault-never-acts", "ruled act");
        }
        if (mode === "shadow" && r.action !== "review") say("shadow-inert", `did ${r.action}`);
        if (mode === "enforce" && r.action !== r.ruling) {
          say("enforce-faithful", `did ${r.action}, ruled ${r.ruling}`);
        }
      }
    }
  }
  return { cells, broken };
}

describe("safety invariants over the strategy grid", () => {
  for (const strategy of STRATEGIES) {
    it(`${strategy}: no cell breaks an invariant`, { timeout: 60_000 }, async () => {
      const { cells, broken } = await sweep(strategy);
      expect(cells).toBeGreaterThan(0);
      expect(broken.slice(0, 20)).toEqual([]);
    });
  }

  it("lowering one voter's p(yes) never makes the ruling less cautious", {
    timeout: 60_000,
  }, async () => {
    const ladder = [0.999, 0.99, 0.95, 0.9, 0.8, 0.6, 0.5, 0.4, 0.2, 0.05, 0.001];
    const others = [0.999, 0.95, 0.7, 0.3, 0.02];
    const rest = (k: number): number[][] =>
      k === 0 ? [[]] : rest(k - 1).flatMap((r) => others.map((o) => [o, ...r]));
    const broken: string[] = [];
    for (const strategy of STRATEGIES) {
      if (strategy.startsWith("battery")) continue; // one voter answers every member alike
      const n = ARITY[strategy];
      for (const fixed of rest(n - 1)) {
        for (let slot = 0; slot < n; slot++) {
          let previous: Action | undefined;
          for (const p of ladder) {
            const ps = [...fixed.slice(0, slot), p, ...fixed.slice(slot)];
            const r = await run(
              strategy,
              ps.map((x) => ({ p: x })),
              "none",
              "enforce",
            );
            if (previous !== undefined && CAUTION[r.ruling] < CAUTION[previous]) {
              broken.push(`${strategy} [${ps.join(", ")}] ruled ${r.ruling} after ${previous}`);
            }
            previous = r.ruling;
          }
        }
      }
    }
    expect(broken.slice(0, 20)).toEqual([]);
  });

  /**
   * The named exception, as an expectation: a cascade's failed lower tier is escalated past,
   * and the upper tier's confident yes acts, pooled or not. If a pooled cascade should fail
   * open when a tier it meant to pool is missing (as an ensemble does below `minMembers`),
   * this is the test that changes.
   */
  it.each(["cascade", "cascade-pooled"] as const)(
    "%s: a failed lower tier is escalated past and the upper tier rules alone",
    async (strategy) => {
      const r = await run(strategy, [{ fault: "throw" }, { p: 0.99 }], "none", "enforce");
      expect(r.called).toEqual([true, true]);
      expect(r.failedOpen).toBe(false);
      expect(r.ruling).toBe("act");
    },
  );
});
