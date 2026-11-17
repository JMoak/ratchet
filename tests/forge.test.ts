import { describe, expect, it } from "vitest";
import { packSpec } from "../examples/decision-packs/packs.ts";
import { DEMO_CASES, DEMO_DRAFT } from "../experiments/forge/fixture.ts";
import {
  capture,
  compileDraft,
  measure,
  parseCases,
  teach,
  teacherRequest,
  teachingExamples,
} from "../experiments/forge/forge.ts";
import { MemoryLedger } from "../src/ledger/ledger.ts";
import { judgeVerdictFrom } from "../src/questions.ts";
import type { JudgeQuestion, Oracle } from "../src/types.ts";

const lines = (items: readonly unknown[]) => items.map((item) => JSON.stringify(item)).join("\n");
const fixture = () => parseCases(lines(DEMO_CASES));
const sure: Oracle = {
  id: "test:sure",
  async decide(_state, questions) {
    return questions.map((q) => ({
      oracle: "test:sure",
      model: "test:sure/1",
      verdict: judgeVerdictFrom(q as JudgeQuestion, 1),
      at: new Date().toISOString(),
      cost: 0,
      latencyMs: 0,
    }));
  },
};

async function captured() {
  const cases = fixture();
  const ledger = new MemoryLedger();
  await capture(cases, ledger);
  const examples = teachingExamples(cases, await ledger.all());
  return { cases, ledger, examples, ...compileDraft(DEMO_DRAFT, examples) };
}

describe("recipe forge", () => {
  it("rejects duplicate identities and family/source leakage before teaching", () => {
    const cases = fixture();
    const first = cases[0];
    const test = cases.find((item) => item.split === "test");
    if (!first || !test) throw new Error("Missing fixture");
    expect(() => parseCases(lines([...cases, first]))).toThrow("Duplicate");
    expect(() =>
      parseCases(
        lines(cases.map((item) => (item === test ? { ...item, group: first.group } : item))),
      ),
    ).toThrow("share a group or source");
    expect(() =>
      parseCases(
        lines(
          cases.map((item) =>
            item === test
              ? {
                  ...item,
                  input: {
                    ...item.input,
                    evidence: `  ${first.input.evidence.replaceAll(" ", "  ")}  `,
                  },
                }
              : item,
          ),
        ),
      ),
    ).toThrow("share a group or source");
  });

  it("does not silently turn preferences, teacher answers or missing controls into reviewed cases", () => {
    for (const source of [
      "accepted:click",
      "desk:assisted",
      "teacher:flagship",
      "review:blind",
      "",
    ])
      expect(() =>
        parseCases(lines(DEMO_CASES.map((c) => ({ ...c, label: { ...c.label, source } })))),
      ).toThrow("Invalid forge case");
    expect(() =>
      parseCases(
        lines(DEMO_CASES.map((c) => ({ ...c, input: { ...c.input, sourceVerified: "true" } }))),
      ),
    ).toThrow("Invalid forge case");
    expect(() =>
      parseCases(lines(DEMO_CASES.map((c) => ({ ...c, secret: "do-not-echo" })))),
    ).toThrow(/^Invalid forge case on line 1;/);
  });

  it("requires contrastive teaching examples and a separate test population", () => {
    expect(() => parseCases(lines(DEMO_CASES.filter((c) => c.split === "teach")))).toThrow(
      "separate test",
    );
    expect(() =>
      parseCases(lines(DEMO_CASES.filter((c) => c.split === "test" || c.label.supported))),
    ).toThrow("both supported and unsupported");
  });

  it("reads the latest reviewed ledger truth without exposing held-out cases or prior verdicts", async () => {
    const { cases, ledger, examples } = await captured();
    expect(examples).toHaveLength(8);
    const request = JSON.stringify(teacherRequest(examples));
    for (const item of cases.filter((c) => c.split === "test")) {
      expect(request).not.toContain(item.input.evidence);
      expect(request).not.toContain(item.id);
    }
    expect(request).not.toContain('"verdict"');
    expect(request).not.toContain('"pYes"');
    const first = examples[0];
    if (!first) throw new Error("Missing example");
    await ledger.label(first.recordId, {
      at: new Date().toISOString(),
      correct: false,
      truth: !first.supported,
      note: "Independent review correction",
      source: "review:blind:reviewer",
    });
    expect(teachingExamples(cases, await ledger.all())[0]).toMatchObject({
      supported: !first.supported,
      why: "Independent review correction",
      source: "review:blind:reviewer",
    });
    await expect(capture(cases, ledger)).rejects.toThrow("fresh ledger");
  });

  it("rejects changed snapshots, ambiguous records and inadmissible later labels", async () => {
    const { cases, ledger, examples } = await captured();
    const rows = await ledger.all();
    const row = rows[0];
    const example = examples[0];
    if (!row || !example) throw new Error("Missing capture");
    expect(() =>
      teachingExamples(
        cases.map((c) =>
          c.id === example.id
            ? { ...c, input: { ...c.input, evidence: "Changed after capture" } }
            : c,
        ),
        rows,
      ),
    ).toThrow("changed teaching evidence");
    expect(() => teachingExamples(cases, [...rows, row])).toThrow("ambiguous");
    await ledger.label(example.recordId, {
      at: new Date().toISOString(),
      truth: true,
      correct: true,
      note: "The model agreed",
      source: "teacher:guess",
    });
    // Pass the actual updated rows, not a snapshot predating the questionable label.
    const updated = await ledger.all();
    expect(() => teachingExamples(cases, updated)).toThrow("other signals need review");
  });

  it("allows rules and example selection, but rejects authority, relabelling and test IDs", async () => {
    const { examples, pack } = await captured();
    expect(pack.examples[0]?.supported).toBe(true);
    expect(JSON.parse(pack.examples[0]?.evidence ?? "{}")).toMatchObject({
      evidence: examples[0]?.evidence,
      policy: examples[0]?.policy,
      checks: examples[0]?.checks,
    });
    for (const extra of [{ policy: { actAbove: 0 } }, { floors: [] }, { supported: true }])
      expect(() => compileDraft({ ...DEMO_DRAFT, ...extra }, examples)).toThrow(
        "exactly these fields",
      );
    expect(() =>
      compileDraft(
        { ...DEMO_DRAFT, exampleIds: ["conditional/yes", "dispatch-arrival/no"] },
        examples,
      ),
    ).toThrow("unknown or held-out");
    expect(() =>
      compileDraft({ ...DEMO_DRAFT, exampleIds: ["conditional/yes", "partial/yes"] }, examples),
    ).toThrow("both supported and unsupported");
    const changed = compileDraft(
      { ...DEMO_DRAFT, rubric: [...DEMO_DRAFT.rubric, "Preserve line identity."] },
      examples,
    );
    expect(packSpec(changed.pack).evidenceVersion).not.toBe(packSpec(pack).evidenceVersion);
    expect(packSpec(pack).mode).toBe("shadow");
  });

  it("runs the forged recipe through real floors in shadow and does not send labels to the judge", async () => {
    const { cases, pack } = await captured();
    const seen: string[] = [];
    const oracle: Oracle = {
      id: "spy",
      async decide(state, qs) {
        seen.push(state);
        return sure.decide(state, qs);
      },
    };
    const ledger = new MemoryLedger();
    const scores = await measure(
      cases.filter((c) => c.split === "test"),
      ledger,
      pack,
      oracle,
      "test",
      "taught",
    );
    expect(scores.filter((s) => s.floor)).toHaveLength(4);
    expect(scores.filter((s) => s.wouldAct)).toHaveLength(12);
    expect(scores.filter((s) => s.wouldAct && !s.truth)).toHaveLength(6);
    expect(seen).toHaveLength(12);
    expect(seen.some((s) => s.includes("curriculum:authored"))).toBe(false);
    expect((await ledger.all()).every((r) => r.mode === "shadow" && r.action === "review")).toBe(
      true,
    );
    await expect(measure(cases, ledger, pack, oracle, "bad", "bare")).rejects.toThrow("Only test");
  });

  it("never lets a failed judge act and stops buying after a caller cutoff", async () => {
    const { cases, pack } = await captured();
    let calls = 0;
    const broken: Oracle = {
      id: "broken",
      async decide() {
        calls++;
        throw new Error("Unavailable");
      },
    };
    const test = cases.filter((c) => c.split === "test").slice(0, 2);
    const ledger = new MemoryLedger();
    const scores = await measure(test, ledger, pack, broken, "broken", "taught");
    expect(scores.every((s) => s.failed && !s.wouldAct)).toBe(true);
    await expect(
      measure(test, ledger, pack, broken, "cutoff", "taught", () => true),
    ).rejects.toThrow("cutoff");
    expect(calls).toBe(2);
  });

  it("validates a paid teacher response before compilation, including incomplete output", async () => {
    const { examples } = await captured();
    let request = "";
    const mock = (finish: string): typeof fetch =>
      Object.assign(
        async (_url: unknown, init?: RequestInit) => {
          request = String(init?.body);
          return Response.json({
            model: "teacher/pinned",
            choices: [
              {
                finish_reason: finish,
                message: { content: JSON.stringify(DEMO_DRAFT) },
              },
            ],
          });
        },
        { preconnect: fetch.preconnect },
      );
    const result = await teach(examples, "test-only", mock("stop"));
    expect(result.model).toBe("teacher/pinned");
    expect(compileDraft(result.draft, examples).pack.examples).toHaveLength(4);
    expect(request).toContain('"effort":"high"');
    expect(request).not.toContain("test-only");
    await expect(teach(examples, "test-only", mock("length"))).rejects.toThrow("incomplete");
  });
});
