import { describe, expect, it } from "vitest";
import { jev, SystemOneOracle, toWire } from "../src/oracles/systemone.ts";
import { judge, pick, rate } from "../src/questions.ts";

const qs = [
  judge("Does this convey urgency?", {
    id: "is_urgent",
    criteria: { yes: "time-sensitive", no: "no urgency" },
  }),
  pick("Which team should handle this?", ["billing", "technical", "sales"], {
    id: "department",
    criteria: { billing: "Payments, invoicing, refunds", technical: "Bugs, outages" },
  }),
  rate("How frustrated is the customer?", ["Calm", "Frustrated", "Very angry"], {
    id: "frustration",
  }),
] as const;

const canned = {
  model: "jev-1.13.0",
  answers: {
    is_urgent: { type: "noul", noul: 0.95 },
    department: {
      type: "choice",
      choice: "billing",
      probabilities: { technical: 0.12, billing: 0.88, sales: 0.0 },
      confidence: 0.81,
    },
    frustration: {
      type: "score",
      score: 1.05,
      legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
      probabilities: { "2": 0.05, "0": 0.0, "1": 0.95 },
      confidence: 0.92,
    },
  },
  usage: { input_tokens: 1000, output_tokens: 20 },
};

function mockFetch(handler: (n: number, init: RequestInit) => Response) {
  let n = 0;
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(n++, init ?? {});
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

describe("System One wire format", () => {
  it("translates questions to noul / choice / score", () => {
    expect(toWire(qs[0])).toEqual({
      type: "noul",
      instructions: "Does this convey urgency?",
      criteria: { true: "time-sensitive", false: "no urgency" },
    });
    expect(toWire(qs[1])).toEqual({
      type: "choice",
      instructions: "Which team should handle this?",
      criteria: {
        billing: "Payments, invoicing, refunds",
        technical: "Bugs, outages",
        sales: null,
      },
    });
    expect(toWire(qs[2])).toEqual({
      type: "score",
      instructions: "How frustrated is the customer?",
      criteria: ["Calm", "Frustrated", "Very angry"],
    });
  });

  it("posts one batched request and maps every answer back by id", async () => {
    const m = mockFetch(() => new Response(JSON.stringify(canned), { status: 200 }));
    const o = new SystemOneOracle({ apiKey: "k", fetch: m.fetch });
    const ds = await o.decide("Help! My payouts have been failing for 3 days.", qs);
    expect(m.calls.length).toBe(1);
    expect(m.calls[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(String(m.calls[0]?.init.body));
    expect(body.model).toBe("jev-1.13.0");
    expect(Object.keys(body.questions)).toEqual(["is_urgent", "department", "frustration"]);
    const headers = (m.calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer k");

    const [u, d, f] = ds;
    if (!u || !d || !f) throw new Error("expected three decisions");
    expect(u.verdict).toMatchObject({ kind: "judge", pYes: 0.95, confidence: 0.95 });
    expect(d.verdict).toMatchObject({ kind: "pick", choice: "billing", confidence: 0.88 });
    expect(d.vendor).toMatchObject({ confidence: 0.81 });
    if (f.verdict.kind !== "rate") throw new Error("expected a rate verdict");
    expect(f.verdict.level).toBe("Frustrated");
    expect(f.verdict.score).toBeCloseTo(1.05, 6);
    expect(f.verdict.probabilities).toEqual([0, 0.95, 0.05]);
    for (const x of ds) {
      expect(x.model).toBe("jev-1.13.0");
      expect(x.cost).toBeCloseTo((1000 * 0.042) / 1e6 / 3, 12);
    }
  });

  it("retries 429 and 529 with backoff, then gives up", async () => {
    const m = mockFetch((n) =>
      n < 2
        ? new Response("slow down", { status: 429 })
        : new Response(JSON.stringify(canned), { status: 200 }),
    );
    const o = new SystemOneOracle({ apiKey: "k", fetch: m.fetch, maxRetries: 2 });
    const ds = await o.decide("x", [qs[0]]);
    expect(ds.length).toBe(1);
    expect(m.calls.length).toBe(3);

    const dead = mockFetch(() => new Response("overloaded", { status: 529 }));
    const o2 = new SystemOneOracle({ apiKey: "k", fetch: dead.fetch, maxRetries: 1 });
    await expect(o2.decide("x", [qs[0]])).rejects.toThrow(/529/);
    expect(dead.calls.length).toBe(2);
  });

  it("throws on missing or mistyped answers so failOpen can neutralise them", async () => {
    const m = mockFetch(
      () =>
        new Response(
          JSON.stringify({ model: "jev-1.13.0", answers: { is_urgent: { type: "choice" } } }),
          { status: 200 },
        ),
    );
    const o = new SystemOneOracle({ apiKey: "k", fetch: m.fetch });
    await expect(o.decide("x", [qs[0]])).rejects.toThrow(/expected noul/);
    await expect(o.decide("x", [qs[1]])).rejects.toThrow(/no answer/);
  });

  it("rejects duplicate ids in one request and requires a key", () => {
    const o = new SystemOneOracle({ apiKey: "k" });
    expect(() => o.buildRequest("x", [qs[0], qs[0]])).toThrow(/duplicate/);
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      expect(() => jev()).toThrow(/apiKey/);
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    }
    expect(jev({ apiKey: "k" }).id).toBe("jev");
    expect(new SystemOneOracle({ apiKey: "k", baseUrl: "http://localhost:8080/" }).model).toBe(
      "jev-1.13.0",
    );
  });
});
