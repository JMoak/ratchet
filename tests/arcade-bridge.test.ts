import { describe, expect, it } from "vitest";
import { play } from "../examples/arcade/bridge.ts";
import { judgeVerdictFrom, type Oracle } from "../src/index.ts";

type Result = Awaited<ReturnType<typeof play>>;
const row = (r: Result, label: string) => {
  const found = r.batch.rows.find((x) => x.label === label);
  if (!found) throw new Error(`no batch row "${label}"`);
  return found;
};
const met = (r: Result) => r.target.checks.map((c) => c.met);

/** A judge that sees every state and answers one fixed probability, or throws. */
function recorder(probability: number | "fail", states: string[] = []): Oracle {
  return {
    id: "test-inspector",
    async decide(state, questions) {
      states.push(state);
      if (probability === "fail") throw new Error("inspector offline");
      return questions.map((q) => {
        if (q.kind !== "judge") throw new Error("expected a judge question");
        return {
          verdict: judgeVerdictFrom(q, probability),
          oracle: "test-inspector",
          cost: 0,
          latencyMs: 0,
          at: new Date(0).toISOString(),
        };
      });
    },
  };
}

describe("Bridge Builder", () => {
  it("opens on the duel: laying every span once rarely crosses, verified commits mostly do", async () => {
    const r = await play({});
    expect(r.settings).toEqual({ spans: 10, bar: 0.9, attempts: 3, pooled: false, second: false });
    const crossed = row(r, "Crossed");
    // Ten spans at about four in five each: near 0.88^8 * 0.65^2, about 15%.
    expect(crossed.baseline).toBeGreaterThan(0.08);
    expect(crossed.baseline).toBeLessThan(0.26);
    expect(crossed.engine).toBeGreaterThan(crossed.baseline + 0.35);
    const collapsed = row(r, "Collapsed with Bolt on it");
    expect(collapsed.baseline).toBeCloseTo(1 - crossed.baseline, 10);
    expect(collapsed.engine).toBeLessThan(0.15);
    // Without checks a bridge never stops short; the ratchet turns most failures into stops.
    const stopped = row(r, "Stopped short, nobody on it");
    expect(stopped.baseline).toBe(0);
    expect(stopped.engine).toBeGreaterThan(collapsed.engine);
    expect(r.batch.worlds).toBe(500);
    expect(r.target.met).toBe(false);
  });

  it("runs one seeded world both ways and reproduces it exactly", async () => {
    const a = await play({ seed: 3, worlds: 10 });
    const b = await play({ seed: 3, worlds: 10 });
    expect(a.world).toEqual(b.world);
    expect(a.batch).toEqual(b.batch);
    const [hope, ratchet] = a.world.arms;
    expect(hope?.cells).toHaveLength(10);
    expect(ratchet?.cells).toHaveLength(10);
    expect(hope?.verdict).toBe("bad");
    expect(ratchet?.verdict).toBe("good");
    // Another seed is another gorge.
    const other = await play({ seed: 4, worlds: 10 });
    expect(other.world.arms).not.toEqual(a.world.arms);
  });

  it("commits a piece only when the gate acts, and labels every inspection", async () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const r = await play({ seed, worlds: 10 });
      const decisions = r.ledger.decisions;
      const committed = r.world.arms[1]?.cells.filter((c) => c.kind === "ok" || c.kind === "bad");
      expect(decisions.every((d) => d.gate === "bridge.inspect")).toBe(true);
      expect(decisions.every((d) => d.truth !== null && d.mode === "enforce")).toBe(true);
      expect(decisions.filter((d) => d.actual === "act")).toHaveLength(committed?.length ?? -1);
      expect(decisions.every((d) => d.actual === "act" || d.probability < 0.9)).toBe(true);
    }
  });

  it("gives each lever the effect its label promises", async () => {
    const base = await play({});
    const strict = await play({ bar: 0.97 });
    expect(row(strict, "Collapsed with Bolt on it").engine).toBeLessThan(
      row(base, "Collapsed with Bolt on it").engine,
    );
    expect(row(strict, "Stopped short, nobody on it").engine).toBeGreaterThan(
      row(base, "Stopped short, nobody on it").engine,
    );
    const pooled = await play({ pooled: true });
    expect(row(pooled, "Crossed").engine).toBeGreaterThan(row(base, "Crossed").engine + 0.1);
    const second = await play({ second: true });
    expect(row(second, "Collapsed with Bolt on it").engine).toBeLessThan(
      row(base, "Collapsed with Bolt on it").engine,
    );
    expect(row(second, "Inspections per bridge").engine).toBeCloseTo(
      2 * row(second, "Pieces laid per bridge").engine,
      10,
    );
    // A longer chain is harder for both arms.
    const long = await play({ spans: 16 });
    expect(row(long, "Crossed").baseline).toBeLessThan(row(base, "Crossed").baseline);
  });

  it("has a target the defaults miss and the three levers together meet", async () => {
    expect(met(await play({}))).toEqual([false, false, true]);
    const solved = await play({ bar: 0.97, pooled: true, second: true });
    expect(solved.target.met).toBe(true);
    expect(met(await play({ bar: 0.97, pooled: true }))).toContain(false);
    expect(met(await play({ bar: 0.97, second: true }))).toContain(false);
  });

  it("sweeps the bar on request only", async () => {
    expect(await play({ worlds: 10 })).not.toHaveProperty("sweep");
    const r = await play({ worlds: 10, sweep: true, bar: 0.85 });
    expect(r.sweep?.values).toHaveLength(9);
    expect(r.sweep?.current).toBe(0.85);
    expect(r.sweep?.series.map((s) => s.label)).toEqual(["Crossed", "Collapsed", "Stopped short"]);
    for (const s of r.sweep?.series ?? []) {
      expect(s.values).toHaveLength(9);
      expect(s.values.every((v) => v >= 0 && v <= 1)).toBe(true);
    }
  });

  it("shows a live judge readings, never whether a piece is sound", async () => {
    const states: string[] = [];
    const r = await play({ seed: 3, worlds: 10 }, recorder(0.95, states));
    expect(r.judgeSource).toBe("live");
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      expect(state).toMatch(/crew A measured: -?\d+\.\d\d mm/);
      expect(state).not.toMatch(/sound|flaw|truth|hard/i);
    }
    // A judge that passes everything commits every first piece: the ratchet is only as good as it.
    expect(r.world.arms[1]?.cells.every((c) => c.text === "" || c.text === "×")).toBe(true);
  });

  it("stops short, with nothing committed, when the judge is unavailable", async () => {
    const r = await play({ seed: 3, worlds: 10 }, recorder("fail"));
    expect(r.world.arms[1]?.verdict).toBe("safe");
    expect(r.world.arms[1]?.summary).toContain("Stopped at span 1");
    expect(r.ledger.decisions.every((d) => d.failedOpen && d.actual === "review")).toBe(true);
  });

  it("rejects settings outside the levers' ranges", async () => {
    for (const input of [
      { spans: 3 },
      { spans: 10.5 },
      { bar: 1 },
      { attempts: 0 },
      { pooled: "yes" },
      { second: 1 },
      { sweep: "true" },
      { seed: -1 },
      { worlds: 501 },
    ]) {
      await expect(play(input)).rejects.toThrow();
    }
    await expect(play(null)).rejects.toThrow("JSON object");
  });
});
