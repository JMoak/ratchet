import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { rng, shuffled } from "../../src/math.ts";
import type { Candidate, Check, Domain, Json, Split, Task } from "./types.ts";

export const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

interface Family {
  readonly name: string;
  readonly domain: Exclude<Domain, "sql">;
  readonly requirement: (v: number) => string;
  /** Only these repository-authored programs execute. Model answers are probabilities. */
  readonly programs: (v: number) => readonly string[];
  readonly visible: (v: number) => readonly Json[];
  readonly hidden: (v: number) => readonly Json[];
  readonly expected: (input: Json, v: number) => Json;
}

const nums = (x: Json): number[] => x as number[];
const arrays = (values: readonly Json[], depth = 3): Json[][] => {
  const out: Json[][] = [[]];
  let level: Json[][] = [[]];
  for (let i = 0; i < depth; i++) {
    level = level.flatMap((prefix) => values.map((value) => [...prefix, value]));
    out.push(...level);
  }
  return out;
};

const FAMILIES: readonly Family[] = [
  {
    name: "half-open-range",
    domain: "boundaries",
    requirement: (v) => `Return true exactly for integer x in [${v + 2}, ${v + 7}).`,
    programs: (v) => [
      `(x) => x >= ${v + 2} && x < ${v + 7}`,
      `(x) => x > ${v + 2} && x < ${v + 7}`,
      `(x) => x >= ${v + 2} && x <= ${v + 7}`,
      `(x) => x >= ${v + 2} || x < ${v + 7}`,
    ],
    visible: (v) => [v + 4, v + 9],
    hidden: (v) => Array.from({ length: 12 }, (_, i) => v + i),
    expected: (x, v) => Array.from({ length: 5 }, (_, i) => v + 2 + i).includes(x as number),
  },
  {
    name: "quota",
    domain: "boundaries",
    requirement: (v) =>
      `Input [used, requested]. Return true iff both are nonnegative integers and their sum does not exceed ${v + 8}.`,
    programs: (v) => [
      `([u,r]) => Number.isInteger(u) && Number.isInteger(r) && u >= 0 && r >= 0 && u+r <= ${v + 8}`,
      `([u,r]) => Number.isInteger(u) && Number.isInteger(r) && u >= 0 && r >= 0 && u+r < ${v + 8}`,
      `([u,r]) => u+r <= ${v + 8}`,
      `([u,r]) => u >= 0 && r >= 0 && u <= ${v + 8}`,
    ],
    visible: () => [
      [1, 2],
      [20, 1],
    ],
    hidden: (v) =>
      [-1, 0, 1, 1.5, v + 7, v + 8, v + 9].flatMap((a) => [-1, 0, 1, 2].map((b) => [a, b])),
    expected: (x, v) => {
      const [u = 0, r = 0] = nums(x);
      if (Math.floor(u) !== u || Math.floor(r) !== r || Math.min(u, r) < 0) return false;
      return r <= v + 8 - u;
    },
  },
  {
    name: "expiry",
    domain: "boundaries",
    requirement: (v) =>
      `Input [issued, now], integer timestamps. A token is valid from issued inclusive until issued + ${v + 5} exclusive. Reject times before issuance.`,
    programs: (v) => [
      `([i,n]) => n >= i && n-i < ${v + 5}`,
      `([i,n]) => n >= i && n-i <= ${v + 5}`,
      `([i,n]) => n-i < ${v + 5}`,
      `([i,n]) => n > i && n-i < ${v + 5}`,
    ],
    visible: () => [
      [10, 12],
      [10, 30],
    ],
    hidden: (v) =>
      [0, 10, 100].flatMap((i) => [-1, 0, 1, v + 4, v + 5, v + 6].map((d) => [i, i + d])),
    expected: (x, v) => {
      const [issued = 0, now = 0] = nums(x);
      return Array.from({ length: v + 5 }, (_, i) => issued + i).includes(now);
    },
  },
  {
    name: "pagination",
    domain: "boundaries",
    requirement: () =>
      "Input [items, offset, limit]. Integers offset and limit are nonnegative. Return up to limit items starting at the zero-based offset; limit=0 returns [].",
    programs: () => [
      "([xs,o,n]) => xs.slice(o,o+n)",
      "([xs,o,n]) => xs.slice(o,n)",
      "([xs,o,n]) => xs.slice(o,o+n+1)",
      "([xs,o,n]) => xs.slice(o,o+(n || xs.length))",
    ],
    visible: () => [[[1, 2, 3], 0, 2]],
    hidden: (v) =>
      [[], [v], [v, v + 1, v + 2, v + 3]].flatMap((xs) =>
        [0, 1, 4, 6].flatMap((o) => [0, 1, 2, 5].map((n) => [xs, o, n])),
      ),
    expected: (x) => {
      const [xs, offset, limit] = x as [Json[], number, number];
      return xs.filter((_, i) => i - offset >= 0 && i - offset < limit);
    },
  },
  {
    name: "interval-overlap",
    domain: "boundaries",
    requirement: () =>
      "Input [a,b,c,d]. Return whether half-open intervals [a,b) and [c,d) overlap with positive length. Empty or reversed intervals do not overlap. Endpoints are integers.",
    programs: () => [
      "([a,b,c,d]) => a < b && c < d && a < d && c < b",
      "([a,b,c,d]) => a <= d && c <= b",
      "([a,b,c,d]) => a < d && c < b",
      "([a,b,c,d]) => a < b && c < d && a >= c && b <= d",
    ],
    visible: (v) => [
      [v + 1, v + 2, v, v + 3],
      [v, v + 1, v + 3, v + 4],
    ],
    hidden: (v) =>
      [0, 1, 2].flatMap((a) =>
        [0, 1, 2].flatMap((b) =>
          [0, 1, 2].flatMap((c) => [0, 1, 2].map((d) => [a + v, b + v, c + v, d + v])),
        ),
      ),
    expected: (x) => {
      const [a = 0, b = 0, c = 0, d = 0] = nums(x);
      const left = new Set(Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i));
      return Array.from({ length: Math.max(0, d - c) }, (_, i) => c + i).some((n) => left.has(n));
    },
  },
  {
    name: "clamp",
    domain: "boundaries",
    requirement: (v) =>
      `Clamp finite number x to the closed interval [${v + 1}, ${v + 6}]. Preserve values inside it.`,
    programs: (v) => [
      `(x) => Math.min(${v + 6},Math.max(${v + 1},x))`,
      `(x) => Math.min(${v + 6},x)`,
      `(x) => Math.max(${v + 1},x)`,
      `(x) => x < ${v + 1} ? ${v + 1} : ${v + 6}`,
    ],
    visible: (v) => [v + 1, v + 6],
    hidden: (v) => [-10, 0, 1, 1.5, 3, 6, 7, 100].map((n) => n + v),
    expected: (x, v) => ((x as number) < v + 1 ? v + 1 : (x as number) > v + 6 ? v + 6 : x),
  },
  {
    name: "stable-unique",
    domain: "transforms",
    requirement: () =>
      "Remove duplicate numbers while preserving their first-occurrence order. Return a new array.",
    programs: () => [
      "(xs) => [...new Set(xs)]",
      "(xs) => [...new Set(xs)].sort((a,b)=>a-b)",
      "(xs) => xs.filter((x,i)=>xs.lastIndexOf(x)===i)",
      "(xs) => xs.filter((x,i)=>i===0 || xs[i-1]!==x)",
    ],
    visible: (v) => [[v, v, v + 1]],
    hidden: (v) => arrays([v, v + 1, v + 2]),
    expected: (x) => {
      const out: Json[] = [];
      for (const value of x as Json[]) if (!out.includes(value)) out.push(value);
      return out;
    },
  },
  {
    name: "null-default",
    domain: "transforms",
    requirement: (v) =>
      `Replace null elements with ${v + 9}. Preserve every other JSON scalar, including 0, false, and empty strings.`,
    programs: (v) => [
      `(xs) => xs.map(x=>x===null ? ${v + 9} : x)`,
      `(xs) => xs.map(x=>x || ${v + 9})`,
      `(xs) => xs.filter(x=>x!==null)`,
      `(xs) => xs.map(x=>typeof x==='number' ? x : ${v + 9})`,
    ],
    visible: (v) => [[null, v + 2]],
    hidden: (v) => arrays([null, 0, false, "", v + 2], 2),
    expected: (x, v) => {
      const out: Json[] = [];
      for (const value of x as Json[]) out.push(value === null ? v + 9 : value);
      return out;
    },
  },
  {
    name: "latest-record",
    domain: "transforms",
    requirement: () =>
      "Input records {id,t,value}. Keep the record with greatest numeric t per id; a tie keeps the FIRST input record. Output records ordered by id ascending (ASCII strings).",
    programs: () => [
      "(xs) => {const m=new Map();for(const x of xs)if(!m.has(x.id)||x.t>m.get(x.id).t)m.set(x.id,x);return [...m.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)}",
      "(xs) => {const m=new Map();for(const x of xs)if(!m.has(x.id)||x.t>=m.get(x.id).t)m.set(x.id,x);return [...m.values()].sort((a,b)=>a.id<b.id?-1:1)}",
      "(xs) => [...new Map(xs.map(x=>[x.id,x])).values()].sort((a,b)=>a.id<b.id?-1:1)",
      "(xs) => {const m=new Map();for(const x of xs)if(!m.has(x.id)||x.t>m.get(x.id).t)m.set(x.id,x);return [...m.values()]}",
    ],
    visible: () => [
      [
        { id: "a", t: 1, value: 4 },
        { id: "a", t: 2, value: 5 },
      ],
    ],
    hidden: (v) =>
      arrays([
        { id: "a", t: 1, value: v },
        { id: "a", t: 1, value: v + 1 },
        { id: "a", t: 2, value: v + 2 },
        { id: "b", t: 0, value: v + 3 },
      ]),
    expected: (x) => {
      const xs = x as { id: string; t: number; value: number }[];
      return [...new Set(xs.map((row) => row.id))].sort().map((id) => {
        const group = xs.filter((row) => row.id === id);
        const highest = Math.max(...group.map((row) => row.t));
        return group.find((row) => row.t === highest) as Json;
      });
    },
  },
  {
    name: "numeric-sort",
    domain: "transforms",
    requirement: () =>
      "Sort a list of finite numbers in ascending NUMERIC order. Preserve duplicates and return a new array.",
    programs: () => [
      "(xs) => [...xs].sort((a,b)=>a-b)",
      "(xs) => [...xs].sort()",
      "(xs) => [...new Set(xs)].sort((a,b)=>a-b)",
      "(xs) => [...xs].sort((a,b)=>b-a)",
    ],
    visible: () => [[3, 1, 2]],
    hidden: (v) => arrays([-2, 0, 2, 10 + v]),
    expected: (x) => {
      const remaining = nums(x).slice();
      const out: number[] = [];
      while (remaining.length) {
        const minimum = Math.min(...remaining);
        out.push(minimum);
        remaining.splice(remaining.indexOf(minimum), 1);
      }
      return out;
    },
  },
  {
    name: "median",
    domain: "transforms",
    requirement: () =>
      "Return the median of finite numbers: sort numerically, return the middle value for odd length or mean of the two middle values for even length. Empty input returns null.",
    programs: () => [
      "(xs) => {if(!xs.length)return null;const a=[...xs].sort((a,b)=>a-b),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}",
      "(xs) => {if(!xs.length)return null;const a=[...xs].sort(),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}",
      "(xs) => {if(!xs.length)return null;const a=[...xs].sort((a,b)=>a-b);return a[Math.floor(a.length/2)]}",
      "(xs) => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null",
    ],
    visible: () => [[1, 2, 3], []],
    hidden: (v) => arrays([0, 2, 10 + v], 4),
    expected: (x) => {
      const a = nums(x)
        .slice()
        .sort((left, right) => left - right);
      if (!a.length) return null;
      const positions = [(a.length - 1) / 2, a.length / 2].map(Math.floor);
      return positions.reduce((total, i) => total + (a[i] ?? 0), 0) / 2;
    },
  },
  {
    name: "flatten-once",
    domain: "transforms",
    requirement: () =>
      "Flatten exactly ONE array nesting level. Preserve scalars including null and false, preserve deeper arrays and element order.",
    programs: () => [
      "(xs) => xs.flat(1)",
      "(xs) => xs.flat(Infinity)",
      "(xs) => xs.flat(1).filter(Boolean)",
      "(xs) => xs.filter(Array.isArray).flat(1)",
    ],
    visible: () => [[[1], [2, 3]]],
    hidden: (v) => arrays([null, false, v + 1, [v + 2], [[v + 3]], []], 2),
    expected: (x) => {
      const out: Json[] = [];
      for (const item of x as Json[]) {
        if (Array.isArray(item)) for (const value of item) out.push(value);
        else out.push(item);
      }
      return out;
    },
  },
];

/** Compare JSON structurally, independent of object insertion order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function checkProgram(source: string, checks: readonly Check[]): boolean {
  try {
    // The source is authored in this module; this is not an isolation boundary for external code.
    const actual: unknown = runInNewContext(
      `const fn=(${source});JSON.stringify(inputs.map(x=>fn(x)))`,
      { inputs: structuredClone(checks.map((c) => c.input)) },
      { timeout: 200 },
    );
    return (
      typeof actual === "string" &&
      canonical(JSON.parse(actual)) === canonical(checks.map((c) => c.expected))
    );
  } catch {
    return false;
  }
}

export const splitFor = (index: number): Split =>
  index < 2 ? "fit" : index < 4 ? "evaluation" : "challenge";

export function makeTask(
  info: Omit<Task, "candidates">,
  programs: readonly string[],
  check: (source: string, hidden: boolean) => boolean,
  counts: { public: number; hidden: number },
  variant: number,
): Task {
  // One third of task instances have no correct candidate. Never force an acceptance.
  const available =
    variant % 3 === 2
      ? [
          ...programs.slice(1),
          info.language === "javascript" ? "() => null" : "SELECT NULL AS invalid",
        ]
      : programs;
  const candidates: Candidate[] = available.map((source) => ({
    id: digest([info.id, source]).slice(0, 16),
    source,
    publicPass: check(source, false),
    hiddenPass: check(source, true),
    publicChecks: counts.public,
    hiddenChecks: counts.hidden,
  }));
  if (!check(programs[0] ?? "", true)) throw new Error(`Reference failed: ${info.id}`);
  if (programs.slice(1).some((p) => check(p, true)))
    throw new Error(`Undetected mutant: ${info.id}`);
  return {
    ...info,
    candidates: shuffled(candidates, rng(Number.parseInt(digest(info.id).slice(0, 8), 16))),
  };
}

export function buildCodeTasks(variants = 3): Task[] {
  const tasks: Task[] = [];
  for (const domain of ["boundaries", "transforms"] as const) {
    FAMILIES.filter((f) => f.domain === domain).forEach((family, index) => {
      for (let v = 0; v < variants; v++) {
        const examples = family
          .visible(v)
          .map((input) => ({ input, expected: family.expected(input, v) }));
        const hidden = family
          .hidden(v)
          .map((input) => ({ input, expected: family.expected(input, v) }));
        tasks.push(
          makeTask(
            {
              id: `${domain}/${family.name}/${v}`,
              family: `${domain}/${family.name}`,
              domain,
              split: splitFor(index),
              requirement: family.requirement(v),
              language: "javascript",
              publicExamples: examples,
            },
            family.programs(v),
            (source, secret) => checkProgram(source, secret ? [...examples, ...hidden] : examples),
            { public: examples.length, hidden: hidden.length },
            v,
          ),
        );
      }
    });
  }
  return tasks;
}

/** Explicit allowlist: no task ids, mutant names, hidden cases, scores or labels reach a judge. */
export function renderCandidate(task: Task, candidate: Candidate): string {
  return [
    `Language: ${task.language}`,
    `Requirement: ${task.requirement}`,
    `Public examples: ${JSON.stringify(task.publicExamples)}`,
    `Public checks passed: ${candidate.publicPass}`,
    `Candidate implementation:\n${candidate.source}`,
  ].join("\n\n");
}
