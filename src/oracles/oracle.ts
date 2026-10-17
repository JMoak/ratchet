import { neutralVerdict } from "../questions.ts";
import type { DecideOptions, Decision, Oracle, Question } from "../types.ts";

export const nowIso = (): string => new Date().toISOString();

export function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
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

/**
 * Wrap an oracle so that errors, timeouts and malformed answers become neutral decisions
 * flagged `failedOpen`, instead of exceptions. A soft judgment that fails must change nothing;
 * the policy then falls back to review. Hard rules live in floors.ts and fail closed.
 */
export function failOpen(inner: Oracle, defaults: FailOpenOptions = {}): Oracle {
  return {
    id: inner.id,
    async decide(state: string, questions: readonly Question[], opts: DecideOptions = {}) {
      const timeoutMs = opts.timeoutMs ?? defaults.timeoutMs;
      const started = performance.now();
      try {
        const call = inner.decide(state, questions, opts);
        const result = timeoutMs ? await withTimeout(call, timeoutMs, opts.signal) : await call;
        if (result.length !== questions.length) {
          throw new Error(`oracle ${inner.id} answered ${result.length} of ${questions.length}`);
        }
        return result;
      } catch (error) {
        defaults.onError?.(error);
        const latencyMs = performance.now() - started;
        const at = nowIso();
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 160);
        return questions.map((q) => ({
          verdict: neutralVerdict(q),
          oracle: inner.id,
          latencyMs,
          cost: 0,
          at,
          failedOpen: true,
          error: message,
        }));
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
