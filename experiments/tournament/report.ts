import { rng } from "../../src/math.ts";
import { digest } from "./corpus.ts";
import { PROTOCOL, select } from "./runner.ts";
import { ARMS, type Bars, type ScoredTask, type Selection } from "./types.ts";

export function summarize(rows: readonly Selection[]) {
  const correct = rows.filter((r) => r.correct).length;
  const wrong = rows.filter((r) => r.wrong).length;
  const held = rows.filter((r) => r.selected === null).length;
  const cost = rows.reduce((sum, r) => sum + r.cost, 0);
  return {
    tasks: rows.length,
    correct,
    wrong,
    held,
    precision: correct + wrong ? correct / (correct + wrong) : null,
    coverage: rows.length ? (correct + wrong) / rows.length : 0,
    missedSolvable: rows.filter((r) => r.selected === null && r.solvable).length,
    calls: rows.reduce((sum, r) => sum + r.calls, 0),
    cost,
    costPerCorrect: correct ? cost / correct : null,
    losses: Object.fromEntries(
      PROTOCOL.wrongAcceptCosts.map((weight) => [weight, wrong * weight + held]),
    ),
  };
}

/** Paired resampling keeps all candidate/parameter relatives together, within each domain. */
export function pairedInterval(a: readonly Selection[], b: readonly Selection[], draws = 2000) {
  const right = new Map(b.map((r) => [r.task, r]));
  if (
    right.size !== b.length ||
    a.length !== b.length ||
    new Set(a.map((r) => r.task)).size !== a.length
  )
    throw new Error("Comparison requires unique paired tasks");
  const domains = new Map<string, Map<string, number[]>>();
  for (const left of a) {
    const paired = right.get(left.task);
    if (!paired || paired.family !== left.family) throw new Error("Mismatched paired tasks");
    const families = domains.get(left.domain) ?? new Map<string, number[]>();
    const group = families.get(left.family) ?? [];
    group.push(Number(left.correct) - Number(paired.correct));
    families.set(left.family, group);
    domains.set(left.domain, families);
  }
  const random = rng(91027);
  const differences: number[] = [];
  for (let i = 0; i < draws; i++) {
    const sample: number[] = [];
    for (const families of domains.values()) {
      const groups = [...families.values()];
      for (let j = 0; j < groups.length; j++)
        sample.push(...(groups[Math.floor(random() * groups.length)] ?? []));
    }
    differences.push(sample.reduce((sum, value) => sum + value, 0) / Math.max(1, sample.length));
  }
  differences.sort((x, y) => x - y);
  return {
    difference:
      a.reduce((sum, row) => sum + Number(row.correct) - Number(right.get(row.task)?.correct), 0) /
      Math.max(1, a.length),
    lower: differences[Math.floor(draws * 0.025)] ?? 0,
    upper: differences[Math.floor(draws * 0.975)] ?? 0,
    clusters: [...domains.values()].reduce((n, families) => n + families.size, 0),
  };
}

const pct = (n: number | null) => (n === null ? "n/a" : `${(100 * n).toFixed(1)}%`);

export function report(tasks: readonly ScoredTask[], bars: Bars, mode: string): string {
  const actual = tasks.flatMap((t) => t.candidates.flatMap((c) => [c.cheap, c.strong]));
  const lines = [
    "# Repair tournament: controlled pilot",
    "",
    `Mode: **${mode}**. ${tasks.length} tasks; ${new Set(tasks.map((t) => t.family)).size} authored families.`,
    "Four authored candidates per task; one third of tasks deliberately have no correct candidate. This is a controlled selection experiment, not a coding-model or production benchmark.",
    "",
    `Frozen bars: ${JSON.stringify(bars)}. Unsupported fits are null and hand off.`,
    `Protocol hash: ${digest(PROTOCOL)}.`,
    `Acquisition cost for the complete paired matrix: $${actual.reduce((sum, s) => sum + s.cost, 0).toFixed(6)}; failed judgments: ${actual.filter((s) => s.failed).length}/${actual.length}.`,
    "The arm costs below replay only the judgments each policy would consume. They exclude candidate generation, test execution, human review, and application integration. Latencies are recorded-call estimates, not an online timing benchmark.",
    "",
  ];
  for (const split of ["evaluation", "challenge"] as const) {
    const heldout = tasks.filter((t) => t.split === split);
    lines.push(
      `## ${split}`,
      "",
      "| Approach | Correct / tasks | Wrong accepted | Handoffs | Accepted precision | Missed solvable | Judge calls | Judge cost |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    const outcomes = new Map(
      ARMS.map((arm) => [arm, heldout.map((task) => select(task, arm, bars))]),
    );
    for (const arm of ARMS) {
      const s = summarize(outcomes.get(arm) ?? []);
      lines.push(
        `| ${arm} | ${s.correct}/${s.tasks} | ${s.wrong} | ${s.held} | ${pct(s.precision)} | ${s.missedSolvable} | ${s.calls} | $${s.cost.toFixed(6)} |`,
      );
    }
    const difference = pairedInterval(outcomes.get("cascade") ?? [], outcomes.get("tests") ?? []);
    lines.push(
      "",
      `Cascade minus tests, correct completion: ${pct(difference.difference)}; exploratory paired family-bootstrap interval [${pct(difference.lower)}, ${pct(difference.upper)}], ${difference.clusters} family clusters. With this few clusters, the interval is descriptive and cannot support a deployment guarantee.`,
      "",
    );
    lines.push("| Domain | Cascade correct | Wrong | Handoffs |", "| --- | ---: | ---: | ---: |");
    for (const domain of ["boundaries", "transforms", "sql"] as const) {
      const s = summarize((outcomes.get("cascade") ?? []).filter((r) => r.domain === domain));
      lines.push(`| ${domain} | ${s.correct}/${s.tasks} | ${s.wrong} | ${s.held} |`);
    }
    lines.push(
      "",
      "Review-cost sensitivity (wrong acceptance costs 5, 20, or 100 reviews; each handoff costs one review):",
      "",
      "| Approach | 5:1 | 20:1 | 100:1 |",
      "| --- | ---: | ---: | ---: |",
    );
    for (const arm of ARMS.filter((a) => a !== "ceiling")) {
      const s = summarize(outcomes.get(arm) ?? []);
      lines.push(`| ${arm} | ${s.losses[5]} | ${s.losses[20]} | ${s.losses[100]} |`);
    }
    lines.push("");
  }
  lines.push(
    "## Interpretation",
    "",
    "A simulation verifies wiring under stipulated error rates; it is not evidence that any live model improves. Live results here test authored candidates with small hidden suites, not naturally generated repairs. Hidden tests are evidence over their finite cases, not proofs over all inputs.",
    "No gate is promoted. Recipes require a separate, frozen acceptance plan on representative independent real cases. Related variants count as a family; repeated calls and replayed candidates never add independent evidence.",
    "Next: independently review the specifications and labels; add naturally generated candidates and new held-out families; then run the frozen selectors at equal generation and review budgets. Keep later revisions and replication sets separate from this evaluation.",
    "",
  );
  return lines.join("\n");
}
