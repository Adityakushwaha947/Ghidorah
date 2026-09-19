import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { PoolConfig } from "pg";
import { RunConfigSchema } from "@ghidorah/contracts";
import { CONTRACT_VERSION, digest, GidorahError, type RunHandle } from "@ghidorah/foundation";
import { GidorahBackend } from "../backend.js";
import { PostgresJournal } from "../storage/journal.js";
import { validateCounterRun, type CounterModelProfile } from "../runtime/model-profile.js";
import { ApiError, ApiPrincipalSchema, authorityFor, type Authenticator, type ApiPrincipal } from "./auth.js";

const startSchema = z.strictObject({ target: z.string(), config: RunConfigSchema });
const stopSchema = z.strictObject({ contractVersion: z.literal(CONTRACT_VERSION), type: z.literal("stop") });
const context = { contractVersion: CONTRACT_VERSION };
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
type Managed = { backend: GidorahBackend; handle: RunHandle; task: Promise<void> };

function requestRunId(principal: ApiPrincipal, requestId: string): string {
  const hash = digest({
    namespace: "ghidorah-api-run-v1",
    tenant: principal.tenantId,
    actor: principal.actorId,
    engagement: principal.engagementId,
    requestId,
  });
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function body(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json" || !request.body)
    throw new ApiError(415, "json_required");
  const reader = request.body.getReader();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)]);
  let bytes = 0;
  let text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const next = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        const abort = () => reject(new ApiError(408, "request_timeout"));
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        reader
          .read()
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
      });
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 65536) throw new ApiError(413, "request_too_large");
      text += decoder.decode(next.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

export class FixtureApi {
  private readonly active = new Map<string, Managed>();
  private readonly starting = new Map<string, { fingerprint: string; promise: Promise<Response> }>();
  private closed = false;
  private readonly observers = new Set<() => Promise<void>>();

  constructor(
    private readonly connection: PoolConfig,
    private readonly authenticate: Authenticator,
    private readonly options: { modelProfile?: CounterModelProfile; maxActiveRuns?: number; pollMs?: number } = {},
  ) {
    z.number()
      .int()
      .positive()
      .max(100)
      .parse(options.maxActiveRuns ?? 4);
    z.number()
      .int()
      .positive()
      .max(60000)
      .parse(options.pollMs ?? 100);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      if (this.closed) throw new ApiError(503, "service_unavailable");
      if (request.headers.has("origin")) throw new ApiError(403, "browser_origin_not_enabled");
      const principal = ApiPrincipalSchema.parse(await this.authenticate(request));
      if (principal.expiresAt <= Date.now()) throw new ApiError(401, "unauthorized");
      const url = new URL(request.url);
      const permission =
        request.method === "GET" ? "run:read" : url.pathname.endsWith("/control") ? "run:control" : "run:create";
      if (!principal.permissions.includes(permission)) throw new ApiError(403, "forbidden");
      if (url.pathname === "/v1/runs" && request.method === "POST") return await this.start(request, principal);
      const match = /^\/v1\/runs\/([0-9a-f-]{36})(?:\/(events|artifacts|control))?$/.exec(url.pathname);
      if (!match) throw new ApiError(404, "not_found");
      const runId = z.uuid().parse(match[1]);
      const journal = new PostgresJournal(this.connection, this.options.modelProfile, authorityFor(principal));
      let streaming = false;
      try {
        await journal.read(runId);
        if (request.method === "GET" && match[2] === "events") {
          if (this.observers.size >= 16) throw new ApiError(429, "observer_capacity_exceeded");
          streaming = true;
          return this.events(request, journal, runId, principal);
        }
        if (request.method === "GET" && match[2] === "artifacts")
          return Response.json(
            await journal.artifact(
              runId,
              z
                .string()
                .regex(/^sha256:[a-f0-9]{64}$/)
                .parse(url.searchParams.get("ref")),
            ),
            { headers },
          );
        if (request.method === "GET" && !match[2]) return Response.json(await journal.snapshot(runId), { headers });
        if (request.method === "POST" && match[2] === "control") {
          stopSchema.parse(await body(request));
          await journal.requestStop(runId);
          this.active.get(runId)?.handle.control({ ...context, type: "stop" });
          return Response.json({ accepted: true, runId }, { status: 202, headers });
        }
        throw new ApiError(404, "not_found");
      } finally {
        if (!streaming) await journal.close();
      }
    } catch (error) {
      const status =
        error instanceof ApiError
          ? error.status
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? 400
            : error instanceof GidorahError && error.code === "run_not_found"
              ? 404
              : 503;
      return Response.json(
        {
          error:
            status >= 500
              ? "service_unavailable"
              : error instanceof ApiError
                ? error.code
                : status === 404
                  ? "not_found"
                  : "invalid_request",
        },
        { status, headers },
      );
    }
  }

  private async start(request: Request, principal: ApiPrincipal): Promise<Response> {
    const requestId = z.uuid().parse(request.headers.get("idempotency-key"));
    const input = startSchema.parse(await body(request));
    const config = validateCounterRun(input.target, input.config, this.options.modelProfile);
    if (this.closed) throw new ApiError(503, "service_unavailable");
    const runId = requestRunId(principal, requestId);
    const fingerprint = digest({ target: input.target, config, authority: authorityFor(principal) });
    const pending = this.starting.get(runId);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new ApiError(409, "idempotency_conflict");
      return (await pending.promise).clone();
    }
    if (this.starting.size + this.active.size >= (this.options.maxActiveRuns ?? 4))
      throw new ApiError(429, "capacity_exceeded");
    const launch = async (): Promise<Response> => {
      const backend = new GidorahBackend(this.connection, {
        modelProfile: this.options.modelProfile,
        authority: authorityFor(principal),
      });
      let managed = false;
      try {
        const existing = await backend.journal.read(runId).catch((error: unknown) => {
          if (error instanceof GidorahError && error.code === "run_not_found") return undefined;
          throw error;
        });
        if (existing) {
          if (
            digest({ target: existing.target, config: existing.config, authority: authorityFor(principal) }) !==
            fingerprint
          )
            throw new ApiError(409, "idempotency_conflict");
          return Response.json({ runId, created: false }, { headers });
        }
        const handle = backend.run(input.target, config, runId);
        const iterator = handle.events[Symbol.asyncIterator]();
        const first = await iterator.next();
        if (first.done || first.value.type !== "run.started") throw new ApiError(503, "start_unavailable");
        const entry: Managed = { backend, handle, task: Promise.resolve() };
        this.active.set(runId, entry);
        managed = true;
        entry.task = (async () => {
          try {
            while (!(await iterator.next()).done) {}
          } catch {
            process.stderr.write(
              `${JSON.stringify({ component: "fixture-api", runId, code: "run_requires_inspection" })}\n`,
            );
          } finally {
            this.active.delete(runId);
            await backend.close();
          }
        })();
        return Response.json({ runId, created: true }, { status: 202, headers });
      } finally {
        if (!managed) await backend.close();
      }
    };
    const promise = launch();
    this.starting.set(runId, { fingerprint, promise });
    try {
      return (await promise).clone();
    } finally {
      this.starting.delete(runId);
    }
  }

  private events(request: Request, journal: PostgresJournal, runId: string, admitted: ApiPrincipal): Response {
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const encoder = new TextEncoder();
    let ending: Promise<void> | undefined;
    const release = () => {
      this.observers.delete(stopObserver);
      return (ending ??= journal.close());
    };
    const authenticate = this.authenticate;
    const pollMs = this.options.pollMs ?? 100;
    const iterator = (async function* () {
      try {
        const checkAccess = async () => {
          const principal = ApiPrincipalSchema.parse(await authenticate(request));
          if (
            principal.expiresAt <= Date.now() ||
            !principal.permissions.includes("run:read") ||
            digest(authorityFor(principal)) !== digest(authorityFor(admitted))
          )
            throw new ApiError(401, "unauthorized");
        };
        await checkAccess();
        const snapshot = await journal.snapshot(runId);
        yield encoder.encode(`event: record\nid: ${snapshot.seq}\ndata: ${JSON.stringify(snapshot)}\n\n`);
        if (snapshot.type === "run.snapshot" && snapshot.terminal) return;
        let seq = snapshot.seq;
        while (!signal.aborted) {
          await checkAccess();
          for (const event of await journal.eventsAfter(runId, seq)) {
            if (signal.aborted) return;
            yield encoder.encode(`event: record\nid: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
            seq = event.seq;
            if (event.type === "run.finished") return;
          }
          await sleep(pollMs, undefined, { signal });
        }
      } catch {
        if (!signal.aborted) yield encoder.encode('event: transport.error\ndata: {"error":"stream_unavailable"}\n\n');
      } finally {
        await release();
      }
    })();
    const stopObserver = async () => {
      controller.abort();
      await iterator.return(undefined);
      await release();
    };
    this.observers.add(stopObserver);
    const stream = new ReadableStream<Uint8Array>({
      pull: async (output) => {
        const next = await iterator.next();
        if (next.done) output.close();
        else output.enqueue(next.value);
      },
      cancel: stopObserver,
    });
    return new Response(stream, { headers: { ...headers, "content-type": "text/event-stream" } });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.observers].map((stop) => stop()));
    await Promise.allSettled([...this.starting.values()].map((entry) => entry.promise));
    const active = [...this.active.values()];
    for (const entry of active) entry.handle.control({ ...context, type: "stop" });
    await Promise.allSettled(active.map((entry) => entry.task));
  }
}
