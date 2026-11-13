import { describe, expect, it } from "vitest";
import { play } from "../examples/arcade/treasure.ts";
import { type Oracle, resolvePlan } from "../src/index.ts";

type Result = Awaited<ReturnType<typeof play>>;
const row = (r: Result, label: string) => {
  const found = r.batch.rows.find((x) => x.label === label);
  if (!found) throw new Error(`no batch row "${label}"`);
  return found;
};
const WORSE = "Scouts worse than the promise that were promoted";
const GOOD = "Scouts as good as the promise that were promoted";
const PITS = "Empty pits nobody saw, per expedition";
const CAUGHT = "Scouts that slipped and were sent back";
const WRONGLY = "Good Scouts sent back while still good";

/** The first dig Scout made alone in an arm, or -1. */
const firstAlone = (r: Result, arm: number): number =>
  (r.world.arms[arm]?.cells ?? []).findIndex((c) => c.kind === "ok" || c.kind === "bad");

const offline: Oracle = {
  id: "test-offline",
  decide: async () => {
    throw new Error("detector offline");
  },
};

describe("Treasure Survey", () => {
  it("opens on the duel: looking until it looks good promotes the bad Scouts, the planned test does not", async () => {
    const r = await play({});
    expect(r.settings).toEqual({ promise: 0.95, allow: 0, audit: 0.2, demotion: "window" });
    expect(r.plan).toEqual({ sampleSize: 59, maxErrors: 0, confidence: 0.95 });
    // A point estimate read after every dig promotes almost anything.
    expect(row(r, WORSE).baseline).toBeGreaterThan(0.9);
    expect(row(r, GOOD).baseline).toBeGreaterThan(0.95);
    // One planned exact test holds false promotions near its 5%, and pays for it in power.
    expect(row(r, WORSE).engine).toBeLessThan(0.08);
    expect(row(r, GOOD).engine).toBeGreaterThan(0.3);
    expect(row(r, GOOD).engine).toBeLessThan(0.75);
    expect(row(r, PITS).engine).toBeLessThan(row(r, PITS).baseline / 5);
    // Nothing watches the first arm, so nothing is ever sent back.
    expect(row(r, CAUGHT).baseline).toBe(0);
    expect(r.batch.worlds).toBe(204);
    expect(r.target.met).toBe(false);
  });

  it("shows a bad Scout promoted at dig 20 by the first arm and never by the engine", async () => {
    const r = await play({ seed: 4, worlds: 12 });
    expect(r.world.note).toContain("right 91.0% of the time, against a promise of 95%");
    const [peeked, earned] = r.world.arms;
    expect(peeked?.cells).toHaveLength(300);
    expect(earned?.cells).toHaveLength(300);
    expect(peeked?.summary).toMatch(/^Promoted after dig 20, .* Scout dug 280 alone, \d+ of them/);
    expect(peeked?.verdict).toBe("bad");
    expect(earned?.summary).toBe(
      "Never promoted: the planned sample of 59 digs held too many wrong ones.",
    );
    expect(firstAlone(r, 1)).toBe(-1);
    // Supervised to the end: every one of the 300 proposals went through the gate in shadow.
    expect(r.ledger.decisions).toHaveLength(300);
    expect(r.ledger.decisions.every((d) => d.mode === "shadow" && d.truth !== null)).toBe(true);
    const again = await play({ seed: 4, worlds: 12 });
    expect(again.world).toEqual(r.world);
    expect(again.batch).toEqual(r.batch);
  });

  it("never lets Scout dig alone before the planned sample is complete and clean", async () => {
    for (const allow of [0, 1]) {
      const size = resolvePlan({ target: 0.95, maxErrors: allow }).sampleSize;
      for (let seed = 1; seed <= 10; seed++) {
        const r = await play({ seed, allow, worlds: 12 });
        const first = firstAlone(r, 1);
        if (first < 0) continue;
        expect(first).toBeGreaterThanOrEqual(size);
        // The planned digs before it held no more wrong ones than the plan allows.
        const wrong = (r.world.arms[1]?.cells ?? [])
          .slice(0, size)
          .filter((c) => c.kind === "held").length;
        expect(wrong).toBeLessThanOrEqual(allow);
      }
    }
  });

  it("cannot send a Scout back without audits, and sends back more with more", async () => {
    const none = await play({ audit: 0, worlds: 102 });
    expect(row(none, CAUGHT).engine).toBe(0);
    expect(row(none, WRONGLY).engine).toBe(0);
    const some = await play({ audit: 0.3, worlds: 102 });
    expect(row(some, CAUGHT).engine).toBeGreaterThan(0.3);
    // An audited dig is not a dig alone.
    expect(row(some, "Digs a good Scout did alone").engine).toBeLessThan(
      row(none, "Digs a good Scout did alone").engine,
    );
    expect(row(some, PITS).engine).toBeLessThan(row(none, PITS).engine);
  });

  it("trades the demotion rules as the engine's tables do", async () => {
    const run = (demotion: string) => play({ demotion, audit: 0.2, worlds: 102 });
    const [detector, first] = [await run("detector"), await run("first-error")];
    // First-error is the most cautious: fewest unseen pits, most good Scouts sent back.
    expect(row(first, PITS).engine).toBeLessThan(row(detector, PITS).engine);
    expect(row(first, WRONGLY).engine).toBeGreaterThan(row(detector, WRONGLY).engine + 0.05);
    // The detector controls false alarms: it sends back almost no Scout that is still good.
    expect(row(detector, WRONGLY).engine).toBeLessThan(0.03);
    // The rule never touches promotion.
    expect(row(first, WORSE).engine).toBe(row(detector, WORSE).engine);
    expect(row(first, GOOD).engine).toBe(row(detector, GOOD).engine);
  });

  it("passes more good Scouts when the sample may hold a wrong dig, with a longer sample", async () => {
    const zero = await play({ worlds: 102 });
    const one = await play({ allow: 1, worlds: 102 });
    expect(one.plan.sampleSize).toBeGreaterThan(zero.plan.sampleSize);
    expect(row(one, GOOD).engine).toBeGreaterThan(row(zero, GOOD).engine + 0.08);
    expect(row(one, WORSE).engine).toBeLessThan(0.1);
  });

  it("has a target the defaults miss and a light audit with the first-error rule meets", async () => {
    expect((await play({})).target.checks.map((c) => c.met)).toEqual([true, false, false]);
    expect((await play({ demotion: "first-error", audit: 0.1 })).target.met).toBe(true);
  });

  it("keeps Scout supervised when the judge is unavailable", async () => {
    const r = await play({ seed: 9, worlds: 12 }, offline);
    expect(firstAlone(r, 1)).toBe(-1);
    expect(r.ledger.decisions.every((d) => d.failedOpen && d.mode === "shadow")).toBe(true);
  });

  it("rejects settings outside the levers' ranges", async () => {
    for (const input of [
      { promise: 0.93 },
      { promise: "0.95" },
      { allow: 3 },
      { audit: 0.6 },
      { demotion: "never" },
      { sweep: 0 },
    ]) {
      await expect(play(input)).rejects.toThrow();
    }
  });
});
