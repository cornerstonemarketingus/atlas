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

test("coder corrects textual tool JSON once and executes only a subsequent structured call", async () => {
  const text = '```json\n{"name":"repository.inspect","arguments":{}}\n```';
  const provider = new MockModelProvider({ metadata, responses: [
    response("text", [{ type: "text", text }], "stop"),
    response("call", [{ type: "tool-call", id: "real-call", name: tool.name, arguments: {} }], "tool-calls"),
    response("done", [{ type: "text", text: "Inspected the repository." }], "stop"),
  ] });
  const audit = new InMemorySessionAuditLog();
  const result = await new ProviderReadOnlyToolAgent({ provider, model: "test", registry: registry("allow"), tools: [tool], audit, recoverTextualToolCalls: true }).run({
    sessionId: "textual", objective: "Inspect", evidence: [], scope: { kind: "global" }, context: { repositoryId: "atlas" },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.trace.turns, 3);
  assert.equal(result.trace.usage.outputTokens, 9, "correction spends from the same usage ledger");
  assert.equal(result.trace.toolCalls, 1);
  assert.match(JSON.stringify(provider.requests[1]?.messages.at(-1)), /structured tool_calls/);
  const calls = audit.snapshot().filter(e => e.type === "tool.requested");
  assert.equal(calls.length, 1);
  assert.ok("toolCallId" in calls[0]!.payload && calls[0]!.payload.toolCallId === "real-call");
});

for (const scenario of ["repeated", "unexecuted-final", "last-turn", "approval"] as const) {
  test(`textual tool correction remains bounded and respects policy: ${scenario}`, async () => {
    const text = JSON.stringify({ tool_calls: [{ function: { name: tool.name, arguments: "{}" } }] });
    const next = scenario === "approval"
      ? response("next", [{ type: "tool-call", id: "requires-approval", name: tool.name, arguments: {} }], "tool-calls")
      : response("next", [{ type: "text", text: scenario === "repeated" ? text : "Done" }], "stop");
    const provider = new MockModelProvider({ metadata, responses: [response("first", [{ type: "text", text }], "stop"), next] });
    const audit = new InMemorySessionAuditLog();
    const result = await new ProviderReadOnlyToolAgent({ provider, model: "test", registry: registry("ask"), tools: [tool], audit,
      maximumTurns: scenario === "last-turn" ? 1 : 8, recoverTextualToolCalls: true }).run({
      sessionId: "bounded-text", objective: "Inspect", evidence: [], scope: { kind: "global" }, context: { repositoryId: "atlas" },
    });
    assert.equal(result.status, scenario === "approval" ? "approval-required" : "blocked");
    assert.equal(provider.requests.length, scenario === "last-turn" ? 1 : 2);
    assert.ok(!audit.snapshot().some(e => e.type === "session.completed"));
  });
}

test("read-only explanations and ordinary coder JSON are not textual tool execution", async () => {
  for (const [enabled, text] of [[false, '{"name":"repository.inspect","arguments":{}}'], [true, '{"name":"report","count":2}']] as const) {
    const provider = new MockModelProvider({ metadata, responses: [response("explanation", [{ type: "text", text }], "stop")] });
    const result = await new ProviderReadOnlyToolAgent({ provider, model: "test", registry: registry("allow"), tools: [tool],
      audit: new InMemorySessionAuditLog(), recoverTextualToolCalls: enabled }).run({
      sessionId: "explanation", objective: "Explain", evidence: [], scope: { kind: "global" }, context: { repositoryId: "atlas" },
    });
    assert.equal(result.status, "completed");
    assert.equal(result.trace.toolCalls, 0);
  }
});

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
    response("one", [{ type: "tool-call", id: "call-1", name: "unavailable.inspect", arguments: {} }], "tool-calls"),
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

for (const alias of ["repo.search", "repo_browser.search", "repository_search", "repositorySearch", "repository-search", "Repository.Search", "repo_browser.read_file", "repositoryReadSource"]) {
  test(`repairs ${alias} at dispatch without a corrective model turn`, async () => {
    const canonical = /read/iu.test(alias) ? "repository.read_source" : "repository.search";
    let executions = 0;
    const target = new PolicyEnforcedReadOnlyToolRegistry({ policy: { defaultDecision: "allow", rules: [] } });
    target.register({ name: canonical, description: "Read", risk: "low",
      validateInput: input => { assert.deepEqual(Object.entries(input as Record<string, unknown>), [["query", "Atlas"]]); return input; },
      execute: async () => { executions++; return { evidence: "found" }; } });
    const provider = new MockModelProvider({ metadata, responses: [
      response("one", [{ type: "tool-call", id: "alias", name: alias, arguments: { query: "Atlas" } }], "tool-calls"),
      response("two", [{ type: "text", text: "Found evidence." }], "stop"),
    ] });
    const audit = new InMemorySessionAuditLog();
    const agent = new ProviderReadOnlyToolAgent({ provider, model: "test", registry: target,
      tools: [{ ...tool, name: canonical }], audit, maximumToolCalls: 1, maximumTurns: 2 });
    const result = await agent.run({ sessionId: "alias", objective: "Read evidence", evidence: [],
      scope: { kind: "repository", repositoryId: "atlas" }, context: { repositoryId: "atlas" } });
    assert.equal(result.status, "completed");
    assert.equal(executions, 1);
    assert.equal(result.trace.turns, 2);
    assert.equal(result.trace.toolCalls, 1);
    const message = provider.requests[1]?.messages.at(-1);
    assert.equal(message?.role === "tool" ? message.isError : undefined, false);
    assert.equal(message?.role === "tool" ? message.toolCallId : undefined, "alias");
    const entry = audit.snapshot().find(event => event.type === "tool.requested");
    assert.ok(entry?.type === "tool.requested");
    const { argumentsDigest, ...auditMetadata } = entry.payload as import("../src/domain/session-audit.js").ToolRequestedPayload;
    assert.match(argumentsDigest ?? "", /^hmac-sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(auditMetadata, { requestId: "alias:model:1", toolCallId: "alias",
      toolId: canonical, argumentCount: 1, requestedToolId: alias, repair: "automatic" });
  });
}

for (const scenario of ["ambiguous", "unoffered", "unoffered-exact", "deny", "ask", "scope"] as const) {
  test(`alias dispatch preserves ${scenario} boundary`, async () => {
    let executions = 0;
    const names = scenario === "ambiguous" ? ["repository.search", "repository_search"] : ["repository.search"];
    const target = new PolicyEnforcedReadOnlyToolRegistry({ policy: {
      defaultDecision: scenario === "deny" ? "deny" : scenario === "ask" ? "ask" : "allow", rules: [],
    } });
    for (const name of names) target.register({ name, description: "Search", risk: "low",
      validateInput: input => input, execute: async () => { executions++; return {}; } });
    const provider = new MockModelProvider({ metadata, responses: [
      response("one", [{ type: "tool-call", id: "alias", name: scenario === "unoffered-exact" ? "repository.search" : "repo.search", arguments: {} }], "tool-calls"),
      response("two", [{ type: "text", text: "Could not execute." }], "stop"),
    ] });
    const offered = scenario.startsWith("unoffered") ? [] : names.map(name => ({ ...tool, name }));
    const agent = new ProviderReadOnlyToolAgent({ provider, model: "test", registry: target, tools: offered,
      audit: new InMemorySessionAuditLog() });
    const result = await agent.run({ sessionId: "guard", objective: "Search", evidence: [],
      scope: { kind: "repository", repositoryId: scenario === "scope" ? "other" : "atlas" }, context: { repositoryId: "atlas" } });
    assert.equal(executions, 0);
    if (scenario === "deny" || scenario === "scope") {
      assert.equal(result.status, "failed");
      assert.equal(provider.requests.length, 1);
    } else if (scenario === "ask") {
      assert.equal(result.status, "approval-required");
      assert.equal(result.status === "approval-required" ? result.toolName : undefined, "repository.search");
      assert.equal(provider.requests.length, 1);
    } else {
      const message = provider.requests[1]?.messages.at(-1);
      const payload = JSON.parse(message?.content[0]?.type === "text" ? message.content[0].text : "{}");
      assert.equal(payload.code, "TOOL_NOT_FOUND");
      assert.deepEqual(payload.availableTools, offered.map(item => item.name));
    }
  });
}


test("audit argument identity is canonical, private and local to one run", async () => {
  const sensitive = "private-argument-value-never-audit";
  let executions = 0;
  const target = new PolicyEnforcedReadOnlyToolRegistry({ policy: { defaultDecision: "allow", rules: [] } });
  target.register({ name: tool.name, description: "Inspect", risk: "low", validateInput: input => input,
    execute: async () => { executions++; return {}; } });
  const responses = (prefix: string): ModelResponse[] => [
    response(prefix + "one", [
      { type: "tool-call", id: "a", name: tool.name, arguments: { query: sensitive, nested: { a: 1, b: [2, 3] } } },
      { type: "tool-call", id: "b", name: tool.name, arguments: { nested: { b: [2, 3], a: 1 }, query: sensitive } },
      { type: "tool-call", id: "c", name: tool.name, arguments: { query: sensitive, nested: { a: 1, b: [3, 2] } } },
    ], "tool-calls"), response(prefix + "two", [{ type: "text", text: "Complete" }], "stop"),
  ];
  const provider = new MockModelProvider({ metadata, responses: [...responses("first"), ...responses("second")] });
  const audit = new InMemorySessionAuditLog();
  const agent = new ProviderReadOnlyToolAgent({ provider, model: "test", registry: target, tools: [tool], audit });
  const run = async (sessionId: string) => {
    const start = audit.snapshot().length;
    const beforeExecutions = executions;
    const result = await agent.run({ sessionId, objective: "Inspect", evidence: [], scope: { kind: "global" }, context: { repositoryId: "atlas" } });
    assert.equal(result.status, "completed");
    assert.equal(result.trace.toolCalls, 3);
    assert.equal(executions - beforeExecutions, 3, "diagnostics must not suppress repeated execution");
    assert.doesNotMatch(JSON.stringify(audit.snapshot()), new RegExp(sensitive, "u"));
    const digests = audit.snapshot().slice(start).filter(e => e.type === "tool.requested").map(e => (e.payload as { argumentsDigest?: string }).argumentsDigest);
    for (const digest of digests) assert.match(digest ?? "", /^hmac-sha256:[0-9a-f]{64}$/u);
    assert.equal(digests[0], digests[1], "object key order must not disguise an identical call");
    assert.notEqual(digests[0], digests[2], "array order remains meaningful");
    return digests[0];
  };
  assert.notEqual(await run("first"), await run("second"), "a reused agent must rotate its unpublished key for each run");
});

test("recovered invalid inputs spend the existing tool-call budget", async () => {
  let validations = 0;
  let executions = 0;
  const target = new PolicyEnforcedReadOnlyToolRegistry({ policy: { defaultDecision: "allow", rules: [] } });
  target.register({ name: tool.name, description: "Inspect", risk: "low", validateInput: () => {
    validations++; throw new RepositoryToolInputError("Unknown tool input field: path");
  }, execute: async () => { executions++; return {}; } });
  const provider = new MockModelProvider({ metadata, responses: [
    response("bad", [1, 2, 3].map(id => ({ type: "tool-call" as const, id: String(id), name: tool.name, arguments: { path: "bad" } })), "tool-calls"),
    response("never", [{ type: "text", text: "Must not continue" }], "stop"),
  ] });
  const audit = new InMemorySessionAuditLog();
  const result = await new ProviderReadOnlyToolAgent({ provider, model: "test", registry: target, tools: [tool], audit, maximumToolCalls: 2 }).run({
    sessionId: "bad-input-budget", objective: "Inspect", evidence: [], scope: { kind: "global" }, context: { repositoryId: "atlas" },
  });
  assert.equal(result.status, "blocked");
  assert.match(result.status === "blocked" ? result.message : "", /Tool-call limit reached/u);
  assert.equal(validations, 2);
  assert.equal(executions, 0);
  assert.equal(provider.requests.length, 1);
  assert.equal(audit.snapshot().filter(e => e.type === "tool.completed").length, 2);
});
