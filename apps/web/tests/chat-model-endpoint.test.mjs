import assert from "node:assert/strict";
import test from "node:test";
import { completionsUrl, replyText, resolveChatModel, threadTitle } from "../app/api/chat/model-endpoint.mjs";

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

test("falls back to the coder runtime's endpoint so one setting serves both", () => {
  const result = resolveChatModel({ ATLAS_CODER_BASE_URL: "https://api.example/v1", ATLAS_CODER_MODEL: "coder-model", GROQ_API_KEY: "k" });
  assert.equal(result.configured, true);
  assert.equal(result.model, "coder-model");
  assert.equal(result.apiKey, "k");
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
