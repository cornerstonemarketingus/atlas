import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLegacyPolicyBridge } from "../src/platform/legacy-policy-bridge.mjs";
import { ToolRegistry } from "../src/agent/tool-registry.mjs";
import { PlatformTaskStore } from "../src/platform/task-store.mjs";

function setup(decision) {
  const events = [];
  const policy = createLegacyPolicyBridge({
    policyForCapability: () => ({ decision }),
    audit: (event) => events.push(event),
  });
  return { policy, events };
}

test("platform policy engine preserves local allow/ask/deny decisions", () => {
  assert.equal(setup("allow").policy("repo.read", "low", { name: "repository.read", risk: "low" }, {}), "allow");
  assert.equal(setup("ask").policy("repo.write", "moderate", { name: "repository.write", risk: "moderate" }, {}), "ask");
  assert.equal(setup("deny").policy("terminal.run", "low", { name: "terminal.run", risk: "low" }, {}), "deny");
  assert.equal(setup(undefined).policy("unknown", "low", { name: "unknown.tool", risk: "low" }, {}), "deny");
});

test("consequential tools require approval even when the saved capability is allowed", () => {
  const { policy, events } = setup("allow");
  assert.equal(policy("communications.send", "high", { name: "communications.send", risk: "high", requiresApproval: true }, { text: "private" }), "ask");
  assert.equal(events[0].effect, "require_approval");
});

test("policy audit includes no raw arguments or secret values", () => {
  const { policy, events } = setup("allow");
  policy("repository.read", "low", { name: "repository.read", risk: "low" }, { path: "secret.txt", token: "do-not-log" }, { agentId: "agent-1", taskId: "task-1" });
  assert.equal(events[0].agentId, "agent-1");
  assert.equal(events[0].taskId, "task-1");
  assert.equal(JSON.stringify(events).includes("do-not-log"), false);
  assert.equal(JSON.stringify(events).includes("secret.txt"), false);
});

test("live ToolRegistry invocations use the bridge while retaining digest approvals", async () => {
  let configured = "ask";
  const events = [];
  const registry = new ToolRegistry({
    policy: createLegacyPolicyBridge({ policyForCapability: () => ({ decision: configured }), audit: (event) => events.push(event) }),
  });
  let executed = 0;
  registry.register({
    name: "demo.write",
    description: "Write one value.",
    capability: "demo.write",
    risk: "low",
    timeoutMs: 1000,
    maxOutputCharacters: 100,
    requiresApproval: false,
    inputSchema: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
    async execute({ input }) { executed += 1; return input.value; },
  });
  const pending = await registry.invoke({ name: "demo.write", rawArguments: JSON.stringify({ value: "approved-value" }), sessionId: "session-1", approvals: { check: async () => false } });
  assert.equal(pending.status, "approval-required");
  assert.equal(executed, 0);
  assert.equal(events.at(-1).effect, "require_approval");

  configured = "deny";
  const denied = await registry.invoke({ name: "demo.write", rawArguments: JSON.stringify({ value: "not-run" }), sessionId: "session-1" });
  assert.equal(denied.code, "POLICY_DENIED");
  assert.equal(executed, 0);

  configured = "allow";
  const allowed = await registry.invoke({ name: "demo.write", rawArguments: JSON.stringify({ value: "ok" }), sessionId: "session-2" });
  assert.equal(allowed.status, "completed");
  assert.equal(executed, 1);
  assert.equal(events.at(-1).effect, "allow");
});

test("team tool policy decisions attach to the durable platform tool-call row", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-policy-bridge-"));
  const store = new PlatformTaskStore(join(directory, "platform.sqlite"));
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const task = store.createTask({ tenantId: "local", userId: "owner", objective: "Read a file.", successCriteria: ["The content is reported."], budget: { toolCalls: 2 } });
  for (const status of ["authorized", "queued", "running"]) store.transitionTask("local", task.id, status, { actor: "test" });
  const call = store.recordToolCall({ tenantId: "local", taskId: task.id, userId: "owner", agentId: "agent-reader", tool: "demo.read", input: {}, status: "requested", idempotencyKey: "test-read" });
  const registry = new ToolRegistry({
    policy: createLegacyPolicyBridge({
      policyForCapability: () => ({ decision: "allow" }),
      audit: (event) => store.transaction(() => {
        store.recordPolicyDecision(event.decision, { toolCallId: event.toolCallId, correlationId: event.correlationId });
        store.updateToolCall(event.tenantId, event.toolCallId, { policyDecisionId: event.decision.id });
      }),
    }),
  });
  registry.register({ name: "demo.read", description: "Read safely.", capability: "demo.read", risk: "low", timeoutMs: 1000, maxOutputCharacters: 100, requiresApproval: false, inputSchema: { type: "object", properties: {} }, async execute() { return "safe"; } });
  const result = await registry.invoke({ name: "demo.read", rawArguments: "{}", sessionId: "mission:1", context: { taskId: task.id, agentId: "agent-reader", toolCallId: call.id, correlationId: task.correlationId } });
  assert.equal(result.status, "completed");
  const persisted = store.getToolCall("local", call.id);
  assert.ok(persisted.policyDecisionId);
  const decision = store.getPolicyDecision("local", persisted.policyDecisionId);
  assert.equal(decision.effect, "allow");
  assert.equal(decision.taskId, task.id);
  assert.equal(decision.agentId, "agent-reader");
});