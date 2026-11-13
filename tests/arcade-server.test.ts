import { describe, expect, it } from "vitest";
import { handleRequest } from "../examples/arcade/server.ts";

const local = "http://127.0.0.1:3210";
const post = (path: string, value: unknown, extra: Record<string, string> = {}) =>
  new Request(`${local}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extra },
    body: JSON.stringify(value),
  });

describe("local arcade", () => {
  it("serves all four games and answers each with its duel already run", async () => {
    for (const game of ["orchard", "bridge", "parcels", "treasure"]) {
      const page = await handleRequest(new Request(`${local}/${game}`));
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      const html = await page.text();
      expect(html).toContain('href="/common.css"');
      expect(html).toContain(`mount({ game: "${game}" })`);
      const result = await handleRequest(post(`/api/${game}`, { worlds: 10 }));
      expect(result.status).toBe(200);
      const body = (await result.json()) as {
        world: { arms: { id: string; cells: unknown[] }[] };
        batch: { worlds: number; headline: string; rows: unknown[] };
        target: { checks: unknown[] };
        ledger: { decisions: unknown[] };
      };
      expect(body).toMatchObject({
        game,
        judgeSource: "seeded simulation",
        backend: { kind: "offline" },
      });
      expect(body.world.arms.map((arm) => arm.id)).toEqual(["baseline", "engine"]);
      expect(body.world.arms.every((arm) => arm.cells.length > 0)).toBe(true);
      expect(body.batch.worlds).toBe(10);
      expect(body.batch.headline).toContain("→");
      expect(body.batch.rows.length).toBeGreaterThan(2);
      expect(body.target.checks.length).toBeGreaterThan(1);
      expect(body.ledger.decisions.length).toBeGreaterThan(0);
    }
    const script = await handleRequest(new Request(`${local}/duel.js`));
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect((await handleRequest(new Request(`${local}/common.js`))).status).toBe(404);
  });

  it("answers a repeated seeded request from memory, and never a rejected one", async () => {
    const ask = async (value: unknown) => {
      const response = await handleRequest(post("/api/parcels", value));
      return (await response.json()) as { ledger?: { rows: { id: string }[] }; error?: string };
    };
    const first = await ask({ seed: 7, worlds: 10 });
    const again = await ask({ seed: 7, worlds: 10 });
    // Row ids are random per run, so equal ids mean the world was not run twice.
    expect(again.ledger?.rows.map((r) => r.id)).toEqual(first.ledger?.rows.map((r) => r.id));
    const other = await ask({ seed: 8, worlds: 10 });
    expect(other.ledger?.rows[0]?.id).not.toBe(first.ledger?.rows[0]?.id);
    expect((await ask({ seed: 7, worlds: 10, bar: 2 })).error).toContain("bar must be");
    expect((await ask({ seed: 7, worlds: 10, bar: 2 })).error).toContain("bar must be");
  });

  it("only exposes the explicit static routes", async () => {
    for (const path of ["/.env", "/src/engine.ts", "/__proto__", "/api/constructor"]) {
      const req = path.startsWith("/api/") ? post(path, {}) : new Request(`${local}${path}`);
      expect((await handleRequest(req)).status).toBe(404);
    }
    const head = await handleRequest(new Request(local, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("rejects cross-origin and nonlocal requests", async () => {
    expect(
      (await handleRequest(post("/api/bridge", {}, { Origin: "https://example.com" }))).status,
    ).toBe(403);
    expect((await handleRequest(new Request("http://example.com:3210/bridge"))).status).toBe(403);
    expect((await handleRequest(post("/api/bridge", {}, { Origin: local }))).status).toBe(200);
  });

  it("bounds request work and returns recoverable JSON errors", async () => {
    for (const value of [null, { attempts: ["not-a-piece"] }, { note: "x".repeat(33_000) }]) {
      const response = await handleRequest(post("/api/bridge", value));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.any(String) });
    }
    expect((await handleRequest(new Request(`${local}/api/bridge`))).status).toBe(405);
    const malformed = new Request(`${local}/api/bridge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect((await handleRequest(malformed)).status).toBe(400);
  });

  it("never enables paid calls from a browser request alone", async () => {
    const capabilities = await handleRequest(new Request(`${local}/api/capabilities`));
    expect(await capabilities.json()).toMatchObject({ liveAvailable: false });
    const live = await handleRequest(post("/api/bridge", { model: "live" }));
    expect(live.status).toBe(400);
    expect(await live.json()).toMatchObject({ error: expect.stringContaining("disabled") });
    expect((await handleRequest(post("/api/bridge", { model: "unknown" }))).status).toBe(400);
    const expedition = await handleRequest(post("/api/treasure", { model: "live" }));
    expect(expedition.status).toBe(400);
    expect(await expedition.json()).toMatchObject({ error: expect.stringContaining("seeded") });
  });
});
