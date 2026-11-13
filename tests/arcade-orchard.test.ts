import { describe, expect, it } from "vitest";
import { play } from "../examples/arcade/orchard.ts";
import type { Oracle } from "../src/index.ts";

type Result = Awaited<ReturnType<typeof play>>;
const row = (r: Result, label: string) => {
  const found = r.batch.rows.find((x) => x.label === label);
  if (!found) throw new Error(`no batch row "${label}"`);
  return found;
};
const RIPE = "Picked fruit that was ripe";
const CLAIMED = "What the pool claimed for those picks";
const PICKED = "Fruit picked per season, of 20";

const offline: Oracle = {
  id: "test-offline",
  decide: async () => {
    throw new Error("scout offline");
  },
};

describe("Signal Orchard", () => {
  it("opens on the duel: counting five alike scouts as five overclaims, the honest pool does not", async () => {
    const r = await play({});
    expect(r.settings).toEqual({ scouts: 5, families: 1, assumed: 0.7, bar: 0.95 });
    const ripe = row(r, RIPE);
    const claimed = row(r, CLAIMED);
    // Pooled as independent: claims nearly certain, and breaks the 95% promise.
    expect(claimed.baseline).toBeGreaterThan(0.99);
    expect(ripe.baseline).toBeLessThan(0.93);
    // Pooled at the true correlation: keeps the promise, and what it claims is what it delivers.
    expect(ripe.engine).toBeGreaterThan(0.95);
    expect(Math.abs(claimed.engine - ripe.engine)).toBeLessThan(0.02);
    // Honesty costs picks.
    expect(row(r, PICKED).engine).toBeLessThan(row(r, PICKED).baseline / 1.5);
    expect(row(r, "Profit per season (+1 ripe, −10 unripe)").engine).toBeGreaterThan(
      row(r, "Profit per season (+1 ripe, −10 unripe)").baseline,
    );
    expect(r.target.met).toBe(false);
  });

  it("makes the two arms the same pool when the assumed correlation is zero or there is one scout", async () => {
    for (const input of [{ assumed: 0 }, { scouts: 1 }]) {
      const r = await play({ ...input, worlds: 40 });
      for (const x of r.batch.rows) expect(x.engine).toBeCloseTo(x.baseline, 10);
      expect(r.world.arms[1]?.cells).toEqual(r.world.arms[0]?.cells);
    }
  });

  it("gets little from more scouts of one family and a lot from a second family", async () => {
    const one = await play({ scouts: 1 });
    const seven = await play({ scouts: 7 });
    const three = await play({ scouts: 3, families: 3 });
    // Seven scouts on one sensor pick barely more than one scout does.
    expect(row(seven, PICKED).engine).toBeLessThan(row(one, PICKED).engine * 1.8);
    // Three scouts on three sensors pick about twice what seven on one do, and keep the promise.
    expect(row(three, PICKED).engine).toBeGreaterThan(row(seven, PICKED).engine * 1.6);
    expect(row(three, RIPE).engine).toBeGreaterThan(0.95);
    expect(Math.abs(row(three, CLAIMED).engine - row(three, RIPE).engine)).toBeLessThan(0.02);
    expect(seven.world.note).toContain("7 scouts sharing a sensor are worth 1.3 independent ones");
  });

  it("has a target the defaults miss and a second family meets", async () => {
    expect((await play({})).target.checks.map((c) => c.met)).toEqual([true, false, false]);
    expect((await play({ scouts: 3, families: 3 })).target.met).toBe(true);
    // Paying for more scouts of one family cannot meet it.
    expect((await play({ scouts: 4 })).target.met).toBe(false);
    // Six scouts across three families pick enough and cost too many looks.
    expect((await play({ scouts: 6, families: 3 })).target.checks.map((c) => c.met)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("runs one seeded season both ways through real gates and labels every fruit", async () => {
    const a = await play({ seed: 18, worlds: 10 });
    const b = await play({ seed: 18, worlds: 10 });
    expect(a.world).toEqual(b.world);
    expect(a.world.arms.map((arm) => arm.cells.length)).toEqual([20, 20]);
    expect(a.world.arms[0]?.verdict).toBe("bad");
    expect(a.world.arms[1]?.verdict).toBe("good");
    expect(a.ledger.decisions).toHaveLength(20);
    expect(a.ledger.decisions.every((d) => d.gate === "orchard.count-independent")).toBe(true);
    expect(a.ledger.decisions.every((d) => d.truth !== null)).toBe(true);
    // Each downloaded row keeps the five scouts' answers behind its pooled one.
    expect(a.ledger.rows).toHaveLength(20);
    expect(
      a.ledger.rows.every((r) => r.strategy === "ensemble" && (r.members ?? []).length === 5),
    ).toBe(true);
  });

  it("sweeps the assumed correlation: the claim and the delivery meet near the truth", async () => {
    const r = await play({ worlds: 10, sweep: true });
    const [ripe, claimed, share] = r.sweep?.series ?? [];
    expect(r.sweep?.values).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
    if (!ripe || !claimed || !share) throw new Error("sweep series missing");
    // At zero the pool overclaims; by the true 0.7 it no longer does.
    expect((claimed.values[0] ?? 0) - (ripe.values[0] ?? 0)).toBeGreaterThan(0.05);
    expect(Math.abs((claimed.values[7] ?? 0) - (ripe.values[7] ?? 0))).toBeLessThan(0.03);
    // Assuming more correlation always picks less.
    expect(share.values[0]).toBeGreaterThan(share.values[9] ?? 1);
  });

  it("picks nothing when the judge is unavailable", async () => {
    const r = await play({ seed: 18, worlds: 10 }, offline);
    expect(r.judgeSource).toBe("live");
    expect(r.world.arms[1]?.summary).toBe("Picked nothing: no fruit cleared the bar.");
    expect(r.ledger.decisions.every((d) => d.failedOpen && d.actual === "review")).toBe(true);
  });

  it("rejects settings outside the levers' ranges and caps families at the scouts hired", async () => {
    for (const input of [
      { scouts: 0 },
      { scouts: 8 },
      { families: 4 },
      { assumed: 1 },
      { bar: 0.4 },
      { sweep: 1 },
    ]) {
      await expect(play(input)).rejects.toThrow();
    }
    expect((await play({ scouts: 2, families: 3, worlds: 10 })).settings.families).toBe(2);
  });
});
