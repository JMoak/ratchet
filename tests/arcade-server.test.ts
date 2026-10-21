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
  it("serves all four applets and runs each default game in shadow", async () => {
    for (const game of ["orchard", "bridge", "parcels", "treasure"]) {
      const page = await handleRequest(new Request(`${local}/${game}`));
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain('href="/common.css"');
      const result = await handleRequest(post(`/api/${game}`, {}));
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({ mode: "shadow" });
    }
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
  });
});
