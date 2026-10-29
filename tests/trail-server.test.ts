import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleRequest, trailOfText } from "../examples/trail/server.ts";
import { Engine } from "../src/engine.ts";
import { JsonlLedger } from "../src/ledger/ledger.ts";
import { SimOracle } from "../src/oracles/sim.ts";
import { judge } from "../src/questions.ts";

const local = "http://127.0.0.1:3211";
const safe = judge("Is this command safe to run without asking?", { id: "safe" });

let dir = "";
let path = "";
let text = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ratchet-trail-server-"));
  path = join(dir, "ledger.jsonl");
  const engine = new Engine({
    oracle: new SimOracle({ accuracy: 0.9, seed: 5 }, () => ({ judge: true })),
    ledger: new JsonlLedger(path),
  });
  const gate = engine.gate({
    id: "bash.safe",
    question: safe,
    policy: { actAbove: 0.9 },
    strategy: { ensemble: { k: 3 } },
  });
  for (let i = 0; i < 5; i++) await gate.ask(`ls ${i}`);
  text = await readFile(path, "utf8");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("trail viewer server", () => {
  it("serves the page and its two files under a strict CSP, and nothing else", async () => {
    const page = await handleRequest(new Request(`${local}/`));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await page.text()).toContain('src="/trail.js"');
    for (const file of ["/trail.css", "/trail.js"]) {
      expect((await handleRequest(new Request(`${local}${file}`))).status).toBe(200);
    }
    for (const bad of ["/.env", "/server.ts", "/../arcade/common.js", "/__proto__"]) {
      expect((await handleRequest(new Request(`${local}${bad}`))).status).toBe(404);
    }
    expect((await handleRequest(new Request("http://example.com:3211/"))).status).toBe(403);
    const foreign = new Request(`${local}/api/trail`, {
      method: "POST",
      headers: { Origin: "https://example.com" },
      body: text,
    });
    expect((await handleRequest(foreign)).status).toBe(403);
  });

  it("builds the trail of the ledger on the command line and answers 304 while it is unchanged", async () => {
    const first = await handleRequest(new Request(`${local}/api/trail`), path);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"\d+-\d+"$/);
    const trail = (await first.json()) as { total: number; entries: { members: unknown[] }[] };
    expect(trail.total).toBe(5);
    expect(trail.entries[0]?.members).toHaveLength(3);
    const again = await handleRequest(
      new Request(`${local}/api/trail`, { headers: { "If-None-Match": etag as string } }),
      path,
    );
    expect(again.status).toBe(304);
    await writeFile(path, text.replace(/"soft":"act"/g, '"soft":"review"'));
    const changed = await handleRequest(
      new Request(`${local}/api/trail`, { headers: { "If-None-Match": etag as string } }),
      path,
    );
    expect(changed.status).toBe(200);
    await writeFile(path, text);
  });

  it("without a path, GET says so and a posted ledger is rendered the same way", async () => {
    const none = await handleRequest(new Request(`${local}/api/trail`));
    expect(none.status).toBe(404);
    expect(await none.json()).toMatchObject({ error: expect.stringContaining("drop") });
    const posted = await handleRequest(
      new Request(`${local}/api/trail?name=dropped.jsonl`, { method: "POST", body: text }),
    );
    expect(posted.status).toBe(200);
    const trail = (await posted.json()) as { ledger: string; total: number };
    expect(trail).toMatchObject({ ledger: "dropped.jsonl", total: 5 });
    expect(trailOfText("x", text).entries.map((e) => e.id)).toEqual(
      trailOfText("x", text).entries.map((e) => e.id),
    );
    const junk = await handleRequest(
      new Request(`${local}/api/trail`, { method: "POST", body: "{not json" }),
    );
    expect(junk.status).toBe(400);
    expect((await handleRequest(new Request(`${local}/api/trail`, { method: "PUT" }))).status).toBe(
      405,
    );
  });
});
