import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { z } from "zod";
import { databaseConfig } from "../config.js";
import { initializeDatabase } from "../storage/bootstrap.js";
import { ApiPrincipalSchema, tokenAuthenticator } from "./auth.js";
import { FixtureApi } from "./service.js";

const tokens = z
  .array(z.strictObject({ tokenSha256: z.string(), principal: ApiPrincipalSchema }))
  .min(1)
  .parse(JSON.parse(process.env.GIDORAH_API_TOKENS_JSON ?? "null"));
const port = z.coerce
  .number()
  .int()
  .min(1024)
  .max(65535)
  .parse(process.env.GIDORAH_API_PORT ?? "4317");
const connection = databaseConfig();
await initializeDatabase(connection);
const api = new FixtureApi(connection, tokenAuthenticator(tokens));
const server = createServer({ headersTimeout: 10000, requestTimeout: 15000 }, async (incoming, outgoing) => {
  const controller = new AbortController();
  incoming.once("aborted", () => controller.abort());
  outgoing.once("close", () => {
    if (!outgoing.writableEnded) controller.abort();
  });
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers))
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
    const init: RequestInit & { duplex?: "half" } = { method: incoming.method, headers, signal: controller.signal };
    if (incoming.method !== "GET" && incoming.method !== "HEAD") {
      init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      init.duplex = "half";
    }
    const response = await api.fetch(new Request(`http://127.0.0.1:${port}${incoming.url ?? "/"}`, init));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), outgoing);
    else outgoing.end();
  } catch {
    if (!outgoing.headersSent)
      outgoing.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    if (!outgoing.destroyed) outgoing.end('{"error":"service_unavailable"}');
  }
});
server.maxConnections = 32;
server.listen(port, "127.0.0.1", () =>
  process.stderr.write(`Authenticated counter-fixture API on 127.0.0.1:${port}; no customer execution enabled.\n`),
);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  server.close();
  await api.close();
  server.closeAllConnections();
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
