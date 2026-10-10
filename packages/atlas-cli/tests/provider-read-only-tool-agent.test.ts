import assert from "node:assert/strict";
import test from "node:test";

import { ProviderReadOnlyToolAgent } from "../src/agent/provider-read-only-tool-agent.js";
import { InMemorySessionAuditLog } from "../src/infrastructure/in-memory-session-audit-log.js";
import { MockModelProvider } from "../src/infrastructure/mock-model-provider.js";
import { PolicyEnforcedReadOnlyToolRegistry } from "../src/infrastructure/policy-enforced-read-only-tool-registry.js";
import type { ModelProviderMetadata, ModelResponse, ModelToolDefinition } from "../src/model/model-provider.js";

const metadata: ModelProviderMetadata = {
  id: "mock", displayName: "Mock",
  models: [{ model: "test", contextWindowTokens: 10_000, maxOutputTokens: 1_000, supportsTools: true, supportsJson: true, supportsStreaming: false }],
};
const tool: ModelToolDefinition = {
  name: "repository.inspect",
  description: "Inspect.",
  inputSchema: { type: "object", additionalProperties: false },
};

test("bounds outgoing read context but keeps full audit evidence", async () => {
  const provider = new MockModelProvider({ metadata, responses: [
    response("one", [{ type: "tool-call", id: "read", name: tool.name, arguments: {} }], "tool-calls"),
    response("two", [{ type: "text", text: "Need a narrower read." }], "stop"),
  ] });
  const target = new PolicyEnforcedReadOnlyToolRegistry({ policy: { defaultDecision: "allow", rules: [] } });
  target.register({ name: tool.name, description: "Inspect.", risk: "low", validateInput: (input) => input,
    execute: async () => ({ source: "x".repeat(8000) }) });
  const agent = new ProviderReadOnlyToolAgent({ provider, model: "test", registry: target, tools: [tool],
    audit: new InMemorySessionAuditLog(), maximumRequestBytes: 2000 });
  const result = await agent.run({ sessionId: "session", objective: "Inspect", evidence: [],
    scope: { kind: "repository", repositoryId: "atlas" }, context: { repositoryId: "atlas" } });
  assert.equal(result.status, "completed");
  assert.match(JSON.stringify(provider.requests[1]), /Read result omitted/);
  assert.match(JSON.stringify(result.trace.messages), /x{8000}/);
});

test("blocks an oversized objective before any model request without clipping it", async () => {
  const provider = new MockModelProvider({ metadata, responses: [] });
  const agent = new ProviderReadOnlyToolAgent({ provider, model: "test", registry: registry("allow"), tools: [tool],
    audit: new InMemorySessionAuditLog(), maximumRequestBytes: 2000 });
  const result = await agent.run({ sessionId: "session", objective: "x".repeat(3000), evidence: [],
    scope: { kind: "repository", repositoryId: "atlas" }, context: { repositoryId: "atlas" } });
  assert.equal(result.status, "blocked");
  assert.equal(provider.requests.length, 0);
  assert.match(result.status === "blocked" ? result.message : "", /Split the task/);
});

function response(id: string, content: ModelResponse["message"]["content"], finishReason: ModelResponse["finishReason"]): ModelResponse {
  return {
    id, providerId: "mock", model: "test", message: { role: "assistant", content }, finishReason,
    usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
  };
}

function registry(decision: "allow" | "ask"): PolicyEnforcedReadOnlyToolRegistry {
  const target = new PolicyEnforcedReadOnlyToolRegistry({ policy: { defaultDecision: decision, rules: [] } });
  target.register({
    name: "repository.inspect", description: "Inspect.", risk: "low",
    validateInput: (input) => input,
    execute: async () => ({ repositoryName: "atlas" }),
  });
  return target;
}

test("executes an allowed read tool and completes with an audited response", async () => {
  const provider = new MockModelProvider({ metadata, responses: [
    response("one", [{ type: "tool-call", id: "call-1", name: tool.name, arguments: {} }], "tool-calls"),
    response("two", [{ type: "text", text: "Atlas is a TypeScript repository." }], "stop"),
  ] });
  const audit = new InMemorySessionAuditLog();
  const agent = new ProviderReadOnlyToolAgent({ provider, model: "test", registry: registry("allow"), tools: [tool], audit });

  const result = await agent.run({
    sessionId: "session", objective: "Explain Atlas", evidence: [],
    scope: { kind: "repository", repositoryId: "atlas" }, context: { repositoryId: "atlas" },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.trace.turns, 2);
  assert.equal(result.trace.toolCalls, 1);
  assert.equal(provider.requests[1]?.messages.at(-1)?.role, "tool");
  assert.equal(audit.snapshot().at(-1)?.type, "session.completed");
});

test("feeds a tool's own execution failure back to the model instead of ending the session", async () => {
  const provider = new MockModelProvider({ metadata, responses: [
    response("one", [{ type: "tool-call", id: "call-1", name: tool.name, arguments: {} }], "tool-calls"),
    response("two", [{ type: "text", text: "The file did not exist yet, so I created it." }], "stop"),
  ] });
  const target = new PolicyEnforcedReadOnlyToolRegistry({ policy: { defaultDecision: "allow", rules: [] } });
  target.register({
    name: "repository.inspect", description: "Inspect.", risk: "low",
    validateInput: (input) => input,
    execute: async () => { throw new Error("Unable to read repository path: missing.md"); },
  });
  const audit = new InMemorySessionAuditLog();
  const agent = new ProviderReadOnlyToolAgent({ provider, model: "test", registry: target, tools: [tool], audit });

  const result = await agent.run({
    sessionId: "session", objective: "Read a file that may not exist", evidence: [],
    scope: { kind: "repository", repositoryId: "atlas" }, context: { repositoryId: "atlas" },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.trace.toolCalls, 1);
  const toolMessage = provider.requests[1]?.messages.find((message) => message.role === "tool");
  assert.equal(toolMessage?.role === "tool" ? toolMessage.isError : undefined, true);
  assert.match(
    toolMessage?.role === "tool" ? toolMessage.content.map((part) => part.type === "text" ? part.text : "").join("") : "",
    /Unable to read repository path/u,
  );
});

test("stops before execution when policy requires approval", async () => {
  const provider = new MockModelProvider({ metadata, responses: [
    response("one", [{ type: "tool-call", id: "call-1", name: tool.name, arguments: {} }], "tool-calls"),
  ] });
  const agent = new ProviderReadOnlyToolAgent({
    provider, model: "test", registry: registry("ask"), tools: [tool], audit: new InMemorySessionAuditLog(),
  });
  const result = await agent.run({
    sessionId: "session", objective: "Inspect", evidence: [],
    scope: { kind: "repository", repositoryId: "atlas" }, context: { repositoryId: "atlas" },
  });

  assert.equal(result.status, "approval-required");
  assert.equal(result.status === "approval-required" ? result.toolCallId : null, "call-1");
});

test("never executes an unregistered tool, however dangerous the name", async () => {
  // This used to assert the session FAILED here. It no longer does — see
  // "recovers from an invented tool name" below — but the property that
  // actually matters is unchanged and is now asserted directly: a tool that
  // was never registered is never executed, whatever the model calls it.
  let executed = false;
  const target = new PolicyEnforcedReadOnlyToolRegistry({ policy: { defaultDecision: "allow", rules: [] } });
  target.register({
    name: tool.name, description: "Inspect.", risk: "low",
    validateInput: (input) => input,
    execute: async () => {
      executed = true;
      return { repositoryName: "atlas" };
    },
  });

  const provider = new MockModelProvider({ metadata, responses: [
    response("one", [{ type: "tool-call", id: "bad", name: "repository.delete", arguments: {} }], "tool-calls"),
    response("two", [{ type: "text", text: "There is no such tool, so I did nothing." }], "stop"),
  ] });
  const agent = new ProviderReadOnlyToolAgent({
    provider, model: "test", registry: target, tools: [tool], audit: new InMemorySessionAuditLog(),
  });
  const result = await agent.run({
    sessionId: "session", objective: "Inspect", evidence: [],
    scope: { kind: "repository", repositoryId: "atlas" }, context: { repositoryId: "atlas" },
  });

  assert.equal(executed, false, "an unregistered name must not reach any registered tool");
  assert.equal(result.status, "completed");
  const correction = provider.requests[1]?.messages.at(-1);
  assert.equal(correction?.role, "tool");
  assert.match(
    correction?.content[0]?.type === "text" ? correction.content[0].text : "",
    /TOOL_NOT_FOUND/u,
  );
});

test("recovers from an invented tool name by naming the real tools", async () => {
  // On 2026-09-10 the nightly agent called "repo.search" instead of
  // "repository.search". The registry threw TOOL_NOT_FOUND, the throw reached
  // the session-level catch, and an entire unattended run was lost to a name
  // the model would have corrected if anything had told it the truth.
  const provider = new MockModelProvider({ metadata, responses: [
    response("one", [{ type: "tool-call", id: "call-1", name: "repo.inspect", arguments: {} }], "tool-calls"),
    response("two", [{ type: "tool-call", id: "call-2", name: tool.name, arguments: {} }], "tool-calls"),
    response("three", [{ type: "text", text: "Atlas is a TypeScript repository." }], "stop"),
  ] });
  const audit = new InMemorySessionAuditLog();
  const agent = new ProviderReadOnlyToolAgent({ provider, model: "test", registry: registry("allow"), tools: [tool], audit });

  const result = await agent.run({
    sessionId: "session", objective: "Explain Atlas", evidence: [],
    scope: { kind: "repository", repositoryId: "atlas" }, context: { repositoryId: "atlas" },
  });

  assert.equal(result.status, "completed", "an invented tool name must not end the session");

  // The correction has to carry the real names, or the model is left guessing
  // a second time.
  const correction = provider.requests[1]?.messages.at(-1);
  assert.equal(correction?.role, "tool");
  const payload = JSON.parse(correction?.content[0]?.type === "text" ? correction.content[0].text : "{}") as {
    code?: string;
    availableTools?: string[];
  };
  assert.equal(payload.code, "TOOL_NOT_FOUND");
  assert.deepEqual(payload.availableTools, ["repository.inspect"]);

  const completions = audit.snapshot().filter((event) => event.type === "tool.completed");
  assert.ok(
    completions.some((event) => (event.payload as { errorCode?: string }).errorCode === "TOOL_NOT_FOUND"),
    "the miss should still be audited, not silently swallowed",
  );
});

test("records which provider/model answered the final turn", async () => {
  const provider = new MockModelProvider({ metadata, responses: [
    response("one", [{ type: "tool-call", id: "call-1", name: tool.name, arguments: {} }], "tool-calls"),
    response("two", [{ type: "text", text: "Atlas is a TypeScript repository." }], "stop"),
  ] });
  const agent = new ProviderReadOnlyToolAgent({ provider, model: "test", registry: registry("allow"), tools: [tool], audit: new InMemorySessionAuditLog() });

  const result = await agent.run({
    sessionId: "session", objective: "Explain Atlas", evidence: [],
    scope: { kind: "repository", repositoryId: "atlas" }, context: { repositoryId: "atlas" },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.trace.lastProviderId, "mock");
  assert.equal(result.trace.lastModel, "test");
});

test("still ends the session when policy denies a tool", async () => {
  // TOOL_NOT_FOUND is recoverable because it is the model's mistake. A policy
  // denial is a security decision, and "try again with something else" is the
  // wrong thing to invite after one.
  const denying = new PolicyEnforcedReadOnlyToolRegistry({ policy: { defaultDecision: "deny", rules: [] } });
  denying.register({
    name: tool.name, description: "Inspect.", risk: "low",
    validateInput: (input) => input,
    execute: async () => ({ repositoryName: "atlas" }),
  });
  const provider = new MockModelProvider({ metadata, responses: [
    response("one", [{ type: "tool-call", id: "call-1", name: tool.name, arguments: {} }], "tool-calls"),
    response("two", [{ type: "text", text: "should never be reached" }], "stop"),
  ] });
  const agent = new ProviderReadOnlyToolAgent({
    provider, model: "test", registry: denying, tools: [tool], audit: new InMemorySessionAuditLog(),
  });

  const result = await agent.run({
    sessionId: "session", objective: "Explain Atlas", evidence: [],
    scope: { kind: "repository", repositoryId: "atlas" }, context: { repositoryId: "atlas" },
  });
  assert.equal(result.status, "failed");
});

test("one empty stop can recover without replaying an executed tool", async () => {
  let executions = 0;
  const target = new PolicyEnforcedReadOnlyToolRegistry({ policy: { defaultDecision: "allow", rules: [] } });
  target.register({ name: tool.name, description: "Inspect", risk: "low", validateInput: input => input, execute: async () => { executions++; return { found: true }; } });
  const provider = new MockModelProvider({ metadata, responses: [
    response("one", [{ type: "tool-call", id: "call-1", name: tool.name, arguments: {} }], "tool-calls"),
    response("two", [], "stop"),
    response("three", [{ type: "text", text: "Inspection finished." }], "stop"),
  ] });
  const agent = new ProviderReadOnlyToolAgent({ provider, model: "test", registry: target, tools: [tool], audit: new InMemorySessionAuditLog() });
  const result = await agent.run({ sessionId: "session", objective: "Inspect", evidence: [], scope: { kind: "repository", repositoryId: "atlas" }, context: { repositoryId: "atlas" } });
  assert.equal(result.status, "completed");
  assert.equal(result.trace.turns, 3);
  assert.equal(executions, 1);
  assert.equal(provider.requests[2]?.messages.at(-1)?.role, "user");
});

test("empty-stop recovery remains bounded by one retry and the turn limit", async () => {
  for (const maximumTurns of [1, 4]) {
    const provider = new MockModelProvider({ metadata, responses: [response("one", [], "stop"), response("two", [], "stop"), response("three", [{ type: "text", text: "Must not run" }], "stop")] });
    const agent = new ProviderReadOnlyToolAgent({ provider, model: "test", maximumTurns, registry: registry("allow"), tools: [tool], audit: new InMemorySessionAuditLog() });
    const result = await agent.run({ sessionId: "session", objective: "Inspect", evidence: [], scope: { kind: "repository", repositoryId: "atlas" }, context: { repositoryId: "atlas" } });
    assert.equal(result.status, "blocked");
    assert.equal(result.trace.turns, Math.min(maximumTurns, 2));
  }
});

import { RepositoryToolInputError } from "../src/infrastructure/repository-read-only-tools.js";

test("invalid tool input is corrected on the next turn and remains audited", async () => {
  let executions = 0;
  const search: ModelToolDefinition = { name: "repository.search", description: "Search", inputSchema: {
    type: "object", properties: { query: { type: "string" }, scope: { type: "string" }, maxResults: { type: "number" } }, additionalProperties: false,
  } };
  const target = new PolicyEnforcedReadOnlyToolRegistry({ policy: { defaultDecision: "allow", rules: [] } });
  target.register({ name: search.name, description: search.description, risk: "low", validateInput: input => {
    if ("path" in (input as Record<string, unknown>)) throw new RepositoryToolInputError("Unknown tool input field: path");
    return input;
  }, execute: async () => { executions++; return { matches: [] }; } });
  const provider = new MockModelProvider({ metadata, responses: [
    response("one", [{ type: "tool-call", id: "bad", name: search.name, arguments: { path: "docs", query: "Atlas" } }], "tool-calls"),
    response("two", [{ type: "tool-call", id: "good", name: search.name, arguments: { query: "Atlas" } }], "tool-calls"),
    response("three", [{ type: "text", text: "Search complete." }], "stop"),
  ] });
  const audit = new InMemorySessionAuditLog();
  const agent = new ProviderReadOnlyToolAgent({ provider, model: "test", registry: target, tools: [search], audit });
  const result = await agent.run({ sessionId: "session", objective: "Search", evidence: [], scope: { kind: "repository", repositoryId: "atlas" }, context: { repositoryId: "atlas" } });
  assert.equal(result.status, "completed");
  assert.equal(executions, 1, "invalid input must never execute");
  const correction = provider.requests[1]?.messages.at(-1);
  assert.equal(correction?.role, "tool");
  const payload = JSON.parse(correction?.content[0]?.type === "text" ? correction.content[0].text : "{}");
  assert.match(payload.error, /repository.search/u);
  assert.match(payload.error, /path/u);
  assert.deepEqual(payload.validFields, ["query", "scope", "maxResults"]);
  assert.equal(payload.code, "INVALID_TOOL_INPUT");
  assert.ok(audit.snapshot().some(event => event.type === "tool.completed" && (event.payload as { errorCode?: string }).errorCode === "INVALID_TOOL_INPUT"));
});
