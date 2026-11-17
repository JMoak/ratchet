export type Domain = "boundaries" | "transforms" | "sql";
export type Split = "fit" | "evaluation" | "challenge";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Check {
  readonly input: Json;
  readonly expected: Json;
}

export interface Candidate {
  readonly id: string;
  readonly source: string;
  readonly publicPass: boolean;
  readonly hiddenPass: boolean;
  readonly publicChecks: number;
  readonly hiddenChecks: number;
}

export interface Task {
  readonly id: string;
  readonly family: string;
  readonly domain: Domain;
  readonly split: Split;
  readonly requirement: string;
  readonly language: "javascript" | "sqlite";
  readonly publicExamples: readonly Check[];
  readonly candidates: readonly Candidate[];
}

export interface Score {
  readonly p: number;
  readonly cost: number;
  readonly latencyMs: number;
  readonly failed: boolean;
  readonly model: string;
}

export interface ScoredCandidate extends Candidate {
  readonly cheap: Score;
  readonly strong: Score;
}

export interface ScoredTask extends Omit<Task, "candidates"> {
  readonly candidates: readonly ScoredCandidate[];
}

export const ARMS = [
  "first",
  "tests",
  "cheap-fixed",
  "cheap-fit",
  "strong-fit",
  "cascade",
  "two-keys",
  "ceiling",
] as const;
export type Arm = (typeof ARMS)[number];

export interface Bars {
  readonly cheap: number | null;
  readonly strong: number | null;
  readonly cascadeCheap: number | null;
  readonly cascadeStrong: number | null;
}

export interface Selection {
  readonly task: string;
  readonly family: string;
  readonly domain: Domain;
  readonly arm: Arm;
  readonly selected: string | null;
  readonly correct: boolean;
  readonly solvable: boolean;
  readonly wrong: boolean;
  readonly inspected: number;
  readonly calls: number;
  readonly cost: number;
  readonly latencyMs: number;
}
