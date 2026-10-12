import http from "node:http";
import https from "node:https";

export class JsonHttpTransportError extends Error {
  public constructor(
    message: string,
    public readonly kind: "network" | "status" | "invalid-json" | "limit" | "cancelled",
    public readonly statusCode?: number,
    options?: { readonly cause?: unknown },
    /** Raw response body, when one was read (`kind === "status"` only). Lets a caller tell a billing-exhausted error apart from a transient one without a second request. */
    public readonly body?: string,
  ) {
    super(message, options);
    this.name = "JsonHttpTransportError";
  }
}

export interface JsonHttpTransportOptions {
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

export interface JsonHttpPostOptions {
  readonly signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export class BoundedJsonHttpTransport {
  private readonly timeoutMs: number;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;

  public constructor(options: JsonHttpTransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_BYTES;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
    for (const [name, value] of Object.entries({ timeoutMs: this.timeoutMs, maxRequestBytes: this.maxRequestBytes, maxResponseBytes: this.maxResponseBytes })) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
    }
  }

  public async post(url: URL, value: unknown, options: JsonHttpPostOptions = {}): Promise<unknown> {
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !isLoopback(url.hostname)) {
      throw new JsonHttpTransportError("Local model endpoints must use HTTP(S) on a loopback host", "network");
    }
    if (url.username !== "" || url.password !== "") {
      throw new JsonHttpTransportError("Endpoint URLs must not contain credentials", "network");
    }
    let body: Buffer;
    try { body = Buffer.from(JSON.stringify(value), "utf8"); }
    catch (cause) { throw new JsonHttpTransportError("Request is not JSON serializable", "invalid-json", undefined, { cause }); }
    if (body.byteLength > this.maxRequestBytes) throw new JsonHttpTransportError("Request body exceeds configured limit", "limit");
    if (options.signal?.aborted === true) throw new JsonHttpTransportError("Request cancelled", "cancelled");

    return await new Promise<unknown>((resolve, reject) => {
      const client = url.protocol === "https:" ? https : http;
      let settled = false;
      const finish = (error?: unknown, result?: unknown): void => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        error === undefined ? resolve(result) : reject(error);
      };
      const request = client.request(url, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(body.byteLength) },
      }, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > this.maxResponseBytes) {
            response.destroy();
            request.destroy();
            finish(new JsonHttpTransportError("Response body exceeds configured limit", "limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            const text = Buffer.concat(chunks).toString("utf8");
            finish(new JsonHttpTransportError(`Model endpoint returned HTTP ${status}`, "status", status, undefined, text));
            return;
          }
          try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown); }
          catch (cause) { finish(new JsonHttpTransportError("Model endpoint returned invalid JSON", "invalid-json", undefined, { cause })); }
        });
      });
      const abort = (): void => {
        request.destroy();
        finish(new JsonHttpTransportError("Request cancelled", "cancelled"));
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      request.setTimeout(this.timeoutMs, () => {
        request.destroy();
        finish(new JsonHttpTransportError("Model endpoint timed out", "network"));
      });
      request.on("error", (cause) => finish(new JsonHttpTransportError("Model endpoint request failed", "network", undefined, { cause })));
      request.end(body);
    });
  }
}
