import { readFile } from "node:fs/promises";
import { play as bridge } from "./bridge.ts";
import { play as orchard } from "./orchard.ts";
import { play as parcels } from "./parcels.ts";
import { play as treasure } from "./treasure.ts";

const games: Record<string, (input: unknown) => Promise<unknown>> = {
  orchard,
  bridge,
  parcels,
  treasure,
};
const files: Record<string, string> = {
  "/": "index.html",
  "/orchard": "orchard.html",
  "/bridge": "bridge.html",
  "/parcels": "parcels.html",
  "/treasure": "treasure.html",
  "/common.css": "common.css",
  "/common.js": "common.js",
};
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};
const json = (data: unknown, status = 200) => Response.json(data, { status, headers });

async function body(req: Request): Promise<unknown> {
  if (!req.headers.get("content-type")?.startsWith("application/json")) {
    throw new Error("Send application/json.");
  }
  const reader = req.body?.getReader();
  if (!reader) throw new Error("A JSON body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 32_768) {
      await reader.cancel();
      throw new Error("Request too large (32 KiB maximum).");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** A loopback-only teaching server; explicit routes keep workspace files private. */
export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
    return json({ error: "Use the local arcade address." }, 403);
  }
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== url.origin) {
    return json({ error: "Cross-origin requests are not accepted." }, 403);
  }
  if (url.pathname.startsWith("/api/")) {
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    const play = games[url.pathname.slice(5)];
    if (!Object.hasOwn(games, url.pathname.slice(5)) || !play) {
      return json({ error: "Unknown game." }, 404);
    }
    try {
      return json(await play(await body(req)));
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "The round could not run." },
        400,
      );
    }
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return json({ error: "Use GET." }, 405);
  }
  const file = files[url.pathname];
  if (!Object.hasOwn(files, url.pathname) || !file) return json({ error: "Not found." }, 404);
  const type = file.endsWith(".css")
    ? "text/css"
    : file.endsWith(".js")
      ? "text/javascript"
      : "text/html";
  const content = await readFile(new URL(file, import.meta.url));
  return new Response(req.method === "HEAD" ? null : content, {
    headers: { ...headers, "Content-Type": `${type}; charset=utf-8` },
  });
}

if (import.meta.main) {
  const port = Number(process.env.ARCADE_PORT ?? "3210");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("ARCADE_PORT must be an integer from 1024 to 65535.");
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: handleRequest });
  console.log(`Ratchet Arcade: ${server.url}`);
  console.log("Four offline games. No keys, model calls, or external actions. Ctrl+C to stop.");
}
