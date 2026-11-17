import { LlmJsonOracle } from "../../src/oracles/llm-json.ts";
import { jevViaOpenRouter } from "../../src/oracles/systemone.ts";
import type { Oracle } from "../../src/types.ts";

export interface Purchase {
  readonly model: string;
  readonly cost: number | null;
  readonly at: string;
  readonly finishReason?: string;
}

/** Serial calls, no retries, durable receipts; unknown billing stops further purchases. */
export class Purchases {
  spent = 0;
  calls = 0;
  stopped = false;
  readonly receipts: Purchase[] = [];
  constructor(
    readonly cap: number,
    readonly record: (purchase: Purchase) => void,
  ) {
    if (!Number.isFinite(cap) || cap <= 0 || cap > 25)
      throw new Error("Run budget must be in (0,25] USD");
  }

  readonly fetch: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      // Reserve a cent before each small request. This is a recorded-spend cutoff, not a prepaid cap.
      if (this.stopped || this.spent + 0.01 > this.cap || this.calls >= 2000) {
        this.stopped = true;
        throw new Error("Purchase cutoff reached");
      }
      this.calls++;
      let model = "unknown";
      try {
        const response = await fetch(input, init);
        if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
        const body = (await response.clone().json()) as {
          model?: string;
          usage?: { cost?: unknown };
          choices?: { finish_reason?: string }[];
        };
        model = body.model ?? "unknown";
        const cost = body.usage?.cost;
        if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
          throw new Error("Provider omitted valid billing");
        this.spent += cost;
        const finishReason = body.choices?.[0]?.finish_reason;
        const receipt = {
          model,
          cost,
          at: new Date().toISOString(),
          ...(finishReason ? { finishReason } : {}),
        };
        this.receipts.push(receipt);
        this.record(receipt);
        return response;
      } catch (error) {
        this.stopped = true;
        const receipt = { model, cost: null, at: new Date().toISOString() };
        this.receipts.push(receipt);
        this.record(receipt);
        throw error;
      }
    },
    { preconnect: fetch.preconnect },
  );
}

export function liveOracles(purchases: Purchases): { cheap: Oracle; strong: Oracle } {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is missing; load .env explicitly");
  return {
    cheap: jevViaOpenRouter({
      apiKey,
      model: "typesafe/jev-1.13",
      id: "tournament.jev",
      maxRetries: 0,
      fetch: purchases.fetch,
    }),
    strong: new LlmJsonOracle({
      apiKey,
      model: "anthropic/claude-haiku-5.5",
      id: "tournament.haiku",
      maxTokens: 1024,
      fetch: purchases.fetch,
    }),
  };
}
