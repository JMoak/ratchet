import { readFile, stat } from "node:fs/promises";
import { readRows } from "../../src/cli/common.ts";
import { selectTrail, type Trail } from "../../src/cli/trail.ts";
import { parseJsonlLedger } from "../../src/ledger/ledger.ts";

/**
 * A loopback-only server for the decision trail viewer. It serves three static files and one
 * resource: the trail of a ledger, either the file named on the command line (GET, with an
 * ETag from the file's size and mtime so the page can poll cheaply) or a JSONL body the page
 * posts after someone drops a file on it. It never calls an oracle and never writes.
 */

const files: Record<string, string> = {
  "/": "index.html",
  "/trail.css": "trail.css",
  "/trail.js": "trail.js",
};
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};
const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { ...headers, ...extra } });

/** 64 MiB: a year of a busy gate, with room; anything bigger belongs on the command line. */
const MAX_BODY = 64 * 1024 * 1024;

async function text(req: Request): Promise<string> {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("A JSON Lines body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw new Error("Ledger too large to post (64 MiB maximum); start the server with its path.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function trailOfText(name: string, body: string): Trail {
  return selectTrail(name, readRows(parseJsonlLedger(body)), {});
}

export async function handleRequest(req: Request, ledgerPath?: string): Promise<Response> {
  const url = new URL(req.url);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
    return json({ error: "Use the local trail address." }, 403);
  }
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== url.origin) {
    return json({ error: "Cross-origin requests are not accepted." }, 403);
  }
  if (url.pathname === "/api/trail") {
    if (req.method === "POST") {
      try {
        const name = url.searchParams.get("name")?.slice(0, 120) || "dropped ledger";
        return json(trailOfText(name, await text(req)));
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : "The ledger could not be read." },
          400,
        );
      }
    }
    if (req.method !== "GET") return json({ error: "Use GET or POST." }, 405);
    if (ledgerPath === undefined) {
      return json({ error: "No ledger on the command line; drop one on the page." }, 404);
    }
    try {
      const s = await stat(ledgerPath);
      const etag = `"${s.size}-${Math.round(s.mtimeMs)}"`;
      if (req.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers: { ...headers, ETag: etag } });
      }
      const body = await readFile(ledgerPath, "utf8");
      return json(trailOfText(ledgerPath, body), 200, { ETag: etag });
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "The ledger could not be read." },
        404,
      );
    }
  }
  if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Use GET." }, 405);
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
  const port = Number(process.env.TRAIL_PORT ?? "3211");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("TRAIL_PORT must be an integer from 1024 to 65535.");
  }
  const ledgerPath = process.argv[2];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (req) => handleRequest(req, ledgerPath),
  });
  console.log(`Ratchet trail: ${server.url}`);
  console.log(
    ledgerPath === undefined
      ? "No ledger given; drop a .jsonl on the page, or pass a path: bun run trail <ledger.jsonl>"
      : `Reading ${ledgerPath}; the page refreshes as the file grows.`,
  );
  console.log("Read-only. Ctrl+C to stop.");
}
