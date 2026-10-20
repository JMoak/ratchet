import { normalize } from "../math.ts";
import {
  judgeVerdictFrom,
  pickVerdictFrom,
  rateVerdictFrom,
  validateVerdict,
} from "../questions.ts";
import type { DecideOptions, Decision, Oracle, Question, Verdict } from "../types.ts";
import { nowIso } from "./oracle.ts";

/**
 * Adapter for the "System One" wire format: `POST {baseUrl}/v1/systemone` with a state and a
 * map of typed questions (noul / choice / score), answers keyed by the same ids. TypeSafe's
 * Jev defined it; Cloudflare's Clef and Amazon's Strands Decider speak it too, and Vercel's AI
 * Gateway proxies it. One adapter, several backends: point `baseUrl` at the one you use.
 *
 * Mapping: judge -> noul, pick -> choice, rate -> score. The engine's `confidence` is the
 * probability mass on the leading answer (the calibrated quantity thresholds consume); the
 * vendor's own `confidence` figure, which is a rescaling, is kept under `Decision.vendor`.
 */
export interface SystemOneOptions {
  /** Default: TypeSafe. Any compatible host works. */
  readonly baseUrl?: string;
  /** Default: process.env.TYPESAFE_API_KEY. */
  readonly apiKey?: string;
  /**
   * Pin a versioned id. Aliases such as "jev-latest" move under you, and thresholds tuned on
   * one version do not transfer. Default "jev-1.13.0".
   */
  readonly model?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** USD per million input tokens; output is free on Jev. Default 0.042. */
  readonly pricePerMillionInput?: number;
  /** Retries on 429 and 529 with exponential backoff. Default 2. */
  readonly maxRetries?: number;
  readonly fetch?: typeof fetch;
  readonly id?: string;
}

type Entry = string | Record<string, unknown> | readonly unknown[] | null;

interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: Entry;
  readonly criteria?: { readonly true?: Entry; readonly false?: Entry };
}
interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: Entry;
  readonly criteria: Readonly<Record<string, Entry>>;
}
interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: Entry;
  readonly criteria: readonly Entry[];
}
export type WireQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface WireRequest {
  readonly state: string;
  readonly model: string;
  readonly questions: Readonly<Record<string, WireQuestion>>;
}

type WireAnswer =
  | { readonly type: "noul"; readonly noul: number }
  | {
      readonly type: "choice";
      readonly choice: string;
      readonly probabilities: Readonly<Record<string, number>>;
      readonly confidence?: number;
    }
  | {
      readonly type: "score";
      readonly score: number;
      readonly legend?: Readonly<Record<string, unknown>>;
      readonly probabilities: Readonly<Record<string, number>>;
      readonly confidence?: number;
    };

export interface WireResponse {
  readonly model?: string;
  readonly answers: Readonly<Record<string, WireAnswer>>;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    /** Gateways such as OpenRouter add the billed cost in USD. */
    readonly cost?: number;
  };
}

/** Translate an engine question into the wire shape. Exported for tests and for request inspection. */
export function toWire(q: Question): WireQuestion {
  switch (q.kind) {
    case "judge": {
      const c = q.criteria;
      return {
        type: "noul",
        instructions: q.prompt,
        ...(c
          ? {
              criteria: {
                ...(c.yes !== undefined ? { true: c.yes } : {}),
                ...(c.no !== undefined ? { false: c.no } : {}),
              },
            }
          : {}),
      };
    }
    case "pick":
      return {
        type: "choice",
        instructions: q.prompt,
        criteria: Object.fromEntries(q.options.map((o) => [o, q.criteria?.[o] ?? null])),
      };
    case "rate":
      return { type: "score", instructions: q.prompt, criteria: q.levels };
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });

/** Live System One distributions are rounded to hundredths: allow at most 0.005 per entry. */
function wireProbabilities(id: string, keys: readonly string[], value: unknown): number[] {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length
  ) {
    throw new Error(`${id}: malformed probabilities`);
  }
  const record = value as Record<string, unknown>;
  const probabilities = keys.map((key) => {
    const p = Object.hasOwn(record, key) ? record[key] : undefined;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
      throw new Error(`${id}: invalid probability for ${key}`);
    }
    return p;
  });
  const total = probabilities.reduce((sum, p) => sum + p, 0);
  const roundingError = keys.length * (0.005 + Number.EPSILON);
  if (!(total > 0) || Math.abs(total - 1) > roundingError) {
    throw new Error(`${id}: probabilities sum to ${total}`);
  }
  return normalize(probabilities);
}

export class SystemOneOracle implements Oracle {
  readonly id: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly price: number;
  private readonly maxRetries: number;
  private readonly headers: Readonly<Record<string, string>>;

  constructor(opts: SystemOneOptions = {}) {
    const key = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
    if (!key) throw new Error("SystemOneOracle needs an apiKey (or TYPESAFE_API_KEY)");
    this.apiKey = key;
    this.baseUrl = (opts.baseUrl ?? "https://api.typesafe.ai").replace(/\/$/, "");
    this.model = opts.model ?? "jev-1.13.0";
    this.id = opts.id ?? this.model;
    this.fetchImpl = opts.fetch ?? fetch;
    this.price = opts.pricePerMillionInput ?? 0.042;
    this.maxRetries = opts.maxRetries ?? 2;
    this.headers = opts.headers ?? {};
  }

  buildRequest(state: string, questions: readonly Question[]): WireRequest {
    const ids = new Set<string>();
    for (const q of questions) {
      if (ids.has(q.id)) throw new Error(`duplicate question id ${q.id} in one request`);
      ids.add(q.id);
    }
    return {
      state,
      model: this.model,
      questions: Object.fromEntries(questions.map((q) => [q.id, toWire(q)])),
    };
  }

  private async post(body: WireRequest, signal?: AbortSignal): Promise<WireResponse> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
          ...this.headers,
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
      if (res.ok) return (await res.json()) as WireResponse;
      const retryable = res.status === 429 || res.status === 529;
      if (retryable && attempt < this.maxRetries) {
        await sleep(250 * 2 ** attempt, signal);
        continue;
      }
      throw new Error(`${this.id}: HTTP ${res.status} ${await res.text()}`);
    }
  }

  async decide(
    state: string,
    questions: readonly Question[],
    opts: DecideOptions = {},
  ): Promise<Decision[]> {
    if (questions.length === 0) return [];
    const started = performance.now();
    const body = this.buildRequest(state, questions);
    const res = await this.post(body, opts.signal);
    const latencyMs = performance.now() - started;
    const billed =
      typeof res.usage?.cost === "number"
        ? res.usage.cost
        : ((res.usage?.input_tokens ?? 0) * this.price) / 1e6;
    const cost = billed / questions.length;
    const at = nowIso();
    return questions.map((q) => {
      const a = res.answers?.[q.id];
      if (!a) throw new Error(`${this.id}: no answer for ${q.id}`);
      const { verdict, vendor } = this.fromWire(q, a);
      validateVerdict(q, verdict);
      return {
        verdict,
        oracle: this.id,
        ...(res.model ? { model: res.model } : {}),
        latencyMs,
        cost,
        at,
        vendor: { ...(vendor ?? {}), batch: questions.length },
      };
    });
  }

  private fromWire(
    q: Question,
    a: WireAnswer,
  ): { verdict: Verdict; vendor?: Record<string, unknown> } {
    switch (q.kind) {
      case "judge": {
        if (a.type !== "noul") throw new Error(`${q.id}: expected noul, got ${a.type}`);
        if (!Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1) {
          throw new Error(`${q.id}: invalid noul probability`);
        }
        return { verdict: judgeVerdictFrom(q, a.noul) };
      }
      case "pick": {
        if (a.type !== "choice") throw new Error(`${q.id}: expected choice, got ${a.type}`);
        const probs = wireProbabilities(q.id, q.options, a.probabilities);
        return {
          verdict: pickVerdictFrom(q, probs),
          vendor: { confidence: a.confidence, choice: a.choice },
        };
      }
      case "rate": {
        if (a.type !== "score") throw new Error(`${q.id}: expected score, got ${a.type}`);
        const probs = wireProbabilities(
          q.id,
          q.levels.map((_, i) => String(i)),
          a.probabilities,
        );
        return {
          verdict: rateVerdictFrom(q, probs),
          vendor: { confidence: a.confidence, score: a.score },
        };
      }
    }
  }
}

/**
 * Jev through OpenRouter, which serves the same wire format at /api/v1/systemone under the
 * model ids typesafe/jev-1.13, typesafe/jev-1.14 and ~typesafe/jev-latest, and reports the
 * billed cost on every response. Reads OPENROUTER_API_KEY unless a key is given.
 */
export function jevViaOpenRouter(opts: Omit<SystemOneOptions, "baseUrl"> = {}): SystemOneOracle {
  const key = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("jevViaOpenRouter needs an apiKey (or OPENROUTER_API_KEY)");
  return new SystemOneOracle({
    ...opts,
    apiKey: key,
    baseUrl: "https://openrouter.ai/api",
    model: opts.model ?? "typesafe/jev-1.13",
    id: opts.id ?? "jev@openrouter",
    headers: { "X-Title": "ratchet", ...opts.headers },
  });
}

/** TypeSafe Jev with a pinned version. Reads TYPESAFE_API_KEY unless a key is given. */
export function jev(opts: Omit<SystemOneOptions, "baseUrl"> = {}): SystemOneOracle {
  return new SystemOneOracle({ ...opts, id: opts.id ?? "jev" });
}
