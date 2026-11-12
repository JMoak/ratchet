import { describe, expect, it } from "vitest";
import { fitActBar } from "../src/ledger/bars.ts";
import {
  chainAttempt,
  disagreement,
  isUnselected,
  modelFamily,
  scoredForAct,
  scoredFromLedger,
} from "../src/ledger/calibration.ts";
import { type BorrowedVia, describeGrade, gradeOf } from "../src/ledger/evidence.ts";
import type { DecisionRecord, MemberRecord } from "../src/ledger/ledger.ts";

const judgeVerdict = (pYes: number) =>
  ({ kind: "judge", questionId: "q", pYes, confidence: Math.max(pYes, 1 - pYes) }) as const;

const member = (key: string, model: string, pYes: number, failedOpen = false): MemberRecord => ({
  key,
  oracle: key,
  model,
  verdict: judgeVerdict(pYes),
  cost: 0,
  latencyMs: 0,
  ...(failedOpen ? { failedOpen: true as const } : {}),
});

const row = (id: string, over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id,
  at: `2026-11-12T00:00:${String(id.length).padStart(2, "0")}.000Z`,
  gateId: "g",
  requestId: id,
  questionId: "q",
  kind: "judge",
  prompt: "ok?",
  questionHash: "q1",
  policyHash: "p1",
  stateHash: id,
  trustedHash: id,
  untrusted: [],
  oracle: "o",
  strategy: "single",
  verdict: judgeVerdict(0.9),
  go: 0.9,
  confidence: 0.9,
  agreement: 1,
  soft: "act",
  action: "review",
  mode: "shadow",
  cost: 0,
  latencyMs: 0,
  failedOpen: false,
  tags: [],
  ...over,
});

describe("disagreement bounds 'at least one judge is wrong', never the gate's error (e2e T5-03)", () => {
  it("says so in the grade's sentence", () => {
    const via: BorrowedVia = {
      type: "disagreement",
      rate: 0.3,
      pairs: 100,
      models: ["vendor/model-1.13", "other/judge-2"],
    };
    const text = describeGrade(gradeOf([], { borrowed: via, borrowedAt: "2026-11-12T00:00:00Z" }));
    expect(text).toBe(
      "borrowed as of 2026-11-12: vendor/model-1.13 and other/judge-2 disagree on 30.0% of 100 pairs, so at least one of the two judges is wrong on at least 30.0% of them; this is not this gate's error rate",
    );
    expect(text).not.toMatch(/at least 30\.0% wrong on this slice/);
  });

  it("refuses two pins of one model family as two models", () => {
    const pins: BorrowedVia = {
      type: "disagreement",
      rate: 0.054,
      pairs: 260,
      models: ["typesafe/jev-1.13-20260917", "typesafe/jev-1.14-20261020"],
    };
    expect(() => gradeOf([], { borrowed: pins })).toThrow(/two model families.*typesafe\/jev/);
    const two: BorrowedVia = {
      ...pins,
      models: ["typesafe/jev-1.13-20260917", "anthropic/claude-haiku-5.5"],
    };
    expect(gradeOf([], { borrowed: two }).kind).toBe("borrowed");
  });

  it("names a family by the first token of the model's name", () => {
    expect(modelFamily("typesafe/jev-1.13-20260917")).toBe("jev");
    expect(modelFamily("typesafe/jev-1.14")).toBe("jev");
    expect(modelFamily("claude-sonnet-4-5")).toBe("claude");
    expect(modelFamily("claude-3-5-sonnet-20241022")).toBe("claude");
    expect(modelFamily("gpt-4o-2024-08-06")).toBe("gpt");
    expect(modelFamily("llama3:8b")).toBe("llama");
    expect(modelFamily("model-a")).toBe("model");
    expect(modelFamily("sim-p0.93-rho0")).toBe("sim");
    expect(modelFamily("Vendor/Model-V2")).toBe("model");
  });

  it("measures disagreement from the ledger across two families, and refuses one family", () => {
    // The repro: the gate's oracle is never wrong; the second opinion is wrong on 30 of 100.
    const rows = Array.from({ length: 100 }, (_, i) => {
      const truth = i % 2 === 0;
      const right = i % 10 >= 3;
      const p = truth ? 0.9 : 0.1;
      return row(`r${i}`, {
        strategy: "ensemble",
        members: [
          member("primary", "vendor/model-1.13", p),
          member("second", "other/judge-2", right ? p : 1 - p),
        ],
      });
    });
    const d = disagreement(rows);
    expect(d?.via).toEqual({
      type: "disagreement",
      rate: 0.3,
      pairs: 100,
      models: ["vendor/model-1.13", "other/judge-2"],
    });
    expect(d?.keys).toEqual(["primary", "second"]);
    if (!d) throw new Error("no disagreement");
    expect(gradeOf(rows, { borrowed: d.via, borrowedAt: d.at }).kind).toBe("borrowed");
    // A failed-open member answers nothing, so its row pairs nothing.
    const dropped = [
      ...rows,
      row("x", {
        strategy: "ensemble",
        members: [
          member("primary", "vendor/model-1.13", 0.9),
          member("second", "other/judge-2", 0.1, true),
        ],
      }),
    ];
    expect(disagreement(dropped)?.via.pairs).toBe(100);
    // Two pins of one family are no second opinion.
    const pins = rows.map((r) => ({
      ...r,
      members: (r.members ?? []).map((m) =>
        m.key === "second" ? { ...m, model: "vendor/model-1.14" } : m,
      ),
    }));
    expect(disagreement(pins)).toBeUndefined();
    expect(disagreement(pins, { keys: ["primary", "second"] })).toBeUndefined();
  });
});

describe("a chain's retries are a selected sample (e2e T2-03)", () => {
  const chainRow = (id: string, attempt: number, right: boolean) =>
    row(id, {
      tags: ["chain", "chain:step:migrate", `chain:attempt:${attempt}`],
      outcome: { at: "2026-11-12T00:00:00Z", correct: right, truth: right },
    });

  it("reads attempt 2 and later as selected, attempt 1 as unselected", () => {
    expect(chainAttempt(chainRow("a", 1, true))).toBe(1);
    expect(chainAttempt(chainRow("b", 3, true))).toBe(3);
    expect(chainAttempt(row("c"))).toBeUndefined();
    expect(isUnselected(chainRow("a", 1, true))).toBe(true);
    expect(isUnselected(chainRow("b", 2, true))).toBe(false);
    // A blind audit tag does not make a retry unselected either.
    const audited = chainRow("d", 2, true);
    expect(isUnselected({ ...audited, tags: [...audited.tags, "audit"] })).toBe(false);
  });

  it("keeps retries out of every unselected fit", () => {
    // 40 first attempts, all right; 40 retries, all wrong. Only the first attempts are fitted.
    const rows = [
      ...Array.from({ length: 40 }, (_, i) => chainRow(`first${i}`, 1, true)),
      ...Array.from({ length: 40 }, (_, i) => chainRow(`retry${i}`, 2, false)),
    ];
    expect(scoredFromLedger(rows, { unselectedOnly: true })).toHaveLength(40);
    expect(scoredForAct(rows, { unselectedOnly: true })).toHaveLength(40);
    const bar = fitActBar(rows, { target: 0.9, minSupport: 30 });
    expect(bar.fittedFrom).toBe("unselected");
    expect(bar.fitRows).toBe(40);
    expect(gradeOf(rows, { minEstimated: 30 })).toMatchObject({
      kind: "estimated",
      n: 40,
      accuracy: 1,
    });
  });
});
