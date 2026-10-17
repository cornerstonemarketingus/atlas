import assert from "node:assert/strict";
import test from "node:test";
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
  assert.equal(result.providerId, "workers-ai"); assert.equal(groqCalls, 1); assert.equal(cloudCalls, 1);
  const call = result.message.content[0]; assert.ok(call?.type === "tool-call");
  const registry = new PolicyEnforcedReadOnlyToolRegistry({ policy: { defaultDecision: "allow", rules: [] } });
  registerRepositoryWriteTools(registry, createRepositoryWriteTools({ repositoryId: "fixture", repositoryRoot: root }, { editor: new SafeRepositoryFileEditor() }));
  const applied = await registry.execute({ name: call.name, input: call.arguments, scope: { kind: "repository", repositoryId: "fixture" }, context: { repositoryId: "fixture" } });
  assert.equal(applied.status, "completed", JSON.stringify(applied));
  for (const file of files) assert.ok((await readFile(join(root, "apps/web/services/wood-framing-mn", file), "utf8")).length);
});

test("authentication never falls back; provider errors cannot echo prompts or credentials", async () => {
  let fallbackCalls = 0;
  const bad = new CloudModelProvider({ providerId: "openai", apiKey: "secret", models: capabilities("fixture"), fetchImplementation: (async () => Response.json({ error: "secret and private prompt" }, { status: 401 })) as typeof fetch });
  const other = new CloudModelProvider({ providerId: "openai", apiKey: "other", models: capabilities("fixture"), fetchImplementation: (async () => { fallbackCalls++; return Response.json(completion()); }) as typeof fetch });
  await assert.rejects(new FallbackModelProvider([{ provider: bad, model: "fixture" }, { provider: other, model: "fixture" }]).complete(request), (error: unknown) => error instanceof ModelProviderError && error.code === "authentication" && !error.message.includes("private prompt") && !error.message.includes("secret"));
  assert.equal(fallbackCalls, 0);
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
