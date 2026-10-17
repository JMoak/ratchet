import type { Truth } from "../src/oracles/sim.ts";

export interface ItemSet {
  readonly states: readonly string[];
  readonly truthOf: (state: string) => Truth | undefined;
  readonly truths: ReadonlyMap<string, Truth>;
}

export function judgeItems(n: number, prefix = "item"): ItemSet {
  const states = Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
  const truths = new Map<string, Truth>(states.map((s, i) => [s, { judge: i % 2 === 0 }]));
  return { states, truths, truthOf: (s) => truths.get(s) };
}

export function pct(x: number, places = 1): string {
  return `${(100 * x).toFixed(places)}%`;
}

export function fmt(x: number, places = 3): string {
  return x.toFixed(places);
}

/** Print a markdown table. */
export function table(
  headers: readonly string[],
  rows: readonly (readonly (string | number)[])[],
): void {
  const cells = rows.map((r) => r.map((c) => (typeof c === "number" ? String(c) : c)));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map((r) => (r[i] ?? "").length)),
  );
  const line = (r: readonly string[]) =>
    `| ${r.map((c, i) => c.padEnd(widths[i] ?? 0)).join(" | ")} |`;
  console.log(line(headers));
  console.log(`| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`);
  for (const r of cells) console.log(line(r));
  console.log();
}

export function heading(text: string): void {
  console.log(`\n## ${text}\n`);
}

export function note(text: string): void {
  console.log(`${text}\n`);
}
