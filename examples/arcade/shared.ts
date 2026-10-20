import { decisionRows, type Ledger } from "../../src/index.ts";

/** Small input boundary for the local teaching examples, not a public engine API. */
export function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Expected a JSON object.");
  }
  return input as Record<string, unknown>;
}

export function numeric(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
  integer = false,
): number {
  const value = input[key] ?? fallback;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    throw new Error(`${key} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}.`);
  }
  return value;
}

export function sandboxMode(input: Record<string, unknown>): "shadow" | "enforce" {
  if (input.automate !== undefined && typeof input.automate !== "boolean") {
    throw new Error("automate must be a boolean.");
  }
  return input.automate === true ? "enforce" : "shadow";
}

/** Decision rows keep member votes out of the action count; member rows are downloadable too. */
export async function ledgerView(ledger: Ledger) {
  const rows = await ledger.all();
  return {
    rows,
    decisions: decisionRows(rows).map((row) => ({
      id: row.id,
      gate: row.gateId,
      probability: row.go,
      suggested: row.soft,
      actual: row.action,
      mode: row.mode,
      floor: row.floor ?? null,
      answered: !row.failedOpen && row.strategy !== "floored" && row.strategy !== "bypass",
      failedOpen: row.failedOpen ?? false,
      correct:
        row.failedOpen || row.strategy === "floored" || row.strategy === "bypass"
          ? null
          : (row.outcome?.correct ?? null),
      truth: row.outcome?.truth ?? null,
    })),
  };
}
