/**
 * Label sources and how far each can be trusted. A label is only as good as the route it
 * arrived by: a reviewer who judged before seeing the model's answer, a person who answered
 * every ask as it came, a person who saw the model's suggestion first (and anchored on it), or
 * an inference from what happened next (which depends on what the gate let happen). Fitting
 * and acceptance read the first two and legacy rows; consequence labels are counted and read
 * by nothing else.
 *
 * A source string is `<channel>:<kind>[:<name>]`, such as `review:blind:jordan`. Its class is
 * looked up by `channel:kind`, then `channel:*`. Only an absent source is `unknown`, which
 * reads exactly as an unsourced label always has, so ledgers written before sources existed do
 * not move. A source that is present but malformed or that no entry names is `unregistered`:
 * counted on its own, never fitted on, graded or accepted, because a mistyped or invented route
 * (`Reverted:git`, `accepted:`, `hook:inferred`) is not evidence that the label was given blind
 * (e2e T4-09). Register a new source with `labelTrust` before writing labels from it.
 */

/**
 * - `blind`: judged before the model's answer was shown.
 * - `census`: a person answered every ask in the moment, so the labels are the population.
 * - `moment`: a person answered after seeing the model's answer or suggestion.
 * - `consequence`: inferred from what happened next.
 * - `unknown`: no source at all, as every label written before sources existed.
 * - `unregistered`: a source is present but malformed, or no registry entry names it.
 */
export type TrustClass = "blind" | "census" | "moment" | "consequence" | "unknown" | "unregistered";

/**
 * The classes a fit or an acceptance test may be told to read. Consequence is not one: a revert
 * or a silence happens because of what the gate did, so a bar fitted on it is fitted on the
 * gate's own output. Unregistered is not one either: register the source (`labelTrust`) to
 * have its labels read, so that what they are is stated once, where it can be reviewed.
 */
export type FitClass = Exclude<TrustClass, "consequence" | "unregistered">;

export const TRUST_CLASSES: readonly TrustClass[] = [
  "blind",
  "census",
  "moment",
  "consequence",
  "unknown",
  "unregistered",
];

/** The default trust filter for fitting and acceptance: blind, census and unsourced labels. */
export const TRUSTED_SOURCES: readonly FitClass[] = ["blind", "census", "unknown"];

/**
 * What a report's `labelled` counts and grades: every class but consequence and unregistered,
 * which are counted on their own (read them with `sources: ["consequence"]` or
 * `["unregistered"]`). A moment label still says how often the model was right; it cannot fit
 * a bar, because the person saw the model's answer before giving it. An unregistered label is
 * not even known to be a person's answer, so it stays out of every figure until its source is
 * registered.
 */
export const COUNTED_SOURCES: readonly FitClass[] = ["blind", "census", "moment", "unknown"];

/** True for a class a fit or an acceptance test may read: not consequence, not unregistered. */
export const isFitClass = (x: unknown): x is FitClass =>
  isTrustClass(x) && x !== "consequence" && x !== "unregistered";

export interface LabelSource {
  readonly channel: string;
  readonly kind: string;
  /** Who, when the channel names one, such as the reviewer of `review:blind:<name>`. */
  readonly name?: string;
}

/** Trust classes keyed by `channel:kind`, or `channel:*` for every kind of a channel. */
export type TrustRegistry = ReadonlyMap<string, TrustClass>;

/**
 * The sources this repository writes or plans to: `ratchet review` writes `review:blind` (or
 * `review:blind:<name>`), the keywork gate writes `keywork:person` and the agent hook writes
 * `<harness>:person` for each harness it supports (`claude-code`, `codex`). The consequence
 * channels are registered before anything writes them, so the first one written reads as
 * consequence rather than as an unregistered source.
 */
export const DEFAULT_TRUST: TrustRegistry = new Map<string, TrustClass>([
  ["review:blind", "blind"],
  ["keywork:person", "census"],
  ["claude-code:person", "census"],
  ["codex:person", "census"],
  ["desk:assisted", "moment"],
  ["accepted:*", "consequence"],
  ["reverted:*", "consequence"],
  ["silence:*", "consequence"],
]);

export const isTrustClass = (x: unknown): x is TrustClass =>
  typeof x === "string" && (TRUST_CLASSES as readonly string[]).includes(x);

/** Split `<channel>:<kind>[:<name>]`; undefined when a part is missing or empty. */
export function parseSource(source: string): LabelSource | undefined {
  const first = source.indexOf(":");
  if (first <= 0) return undefined;
  const second = source.indexOf(":", first + 1);
  const channel = source.slice(0, first);
  const kind = second < 0 ? source.slice(first + 1) : source.slice(first + 1, second);
  if (kind === "") return undefined;
  if (second < 0) return { channel, kind };
  const name = source.slice(second + 1);
  return name === "" ? undefined : { channel, kind, name };
}

/**
 * The trust class of a label's source. Only an absent source is `unknown` (trusted, as every
 * label written before sources existed). A present source that is not a string, does not
 * parse, or that no entry names is `unregistered`, which nothing fits on or accepts: a label
 * whose route is unreadable must not pass as one whose route was never recorded.
 */
export function trustOf(
  source: string | undefined,
  registry: TrustRegistry = DEFAULT_TRUST,
): TrustClass {
  if (source === undefined) return "unknown";
  const s = typeof source === "string" ? parseSource(source) : undefined;
  if (!s) return "unregistered";
  return registry.get(`${s.channel}:${s.kind}`) ?? registry.get(`${s.channel}:*`) ?? "unregistered";
}

/**
 * A registry with `extra` laid over `base` (the defaults unless given). Keys are
 * `<channel>:<kind>` or `<channel>:*`; an entry replaces the base's for the same key.
 * Reclassifying a source changes which labels fit a gate's bar, so bump its evidence version.
 * Throws on a malformed key or a class that is not one of `TRUST_CLASSES`.
 */
export function trustRegistry(
  extra?: Readonly<Record<string, TrustClass>>,
  base: TrustRegistry = DEFAULT_TRUST,
): TrustRegistry {
  if (extra === undefined) return base;
  const out = new Map(base);
  for (const [prefix, cls] of Object.entries(extra)) {
    const s = parseSource(prefix);
    if (!s || s.name !== undefined) {
      throw new Error(`trust prefix "${prefix}" must be <channel>:<kind> or <channel>:*`);
    }
    if (!isTrustClass(cls)) {
      throw new Error(
        `trust class "${String(cls)}" for ${prefix} must be one of ${TRUST_CLASSES.join(", ")}`,
      );
    }
    out.set(prefix, cls);
  }
  return out;
}

/** Which labels a computation reads, by the trust class of their source. */
export interface TrustFilter {
  /** Classes whose labels are read. Default `TRUSTED_SOURCES`. */
  readonly sources?: readonly TrustClass[];
  /** How sources map to classes. Default `DEFAULT_TRUST`. */
  readonly trust?: TrustRegistry;
}

/**
 * True when a label from `source` passes the filter. A filter that names `unregistered` admits
 * those labels, which is how a report counts them; fits and acceptance take `FitClass`es, which
 * cannot name it.
 */
export function admits(filter: TrustFilter, source: string | undefined): boolean {
  const sources: readonly TrustClass[] = filter.sources ?? TRUSTED_SOURCES;
  return sources.includes(trustOf(source, filter.trust));
}
