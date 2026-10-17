import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine.ts";
import { SimOracle, type Truth } from "../src/oracles/sim.ts";
import { judge } from "../src/questions.ts";
import {
  band,
  compare,
  count,
  daysBetween,
  lines,
  pruneFields,
  relativeTime,
} from "../src/recipes/digest.ts";
import { Rollout } from "../src/rollout.ts";
import type { JudgeVerdict } from "../src/types.ts";

describe("digest helpers", () => {
  it("bands, compares, counts and renders", () => {
    const hp = [
      { upTo: 50, label: "critical" },
      { upTo: 150, label: "low" },
    ];
    expect(band(38, hp, "healthy")).toBe("critical");
    expect(band(150, hp, "healthy")).toBe("low");
    expect(band(151, hp, "healthy")).toBe("healthy");
    expect(compare(22400, 22000, { actual: "loaded", limit: "weight limit", unit: "kg" })).toBe(
      "loaded (22400 kg) exceeds weight limit (22000 kg) by 400 kg",
    );
    expect(compare(5, 5)).toBe("actual equals limit (5)");
    expect(count(0, "open ticket")).toBe("no open tickets");
    expect(count(1, "open ticket")).toBe("1 open ticket");
    expect(count(3, "open ticket")).toBe("3 open tickets");
    expect(lines({ a: "x", b: 2, c: undefined, d: "" })).toBe("a: x\nb: 2");
    expect(pruneFields({ a: 1, b: 2, c: 3 }, ["c", "a"])).toEqual({ c: 3, a: 1 });
  });
  it("relative time and day differences", () => {
    const now = new Date("2026-10-16T12:00:00Z");
    expect(relativeTime("2026-10-13T12:00:00Z", now)).toBe("3 days ago");
    expect(relativeTime("2026-10-16T14:00:00Z", now)).toBe("in 2 hours");
    expect(relativeTime("2026-10-16T12:00:10Z", now)).toBe("just now");
    expect(relativeTime("2025-10-16T12:00:00Z", now)).toBe("1 year ago");
    expect(daysBetween("2026-03-14", "2026-06-20")).toBe(98);
  });
});

describe("Rollout", () => {
  const items = Array.from({ length: 400 }, (_, i) => `s-${i}`);
  let flipped = false;
  const truths = new Map<string, Truth>(items.map((s, i) => [s, { judge: i % 2 === 0 }]));
  const truthOf = (s: string): Truth | undefined => {
    const t = truths.get(s);
    return t && flipped ? { judge: !t.judge } : t;
  };
  const q = judge("ok?", { id: "ok" });

  it("promotes on shadow evidence and demotes on audited drift", async () => {
    const engine = new Engine({
      oracle: new SimOracle({ accuracy: 0.97, seed: 3 }, truthOf),
      mode: "shadow",
      auditRate: 0.5,
      seed: 1,
    });
    const rollout = new Rollout({
      engine,
      promisedAccuracy: 0.9,
      minShadowRows: 100,
      minAuditRows: 30,
    });
    const run = async (slice: string[]) => {
      for (const s of slice) {
        const r = await engine.ask(s, q, { policy: { actAbove: 0.8 }, baseline: "review" });
        const v = r.decision.verdict as JudgeVerdict;
        const truth = truths.get(s)?.judge ?? false;
        await engine.label(r.recordId, { correct: v.pYes >= 0.5 === truth, truth });
      }
    };
    expect((await rollout.evaluate()).mode).toBe("shadow");
    await run(items.slice(0, 150));
    const promoted = await rollout.evaluate();
    expect(promoted.mode).toBe("enforce");
    expect(promoted.changed).toBe(true);
    expect(engine.mode).toBe("enforce");

    // The world changes under the model: its answers are now mostly wrong.
    flipped = true;
    await run(items.slice(150, 300));
    const demoted = await rollout.evaluate();
    expect(demoted.mode).toBe("shadow");
    expect(demoted.changed).toBe(true);
    expect(demoted.reason).toMatch(/demoted/);
    expect(engine.mode).toBe("shadow");
    expect(rollout.history.length).toBe(3);
  });
});

describe("Rollout per gate", () => {
  const items = Array.from({ length: 400 }, (_, i) => `g-${i}`);
  let flipped = false;
  const truths = new Map<string, boolean>(items.map((s, i) => [s, i % 2 === 0]));
  const truthOf = (s: string): Truth | undefined => {
    const t = truths.get(s);
    return t === undefined ? undefined : { judge: flipped ? !t : t };
  };

  it("promotes and demotes one gate on its own rows, leaving the engine and other gates alone", async () => {
    const engine = new Engine({
      oracle: new SimOracle({ accuracy: 0.97, seed: 3 }, truthOf),
      mode: "shadow",
      seed: 1,
    });
    const gate = engine.gate({
      id: "bash.safe",
      question: judge("ok?", { id: "ok" }),
      policy: { actAbove: 0.8 },
      promisedAccuracy: 0.9,
      auditRate: 0.5,
      rollout: { minShadowRows: 100, minAuditRows: 30 },
    });
    const other = engine.gate({
      id: "bash.other",
      question: judge("fine?", { id: "fine" }),
      policy: { actAbove: 0.8 },
    });
    const run = async (slice: string[]) => {
      for (const s of slice) {
        const truth = truths.get(s) ?? false;
        for (const g of [gate, other]) {
          const r = await g.ask(s, { baseline: "review" });
          const v = r.decision.verdict as JudgeVerdict;
          await engine.label(r.recordId, { correct: v.pYes >= 0.5 === truth, truth });
        }
      }
    };
    expect((await gate.rollout.evaluate()).mode).toBe("shadow");
    await run(items.slice(0, 150));
    const promoted = await gate.rollout.evaluate();
    expect(promoted).toMatchObject({ mode: "enforce", changed: true, gateId: "bash.safe" });
    expect(promoted.window.n).toBe(150);
    expect(gate.mode).toBe("enforce");
    expect(engine.mode).toBe("shadow");
    expect(other.mode).toBe("shadow");

    // The world changes under the model: its answers are now mostly wrong.
    flipped = true;
    await run(items.slice(150, 350));
    const rows = await engine.ledger.all();
    expect(rows.some((r) => r.gateId === "bash.other" && r.mode === "enforce")).toBe(false);
    const demoted = await gate.rollout.evaluate();
    expect(demoted).toMatchObject({ mode: "shadow", changed: true, gateId: "bash.safe" });
    expect(demoted.reason).toMatch(/demoted/);
    expect(gate.mode).toBe("shadow");
    expect(gate.rollout.history.length).toBe(3);
  });
});
