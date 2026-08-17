import assert from "node:assert/strict";
import test from "node:test";
import { renderChatJson, renderChatText, toChatOutput } from "../src/presentation/chat-renderers.js";

const trace = {
  turns: 2,
  toolCalls: 1,
  usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
  messages: [],
};

test("renders completed chat output without exposing message traces", () => {
  const output = toChatOutput("session", { status: "completed", response: "Done", trace });
  assert.match(renderChatText(output), /^Done/u);
  assert.equal(JSON.parse(renderChatJson(output)).messages, undefined);
});

test("explains the explicit source approval flag", () => {
  const output = toChatOutput("session", {
    status: "approval-required",
    toolCallId: "call",
    toolName: "repository.read_source",
    trace,
  });
  assert.match(output.message ?? "", /--allow-source/u);
  assert.equal(output.pendingTool, "repository.read_source");
});
