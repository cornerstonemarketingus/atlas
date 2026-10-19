import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GovernedModelProvider } from "../src/infrastructure/governed-model-provider.js";
import { createHttpGovernor, quotaScopeFor } from "../src/infrastructure/inference-governor-client.js";
import { ModelProviderError, type ModelProvider, type ModelProviderMetadata, type ModelRequest, type ModelResponse } from "../src/model/model-provider.js";

/**
 * The CLI's HTTP governor against the Worker's real gateway and real ledger
 * (apps/web), over a real HTTP socket: this is the contract between the two
 * packages. Skipped only when the web app's sources are not in the checkout.
 */
const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "..", "..", "..", "apps", "web");
const gatewayFile = join(web, "app", "api", "inference", "governor-gateway.mjs");
const coreFile = join(web, "worker", "inference-governor-core.mjs");
const skip = existsSync(gatewayFile) && existsSync(coreFile) ? false : "apps/web sources are not available";

const TOKEN = "gov-0123456789abcdef0123456789abcdef";
const metadata: ModelProviderMetadata = { id: "groq", displayName: "Groq", models: [{ model: "m1", contextWindowTokens: 8000, maxOutputTokens: 1000, supportsTools: false, supportsJson: false, supportsStreaming: false }] };
const ok: ModelResponse = { id: "r", providerId: "groq", model: "m1", message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
const request: ModelRequest = { model: "m1", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], maxOutputTokens: 100 };

class Scripted implements ModelProvider {
  public readonly metadata = metadata;
  public calls = 0;
  public constructor(private readonly outcome: ModelResponse | Error) {}
  public async complete(): Promise<ModelResponse> { this.calls += 1; if (this.outcome instanceof Error) throw this.outcome; return this.outcome; }
}

async function liveGateway() {
  const { createGovernorCore } = await import(pathToFileURL(coreFile).href) as { createGovernorCore: (options: unknown) => Record<string, (argument: unknown) => Promise<unknown>> };
  const { handleGovernorGateway } = await import(pathToFileURL(gatewayFile).href) as { handleGovernorGateway: (request: Request, options: unknown) => Promise<Response> };
  const cores = new Map<string, Record<string, (argument: unknown) => Promise<unknown>>>();
  const storage = () => { const map = new Map<string, unknown>(); return { get: async (key: string) => map.get(key), put: async (key: string, value: unknown) => { map.set(key, structuredClone(value)); }, setAlarm: async () => {} }; };
  const call = async (scope: string, method: string, argument: unknown) => {
    if (!cores.has(scope)) cores.set(scope, createGovernorCore({ storage: storage() }));
    return cores.get(scope)![method]!(argument);
  };
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const request = new Request(`http://127.0.0.1${incoming.url ?? "/"}`, { method: incoming.method ?? "GET", headers: incoming.headers as Record<string, string>, ...(incoming.method === "POST" ? { body: Buffer.concat(chunks) } : {}) });
      void handleGovernorGateway(request, { environment: { ATLAS_GOVERNOR_TOKEN: TOKEN }, call }).then(async (response) => {
        outgoing.writeHead(response.status, { "content-type": "application/json" });
        outgoing.end(await response.text());
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/api/inference/governor`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("a rate limit seen by one runner makes every caller on that quota wait, without another provider request", { skip }, async () => {
  const gateway = await liveGateway();
  try {
    const scope = quotaScopeFor("https://api.groq.com", "shared-key");
    const governorFor = () => createHttpGovernor({ url: gateway.url, token: TOKEN, scope, warn: () => { throw new Error("the governor must be reachable in this test"); } });
    const limited = new ModelProviderError({ message: "429", code: "rate-limit", providerId: "groq", retryable: true, retryAfterMs: 20_000 });
    const first = new Scripted(limited);
    await assert.rejects(new GovernedModelProvider(first, governorFor()).complete(request), (error: unknown) => error === limited);
    assert.equal(first.calls, 1);

    // A second runner, same key and so same scope, is told to wait and never reaches the provider.
    const second = new Scripted(ok);
    await assert.rejects(
      new GovernedModelProvider(second, governorFor(), { maximumWaitMs: 5_000, sleep: async () => { throw new Error("must not sleep"); } }).complete(request),
      (error: unknown) => error instanceof ModelProviderError && error.code === "rate-limit" && error.retryable && (error.retryAfterMs ?? 0) > 5_000,
    );
    assert.equal(second.calls, 0, "no request was sent during the cooldown");

    // A different key is a different quota and is unaffected.
    const other = new Scripted(ok);
    const otherGovernor = createHttpGovernor({ url: gateway.url, token: TOKEN, scope: quotaScopeFor("https://api.groq.com", "another-key") });
    assert.equal((await new GovernedModelProvider(other, otherGovernor).complete(request)).message.role, "assistant");
    assert.equal(other.calls, 1);
  } finally { await gateway.close(); }
});

test("a wrong token is refused by the gateway with zero provider dispatches", { skip }, async () => {
  const gateway = await liveGateway();
  try {
    const warnings: string[] = [];
    const governor = createHttpGovernor({ url: gateway.url, token: "not-the-token", scope: quotaScopeFor("https://api.groq.com", "k"), warn: (message) => warnings.push(message) });
    const provider = new Scripted(ok);
    await assert.rejects(new GovernedModelProvider(provider, governor).complete(request),
      (e: unknown) => e instanceof ModelProviderError && e.code === "authentication" && !e.retryable);
    assert.equal(provider.calls, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /401/u);
  } finally { await gateway.close(); }
});
