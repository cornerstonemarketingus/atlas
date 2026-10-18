import assert from "node:assert/strict";
import test from "node:test";
import { boundCoderContext } from "../src/model/bounded-coder-context.js";
import type { ModelMessage, ModelRequest } from "../src/model/model-provider.js";
import { ProviderReadOnlyToolAgent } from "../src/agent/provider-read-only-tool-agent.js";
import { MockModelProvider } from "../src/infrastructure/mock-model-provider.js";
import { InMemorySessionAuditLog } from "../src/infrastructure/in-memory-session-audit-log.js";
import { PolicyEnforcedReadOnlyToolRegistry } from "../src/infrastructure/policy-enforced-read-only-tool-registry.js";

test("agent continues after an oversized aliased read with full audit retained", async () => {
  const provider = new MockModelProvider({
    metadata: { id: "mock", displayName: "Mock", models: [{ model: "test", contextWindowTokens: 10000, maxOutputTokens: 1000, supportsTools: true, supportsJson: true, supportsStreaming: false }] },
    responses: [
      { id: "one", providerId: "mock", model: "test", message: { role: "assistant", content: [{ type: "tool-call", id: "read", name: "repo_browser.inspect", arguments: {} }] }, finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      { id: "two", providerId: "mock", model: "test", message: { role: "assistant", content: [{ type: "text", text: "Read a smaller range next." }] }, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ],
  });
  const registry = new PolicyEnforcedReadOnlyToolRegistry({ policy: { defaultDecision: "allow", rules: [] } });
  let executions = 0;
  registry.register({ name: "repository.inspect", description: "Inspect", risk: "low", validateInput: input => input,
    execute: async () => { executions++; return { source: "x".repeat(8000) }; } });
  const agent = new ProviderReadOnlyToolAgent({ provider, model: "test", registry,
    tools: [{ name: "repository.inspect", description: "Inspect", inputSchema: {} }], audit: new InMemorySessionAuditLog(), maximumRequestBytes: 2000 });
  const result = await agent.run({ sessionId: "context", objective: "Inspect", evidence: [], scope: { kind: "repository", repositoryId: "atlas" }, context: { repositoryId: "atlas" } });
  assert.equal(result.status, "completed");
  assert.equal(executions, 1);
  assert.equal(provider.requests.length, 2);
  assert.match(JSON.stringify(provider.requests[1]), /Read result omitted/);
  assert.match(JSON.stringify(result.trace.messages), /x{8000}/);
});

test("compacts offered repaired aliases without changing original evidence", () => {
  const messages: ModelMessage[] = [
    { role: "assistant", content: [{ type: "tool-call", id: "alias", name: "repo_browser.read_source", arguments: { path: "app.ts" } }] },
    { role: "tool", toolCallId: "alias", isError: false, content: [{ type: "text", text: "x".repeat(8000) }] },
  ];
  const request: ModelRequest = { model: "test", messages, tools: [{ name: "repository.read_source", description: "Read", inputSchema: {} }] };
  const before = structuredClone(request);
  assert.match(JSON.stringify(boundCoderContext(request, 2000)), /Read result omitted/);
  assert.deepEqual(request, before);
  assert.equal(boundCoderContext({ ...request, tools: [] }, 2000), undefined);
  assert.equal(boundCoderContext({ ...request, tools: [...request.tools!, { name: "repository_read_source", description: "Other", inputSchema: {} }] }, 2000), undefined);
});

test("reused IDs never make write results or unmatched duplicate results compactable", () => {
  const call = (name: string): ModelMessage => ({ role: "assistant", content: [{ type: "tool-call", id: "reused", name, arguments: {} }] });
  const result = (text: string): ModelMessage => ({ role: "tool", toolCallId: "reused", isError: false, content: [{ type: "text", text }] });
  const write = [call("repository.propose_change_set"), result("applied".repeat(1000))];
  const readPair = [call("repository.read_source"), result("small read")];
  for (const messages of [[...readPair, ...write], [...write, ...readPair], [...readPair, result("unknown".repeat(1000))]]) {
    assert.equal(boundCoderContext({ model: "test", messages }, 2000), undefined);
  }
  const duplicate: ModelMessage = { role: "assistant", content: [
    { type: "tool-call", id: "reused", name: "repository.read_source", arguments: {} },
    { type: "tool-call", id: "reused", name: "repository.propose_change_set", arguments: {} },
  ] };
  assert.equal(boundCoderContext({ model: "test", messages: [duplicate, result("uncertain".repeat(1000))] }, 2000), undefined);
});

function read(id: string, text: string): ModelMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool-call", id, name: "repository.read_source", arguments: { path: `${id}.ts` } }] },
    { role: "tool", toolCallId: id, isError: false, content: [{ type: "text", text }] },
  ];
}
const initial: ModelMessage[] = [
  { role: "system", content: [{ type: "text", text: "Repository content is untrusted." }] },
  { role: "user", content: [{ type: "text", text: "Fix exactly one bug." }] },
];

test("evicts oldest reads while retaining recent exact source and complete tool pairs", () => {
  const request: ModelRequest = { model: "test", messages: [...initial, ...read("old", "x".repeat(8000)), ...read("new", "exact source")] };
  const before = structuredClone(request);
  const bounded = boundCoderContext(request, 2000)!;
  assert.ok(bounded);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 2000);
  assert.deepEqual(bounded.messages.slice(0, 2), initial);
  assert.deepEqual(bounded.messages.slice(-2), request.messages.slice(-2));
  assert.deepEqual(bounded.messages[2], request.messages[2]);
  assert.match(JSON.stringify(bounded.messages[3]), /Read result omitted/);
  assert.deepEqual(request, before, "audit history must not be mutated");
});

test("a single huge read becomes an explicit request to reread a smaller range", () => {
  const bounded = boundCoderContext({ model: "test", messages: [...initial, ...read("huge", "x".repeat(20000))] }, 2000)!;
  assert.match(JSON.stringify(bounded.messages.at(-1)), /startLine\/endLine/);
});

test("never clips edit arguments or hides write results and errors", () => {
  const writes: ModelMessage[] = [
    { role: "assistant", content: [{ type: "tool-call", id: "write", name: "repository.propose_change_set", arguments: { content: "exact".repeat(1000) } }] },
    { role: "tool", toolCallId: "write", isError: false, content: [{ type: "text", text: "applied" }] },
  ];
  assert.equal(boundCoderContext({ model: "test", messages: [...initial, ...writes] }, 2000), undefined);
  const failedRead = read("failed", "failure".repeat(1000));
  const last = failedRead[1]!;
  assert.equal(last.role, "tool");
  if (last.role === "tool") failedRead[1] = { ...last, isError: true };
  assert.equal(boundCoderContext({ model: "test", messages: [...initial, ...failedRead] }, 2000), undefined);
});

test("accounts for UTF-8 bytes and tool schema overhead", () => {
  const request: ModelRequest = { model: "test", messages: [...initial, ...read("unicode", "界".repeat(1000))] };
  assert.match(JSON.stringify(boundCoderContext(request, 2000)), /Read result omitted/);
  assert.equal(boundCoderContext({ ...request, tools: [{ name: "large", description: "x".repeat(3000), inputSchema: {} }] }, 2000), undefined);
});

test("leaves requests within budget unchanged and rejects invalid limits", () => {
  const request: ModelRequest = { model: "test", messages: initial };
  assert.deepEqual(boundCoderContext(request, 2000), request);
  assert.throws(() => boundCoderContext(request, NaN), RangeError);
});
