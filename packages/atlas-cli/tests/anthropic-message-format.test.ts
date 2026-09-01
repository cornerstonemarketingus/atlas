import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRequest, ToolCallContent } from "../src/model/model-provider.js";
import { ModelValidationError } from "../src/model/model-contract-validation.js";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  JSON_RESPONSE_INSTRUCTION,
  MAX_OUTPUT_TOKENS_CEILING,
  buildAnthropicMessagesPayload,
  parseAnthropicMessagesResponse,
} from "../src/infrastructure/anthropic-message-format.js";

type RecordValue = Record<string, unknown>;

const build = (request: ModelRequest): RecordValue => buildAnthropicMessagesPayload(request);
const messagesOf = (payload: RecordValue): readonly RecordValue[] => payload["messages"] as readonly RecordValue[];

test("hoists system messages into the top-level system parameter", () => {
  const payload = build({
    model: "claude-opus-5",
    messages: [
      { role: "system", content: [{ type: "text", text: "You are terse." }] },
      { role: "system", content: [{ type: "text", text: "Never guess." }] },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ],
  });
  assert.equal(payload["system"], "You are terse.\n\nNever guess.");
  const messages = messagesOf(payload);
  assert.equal(messages.length, 1, "system messages must not remain in the messages array");
  assert.equal(messages[0]?.["role"], "user");
});

test("omits the system parameter entirely when there is no system message", () => {
  const payload = build({ model: "claude-opus-5", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  assert.ok(!Object.hasOwn(payload, "system"));
});

test("maps assistant tool calls to tool_use blocks with structured input", () => {
  const payload = build({
    model: "claude-opus-5",
    messages: [
      { role: "user", content: [{ type: "text", text: "read it" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading the file." },
          { type: "tool-call", id: "toolu_1", name: "read_file", arguments: { path: "a.ts", lines: 10 } },
        ],
      },
    ],
  });
  const assistant = messagesOf(payload)[1];
  assert.equal(assistant?.["role"], "assistant");
  const blocks = assistant?.["content"] as readonly RecordValue[];
  assert.deepEqual(blocks[0], { type: "text", text: "Reading the file." });
  assert.deepEqual(blocks[1], { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts", lines: 10 } });
  // Anthropic takes a structured object, never an OpenAI-style JSON string.
  assert.equal(typeof (blocks[1]?.["input"] as RecordValue), "object");
  assert.ok(!Object.hasOwn(assistant ?? {}, "tool_calls"));
});

test("turns tool results into tool_result blocks in a user message", () => {
  const payload = build({
    model: "claude-opus-5",
    messages: [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "tool-call", id: "toolu_1", name: "read_file", arguments: {} }] },
      { role: "tool", toolCallId: "toolu_1", isError: false, content: [{ type: "text", text: "file body" }] },
    ],
  });
  const result = messagesOf(payload)[2];
  assert.equal(result?.["role"], "user", "tool results belong to a user message, not a `tool` role");
  assert.deepEqual(result?.["content"], [{ type: "tool_result", tool_use_id: "toolu_1", content: "file body" }]);
});

test("batches consecutive tool results into a single user message", () => {
  const payload = build({
    model: "claude-opus-5",
    messages: [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "tool-call", id: "toolu_1", name: "a", arguments: {} },
          { type: "tool-call", id: "toolu_2", name: "b", arguments: {} },
        ],
      },
      { role: "tool", toolCallId: "toolu_1", isError: false, content: [{ type: "text", text: "one" }] },
      { role: "tool", toolCallId: "toolu_2", isError: true, content: [{ type: "text", text: "boom" }] },
      { role: "user", content: [{ type: "text", text: "thanks" }] },
    ],
  });
  const messages = messagesOf(payload);
  assert.equal(messages.length, 4, "the two tool results must collapse into one user message");
  const batched = messages[2]?.["content"] as readonly RecordValue[];
  assert.equal(batched.length, 2);
  assert.deepEqual(batched[0], { type: "tool_result", tool_use_id: "toolu_1", content: "one" });
  assert.deepEqual(batched[1], { type: "tool_result", tool_use_id: "toolu_2", content: "boom", is_error: true });
  assert.equal(messages[3]?.["role"], "user");
});

test("serialises json content parts and drops empty blocks", () => {
  const payload = build({
    model: "claude-opus-5",
    messages: [
      { role: "user", content: [{ type: "json", value: { a: 1 } }] },
      { role: "assistant", content: [{ type: "text", text: "" }] },
    ],
  });
  const messages = messagesOf(payload);
  assert.equal(messages.length, 1, "an assistant message with only empty text would be rejected by the API");
  assert.deepEqual(messages[0]?.["content"], [{ type: "text", text: '{"a":1}' }]);
});

test("always supplies max_tokens, defaulting when the request omits it", () => {
  const withoutLimit = build({ model: "claude-opus-5", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  assert.equal(withoutLimit["max_tokens"], DEFAULT_MAX_OUTPUT_TOKENS);

  const withLimit = build({ model: "claude-opus-5", maxOutputTokens: 321, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  assert.equal(withLimit["max_tokens"], 321);

  const overrideDefault = buildAnthropicMessagesPayload(
    { model: "claude-opus-5", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    { defaultMaxOutputTokens: 42 },
  );
  assert.equal(overrideDefault["max_tokens"], 42);

  const clamped = build({ model: "claude-opus-5", maxOutputTokens: 5_000_000, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  assert.equal(clamped["max_tokens"], MAX_OUTPUT_TOKENS_CEILING);
});

test("maps tools and temperature, and carries json mode as a system instruction", () => {
  const payload = build({
    model: "claude-opus-5",
    temperature: 0.5,
    responseFormat: "json",
    tools: [{ name: "read_file", description: "Reads a file.", inputSchema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  });
  assert.equal(payload["temperature"], 0.5);
  assert.deepEqual(payload["tools"], [
    { name: "read_file", description: "Reads a file.", input_schema: { type: "object", properties: {} } },
  ]);
  assert.equal(payload["system"], JSON_RESPONSE_INSTRUCTION);
  assert.ok(!Object.hasOwn(payload, "response_format"));
});

const responseBody = (overrides: RecordValue = {}): RecordValue => ({
  id: "msg_1",
  model: "claude-opus-5",
  stop_reason: "end_turn",
  content: [{ type: "text", text: "hello" }],
  usage: { input_tokens: 10, output_tokens: 4 },
  ...overrides,
});

test("parses text and tool_use blocks back into neutral assistant content", () => {
  const parsed = parseAnthropicMessagesResponse(
    responseBody({
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "ignored" },
        { type: "text", text: "Calling a tool." },
        { type: "tool_use", id: "toolu_9", name: "read_file", input: { path: "a.ts" } },
      ],
    }),
    "anthropic",
  );
  assert.equal(parsed.id, "msg_1");
  assert.equal(parsed.providerId, "anthropic");
  assert.equal(parsed.finishReason, "tool-calls");
  assert.equal(parsed.message.content.length, 2, "thinking blocks have no neutral representation and are dropped");
  const call = parsed.message.content[1];
  assert.equal(call?.type, "tool-call");
  const toolCall = call as ToolCallContent;
  assert.equal(toolCall.id, "toolu_9");
  assert.equal(toolCall.name, "read_file");
  // The validator hands back null-prototype objects for JSON values, so the
  // arguments are spread into a plain object before comparison.
  assert.deepEqual({ ...toolCall.arguments }, { path: "a.ts" });
});

test("maps every documented stop reason onto the neutral finish reason union", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["max_tokens", "length"],
    ["tool_use", "tool-calls"],
    ["refusal", "content-filter"],
    ["pause_turn", "other"],
    ["something_new", "other"],
  ];
  for (const [stopReason, expected] of cases) {
    const parsed = parseAnthropicMessagesResponse(responseBody({ stop_reason: stopReason }), "anthropic");
    assert.equal(parsed.finishReason, expected, `stop_reason ${stopReason}`);
  }
  assert.equal(parseAnthropicMessagesResponse(responseBody({ stop_reason: null }), "anthropic").finishReason, "other");
});

test("reads input_tokens/output_tokens and folds cache counters into the input total", () => {
  const plain = parseAnthropicMessagesResponse(responseBody(), "anthropic");
  assert.deepEqual(plain.usage, { inputTokens: 10, outputTokens: 4, totalTokens: 14 });

  const cached = parseAnthropicMessagesResponse(
    responseBody({ usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 } }),
    "anthropic",
  );
  // Anthropic excludes cached tokens from input_tokens, but the neutral
  // contract requires cachedInputTokens <= inputTokens and a consistent total.
  assert.equal(cached.usage.inputTokens, 45);
  assert.equal(cached.usage.cachedInputTokens, 30);
  assert.equal(cached.usage.totalTokens, 49);
});

test("rejects a response missing usage or identity fields", () => {
  assert.throws(() => parseAnthropicMessagesResponse(responseBody({ usage: {} }), "anthropic"), ModelValidationError);
  assert.throws(() => parseAnthropicMessagesResponse(responseBody({ id: undefined }), "anthropic"), ModelValidationError);
  assert.throws(() => parseAnthropicMessagesResponse("not an object", "anthropic"), ModelValidationError);
});
