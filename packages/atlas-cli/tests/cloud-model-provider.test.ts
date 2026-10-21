import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudModelProvider } from "../src/infrastructure/cloud-model-provider.js";
import { GroqModelProvider } from "../src/infrastructure/groq-model-provider.js";
import { FallbackModelProvider } from "../src/infrastructure/fallback-model-provider.js";
import { ModelProviderError, type ModelRequest } from "../src/model/model-provider.js";
import { selectCoderProvider, inferCoderProviderId } from "../src/model/coder-provider-selection.js";
import { createRepositoryWriteTools, registerRepositoryWriteTools } from "../src/infrastructure/repository-write-tools.js";
import { SafeRepositoryFileEditor } from "../src/infrastructure/safe-repository-file-editor.js";
import { PolicyEnforcedReadOnlyToolRegistry } from "../src/infrastructure/policy-enforced-read-only-tool-registry.js";

const capabilities = (model: string) => [{ model, contextWindowTokens: 128_000, maxOutputTokens: 8192, supportsTools: true, supportsJson: true, supportsStreaming: false }];
const request: ModelRequest = { model: "fixture", messages: [{ role: "user", content: [{ type: "text", text: "Create a framing business website" }] }], maxOutputTokens: 8192 };
const completion = (model = "fixture") => ({ id: "cloud-1", model, choices: [{ message: { content: "Complete" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });

test("OpenAI and Workers AI profiles infer fixed provider identities and scoped key names", () => {
  for (const [model, provider, key] of [["gpt-5.4-mini", "openai", "OPENAI_API_KEY"], ["@cf/openai/gpt-oss-120b", "workers-ai", "ATLAS_WORKERS_AI_TOKEN"]]) {
    assert.equal(inferCoderProviderId(model!), provider);
    const selected = selectCoderProvider({ model: model!, tokenBudget: 20000 });
    assert.ok(selected.ok);
    assert.equal(selected.selection.apiKeyEnvironmentVariable, key);
  }
});

test("vendor destinations and output fields are fixed; bearer credentials do not follow redirects", async () => {
  for (const id of ["openai", "workers-ai"] as const) {
    const provider = new CloudModelProvider({ providerId: id, apiKey: "vendor-secret", accountId: "a".repeat(32), models: capabilities("fixture"),
      fetchImplementation: (async (url, init) => {
        assert.equal(new URL(String(url)).hostname, id === "openai" ? "api.openai.com" : "api.cloudflare.com");
        assert.equal(init?.redirect, "error");
        assert.equal((init?.headers as Record<string,string>)["authorization"], "Bearer vendor-secret");
        const body = JSON.parse(String(init?.body));
        assert.equal(body[id === "openai" ? "max_completion_tokens" : "max_tokens"], 8192);
        if (id === "openai") assert.equal(body.max_tokens, undefined);
        return Response.json(completion());
      }) as typeof fetch });
    assert.equal((await provider.complete(request)).providerId, id);
  }
  assert.throws(() => new CloudModelProvider({ providerId: "workers-ai", apiKey: "token", accountId: "../other", models: capabilities("fixture") }), /CLOUDFLARE_ACCOUNT_ID/);
});

test("quota 413 falls through from Groq to Workers AI without replaying work; tool creates all nested website files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atlas-cloud-framing-")); t.after(() => rm(root, { recursive: true, force: true }));
  const files = ["index.html", "about.html", "services.html", "contact.html", "styles.css"];
  const edits = files.map((name) => ({ operation: "create", path: "apps/web/services/wood-framing-mn/" + name, content: name.endsWith("css") ? "body { color: #123; }" : "<h1>Framing</h1>" }));
  let groqCalls = 0, cloudCalls = 0;
  const groq = new GroqModelProvider({ apiKey: "groq-key", models: capabilities("groq-model"), fetchImplementation: (async () => { groqCalls++; return Response.json({ error: { message: "Request too large on tokens per minute (TPM): Limit 8000, Requested 8503" } }, { status: 413 }); }) as typeof fetch });
  const cloud = new CloudModelProvider({ providerId: "workers-ai", apiKey: "cloud-key", accountId: "a".repeat(32), models: capabilities("cloud-model"), fetchImplementation: (async (_url, init) => {
    cloudCalls++; const body = JSON.parse(String(init?.body)); assert.deepEqual(body.messages, [{ role: "user", content: "Create a framing business website" }]);
    return Response.json({ ...completion("cloud-model"), choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "write-site", type: "function", function: { name: "repository.propose_change_set", arguments: JSON.stringify({ edits }) } }] } }] });
  }) as typeof fetch });
  const fallback = new FallbackModelProvider([{ provider: groq, model: "groq-model" }, { provider: cloud, model: "cloud-model" }]);
  const result = await fallback.complete(request);
  // Groq gets the request once, then once refitted to its stated allowance; it still refuses, so Workers AI answers.
  assert.equal(result.providerId, "workers-ai"); assert.equal(groqCalls, 2); assert.equal(cloudCalls, 1);
  const call = result.message.content[0]; assert.ok(call?.type === "tool-call");
  const registry = new PolicyEnforcedReadOnlyToolRegistry({ policy: { defaultDecision: "allow", rules: [] } });
  registerRepositoryWriteTools(registry, createRepositoryWriteTools({ repositoryId: "fixture", repositoryRoot: root }, { editor: new SafeRepositoryFileEditor() }));
  const applied = await registry.execute({ name: call.name, input: call.arguments, scope: { kind: "repository", repositoryId: "fixture" }, context: { repositoryId: "fixture" } });
  assert.equal(applied.status, "completed", JSON.stringify(applied));
  for (const file of files) assert.ok((await readFile(join(root, "apps/web/services/wood-framing-mn", file), "utf8")).length);
});

test("a rejected key moves to the next route; provider errors cannot echo prompts or credentials", async () => {
  let fallbackCalls = 0;
  const bad = new CloudModelProvider({ providerId: "openai", apiKey: "secret", models: capabilities("fixture"), fetchImplementation: (async () => Response.json({ error: "secret and private prompt" }, { status: 401 })) as typeof fetch });
  const other = new CloudModelProvider({ providerId: "openai", apiKey: "other", models: capabilities("fixture"), fetchImplementation: (async () => { fallbackCalls++; return Response.json(completion()); }) as typeof fetch });
  assert.equal((await new FallbackModelProvider([{ provider: bad, model: "fixture" }, { provider: other, model: "fixture" }]).complete(request)).providerId, "openai");
  assert.equal(fallbackCalls, 1);
  await assert.rejects(new FallbackModelProvider([{ provider: bad, model: "fixture" }]).complete(request), (error: unknown) => error instanceof ModelProviderError && error.code === "authentication" && !error.message.includes("private prompt") && !error.message.includes("secret"));
});

test("cloud request cancellation, oversized responses and empty replies fail explicitly", async () => {
  const cancelled = new CloudModelProvider({ providerId: "openai", apiKey: "secret", models: capabilities("fixture"), fetchImplementation: (async (_url, init) => { init?.signal?.throwIfAborted(); return Response.json(completion()); }) as typeof fetch });
  await assert.rejects(cancelled.complete(request, { signal: AbortSignal.abort() }), (error: unknown) => error instanceof ModelProviderError && error.code === "cancelled");
  const large = new CloudModelProvider({ providerId: "openai", apiKey: "secret", models: capabilities("fixture"), fetchImplementation: (async () => new Response("x".repeat(4*1024*1024+1))) as typeof fetch });
  await assert.rejects(large.complete(request), /within its bound/);
  const empty = new CloudModelProvider({ providerId: "openai", apiKey: "secret", models: capabilities("fixture"), fetchImplementation: (async () => Response.json({ ...completion(), choices: [{ finish_reason: "length", message: { content: " " } }] })) as typeof fetch });
  await assert.rejects(empty.complete(request), /empty or invalid/);
});

test("cloud function names and historical calls round-trip to exact Atlas registry IDs", async () => {
  const provider = new CloudModelProvider({ providerId: "openai", apiKey: "secret", models: capabilities("fixture"), fetchImplementation: (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const wireName = body.tools[0].function.name;
    assert.match(wireName, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal(body.messages[1].tool_calls[0].function.name, wireName);
    return Response.json({ ...completion(), choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "write", type: "function", function: { name: wireName, arguments: "{}" } }] } }] });
  }) as typeof fetch });
  const result = await provider.complete({ ...request, tools: [{ name: "repository.propose_change_set", description: "Apply edits", inputSchema: { type: "object" } }], messages: [...request.messages, { role: "assistant", content: [{ type: "tool-call", id: "earlier", name: "repository.propose_change_set", arguments: {} }] }, { role: "tool", toolCallId: "earlier", isError: false, content: [{ type: "text", text: "done" }] }] });
  const call = result.message.content[0]; assert.ok(call?.type === "tool-call"); assert.equal(call.name, "repository.propose_change_set");
});

test("free vendors have fixed destinations, their own key names, and are inferred from model names", async () => {
  const destinations = { cerebras: "api.cerebras.ai", gemini: "generativelanguage.googleapis.com", openrouter: "openrouter.ai", mistral: "api.mistral.ai" } as const;
  for (const [id, host] of Object.entries(destinations) as [keyof typeof destinations, string][]) {
    const provider = new CloudModelProvider({ providerId: id, apiKey: "vendor-secret", models: capabilities("fixture"),
      fetchImplementation: (async (url, init) => {
        assert.equal(new URL(String(url)).hostname, host);
        assert.equal((init?.headers as Record<string, string>)["authorization"], "Bearer vendor-secret");
        assert.equal(JSON.parse(String(init?.body)).max_tokens, 8192);
        return Response.json(completion());
      }) as typeof fetch });
    assert.equal((await provider.complete(request)).providerId, id);
  }
  for (const [model, provider, key] of [["gemini-2.5-flash", "gemini", "GEMINI_API_KEY"], ["openai/gpt-oss-20b:free", "openrouter", "OPENROUTER_API_KEY"], ["devstral-small-latest", "mistral", "MISTRAL_API_KEY"]] as const) {
    assert.equal(inferCoderProviderId(model), provider);
    const selected = selectCoderProvider({ model, tokenBudget: 20000 });
    assert.ok(selected.ok);
    assert.equal(selected.selection.apiKeyEnvironmentVariable, key);
  }
  const cerebras = selectCoderProvider({ provider: "cerebras", model: "gpt-oss-120b", tokenBudget: 20000 });
  assert.ok(cerebras.ok && cerebras.selection.apiKeyEnvironmentVariable === "CEREBRAS_API_KEY");
});

test("route specifications keep colons inside the model name", async () => {
  const { splitRouteSpecification } = await import("../src/cli.js");
  assert.deepEqual(splitRouteSpecification("openrouter:openai/gpt-oss-20b:free:OPENROUTER_API_KEY"), ["openrouter", "openai/gpt-oss-20b:free", "OPENROUTER_API_KEY"]);
  assert.deepEqual(splitRouteSpecification("groq:openai/gpt-oss-120b:GROQ_API_KEY"), ["groq", "openai/gpt-oss-120b", "GROQ_API_KEY"]);
  assert.equal(splitRouteSpecification("groq:GROQ_API_KEY"), undefined);
  assert.equal(splitRouteSpecification("groq::GROQ_API_KEY"), undefined);
});

test("hard cloud deadline releases stalled headers even if fetch ignores abort", async () => {
  let lateCancelled = false;
  const provider = new CloudModelProvider({ providerId: "openai", apiKey: "secret", models: capabilities("fixture"), timeoutMs: 30,
    fetchImplementation: (async () => new Promise<Response>(resolve => setTimeout(() => resolve(new Response(new ReadableStream({ pull(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(completion()))); controller.close(); }, cancel() { lateCancelled = true; } }, { highWaterMark: 0 }))), 200))) as typeof fetch });
  await assert.rejects(provider.complete(request), (error: unknown) => error instanceof ModelProviderError && error.code === "provider-failure" && error.retryable);
  await new Promise(resolve => setTimeout(resolve, 230));
  assert.equal(lateCancelled, true);
});

test("hard cloud body deadline does not wait for a noncooperative cancellation", async () => {
  let cancelled = false;
  let release: (() => void) | undefined;
  const provider = new CloudModelProvider({ providerId: "workers-ai", apiKey: "secret", accountId: "a".repeat(32), models: capabilities("fixture"), timeoutMs: 30,
    fetchImplementation: (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { release = () => { try { controller.enqueue(new TextEncoder().encode(JSON.stringify(completion()))); controller.close(); } catch { /* cancelled */ } }; },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    }))) as typeof fetch });
  const fixture = setTimeout(() => release?.(), 250);
  try {
    await assert.rejects(provider.complete(request), (error: unknown) => error instanceof ModelProviderError && error.code === "provider-failure" && error.retryable);
    assert.equal(cancelled, true);
  } finally { clearTimeout(fixture); release?.(); }
});

test("pre-cancelled cloud requests make no network call", async () => {
  let calls = 0;
  const provider = new CloudModelProvider({ providerId: "openai", apiKey: "secret", models: capabilities("fixture"), fetchImplementation: (async () => { calls++; return Response.json(completion()); }) as typeof fetch });
  await assert.rejects(provider.complete(request, { signal: AbortSignal.abort(new Error("private cancellation reason")) }), (error: unknown) => error instanceof ModelProviderError && error.code === "cancelled" && !error.retryable && !error.message.includes("private"));
  assert.equal(calls, 0);
});

test("caller cancellation interrupts a stalled cloud body without fallback", async () => {
  const controller = new AbortController(); let fallbackCalls = 0, cancelled = false;
  const primary = new CloudModelProvider({ providerId: "openai", apiKey: "secret", models: capabilities("fixture"), timeoutMs: 1000,
    fetchImplementation: (async () => new Response(new ReadableStream<Uint8Array>({
      pull(stream) { setTimeout(() => { try { stream.close(); } catch { /* cancelled */ } }, 200); controller.abort(new Error("private caller reason")); return new Promise<void>(() => {}); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    }))) as typeof fetch });
  const other = new CloudModelProvider({ providerId: "openai", apiKey: "other", models: capabilities("fixture"), fetchImplementation: (async () => { fallbackCalls++; return Response.json(completion()); }) as typeof fetch });
  await assert.rejects(new FallbackModelProvider([{ provider: primary, model: "fixture" }, { provider: other, model: "fixture" }]).complete(request, { signal: controller.signal }), (error: unknown) => error instanceof ModelProviderError && error.code === "cancelled" && !error.retryable && !error.message.includes("private"));
  assert.equal(cancelled, true); assert.equal(fallbackCalls, 0);
});

test("a cloud response deadline can recover through the existing fallback chain", async () => {
  const first = new CloudModelProvider({ providerId: "openai", apiKey: "secret", models: capabilities("fixture"), timeoutMs: 20, fetchImplementation: (async () => new Promise<Response>(resolve => setTimeout(() => resolve(Response.json(completion())), 200))) as typeof fetch });
  let calls = 0;
  const other = new CloudModelProvider({ providerId: "workers-ai", accountId: "a".repeat(32), apiKey: "other", models: capabilities("fixture"), fetchImplementation: (async () => { calls++; return Response.json(completion()); }) as typeof fetch });
  const result = await new FallbackModelProvider([{ provider: first, model: "fixture" }, { provider: other, model: "fixture" }]).complete(request);
  assert.equal(result.providerId, "workers-ai"); assert.equal(calls, 1);
});

test("completed cloud requests release caller listeners and reject invalid deadlines before fetch", async () => {
  const controller = new AbortController(); let calls = 0;
  const fetcher = (async () => { calls++; return Response.json(completion()); }) as typeof fetch;
  const provider = new CloudModelProvider({ providerId: "openai", apiKey: "secret", models: capabilities("fixture"), fetchImplementation: fetcher });
  for (let index = 0; index < 12; index++) await provider.complete(request, { signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  for (const timeoutMs of [0, -1, NaN, Infinity, 2_147_483_648]) {
    const invalid = new CloudModelProvider({ providerId: "openai", apiKey: "secret", models: capabilities("fixture"), timeoutMs, fetchImplementation: fetcher });
    await assert.rejects(invalid.complete(request), RangeError);
  }
  assert.equal(calls, 12);
});

test("stalled error bodies preserve authentication classification and safe retry headers", async () => {
  for (const status of [401, 403, 429]) {
    let cancelled = false, fallbacks = 0;
    const provider = new CloudModelProvider({ providerId: "openai", apiKey: "secret", models: capabilities("fixture"), timeoutMs: 30,
      fetchImplementation: (async () => new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise<void>(() => {}); } }), { status, headers: { "retry-after": "2" } })) as typeof fetch });
    if (status === 429) {
      await assert.rejects(provider.complete(request), (error: unknown) => error instanceof ModelProviderError && error.code === "rate-limit" && error.retryAfterMs === 2000);
    } else {
      const other = new CloudModelProvider({ providerId: "workers-ai", accountId: "a".repeat(32), apiKey: "other", models: capabilities("fixture"), fetchImplementation: (async () => { fallbacks++; return Response.json(completion()); }) as typeof fetch });
      await assert.rejects(provider.complete(request), (error: unknown) => error instanceof ModelProviderError && error.code === "authentication" && !error.retryable);
      // A rejected key moves to the next route (#397); it is not retried on the same one.
      assert.equal((await new FallbackModelProvider([{ provider, model: "fixture" }, { provider: other, model: "fixture" }]).complete(request)).providerId, "workers-ai");
      assert.equal(fallbacks, 1);
    }
    assert.equal(cancelled, true);
  }
});
