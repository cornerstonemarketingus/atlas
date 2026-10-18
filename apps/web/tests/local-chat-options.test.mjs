import assert from "node:assert/strict";
import test from "node:test";
import { resolveChatProvider, chatProviderChoices } from "../app/api/chat/providers.mjs";
import { callModel } from "../app/api/chat/agent-loop.mjs";
import { completionsUrl } from "../app/api/chat/model-endpoint.mjs";

const env = { ATLAS_CHAT_BASE_URL: "http://127.0.0.1:11434/v1", ATLAS_CHAT_MODEL: "qwen3:0.6b", ATLAS_CHAT_MODELS: "qwen3:1.7b,qwen2.5-coder:1.5b", GROQ_API_KEY: "server-secret" };

test("the picker exposes configured models without endpoint addresses or secrets", () => {
  const choices = chatProviderChoices(env);
  assert.deepEqual(choices.filter((choice) => choice.id.startsWith("configured:")).map((choice) => choice.id), ["configured:qwen3:0.6b", "configured:qwen3:1.7b", "configured:qwen2.5-coder:1.5b"]);
  assert.equal(JSON.stringify(choices).includes("server-secret"), false);
  assert.equal(JSON.stringify(choices).includes("127.0.0.1"), false);
  const selected = resolveChatProvider(env, "configured:qwen3:1.7b");
  assert.equal(selected.model, "qwen3:1.7b");
  assert.deepEqual(selected.models, ["qwen3:1.7b"]);
  assert.equal(selected.fallbackModel, null);
  assert.equal(selected.apiKey, null);
  assert.equal(resolveChatProvider(env).models.length, 3, "Automatic retains its capacity pool and provider fallback");
  for (const id of ["configured:unknown", "configured:https://attacker.example/v1"]) assert.equal(resolveChatProvider(env, id).configured, false);
});

test("a local Qwen reply disables reasoning, while hosted requests retain their defaults", async () => {
  for (const [baseUrl, expected] of [["http://127.0.0.1:11434/v1/", "none"], ["https://model.example/v1/", undefined]]) {
    let sent;
    const response = await callModel({ baseUrl, model: "qwen3:0.6b" }, [{ role: "user", content: "Hello" }], {
      stream: false, tools: null, fetcher: async (_url, init) => {
        sent = JSON.parse(init.body);
        return Response.json({ choices: [{ message: { content: "Hello" } }] });
      },
    });
    assert.equal(response.status, 200);
    assert.equal(sent.reasoning_effort, expected);
  }
});

test("chat URLs retain their API path with and without a trailing slash", () => {
  for (const base of ["https://model.example/v1", "https://model.example/v1/"]) assert.equal(completionsUrl(base), "https://model.example/v1/chat/completions");
});
