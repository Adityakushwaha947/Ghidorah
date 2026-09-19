import { CONTRACT_VERSION, EventSchema, type Event, type RunConfig } from "@ghidorah/contracts";

export class ClientError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(code);
  }
}

export class GhidorahClient {
  private readonly origin: string;
  constructor(
    endpoint: string,
    private readonly token: () => string,
    private readonly transport: typeof fetch = fetch,
  ) {
    const url = new URL(endpoint);
    if (
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new ClientError("invalid_endpoint");
    this.origin = url.origin;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.transport(`${this.origin}${path}`, {
        ...init,
        redirect: "error",
        credentials: "omit",
        headers: { "content-type": "application/json", ...init.headers, authorization: `Bearer ${this.token()}` },
      });
    } catch {
      throw new ClientError(init.signal?.aborted ? "request_cancelled" : "transport_unavailable");
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new ClientError("request_rejected", response.status);
    }
    return response;
  }

  private async json(response: Response): Promise<unknown> {
    if (!response.body || response.headers.get("content-type")?.split(";")[0] !== "application/json") {
      void response.body?.cancel().catch(() => undefined);
      throw new ClientError("invalid_response");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0;
    let text = "";
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 1_048_576) throw new ClientError("response_too_large");
        text += decoder.decode(next.value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } catch (error) {
      throw error instanceof ClientError ? error : new ClientError("invalid_response");
    } finally {
      void reader.cancel().catch(() => undefined);
    }
  }

  async start(target: string, config: RunConfig, idempotencyKey: string): Promise<{ runId: string; created: boolean }> {
    const response = await this.request("/v1/runs", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ target, config }),
    });
    const result = await this.json(response);
    if (
      !result ||
      typeof result !== "object" ||
      !("runId" in result) ||
      typeof result.runId !== "string" ||
      !("created" in result) ||
      typeof result.created !== "boolean"
    )
      throw new ClientError("invalid_response");
    return { runId: result.runId, created: result.created };
  }

  async snapshot(runId: string): Promise<Event> {
    const parsed = EventSchema.safeParse(await this.json(await this.request(`/v1/runs/${encodeURIComponent(runId)}`)));
    if (!parsed.success) throw new ClientError("invalid_snapshot");
    const event = parsed.data;
    if (event.runId !== runId || event.type !== "run.snapshot") throw new ClientError("invalid_snapshot");
    return event;
  }

  async stop(runId: string): Promise<void> {
    const response = await this.request(`/v1/runs/${encodeURIComponent(runId)}/control`, {
      method: "POST",
      body: JSON.stringify({ contractVersion: CONTRACT_VERSION, type: "stop" }),
    });
    await response.body?.cancel();
  }

  async *events(runId: string, signal?: AbortSignal): AsyncGenerator<Event> {
    const response = await this.request(`/v1/runs/${encodeURIComponent(runId)}/events`, { signal });
    if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
      void response.body?.cancel().catch(() => undefined);
      throw new ClientError("invalid_stream");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    let seq: number | undefined;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) throw new ClientError("stream_interrupted");
        pending += decoder.decode(next.value, { stream: true });
        if (pending.length > 1_048_576) throw new ClientError("stream_too_large");
        let boundary = pending.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const kind = frame
            .split("\n")
            .find((line) => line.startsWith("event:"))
            ?.slice(6)
            .trim();
          if (kind === "transport.error") throw new ClientError("stream_unavailable");
          if (kind === "record") {
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            const parsed = EventSchema.safeParse(JSON.parse(data));
            if (!parsed.success || parsed.data.runId !== runId) throw new ClientError("invalid_event");
            const event = parsed.data;
            if (event.type !== "run.snapshot") {
              if (seq === undefined) throw new ClientError("missing_snapshot");
              if (event.seq <= seq) {
                boundary = pending.indexOf("\n\n");
                continue;
              }
              if (event.seq !== seq + 1) throw new ClientError("event_gap");
            }
            seq = event.seq;
            yield event;
            if (event.type === "run.finished" || (event.type === "run.snapshot" && event.terminal)) return;
          }
          boundary = pending.indexOf("\n\n");
        }
      }
    } catch (error) {
      throw error instanceof ClientError
        ? error
        : new ClientError(signal?.aborted ? "request_cancelled" : "invalid_stream");
    } finally {
      void reader.cancel().catch(() => undefined);
    }
  }
}
