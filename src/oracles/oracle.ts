import { neutralVerdict, show, validateVerdict } from "../questions.ts";
import type { DecideOptions, Decision, Oracle, Question } from "../types.ts";

export const nowIso = (): string => new Date().toISOString();

/**
 * Race a promise against a timer and an abort signal. It only stops waiting; to stop the work
 * too, give the call a signal and abort it (`failOpen` does both).
 */
export function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("oracle call aborted"));
      return;
    }
    const t = setTimeout(() => reject(new Error(`oracle timed out after ${ms} ms`)), ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("oracle call aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(t);
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        signal?.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export interface FailOpenOptions {
  readonly timeoutMs?: number;
  readonly onError?: (error: unknown) => void;
}

/** A finite, non-negative number: what a cost or a latency must be to be added up. */
const isAmount = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;

/**
 * An error's message for a record, without ever throwing: an error whose `message` getter
 * throws, or a thrown value `String()` cannot print (an object with no prototype), must not turn
 * a failure that should fail open into an exception that loses the ledger row.
 */
export function messageOf(error: unknown): string {
  try {
    if (typeof error === "string") return error;
    if (error instanceof Error) {
      const message: unknown = error.message;
      if (typeof message === "string") return message;
    }
  } catch {
    return "an error whose message cannot be read";
  }
  return show(error);
}

/** The fields of a decision `failOpen` keeps; anything else an adapter returns is dropped. */
const DECISION_FIELDS = [
  "verdict",
  "oracle",
  "model",
  "latencyMs",
  "cost",
  "at",
  "failedOpen",
  "error",
  "costUnknown",
  "vendor",
] as const;

type Raw = Partial<Record<(typeof DECISION_FIELDS)[number], unknown>>;

/** Each whitelisted field of an answer, read exactly once. Throws when reading one throws. */
function readFields(d: object): Raw {
  const raw: Record<string, unknown> = {};
  for (const key of DECISION_FIELDS) raw[key] = (d as Record<string, unknown>)[key];
  return raw as Raw;
}

/** An own, enumerable data property, defined so that a key like "__proto__" stays a key. */
function put(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * A plain copy of a verdict, every field read once, so what is validated is what is ruled on:
 * a getter or a Proxy that answers 0.2 while checked and 0.99 afterwards cannot change it.
 * Distributions are copied too (own keys of a pick's record, the indices of a rate's array).
 */
function copyVerdict(v: unknown): unknown {
  if (typeof v !== "object" || v === null) return v;
  const src = v as Record<string, unknown>;
  const kind = src.kind;
  const out: Record<string, unknown> = { kind, questionId: src.questionId };
  if (kind === "judge") {
    out.pYes = src.pYes;
    out.confidence = src.confidence;
  } else if (kind === "pick") {
    out.choice = src.choice;
    out.confidence = src.confidence;
    const ps = src.probabilities;
    if (typeof ps === "object" && ps !== null) {
      const copy: Record<string, unknown> = {};
      for (const key of Object.keys(ps)) put(copy, key, (ps as Record<string, unknown>)[key]);
      out.probabilities = copy;
    } else out.probabilities = ps;
  } else if (kind === "rate") {
    out.level = src.level;
    out.score = src.score;
    out.confidence = src.confidence;
    const ps = src.probabilities;
    if (Array.isArray(ps)) {
      const n: unknown = ps.length;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 64) {
        throw new Error("rate probabilities have no usable length");
      }
      out.probabilities = Array.from({ length: n }, (_, i) => ps[i]);
    } else out.probabilities = typeof ps === "object" && ps !== null ? "an object" : ps;
  }
  return out;
}

/** Primitive extras only: the vendor record is for audit, and nothing it holds is ruled on. */
function copyVendor(v: unknown): Record<string, string | number | boolean | null> | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(v)) {
    const x: unknown = (v as Record<string, unknown>)[key];
    if (x === null || typeof x === "string" || typeof x === "number" || typeof x === "boolean") {
      Object.defineProperty(out, key, { value: x, enumerable: true, writable: true });
    }
  }
  return out;
}

/** What `inspect` makes of a batch: the checked copies, or why not and what it cost. */
type Inspected =
  | { readonly decisions: Decision[] }
  | { readonly error: unknown; readonly spent: number | undefined };

/**
 * Check a batch and copy what passes. The batch is read once, by index (a sparse array's hole
 * is a missing answer, not a skipped one), each answer's whitelisted fields once; nothing it
 * does while being read can throw out of here. On a rejection, `spent` is the batch's cost when
 * every answer it returned stated a valid one, else undefined.
 */
function inspect(oracleId: string, questions: readonly Question[], result: unknown): Inspected {
  let spent: number | undefined;
  try {
    if (!Array.isArray(result)) {
      return {
        error: new Error(`oracle ${oracleId} returned ${show(result)}, not a list of decisions`),
        spent: undefined,
      };
    }
    const n: unknown = result.length;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      return { error: new Error(`oracle ${oracleId} returned an unusable list`), spent: undefined };
    }
    const raws: (Raw | undefined)[] = [];
    let total = 0;
    let costsKnown = n > 0;
    for (let i = 0; i < n; i++) {
      const d: unknown = result[i];
      const raw = typeof d === "object" && d !== null ? readFields(d) : undefined;
      raws.push(raw);
      if (raw && isAmount(raw.cost)) total += raw.cost;
      else costsKnown = false;
    }
    spent = costsKnown ? total : undefined;
    if (n !== questions.length) {
      return { error: new Error(`oracle ${oracleId} answered ${n} of ${questions.length}`), spent };
    }
    const decisions: Decision[] = [];
    for (let i = 0; i < n; i++) {
      const q = questions[i] as Question;
      const where = `oracle ${oracleId}, answer ${i + 1} of ${questions.length} (${q.id})`;
      const raw = raws[i];
      if (raw === undefined) return { error: new Error(`${where}: not a decision`), spent };
      const verdict = copyVerdict(raw.verdict);
      try {
        validateVerdict(q, verdict as Decision["verdict"]);
      } catch (error) {
        return { error: new Error(`${where}: ${messageOf(error)}`), spent };
      }
      if (!isAmount(raw.cost)) {
        const cost = show(raw.cost);
        return { error: new Error(`${where}: cost ${cost} is not a non-negative number`), spent };
      }
      if (!isAmount(raw.latencyMs)) {
        const latency = show(raw.latencyMs);
        return {
          error: new Error(`${where}: latency ${latency} is not a non-negative number`),
          spent,
        };
      }
      const vendor = copyVendor(raw.vendor);
      decisions.push({
        verdict: verdict as Decision["verdict"],
        oracle: typeof raw.oracle === "string" ? raw.oracle : oracleId,
        ...(typeof raw.model === "string" ? { model: raw.model } : {}),
        latencyMs: raw.latencyMs,
        cost: raw.cost,
        at: typeof raw.at === "string" ? raw.at : nowIso(),
        ...(raw.failedOpen === true ? { failedOpen: true } : {}),
        ...(typeof raw.error === "string" ? { error: raw.error.slice(0, 160) } : {}),
        ...(raw.costUnknown === true ? { costUnknown: true as const } : {}),
        ...(vendor !== undefined ? { vendor } : {}),
      });
    }
    return { decisions };
  } catch (error) {
    // A getter, a Proxy trap or a length that throws: the batch cannot be read.
    const why = messageOf(error);
    return { error: new Error(`oracle ${oracleId}: answer unreadable: ${why}`), spent };
  }
}

/**
 * Check a batch of answers against the questions asked, in order: one decision per question,
 * each verdict valid for its own question (kind, id, ranges, consistency; `validateVerdict`),
 * and a cost and latency that are finite and non-negative. Matching ids position by position
 * is what catches a backend that swapped two answers or repeated one for every question.
 * Throws on the first violation. Returns plain copies built from the values it validated, with
 * only the fields a decision has (`verdict`, `oracle`, `model`, `latencyMs`, `cost`, `at`,
 * `failedOpen`, `error`, `costUnknown`, and primitive `vendor` extras): an adapter cannot
 * change an answer after it was checked, or pass itself off as a compound with members.
 */
export function checkDecisions(
  oracleId: string,
  questions: readonly Question[],
  result: unknown,
): Decision[] {
  const checked = inspect(oracleId, questions, result);
  if ("decisions" in checked) return checked.decisions;
  throw new Error(messageOf(checked.error));
}

/**
 * Wrap an oracle so that errors, timeouts and malformed answers become neutral decisions
 * flagged `failedOpen`, instead of exceptions. A soft judgment that fails must change nothing;
 * the policy then falls back to review. Hard rules live in floors.ts and fail closed.
 *
 * Every batch is checked (`checkDecisions`): a NaN, string or out-of-range probability, an
 * inconsistent confidence, a wrong id or kind, swapped or repeated answers, a short, long or
 * sparse batch, a missing verdict, or an invalid cost or latency fails the whole batch open,
 * with the reason in `error`. One bad answer means the adapter is broken, so its other answers
 * are not trusted either. What passes is returned as plain copies of the checked values. A
 * rejected batch whose costs were all valid still records them, split evenly: it was paid for.
 * Nothing the inner oracle does, however it throws or whatever it returns, makes this throw.
 *
 * The call gets its own AbortSignal, linked to the caller's `signal`: a timeout or the caller's
 * abort cancels the underlying request (adapters pass the signal to `fetch`) instead of only
 * no longer waiting for it. A decision that stopped waiting records cost 0 with `costUnknown`,
 * since the request may still have been billed; a budget must not read that 0 as free. So does
 * a rejected batch whose costs cannot be read. A caller whose signal is already aborted gets
 * failed-open decisions without a call.
 */
export function failOpen(inner: Oracle, defaults: FailOpenOptions = {}): Oracle {
  return {
    id: inner.id,
    async decide(state: string, questions: readonly Question[], opts: DecideOptions = {}) {
      const started = performance.now();
      const failed = (error: unknown, spent: number | undefined): Decision[] => {
        try {
          defaults.onError?.(error);
        } catch {
          // A hook that throws must not undo failing open.
        }
        const latencyMs = performance.now() - started;
        const at = nowIso();
        const message = messageOf(error).slice(0, 160);
        const cost = spent === undefined ? 0 : spent / Math.max(1, questions.length);
        return questions.map((q) => ({
          verdict: neutralVerdict(q),
          oracle: inner.id,
          latencyMs,
          cost,
          at,
          failedOpen: true,
          error: message,
          ...(spent === undefined ? { costUnknown: true as const } : {}),
        }));
      };
      try {
        const timeoutMs = opts.timeoutMs ?? defaults.timeoutMs;
        const caller = opts.signal;
        if (caller?.aborted) return failed(new Error("oracle call aborted"), 0);

        const controller = new AbortController();
        const forward = () => controller.abort(caller?.reason);
        caller?.addEventListener("abort", forward, { once: true });
        let timedOut = false;
        // Settles only by rejecting, once the call is cancelled by the timer or by the caller.
        const cancelled = new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () =>
              reject(
                new Error(
                  timedOut ? `oracle timed out after ${timeoutMs} ms` : "oracle call aborted",
                ),
              ),
            { once: true },
          );
        });
        const timer = timeoutMs
          ? setTimeout(() => {
              timedOut = true;
              controller.abort(new Error(`oracle timed out after ${timeoutMs} ms`));
            }, timeoutMs)
          : undefined;
        let result: unknown;
        try {
          const call = inner.decide(state, questions, { ...opts, signal: controller.signal });
          result = await Promise.race([call, cancelled]);
        } catch (error) {
          // Cancelled, the request may have been billed and nobody will say for how much. An
          // error the call raised itself is recorded at 0, as before: most are refusals that
          // bought nothing (402, 429, 5xx), and counting each as a maximal spend would let an
          // outage use up a day's cap.
          return failed(error, controller.signal.aborted ? undefined : 0);
        } finally {
          clearTimeout(timer);
          caller?.removeEventListener("abort", forward);
        }
        const checked = inspect(inner.id, questions, result);
        return "decisions" in checked ? checked.decisions : failed(checked.error, checked.spent);
      } catch (error) {
        return failed(error, undefined);
      }
    },
  };
}

/**
 * Memoize decisions per (state, questions). Decision models are deterministic enough that
 * repeated identical questions should not be paid for twice; the DSPy integration caches by
 * default. Keyed on the full question objects so option order changes are distinct calls.
 */
export interface CacheOptions {
  readonly maxEntries?: number;
  /** Lease length: entries older than this are re-asked. Default: never expire. */
  readonly ttlMs?: number;
  /** Lease uses: entries served this many times are re-asked. Default: unlimited. */
  readonly maxUses?: number;
  readonly now?: () => number;
}

export function cached(
  inner: Oracle,
  options: number | CacheOptions = {},
): Oracle & { readonly size: number } {
  const opts: CacheOptions = typeof options === "number" ? { maxEntries: options } : options;
  const maxEntries = opts.maxEntries ?? 10_000;
  const now = opts.now ?? (() => Date.now());
  const store = new Map<string, { value: Decision[]; at: number; uses: number }>();
  return {
    id: inner.id,
    get size() {
      return store.size;
    },
    async decide(state, questions, dopts) {
      const key = JSON.stringify([state, questions]);
      const hit = store.get(key);
      if (hit) {
        const expired = opts.ttlMs !== undefined && now() - hit.at > opts.ttlMs;
        const spent = opts.maxUses !== undefined && hit.uses >= opts.maxUses;
        if (!expired && !spent) {
          hit.uses++;
          return hit.value;
        }
        store.delete(key);
      }
      const result = await inner.decide(state, questions, dopts);
      if (result.every((d) => !d.failedOpen)) {
        if (store.size >= maxEntries) {
          const first = store.keys().next().value;
          if (first !== undefined) store.delete(first);
        }
        store.set(key, { value: result, at: now(), uses: 0 });
      }
      return result;
    },
  };
}

export const isFailedOpen = (d: Decision): boolean => d.failedOpen === true;

export const totalCost = (ds: readonly Decision[]): number => ds.reduce((s, d) => s + d.cost, 0);
export const maxLatency = (ds: readonly Decision[]): number =>
  ds.reduce((m, d) => Math.max(m, d.latencyMs), 0);

/**
 * Try the primary oracle; on an error, a timeout or a batch that failed open entirely, ask
 * the secondary. Decision models are services: Jev returned HTTP 402 to everyone for part of
 * 10 October 2026, and the harnesses that kept working were the ones with a second backend
 * (an open-weight clone, a local model, or a different vendor speaking the same wire format).
 * The answer carries the oracle id that actually answered, so the ledger stays honest.
 */
export function withFallback(
  primary: Oracle,
  secondary: Oracle,
  opts: FailOpenOptions = {},
): Oracle {
  const safePrimary = failOpen(primary, opts);
  return {
    id: `${primary.id}|${secondary.id}`,
    async decide(state, questions, dopts) {
      const first = await safePrimary.decide(state, questions, dopts);
      if (first.some((d) => !d.failedOpen)) return first;
      return secondary.decide(state, questions, dopts);
    },
  };
}
