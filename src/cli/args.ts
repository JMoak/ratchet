/**
 * A tiny flag parser with no dependencies. Every command declares its flags up front, so an
 * unknown or misspelled flag is a usage error rather than a silently ignored option; in a CI
 * gate a typo that passes is worse than one that fails.
 */

import { isTrustClass, TRUST_CLASSES, type TrustClass, trustRegistry } from "../ledger/sources.ts";

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
  /** Flags that take a value and may repeat, each occurrence adding one: `--name a --name b`. */
  readonly lists?: readonly string[];
}

export interface Parsed {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
  /** Every value of each repeatable flag given, in order. */
  readonly lists: ReadonlyMap<string, readonly string[]>;
}

/** Parse argv against a spec. `--` ends flag parsing; `-h` is `--help`. */
export function parseArgs(argv: readonly string[], spec: ArgSpec, command?: string): Parsed {
  const valueFlags = new Set(spec.values ?? []);
  const boolFlags = new Set(spec.booleans ?? []);
  const listFlags = new Set(spec.lists ?? []);
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const lists = new Map<string, string[]>();
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
    const repeatable = listFlags.has(name);
    if (!repeatable && !valueFlags.has(name)) throw new CliError(`unknown flag --${name}`, command);
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
    if (!repeatable) values.set(name, value);
    else lists.set(name, [...(lists.get(name) ?? []), value]);
  }
  return { positionals, values, booleans, lists };
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
  return raw === undefined ? undefined : numberValue(raw, name, rule, command);
}

/** Every value of a repeatable numeric flag, each checked as `numberFlag` checks one. */
export function numberList(
  p: Parsed,
  name: string,
  rule: NumberRule,
  command?: string,
): number[] | undefined {
  return p.lists.get(name)?.map((raw) => numberValue(raw, name, rule, command));
}

function numberValue(raw: string, name: string, rule: NumberRule, command?: string): number {
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

/**
 * Every `--trust <prefix>=<class>` given, as the overrides `trustRegistry` lays over the
 * defaults; undefined when there are none. A prefix given twice is a usage error rather than
 * a silent last-one-wins, since either reading changes which labels fit a bar.
 */
export function trustFlag(
  p: Parsed,
  command?: string,
): Readonly<Record<string, TrustClass>> | undefined {
  const raw = p.lists.get("trust");
  if (raw === undefined) return undefined;
  const out = new Map<string, TrustClass>();
  for (const entry of raw) {
    const eq = entry.lastIndexOf("=");
    const prefix = entry.slice(0, eq);
    const cls = entry.slice(eq + 1);
    if (eq <= 0 || !isTrustClass(cls)) {
      throw new CliError(
        `--trust must be <prefix>=<class> with a class of ${TRUST_CLASSES.join(", ")}, got "${entry}"`,
        command,
      );
    }
    if (out.has(prefix)) throw new CliError(`--trust ${prefix} given twice`, command);
    out.set(prefix, cls);
  }
  const overrides = Object.fromEntries(out);
  try {
    trustRegistry(overrides);
  } catch (e) {
    throw new CliError(`--trust: ${e instanceof Error ? e.message : String(e)}`, command);
  }
  return overrides;
}

/** Exactly one positional argument: the ledger path. */
export function ledgerPath(p: Parsed, command: string): string {
  const [path, ...rest] = p.positionals;
  if (path === undefined) throw new CliError("missing <ledger> path", command);
  if (rest.length > 0) throw new CliError(`unexpected argument "${rest[0]}"`, command);
  return path;
}
