import assert from "node:assert/strict";
import test from "node:test";
import { renderCodeText, toCodeOutput, toVerifiedCodeOutput } from "../src/presentation/code-renderers.js";
import type { VerifiedCoderResult } from "../src/agent/verified-coder-session.js";

const trace = {
  turns: 2,
  toolCalls: 1,
  usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
  messages: [],
};

test("toCodeOutput surfaces which provider/model answered the final turn", () => {
  const output = toCodeOutput(
    "session",
    { status: "completed", response: "Done", trace: { ...trace, lastProviderId: "local", lastModel: "llama3.1" } },
    [],
  );
  assert.equal(output.answeredBy, "local (llama3.1)");
  assert.match(renderCodeText(output), /Answered by: local \(llama3\.1\)/u);
});

test("toCodeOutput omits answeredBy when the trace never recorded a provider", () => {
  const output = toCodeOutput("session", { status: "completed", response: "Done", trace }, []);
  assert.equal(output.answeredBy, undefined);
  assert.doesNotMatch(renderCodeText(output), /Answered by/u);
});

test("toVerifiedCodeOutput threads the caller-supplied answeredBy from the usage summary", () => {
  const result: VerifiedCoderResult = {
    status: "completed",
    response: "Done",
    message: null,
    edits: [],
    verification: { status: "verified", attempts: 1, profileIds: [], summary: null, newFailures: [], message: "All checks passed." },
  };
  const output = toVerifiedCodeOutput("session", result, {
    turns: 2, toolCalls: 1, inputTokens: 10, outputTokens: 4, answeredBy: "groq (llama-3.3-70b)",
  });
  assert.equal(output.answeredBy, "groq (llama-3.3-70b)");
  assert.match(renderCodeText(output), /Answered by: groq \(llama-3\.3-70b\)/u);
});

test("toVerifiedCodeOutput omits answeredBy when no pass reported a provider", () => {
  const result: VerifiedCoderResult = {
    status: "completed",
    response: "Done",
    message: null,
    edits: [],
    verification: { status: "verified", attempts: 1, profileIds: [], summary: null, newFailures: [], message: "All checks passed." },
  };
  const output = toVerifiedCodeOutput("session", result, { turns: 2, toolCalls: 1, inputTokens: 10, outputTokens: 4 });
  assert.equal(output.answeredBy, undefined);
  assert.doesNotMatch(renderCodeText(output), /Answered by/u);
});
