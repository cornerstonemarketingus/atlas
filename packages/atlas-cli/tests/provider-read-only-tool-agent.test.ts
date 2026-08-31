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

test("fails safely when an unregistered tool is requested", async () => {
  const provider = new MockModelProvider({ metadata, responses: [
    response("one", [{ type: "tool-call", id: "bad", name: "repository.delete", arguments: {} }], "tool-calls"),
  ] });
  const agent = new ProviderReadOnlyToolAgent({
    provider, model: "test", registry: registry("allow"), tools: [tool], audit: new InMemorySessionAuditLog(),
  });
  const result = await agent.run({
    sessionId: "session", objective: "Inspect", evidence: [],
    scope: { kind: "repository", repositoryId: "atlas" }, context: { repositoryId: "atlas" },
  });
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.message : "", /Unknown read-only tool/u);
});
