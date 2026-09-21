import assert from "node:assert/strict";
import test from "node:test";

import {
  ChildAgentError,
  ChildAgentRegistry,
} from "../src/agent/child-agents.mjs";

const fullBudget = {
  inputTokens: 1_000,
  outputTokens: 500,
  toolCalls: 20,
  elapsedMs: 60_000,
  costMicroUsd: 10_000,
};

const allocation = (overrides = {}) => ({
  inputTokens: 100,
  outputTokens: 50,
  toolCalls: 5,
  elapsedMs: 5_000,
  costMicroUsd: 1_000,
  ...overrides,
});

function harness(options = {}) {
  let nextId = 0;
  let tick = 0;
  const registry = new ChildAgentRegistry({
    idFactory: () => `id-${++nextId}`,
    now: () => `2026-09-21T00:00:${String(tick++).padStart(2, "0")}.000Z`,
    ...options,
  });
  const root = registry.createRoot({
    name: "lead",
    capabilities: {
      tools: ["repo.read", "repo.write", "browser.use"],
      policy: {
        allowedActions: ["read", "write", "deploy"],
        requiredApprovals: ["deploy"],
        deniedActions: ["purchase"],
      },
      budget: fullBudget,
    },
  });
  return { registry, root };
}

test("spawn records parent/child identity and queues an immutable initial instruction", () => {
  const { registry, root } = harness();
  const child = registry.spawn(root.id, {
    name: "researcher",
    task: "Map the repository.",
    capabilities: { budget: allocation() },
  });

  assert.equal(child.parentId, root.id);
  assert.equal(child.rootId, root.id);
  assert.equal(child.depth, 1);
  assert.deepEqual(child.path, [root.id, child.id]);
  assert.equal(child.status, "queued");
  assert.deepEqual(registry.status(root.id).childIds, [child.id]);
  assert.deepEqual(registry.messages(child.id).map(({ kind, text }) => ({ kind, text })), [
    { kind: "instruction", text: "Map the repository." },
  ]);
});

test("capabilities can only narrow tools/actions and tighten policy", () => {
  const { registry, root } = harness();
  const child = registry.spawn(root.id, {
    name: "builder",
    task: "Build safely.",
    capabilities: {
      tools: ["repo.read", "repo.write"],
      policy: {
        allowedActions: ["read", "write"],
        requiredApprovals: ["deploy", "write"],
        deniedActions: ["purchase", "deploy"],
      },
      budget: allocation(),
    },
  });
  assert.deepEqual(child.capabilities.tools, ["repo.read", "repo.write"]);
  assert.deepEqual(child.capabilities.policy.requiredApprovals, ["deploy", "write"]);

  assert.throws(() => registry.spawn(root.id, {
    name: "escalator",
    task: "Try more authority.",
    capabilities: { tools: ["shell.admin"], budget: allocation() },
  }), (error) => error instanceof ChildAgentError && error.code === "CAPABILITY_ESCALATION");
  assert.throws(() => registry.spawn(root.id, {
    name: "approval-remover",
    task: "Try fewer approvals.",
    capabilities: {
      policy: { allowedActions: ["read"], requiredApprovals: [], deniedActions: ["purchase"] },
      budget: allocation(),
    },
  }), (error) => error.code === "CAPABILITY_ESCALATION");
});

test("parallel child budgets are reserved and unused allowance is returned", () => {
  const { registry, root } = harness();
  const first = registry.spawn(root.id, { name: "a", task: "A", capabilities: { budget: allocation({ toolCalls: 12 }) } });
  assert.equal(registry.status(root.id).budgetAvailable.toolCalls, 8);
  assert.throws(() => registry.spawn(root.id, {
    name: "b",
    task: "B",
    capabilities: { budget: allocation({ toolCalls: 9 }) },
  }), (error) => error.code === "BUDGET_UNAVAILABLE");

  registry.start(first.id);
  registry.complete(first.id, { summary: "A done", usage: allocation({ toolCalls: 3 }) });
  const parent = registry.status(root.id);
  assert.equal(parent.budgetReserved.toolCalls, 0);
  assert.equal(parent.budgetConsumed.toolCalls, 3);
  assert.equal(parent.budgetAvailable.toolCalls, 17);
});

test("depth and lifetime fanout limits are enforced", () => {
  const { registry, root } = harness({ maxDepth: 1, maxFanout: 1 });
  const child = registry.spawn(root.id, { name: "only", task: "Only", capabilities: { budget: allocation() } });
  assert.throws(() => registry.spawn(root.id, { name: "extra", task: "Extra", capabilities: { budget: allocation() } }), (error) => error.code === "MAX_FANOUT");
  registry.start(child.id);
  assert.throws(() => registry.spawn(child.id, { name: "deep", task: "Deep", capabilities: { budget: allocation({ toolCalls: 1 }) } }), (error) => error.code === "MAX_DEPTH");
});

test("messages are scoped to family relationships and terminal inboxes are closed", () => {
  const { registry, root } = harness();
  const left = registry.spawn(root.id, { name: "left", task: "Left", capabilities: { budget: allocation() } });
  const right = registry.spawn(root.id, { name: "right", task: "Right", capabilities: { budget: allocation() } });
  const message = registry.send(left.id, right.id, { kind: "context", text: "Shared finding", metadata: { file: "a.mjs" } });
  assert.equal(message.fromId, left.id);
  assert.equal(registry.messages(right.id, { after: 1 }).at(0).text, "Shared finding");

  registry.start(left.id);
  registry.complete(left.id, { summary: "Done" });
  assert.throws(() => registry.send(left.id, root.id, { kind: "status", text: "late" }), (error) => error.code === "TERMINAL_AGENT");
});

test("stop and resume cascade without making terminal agents resumable", () => {
  const { registry, root } = harness();
  const child = registry.spawn(root.id, { name: "child", task: "Work", capabilities: { budget: allocation() } });
  registry.start(child.id);
  registry.stop(root.id, "operator takeover");
  assert.equal(registry.status(root.id).status, "stopped");
  assert.equal(registry.status(child.id).status, "stopped");

  registry.resume(root.id);
  assert.equal(registry.status(root.id).status, "running");
  assert.equal(registry.status(child.id).status, "running");
  registry.complete(child.id, { summary: "Done" });
  assert.throws(() => registry.resume(child.id), (error) => error.code === "TERMINAL_AGENT");
});

test("structured results roll descendant usage up exactly once", () => {
  const { registry, root } = harness({ maxDepth: 3 });
  const child = registry.spawn(root.id, { name: "builder", task: "Build", capabilities: { budget: allocation() } });
  registry.start(child.id);
  const grandchild = registry.spawn(child.id, {
    name: "reviewer",
    task: "Review",
    capabilities: { budget: allocation({ inputTokens: 20, outputTokens: 10, toolCalls: 1, elapsedMs: 500, costMicroUsd: 100 }) },
  });
  registry.start(grandchild.id);
  registry.complete(grandchild.id, {
    summary: "Review passed",
    outputs: [{ type: "report", path: "review.json" }],
    evidence: [{ type: "test", passed: true }],
    usage: allocation({ inputTokens: 5, outputTokens: 2, toolCalls: 1, elapsedMs: 50, costMicroUsd: 10 }),
    handoff: { nextActions: ["merge"], context: { sha: "abc" } },
  });
  const done = registry.complete(child.id, {
    summary: "Feature complete",
    usage: allocation({ inputTokens: 10, outputTokens: 3, toolCalls: 1, elapsedMs: 100, costMicroUsd: 20 }),
    handoff: { nextActions: ["deploy"] },
  });
  assert.equal(done.result.usage.toolCalls, 2);
  assert.equal(registry.status(root.id).budgetConsumed.toolCalls, 2);
  assert.deepEqual(registry.status(grandchild.id).result.handoff.nextActions, ["merge"]);
});

test("parents cannot finish with live children and cancellation is terminal-safe", () => {
  const { registry, root } = harness();
  const child = registry.spawn(root.id, { name: "builder", task: "Build", capabilities: { budget: allocation() } });
  registry.start(child.id);
  assert.throws(() => registry.complete(root.id, { summary: "Too early" }), (error) => error.code === "CHILDREN_ACTIVE");

  const cancelled = registry.cancel(root.id, "mission cancelled");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(registry.status(child.id).status, "cancelled");
  assert.equal(registry.cancel(root.id).status, "cancelled", "repeated cancellation is idempotent");
  assert.throws(() => registry.complete(root.id, { summary: "resurrect" }), (error) => error.code === "TERMINAL_AGENT");
});

test("invalid or incomplete budget contracts fail closed", () => {
  const { registry, root } = harness();
  assert.throws(() => registry.spawn(root.id, { name: "missing", task: "No allocation" }), (error) => error.code === "INVALID_CONTRACT");
  assert.throws(() => registry.spawn(root.id, {
    name: "partial",
    task: "Partial allocation",
    capabilities: { budget: { toolCalls: 1 } },
  }), (error) => error.code === "INVALID_CONTRACT");
});
