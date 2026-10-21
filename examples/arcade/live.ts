import { jev, jevViaOpenRouter, type Oracle } from "../../src/index.ts";

/** Local demo limits count distinct backend requests, including failed requests. */
export interface LiveLimits {
  readonly maxCalls: number;
  readonly maxRoundCalls: number;
  readonly stopAfterUsd: number;
  readonly timeoutMs: number;
}

const defaults: LiveLimits = {
  maxCalls: 100,
  maxRoundCalls: 16,
  stopAfterUsd: 0.1,
  timeoutMs: 8_000,
};

/** Keep replay stable and deduplicate concurrent replay without making verdicts model evidence. */
export function createLiveRuntime(backend?: Oracle, overrides: Partial<LiveLimits> = {}) {
  const limits = { ...defaults, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid arcade limit: ${key}`);
  }
  if (!Number.isInteger(limits.maxCalls) || !Number.isInteger(limits.maxRoundCalls)) {
    throw new Error("Arcade call limits must be integers.");
  }
  const cache = new Map<string, Promise<Awaited<ReturnType<Oracle["decide"]>>>>();
  let calls = 0;
  let reportedCost = 0;
  let unknownCost = false;
  return {
    status() {
      const blockedReason = unknownCost
        ? "Connection failed; new paid calls paused"
        : reportedCost >= limits.stopAfterUsd
          ? "Reported-spend cutoff reached"
          : calls >= limits.maxCalls
            ? "Live request limit reached"
            : cache.size >= limits.maxCalls * 3
              ? "Replay cache full"
              : null;
      return {
        liveAvailable: backend !== undefined,
        acceptingNewRequests: backend !== undefined && blockedReason === null,
        blockedReason,
        remainingCalls: Math.max(0, limits.maxCalls - calls),
        oracle: backend?.id ?? null,
        calls,
        reportedCost,
        unknownCost,
        limits,
      };
    },
    round(): Oracle {
      if (!backend)
        throw new Error("Live play is disabled. Start with ARCADE_LIVE=1 and a server key.");
      let roundCalls = 0;
      return {
        id: backend.id,
        async decide(state, questions, options) {
          if (state.length > 24_000 || questions.length > 64) {
            throw new Error("Live arcade decision is too large.");
          }
          const key = JSON.stringify([state, questions]);
          const prior = cache.get(key);
          if (prior) {
            return structuredClone(await prior).map((decision) => ({
              ...decision,
              cost: 0,
              latencyMs: 0,
              at: new Date().toISOString(),
              vendor: {
                ...decision.vendor,
                arcadeCacheHit: true,
                arcadeOriginalCost: decision.cost,
                arcadeOriginalAt: decision.at,
              },
            }));
          }
          if (cache.size >= limits.maxCalls * 3) {
            throw new Error("Live replay cache is full; restart the server or use offline play.");
          }
          if (calls >= limits.maxCalls || roundCalls >= limits.maxRoundCalls) {
            const denied = Promise.reject<Awaited<ReturnType<Oracle["decide"]>>>(
              new Error("Live arcade request limit reached; use manual or offline play."),
            );
            cache.set(key, denied);
            return await denied;
          }
          if (unknownCost || reportedCost >= limits.stopAfterUsd) {
            throw new Error("Live arcade spending cutoff reached; use manual or offline play.");
          }
          calls++;
          roundCalls++;
          const controller = new AbortController();
          const signal = options?.signal
            ? AbortSignal.any([options.signal, controller.signal])
            : controller.signal;
          // Failed promises stay cached too: a later replay must not rewrite an earlier move.
          const pending = (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const deadline = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  controller.abort();
                  reject(new Error("Live arcade decision timed out."));
                }, limits.timeoutMs);
              });
              const decisions = await Promise.race([
                backend.decide(state, questions, { signal, timeoutMs: limits.timeoutMs }),
                deadline,
              ]);
              for (const decision of decisions) {
                if (!Number.isFinite(decision.cost) || decision.cost < 0) {
                  unknownCost = true;
                  throw new Error("Live arcade could not account for this request's cost.");
                }
                reportedCost += decision.cost;
              }
              return decisions;
            } catch {
              // An unsuccessful HTTP call may still be billed. Stop buying until a restart.
              unknownCost = true;
              throw new Error(
                "Live judge unavailable; use manual play or restart the live server.",
              );
            } finally {
              if (timer !== undefined) clearTimeout(timer);
            }
          })();
          cache.set(key, pending);
          return structuredClone(await pending);
        },
      };
    },
  };
}

export type LiveRuntime = ReturnType<typeof createLiveRuntime>;

/** Merely having a key never enables network calls. Keys remain on the server. */
export function configuredLiveRuntime(): LiveRuntime {
  if (process.env.ARCADE_LIVE !== "1") return createLiveRuntime();
  const backend = process.env.TYPESAFE_API_KEY
    ? jev({ maxRetries: 0 })
    : jevViaOpenRouter({ maxRetries: 0 });
  return createLiveRuntime(backend);
}
