/**
 * A tiny flag parser with no dependencies. Every command declares its flags up front, so an
 * unknown or misspelled flag is a usage error rather than a silently ignored option; in a CI
 * gate a typo that passes is worse than one that fails.
 */

/** A usage error or unreadable input: the command could not run. Exit code 2. */
export class CliError extends Error {
  constructor(
    message: string,
    /** The command whose help explains the fix, when there is one. */
    readonly command?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export interface ArgSpec {
  /** Flags that take a value: `--name value` or `--name=value`. */
  readonly values?: readonly string[];
  /** Flags that are present or absent: `--name`. */
  readonly booleans?: readonly string[];
}

export interface Parsed {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
}

/** Parse argv against a spec. `--` ends flag parsing; `-h` is `--help`. */
export function parseArgs(argv: readonly string[], spec: ArgSpec, command?: string): Parsed {
  const valueFlags = new Set(spec.values ?? []);
  const boolFlags = new Set(spec.booleans ?? []);
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h") {
      booleans.add("help");
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (boolFlags.has(name)) {
      if (eq >= 0) throw new CliError(`--${name} takes no value`, command);
      booleans.add(name);
      continue;
    }
    if (!valueFlags.has(name)) throw new CliError(`unknown flag --${name}`, command);
    if (values.has(name)) throw new CliError(`--${name} given twice`, command);
    let value: string | undefined;
    if (eq >= 0) value = arg.slice(eq + 1);
    else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      }
    }
    if (value === undefined || value === "") throw new CliError(`--${name} needs a value`, command);
    values.set(name, value);
  }
  return { positionals, values, booleans };
}

export interface NumberRule {
  readonly min?: number;
  readonly max?: number;
  /** Exclude `min` itself. */
  readonly above?: boolean;
  readonly integer?: boolean;
}

/** Read a numeric flag, or the fallback when absent. Throws CliError on junk or out of range. */
export function numberFlag(
  p: Parsed,
  name: string,
  rule: NumberRule,
  command?: string,
): number | undefined {
  const raw = p.values.get(name);
  if (raw === undefined) return undefined;
  const x = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(x)) {
    throw new CliError(`--${name} must be a number, got "${raw}"`, command);
  }
  if (rule.integer && !Number.isInteger(x)) {
    throw new CliError(`--${name} must be a whole number, got "${raw}"`, command);
  }
  const lowOk = rule.min === undefined || (rule.above ? x > rule.min : x >= rule.min);
  const highOk = rule.max === undefined || x <= rule.max;
  if (!lowOk || !highOk) {
    const lo = rule.min === undefined ? "" : `${rule.above ? "above" : "at least"} ${rule.min}`;
    const hi = rule.max === undefined ? "" : `at most ${rule.max}`;
    throw new CliError(`--${name} must be ${[lo, hi].filter(Boolean).join(" and ")}`, command);
  }
  return x;
}

/** A numeric flag that must be present. */
export function requiredNumber(
  p: Parsed,
  name: string,
  rule: NumberRule,
  command?: string,
): number {
  const x = numberFlag(p, name, rule, command);
  if (x === undefined) throw new CliError(`--${name} is required`, command);
  return x;
}

/** A string flag that must be present. */
export function requiredString(p: Parsed, name: string, command?: string): string {
  const v = p.values.get(name);
  if (v === undefined) throw new CliError(`--${name} is required`, command);
  return v;
}

/** `true` or `false`, spelled out. */
export function booleanValue(p: Parsed, name: string, command?: string): boolean | undefined {
  const raw = p.values.get(name);
  if (raw === undefined) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new CliError(`--${name} must be true or false, got "${raw}"`, command);
}

/** Exactly one positional argument: the ledger path. */
export function ledgerPath(p: Parsed, command: string): string {
  const [path, ...rest] = p.positionals;
  if (path === undefined) throw new CliError("missing <ledger> path", command);
  if (rest.length > 0) throw new CliError(`unexpected argument "${rest[0]}"`, command);
  return path;
}
