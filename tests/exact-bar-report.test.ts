import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LedgerReport, report } from "../src/cli/report.ts";
import {
  describeExactBar,
  exactBarFor,
  fitActBar,
  type GateEvidence,
  gateEvidence,
} from "../src/ledger/bars.ts";
import { type DecisionRecord, JsonlLedger } from "../src/ledger/ledger.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ratchet-exact-report-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const template: DecisionRecord = {
  id: "",
  at: "2026-11-12T00:00:00.000Z",
  gateId: "g",
  requestId: "",
  questionId: "q",
  kind: "pick",
  prompt: "route?",
  questionHash: "0000000000000000",
  stateHash: "",
  trustedHash: "",
  untrusted: [],
  oracle: "fixed",
  strategy: "single",
  verdict: {
    kind: "pick",
    questionId: "q",
    choice: "a",
    probabilities: { a: 0.9 },
    confidence: 0.9,
  },
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
};

let seq = 0;
/** A labelled pick row at `confidence`; shadow unless `extra` says otherwise. */
function row(
  confidence: number,
  correct: boolean,
  extra: Partial<DecisionRecord> = {},
): DecisionRecord {
  const id = `e${seq++}`;
  return {
    ...template,
    id,
    requestId: id,
    stateHash: id,
    trustedHash: id,
    verdict: {
      kind: "pick",
      questionId: "q",
      choice: "a",
      probabilities: { a: confidence },
      confidence,
    },
    go: confidence,
    confidence,
    outcome: { at: template.at, correct },
    ...extra,
  };
}

/** `n` clean rows at 0.97, in groups of `size` rows (session:0, session:1, ...) when given. */
function clean(n: number, size?: number): DecisionRecord[] {
  return Array.from({ length: n }, (_, i) =>
    row(0.97, true, size === undefined ? {} : { tags: [`session:${Math.floor(i / size)}`] }),
  );
}

const levers = { target: 0.95 };
const reading = (e: GateEvidence) => {
  if (e.exact === undefined) throw new Error("no exact reading");
  return e.exact;
};

describe("without the option nothing changes", () => {
  const rows = [...clean(80), row(0.4, false), row(0.6, true, { mode: "enforce" })];

  it("gateEvidence has no exact field, and the rest is the same with it", () => {
    const plain = gateEvidence(rows, { levers });
    expect("exact" in plain).toBe(false);
    const { exact, ...rest } = gateEvidence(rows, { levers, exact: {} });
    expect(exact).toBeDefined();
    expect(rest).toEqual(plain);
  });

  it("the report's text is the same but for the added line, and has none without the flag", async () => {
    const path = join(dir, "plain.jsonl");
    const ledger = new JsonlLedger(path);
    for (const r of rows) await ledger.append(r);
    const base = (await report([path, "--target", "0.95"])).output;
    expect(base).not.toContain("exact bar");
    const withFlag = (await report([path, "--target", "0.95", "--exact-bar"])).output;
    const lines = withFlag.split("\n");
    expect(lines.filter((l) => l.startsWith("  - exact bar: "))).toHaveLength(1);
    expect(lines.filter((l) => !l.startsWith("  - exact bar: ")).join("\n")).toBe(base);
    const json = JSON.parse(
      (await report([path, "--target", "0.95", "--json"])).output,
    ) as LedgerReport;
    expect(json.gates[0] !== undefined && "exact" in json.gates[0]).toBe(false);
    const jsonExact = JSON.parse(
      (await report([path, "--target", "0.95", "--json", "--exact-bar"])).output,
    ) as LedgerReport;
    expect(jsonExact.gates[0]?.exact?.leftOut).toBe(0);
  });
});

describe("the exact bar on a ledger whose answer is known", () => {
  it("finds a bar on a clean tail of exactly the needed size, and says so", () => {
    const e = gateEvidence(clean(59), { levers, exact: {} });
    const { bar } = reading(e);
    expect(bar.bar).toBe(0.05);
    expect(bar.unit).toBe("row");
    const text = describeExactBar(reading(e));
    expect(text).toContain("act above 0.050");
    expect(text).toContain("of the 59 rows at or above it, 0 wrong");
    expect(text).toContain("exact one-sided 95.0% lower bound 95.0% >= 95.0%");
    expect(text).toContain("a fixed sequence over 19 preset edges");
    expect(text).toContain("assumes rows are independent");
    expect(text).toContain("start chosen from the fit rows' own counts");
    expect(text).toContain(
      "provisional: found at the edge of power, label more before relying on it",
    );
    expect(text).not.toContain("left out");
  });

  it("gives the reason one row fewer", () => {
    const e = gateEvidence(clean(58), { levers, exact: {} });
    const { bar } = reading(e);
    expect(bar.bar).toBeUndefined();
    const text = describeExactBar(reading(e));
    expect(text).toBe((bar as { reason: string }).reason);
    expect(text).toContain("a bar needs 59 rows");
    expect(text).toContain("holds 58");
  });

  it("counts rows tagged into groups as groups, and says so", () => {
    const group = { tagPrefix: "session:" };
    const e = gateEvidence(clean(118, 2), { levers, exact: { group } });
    expect(reading(e).bar).toMatchObject({ unit: "group", rows: 118, units: 59 });
    const text = describeExactBar(reading(e));
    expect(text).toContain("of the 59 groups at or above it, 0 held a wrong act");
    expect(text).toContain("118 rows are about 59 independent observations");
    expect(text).not.toContain("assumes rows are independent");
    // The same rows read as rows are 118 units, not 59.
    expect(reading(gateEvidence(clean(118, 2), { levers, exact: {} })).bar.units).toBe(118);
    // One group fewer: no bar, and the reason speaks of groups.
    const short = describeExactBar(
      reading(gateEvidence(clean(116, 2), { levers, exact: { group } })),
    );
    expect(short).toContain("too few groups");
    expect(short).not.toContain("too few rows");
  });

  it("makes a group wrong when any one of its rows is", () => {
    const group = { tagPrefix: "session:" };
    // 60 groups of two clean rows, then one wrong row in session:0 at the same go.
    const rows = [...clean(120, 2), row(0.97, false, { tags: ["session:0"] })];
    const e = gateEvidence(rows, { levers, exact: { group } });
    const { bar } = reading(e);
    expect(bar.unit).toBe("group");
    expect(bar.units).toBe(60);
    expect(bar.tested[0]).toMatchObject({ units: 60, wrong: 1, rows: 121 });
    expect(bar.bar).toBeUndefined();
    expect(describeExactBar(reading(e))).toContain(
      "1 of the 60 groups at or above it held a wrong act",
    );
  });
});

describe("the exact bar fits the rows the reported bar fits", () => {
  // 40 shadow rows and 100 enforced rows, all labelled by an unsourced (trusted) label.
  const rows = [
    ...clean(40),
    ...Array.from({ length: 100 }, () => row(0.99, true, { mode: "enforce" })),
  ];

  it("reads the unselected rows when there are enough", () => {
    const opts = { target: 0.95, minSupport: 30 };
    const act = fitActBar(rows, opts);
    expect(act.fittedFrom).toBe("unselected");
    const { bar, leftOut } = exactBarFor(rows, opts);
    expect(bar.rows).toBe(act.fitRows);
    expect(bar.rows).toBe(40);
    expect(leftOut).toBe(0);
  });

  it("reads every trusted labelled row otherwise", () => {
    const opts = { target: 0.95, minSupport: 50 };
    const act = fitActBar(rows, opts);
    expect(act.fittedFrom).toBe("all");
    expect(act.fitRows).toBe(140);
    expect(exactBarFor(rows, opts).bar.rows).toBe(140);
  });

  it("reads only the current configuration", () => {
    const older = clean(70).map((r) => ({ ...r, evidenceVersion: "v1" }));
    const now = clean(10).map((r) => ({ ...r, evidenceVersion: "v2" }));
    const all = [...older, ...now];
    const opts = { target: 0.95, minSupport: 5 };
    expect(exactBarFor(all, opts).bar.rows).toBe(fitActBar(all, opts).fitRows);
    expect(exactBarFor(all, opts).bar.rows).toBe(10);
  });
});

describe("rows the exact fit cannot read are left out and counted", () => {
  it("leaves out a probability outside [0, 1] and does not throw", () => {
    const rows = [...clean(59), row(1.5, true), row(-0.2, false)];
    const e = gateEvidence(rows, { levers, exact: {} });
    expect(reading(e).leftOut).toBe(2);
    expect(reading(e).bar.rows).toBe(59);
    expect(reading(e).bar.bar).toBe(0.05);
    expect(describeExactBar(reading(e))).toContain(
      "; 2 rows left out, their act-side probability not a number in [0, 1]",
    );
    // The reported bar's fit set held all 61: the two counts add up.
    expect(fitActBar(rows, { ...levers, minSupport: 30 }).fitRows).toBe(61);
  });

  it("says one row in the singular, after the reason when there is no bar", () => {
    const e = gateEvidence([...clean(10), row(2, true)], { levers, exact: {} });
    expect(reading(e).leftOut).toBe(1);
    expect(describeExactBar(reading(e))).toMatch(/^no act bar: too few rows.*; 1 row left out/);
  });

  it("does not throw on a probability that is not a number", () => {
    const bad = row(0.9, true, { confidence: "high" as unknown as number });
    const e = gateEvidence([...clean(59), bad], { levers, exact: {} });
    expect(reading(e).bar.rows).toBe(59);
  });
});

describe("the --exact-bar and --group flags", () => {
  let path: string;
  beforeAll(async () => {
    path = join(dir, "flags.jsonl");
    const ledger = new JsonlLedger(path);
    for (const r of clean(118, 2)) await ledger.append(r);
  });

  it("--exact-bar adds exactly one line per gate", async () => {
    const two = join(dir, "two.jsonl");
    const ledger = new JsonlLedger(two);
    for (const r of clean(70)) await ledger.append(r);
    for (const r of clean(60)) await ledger.append({ ...r, id: `h-${r.id}`, gateId: "h" });
    const base = (await report([two, "--target", "0.95"])).output.split("\n");
    const plus = (await report([two, "--target", "0.95", "--exact-bar"])).output.split("\n");
    expect(plus.filter((l) => l.startsWith("  - exact bar: "))).toHaveLength(2);
    expect(plus.length - base.length).toBe(2);
  });

  it("--group makes the line speak of groups", async () => {
    const r = await report([path, "--target", "0.95", "--exact-bar", "--group", "session:"]);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("118 rows are about 59 independent observations");
    expect(r.output).toContain("of the 59 groups at or above it, 0 held a wrong act");
  });

  it("refuses --group without --exact-bar", async () => {
    const r = await report([path, "--group", "session:"]);
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain("--group only applies with --exact-bar");
  });

  it("refuses an empty group prefix", async () => {
    const blank = await report([path, "--exact-bar", "--group", " "]);
    expect(blank.exitCode).toBe(2);
    expect(blank.output).toContain("--group needs a non-empty tag prefix");
    const empty = await report([path, "--exact-bar", "--group="]);
    expect(empty.exitCode).toBe(2);
    expect(empty.output).toContain("--group needs a value");
  });

  it("refuses --exact-bar at a promise of 1 rather than throwing", async () => {
    const r = await report([path, "--exact-bar", "--target", "1"]);
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain("--exact-bar needs a --target below 1");
  });
});
