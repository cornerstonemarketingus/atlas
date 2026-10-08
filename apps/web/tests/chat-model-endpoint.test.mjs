import assert from "node:assert/strict";
import test from "node:test";
import { completionsUrl, replyText, resolveChatModel, threadTitle, chatModelOptions, selectChatModel, publicChatModels, chatRequestBody } from "../app/api/chat/model-endpoint.mjs";

test("local thinking control reaches the model without modifying hosted defaults", () => {
  const messages = [{ role: "user", content: "Hello" }];
  const profiles = JSON.stringify([{ id: "local", model: "qwen3:0.6b", baseUrl: "http://localhost:11434/v1", reasoningEffort: "none" }]);
  const endpoint = selectChatModel({ ATLAS_CHAT_PROFILES: profiles }, "local");
  assert.equal(chatRequestBody(endpoint, messages).reasoning_effort, "none");
  assert.equal(chatRequestBody({ model: "hosted" }, messages).reasoning_effort, undefined);
  assert.equal(chatRequestBody(endpoint, messages).messages, messages);
});

test("offers allowed models and rejects client-supplied endpoints or unknown ids", () => {
  const env = { ATLAS_CHAT_BASE_URL: "http://localhost:11434/v1", ATLAS_CHAT_MODEL: "qwen3:0.6b", ATLAS_CHAT_MODELS: "qwen3:1.7b,qwen3:4b,qwen3:0.6b" };
  assert.equal(chatModelOptions(env).options.length, 3);
  assert.equal(selectChatModel(env).model, "qwen3:0.6b");
  assert.equal(selectChatModel(env, "qwen3:4b").model, "qwen3:4b");
  for (const id of ["https://attacker.example/v1", "unknown", null, {}]) {
    assert.equal(selectChatModel(env, id).invalidSelection, true);
  }
});

test("profile credentials stay isolated and never appear in the public catalog", () => {
  const env = { HOSTED_KEY: "private-secret", ATLAS_MODEL_API_KEY: "unrelated-secret", ATLAS_CHAT_PROFILES: JSON.stringify([
    { id: "local", model: "qwen3:0.6b", baseUrl: "http://localhost:11434/v1", label: "Local fast" },
    { id: "hosted", model: "hosted-model", baseUrl: "https://model.example/v1", apiKeyEnv: "HOSTED_KEY" },
  ]) };
  assert.equal(selectChatModel(env, "local").apiKey, null);
  assert.equal(selectChatModel(env, "hosted").apiKey, "private-secret");
  assert.deepEqual(publicChatModels(env), { configured: true, reason: null, defaultModel: "local", models: [
    { id: "local", model: "qwen3:0.6b", label: "Local fast" },
    { id: "hosted", model: "hosted-model", label: "hosted-model" },
  ] });
});

test("invalid profile configuration fails closed", () => {
  for (const profiles of ["not-json", "{}", "[]", '[null]', JSON.stringify([
    { id: "x", model: "m", baseUrl: "https://a.example/v1" },
    { id: "x", model: "m", baseUrl: "https://b.example/v1" },
  ]), JSON.stringify([{ id: "x", model: "m", baseUrl: "http://remote.example/v1" }]),
  JSON.stringify([{ id: "x", model: "m", baseUrl: "https://a.example/v1", apiKeyEnv: "MISSING_KEY" }])]) {
    assert.equal(publicChatModels({ ATLAS_CHAT_PROFILES: profiles }).configured, false);
  }
});

test("a provider fallback key never leaks to a different model host", () => {
  const env = { ATLAS_CHAT_MODEL: "model", GROQ_API_KEY: "provider-secret" };
  assert.equal(resolveChatModel({ ...env, ATLAS_CHAT_BASE_URL: "https://api.groq.com/openai/v1" }).apiKey, "provider-secret");
  assert.equal(resolveChatModel({ ...env, ATLAS_CHAT_BASE_URL: "https://model.example/v1" }).apiKey, null);
  for (const url of ["ftp://localhost/v1", "file://localhost/v1", "https://model.example/v1?token=x", "https://model.example/v1#secret"]) {
    assert.equal(resolveChatModel({ ...env, ATLAS_CHAT_BASE_URL: url }).configured, false);
  }
});

test("reports chat as unconfigured, with a reason, when no endpoint is set", () => {
  const result = resolveChatModel({});
  assert.equal(result.configured, false);
  assert.match(result.reason, /ATLAS_CHAT_BASE_URL/);
});

test("needs both an endpoint and a model name", () => {
  assert.equal(resolveChatModel({ ATLAS_CHAT_BASE_URL: "https://api.example/v1" }).configured, false);
  assert.equal(resolveChatModel({ ATLAS_CHAT_MODEL: "a-model" }).configured, false);
});

test("accepts an https endpoint and carries the key separately", () => {
  const result = resolveChatModel({ ATLAS_CHAT_BASE_URL: "https://api.example/v1", ATLAS_CHAT_MODEL: "a-model", ATLAS_MODEL_API_KEY: "secret" });
  assert.equal(result.configured, true);
  assert.equal(result.model, "a-model");
  assert.equal(result.apiKey, "secret");
  assert.equal(completionsUrl(result.baseUrl), "https://api.example/v1/chat/completions");
});

test("does not pretend GitHub Actions coder variables reach a deployed Worker", () => {
  const result = resolveChatModel({ ATLAS_CODER_BASE_URL: "https://api.example/v1", ATLAS_CODER_MODEL: "coder-model", GROQ_API_KEY: "k" });
  assert.equal(result.configured, false);
  assert.match(result.reason, /ATLAS_CHAT_BASE_URL/);
});

test("allows plain http only on loopback", () => {
  for (const host of ["127.0.0.1:11434", "localhost:11434", "[::1]:11434"]) {
    assert.equal(resolveChatModel({ ATLAS_CHAT_BASE_URL: `http://${host}/v1`, ATLAS_CHAT_MODEL: "m" }).configured, true, host);
  }
  const remote = resolveChatModel({ ATLAS_CHAT_BASE_URL: "http://models.example/v1", ATLAS_CHAT_MODEL: "m" });
  assert.equal(remote.configured, false);
  assert.match(remote.reason, /HTTPS/);
});

test("refuses credentials embedded in the endpoint URL", () => {
  const result = resolveChatModel({ ATLAS_CHAT_BASE_URL: "https://user:pass@api.example/v1", ATLAS_CHAT_MODEL: "m" });
  assert.equal(result.configured, false);
  assert.match(result.reason, /ATLAS_MODEL_API_KEY/);
});

test("refuses an endpoint that is not a URL at all", () => {
  assert.equal(resolveChatModel({ ATLAS_CHAT_BASE_URL: "not a url", ATLAS_CHAT_MODEL: "m" }).configured, false);
});

test("appends chat/completions without losing the base path", () => {
  assert.equal(completionsUrl("https://api.example/v1/"), "https://api.example/v1/chat/completions");
  assert.equal(completionsUrl("http://127.0.0.1:11434/v1/"), "http://127.0.0.1:11434/v1/chat/completions");
});

test("reads a reply from either content shape and ignores anything else", () => {
  assert.equal(replyText({ choices: [{ message: { content: "  hello  " } }] }), "hello");
  assert.equal(replyText({ choices: [{ message: { content: [{ text: "a" }, { text: "b" }] } }] }), "ab");
  assert.equal(replyText({ choices: [{ message: { reasoning: "private" } }] }), "");
  assert.equal(replyText({}), "");
  assert.equal(replyText(null), "");
});

test("titles a thread from its first message, truncated", () => {
  assert.equal(threadTitle("  build   me a   site "), "build me a site");
  const long = threadTitle("x".repeat(200));
  assert.equal(long.length, 72);
  assert.ok(long.endsWith("…"));
});
