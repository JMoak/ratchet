import { describe, expect, it } from "vitest";
import {
  acceptanceProgress,
  acceptanceSample,
  evaluateAcceptance,
  type ResolvedPlan,
  resolvePlan,
} from "../src/acceptance.ts";
import { anytimeLowerBound } from "../src/anytime.ts";
import type { DecisionRecord, Outcome } from "../src/ledger/ledger.ts";
import type { FitClass } from "../src/ledger/sources.ts";
import { rng } from "../src/math.ts";
import type { Action } from "../src/types.ts";

/** How a hand-built act is labelled: right or wrong to act on, by a source, or not at all. */
type Label = boolean | { readonly right: boolean; readonly source: string } | undefined;

interface RowOptions {
  readonly id: string;
  readonly label?: Label;
  readonly state?: string;
  readonly soft?: Action;
  readonly tags?: readonly string[];
  /** An exact 0.5 judge verdict: its label cannot say whether acting was right. */
  readonly unreadable?: boolean;
}

function outcomeOf(label: Label): Outcome | undefined {
  if (label === undefined) return undefined;
  const right = typeof label === "boolean" ? label : label.right;
  return {
    at: "t",
    correct: right,
    truth: right,
    ...(typeof label === "boolean" ? {} : { source: label.source }),
  };
}

function row(o: RowOptions): DecisionRecord {
  const outcome = outcomeOf(o.label);
  const pYes = o.unreadable ? 0.5 : 0.97;
  return {
    id: o.id,
    at: "2026-11-12T00:00:00.000Z",
    gateId: "g",
    requestId: o.id,
    questionId: "q",
    kind: "judge",
    prompt: "ok?",
    questionHash: "0123456789abcdef",
    stateHash: o.state ?? o.id,
    trustedHash: o.state ?? o.id,
    untrusted: [],
    oracle: "o",
    strategy: "single",
    verdict: { kind: "judge", questionId: "q", pYes, confidence: pYes },
    go: pYes,
    confidence: pYes,
    agreement: 1,
    soft: o.soft ?? "act",
    action: "review",
    mode: "shadow",
    cost: 0,
    latencyMs: 0,
    failedOpen: false,
    tags: o.tags ?? [],
    ...(outcome !== undefined ? { outcome } : {}),
  };
}

const acts = (labels: readonly Label[], prefix = "a"): DecisionRecord[] =>
  labels.map((label, i) => row({ id: `${prefix}${i}`, label }));

/** The bound's level is the plan's 1 - confidence, computed as the readout computes it. */
const ALPHA = 1 - 0.95;
/** A 149-act zero-error plan: 98% at 95%. */
const plan98 = resolvePlan({ target: 0.98 });

describe("acceptanceProgress: what a planned sample shows while it fills", () => {
  it("counts the labelled prefix in sample order, and every labelled act anywhere", () => {
    const rows = acts([true, true, true, undefined, false, true]);
    const p = acceptanceProgress(rows, plan98);
    expect(p).toMatchObject({
      acts: 6,
      sampleSize: 149,
      sample: ["a0", "a1", "a2", "a3", "a4", "a5"],
      prefix: { acts: 3, right: 3, wrong: 0 },
      labelled: 5,
      wrong: 1,
      untrusted: 0,
    });
    expect(p.plan).toEqual(plan98);
    // The prefix stops at the unlabelled act, but a wrong act after it already dooms the sample.
    expect(p.cannotPass).toBe(true);
    expect(p.lowerBound).toBe(anytimeLowerBound(3, 0, ALPHA));
  });

  it("reads nothing past an unlabelled act, however many later acts are labelled", () => {
    const rows = acts([undefined, ...Array<Label>(40).fill(true)]);
    const p = acceptanceProgress(rows, plan98);
    expect(p.prefix).toEqual({ acts: 0, right: 0, wrong: 0 });
    expect(p.labelled).toBe(40);
    expect(p.lowerBound).toBe(0);
    expect(p.cannotPass).toBe(false);
  });

  it("treats a label from a source the plan does not read as no label", () => {
    const consequence = { right: false, source: "reverted:git" };
    const rows = acts([true, consequence, true, { right: true, source: "review:blind:b" }]);
    const p = acceptanceProgress(rows, plan98);
    expect(p).toMatchObject({
      prefix: { acts: 1, right: 1, wrong: 0 },
      labelled: 3,
      wrong: 0,
      untrusted: 1,
      // The revert lands on a wrong act, but the plan does not read it, so it cannot doom it.
      cannotPass: false,
    });
    // The same act read as evaluateAcceptance reads it, once the sample is complete.
    const complete = [...rows, ...acts(Array<Label>(145).fill(true), "b")];
    expect(evaluateAcceptance(complete, plan98)).toMatchObject({
      status: "awaiting-labels",
      unlabelled: 1,
      untrusted: 1,
    });
  });

  it("reads the plan's own sources: a blind-only plan does not read unsourced labels", () => {
    const blindOnly = resolvePlan({ target: 0.98, sources: ["blind"] satisfies FitClass[] });
    const rows = acts([{ right: true, source: "review:blind:b" }, true, false]);
    expect(acceptanceProgress(rows, blindOnly)).toMatchObject({
      prefix: { acts: 1, right: 1, wrong: 0 },
      labelled: 1,
      wrong: 0,
      // An unsourced label is of the unknown class, which this plan does not read: as in
      // evaluateAcceptance, its act counts as labelled only from a source the plan does not read.
      untrusted: 2,
    });
  });

  it("counts an unreadable label as wrong, as the evaluation does", () => {
    const rows = [row({ id: "u", label: true, unreadable: true }), ...acts([true, true])];
    const p = acceptanceProgress(rows, plan98);
    expect(p).toMatchObject({ prefix: { acts: 3, right: 2, wrong: 1 }, wrong: 1 });
    expect(p.cannotPass).toBe(true);
  });

  it("is anytimeLowerBound on the prefix, and falls when a wrong act enters it", () => {
    const clean = acts(Array<Label>(50).fill(true));
    const before = acceptanceProgress(clean, plan98).lowerBound;
    expect(before).toBe(anytimeLowerBound(50, 0, ALPHA));
    const withWrong = [...clean, row({ id: "w", label: false })];
    const after = acceptanceProgress(withWrong, plan98).lowerBound;
    expect(after).toBe(anytimeLowerBound(50, 1, ALPHA));
    expect(after).toBeLessThan(before);
    // The plan's confidence sets the level.
    const loose = resolvePlan({ target: 0.98, confidence: 0.8 });
    expect(acceptanceProgress(clean, loose).lowerBound).toBe(anytimeLowerBound(50, 0, 1 - 0.8));
  });

  it("orders by sample position, never by when labels arrived", () => {
    // A wrong act labelled early, behind an act still awaiting review, does not enter the bound;
    // once the earlier act is labelled, both enter in sample order.
    const waiting = [
      ...acts(Array<Label>(50).fill(true)),
      row({ id: "late" }),
      row({ id: "w", label: false }),
    ];
    expect(acceptanceProgress(waiting, plan98).lowerBound).toBe(anytimeLowerBound(50, 0, ALPHA));
    const reviewed = waiting.map((r) => (r.id === "late" ? row({ id: "late", label: true }) : r));
    const p = acceptanceProgress(reviewed, plan98);
    expect(p.prefix).toEqual({ acts: 52, right: 51, wrong: 1 });
    expect(p.lowerBound).toBe(anytimeLowerBound(51, 1, ALPHA));
  });

  it("draws exactly the acts acceptanceSample draws: retries once, groups capped, then stops", () => {
    const grouped = resolvePlan({
      target: 0.5,
      confidence: 0.9,
      group: { tagPrefix: "session:", maxPerGroup: 2 },
    });
    const rows = [
      row({ id: "a1", tags: ["session:a"], label: true }),
      row({ id: "a1-retry", state: "a1", tags: ["session:a"], label: false }),
      row({ id: "a2", tags: ["session:a"], label: true }),
      row({ id: "a3", tags: ["session:a"], label: false }),
      row({ id: "held", soft: "review", label: false }),
      row({ id: "b1", tags: ["session:b"], label: true }),
      row({ id: "loose", label: true }),
      ...acts(Array<Label>(10).fill(false), "after"),
    ];
    const p = acceptanceProgress(rows, grouped);
    const drawn = acceptanceSample(rows, grouped).map((r) => r.id);
    expect(p.sample).toEqual(drawn);
    expect(p.acts).toBe(grouped.sampleSize);
    // The retry, the capped third act and the held row are not in it; nor is anything past it.
    expect(p.sample).not.toContain("a1-retry");
    expect(p.sample).not.toContain("a3");
    expect(p.sample).not.toContain("held");
    const inSample = rows.filter((r) => drawn.includes(r.id));
    const wrong = inSample.filter((r) => r.outcome?.correct === false).length;
    expect(p.wrong).toBe(wrong);
    expect(p.labelled).toBe(inSample.length);
  });

  it("agrees with the evaluation once the sample is complete", () => {
    const rows = acts([...Array<Label>(140).fill(true), false, ...Array<Label>(8).fill(true)]);
    const p = acceptanceProgress(rows, plan98);
    const result = evaluateAcceptance(rows, plan98);
    expect(result).toMatchObject({ status: "rejected", errors: 1 });
    expect(p).toMatchObject({ acts: 149, labelled: 149, wrong: 1, cannotPass: true });
    expect(result.status !== "collecting" && result.sample).toEqual(p.sample);
  });
});

describe("cannotPass agrees with evaluateAcceptance in the limit", () => {
  /** A seeded random partial ledger: acts labelled right, wrong, unreadably, untrusted or not at all. */
  function partial(rand: () => number, plan: ResolvedPlan, trial: number): DecisionRecord[] {
    const n = Math.floor(rand() * (plan.sampleSize + 1));
    return Array.from({ length: n }, (_, i) => {
      const id = `t${trial}-${i}`;
      const u = rand();
      if (u < 0.3) return row({ id });
      if (u < 0.38) return row({ id, label: { right: rand() < 0.5, source: "reverted:git" } });
      if (u < 0.42) return row({ id, label: true, unreadable: true });
      return row({ id, label: rand() < 0.9 });
    });
  }

  /** Complete the sample: label every act the plan cannot read yet, then add acts to its size. */
  function complete(
    rows: readonly DecisionRecord[],
    plan: ResolvedPlan,
    right: () => boolean,
    trial: number,
  ): DecisionRecord[] {
    const readable = (r: DecisionRecord) =>
      r.outcome !== undefined && r.outcome.source === undefined;
    const filled = rows.map((r) => (readable(r) ? r : row({ id: r.id, label: right() })));
    const more = Array.from({ length: plan.sampleSize - rows.length }, (_, i) =>
      row({ id: `t${trial}-more-${i}`, label: right() }),
    );
    return [...filled, ...more];
  }

  it("rejects every completion of a sample that cannot pass, and some completion of any other passes", () => {
    const rand = rng(20261112);
    const plans = [
      resolvePlan({ target: 0.8, confidence: 0.9 }),
      resolvePlan({ target: 0.8, confidence: 0.9, maxErrors: 1 }),
      resolvePlan({ target: 0.9, confidence: 0.8, maxErrors: 2 }),
    ];
    let doomed = 0;
    let open = 0;
    for (let trial = 0; trial < 600; trial++) {
      const plan = plans[trial % plans.length] as ResolvedPlan;
      const rows = partial(rand, plan, trial);
      const p = acceptanceProgress(rows, plan);
      // Any labels for the remaining acts, the earlier labels the plan reads left as they are.
      const randomly = evaluateAcceptance(
        complete(rows, plan, () => rand() < 0.5, trial),
        plan,
      ).status;
      const cleanly = evaluateAcceptance(
        complete(rows, plan, () => true, trial),
        plan,
      ).status;
      if (p.cannotPass) {
        doomed++;
        expect(randomly, `trial ${trial}`).toBe("rejected");
        expect(cleanly, `trial ${trial}`).toBe("rejected");
      } else {
        open++;
        // The converse: with every remaining act right the completed sample passes, so the
        // notice never fires early.
        expect(cleanly, `trial ${trial}`).toBe("accepted");
      }
    }
    // Both branches were exercised.
    expect(doomed).toBeGreaterThan(50);
    expect(open).toBeGreaterThan(50);
  });
});
