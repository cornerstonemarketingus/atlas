import assert from "node:assert/strict";
import test from "node:test";
import { converse, inferenceFailureMetadata } from "../app/api/chat/agent-loop.mjs";

const tool = { type: "function", function: { name: "read_fixture", description: "Read test evidence", parameters: { type: "object", properties: {} } } };
const endpoint = { baseUrl: "https://model.test/v1/", apiKey: "SECRET_SENTINEL", model: "fixture-model" };
const toolReply = { choices: [{ message: { content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_fixture", arguments: "{}" } }] }, finish_reason: "tool_calls" }] };

for (const stream of [false, true]) for (const [status, category] of [[400, "UNKNOWN"], [401, "AUTHENTICATION"], [403, "PERMISSION"], [404, "MODEL_NOT_FOUND"]]) {
  test(`permanent failure after a completed tool is actionable and redacted (${status}, stream=${stream})`, async () => {
    let calls = 0;
    let executed = 0;
    const events = [];
    const outcome = await converse({ endpoint, turns: [{ role: "user", content: "PROMPT_SENTINEL" }], tools: [tool], allowTasks: false, stream,
      handlers: { read_fixture: async () => { executed += 1; return { ok: true, label: "Fixture read", content: "TOOL_RESULT_SENTINEL" }; } }, emit: (type, data) => events.push({ type, data }),
      fetcher: async (_url, init) => {
        calls += 1;
        if (calls === 1) return Response.json(toolReply);
        assert.ok(JSON.parse(init.body).messages.some(message => message.role === "tool"));
        return Response.json({ error: { message: "PROVIDER_BODY_SENTINEL", code: "PRIVATE_CODE_SENTINEL" } }, { status });
      }, sleep: async () => {},
    });
    assert.equal(executed, 1);
    assert.match(outcome.reply, /Stopped early/);
    assert.equal(outcome.steps[0].ok, true);
    const expected = { status, provider: "self-hosted", model: "fixture-model", category, round: 1 };
    assert.deepEqual(outcome.inferenceFailure, expected);
    assert.deepEqual(events.find(event => event.type === "inference_failure")?.data, expected);
    assert.doesNotMatch(JSON.stringify(outcome.inferenceFailure), /SENTINEL/);
    assert.doesNotMatch(JSON.stringify(outcome), /PROVIDER_BODY_SENTINEL|PRIVATE_CODE_SENTINEL|SECRET_SENTINEL|PROMPT_SENTINEL/);
    assert.equal(outcome.servedBy, undefined, "failed provider must not be claimed as the author of a reply");
  });
}

test("metadata rejects arbitrary provider, model, category and status fields", () => {
  assert.deepEqual(inferenceFailureMetadata({ provider: "https://SECRET_SENTINEL.example", model: "model\nSECRET_SENTINEL", status: 999, kind: "PRIVATE_SENTINEL", body: "PROMPT_SENTINEL" }, "private"),
    { status: null, provider: "unknown", model: "unknown", category: "UNKNOWN", round: null });
});

test("first-round permanent failure includes the same safe metadata", async () => {
  const outcome = await converse({ endpoint, turns: [{ role: "user", content: "hello" }], tools: [], allowTasks: false, stream: false, emit: () => {},
    fetcher: async () => Response.json({ error: { message: "PRIVATE_SENTINEL" } }, { status: 401 }) });
  assert.deepEqual(outcome.inferenceFailure, { status: 401, provider: "self-hosted", model: "fixture-model", category: "AUTHENTICATION", round: 0 });
  assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE_SENTINEL/);
});

test("failure diagnostics name the actual fallback provider and model", async () => {
  let primaryCalls = 0;
  const outcome = await converse({ endpoint: { ...endpoint, providerFallback: { baseUrl: "https://api.openai.com/v1/", model: "fallback-model", apiKey: "FALLBACK_SECRET_SENTINEL" } },
    turns: [{ role: "user", content: "hello" }], tools: [tool], allowTasks: false, stream: false, emit: () => {}, sleep: async () => {},
    handlers: { read_fixture: async () => ({ ok: true, label: "Fixture read", content: "fixture" }) },
    fetcher: async url => {
      if (new URL(url).hostname === "model.test" && ++primaryCalls === 1) return Response.json(toolReply);
      return Response.json({ error: { message: "PRIVATE_SENTINEL" } }, { status: new URL(url).hostname === "model.test" ? 429 : 403, headers: { "retry-after": "120" } });
    } });
  assert.deepEqual(outcome.inferenceFailure, { status: 403, provider: "openai", model: "fallback-model", category: "PERMISSION", round: 1 });
  assert.doesNotMatch(JSON.stringify(outcome.inferenceFailure), /SECRET|PRIVATE/);
});
