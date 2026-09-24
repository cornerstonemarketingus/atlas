import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AgentFamilyRegistry,
  DEFAULT_FAMILY_TREE,
  FamilyError,
  MessageBus,
  TaskDelegation,
  permissionCovers,
  seedFamilies,
} from "../src/platform/family/index.mjs";

const T = "tenant-a";
const U = "tenant-b";
const budget = (n) => ({ toolCalls: n, wallTimeMs: n * 1000, inputTokens: n * 100, outputTokens: n * 10, costMicroUsd: n * 50 });
const code = (c) => (error) => error instanceof FamilyError && error.code === c;

/** root → parentA → {childA1, childA2}; root → parentB → childB1 (cousin of A1/A2). */
function harness(caps = {}) {
  const registry = new AgentFamilyRegistry(":memory:", { caps });
  const delegation = new TaskDelegation(registry);
  const spawn = (spec) => registry.spawnAgent({ tenantId: T, requestedBy: "user-1", persistent: false, ...spec }, { authorizer: "policy-engine" });
  const root = spawn({ parentId: null, role: "root", family: "atlas", persistent: true, permissions: ["repo.*", "browser.*", "web.search"], budget: budget(100) });
  const parentA = spawn({ parentId: root.id, role: "parent", family: "engineering", persistent: true, permissions: ["repo.*"], budget: budget(40) });
  const childA1 = spawn({ parentId: parentA.id, role: "frontend", family: "engineering", permissions: ["repo.read", "repo.write"], budget: budget(10) });
  const childA2 = spawn({ parentId: parentA.id, role: "testing", family: "engineering", permissions: ["repo.read"], budget: budget(10) });
  const parentB = spawn({ parentId: root.id, role: "parent", family: "research", persistent: true, permissions: ["web.search", "browser.read"], budget: budget(20) });
  const childB1 = spawn({ parentId: parentB.id, role: "web_research", family: "research", persistent: true, permissions: ["web.search"], budget: budget(5) });
  return { registry, delegation, bus: delegation.bus, spawn, root, parentA, childA1, childA2, parentB, childB1 };
}

test("glob-aware permission coverage", () => {
  assert.ok(permissionCovers("browser.*", "browser.navigate"));
  assert.ok(permissionCovers("browser.*", "browser.tabs.*"));
  assert.ok(!permissionCovers("browser.navigate", "browser.*"));
  assert.ok(!permissionCovers("browser.*", "browserx.read"));
  assert.ok(!permissionCovers("browser.*", "browser"));
  assert.ok(permissionCovers("*", "anything.at_all"));
});

test("relationship queries: parent, children, siblings, cousins, grandparent, ancestors, descendants", () => {
  const h = harness();
  const { registry: r } = h;
  assert.equal(r.parent(T, h.childA1.id).id, h.parentA.id);
  assert.deepEqual(r.children(T, h.parentA.id).map((a) => a.id), [h.childA1.id, h.childA2.id]);
  assert.deepEqual(r.siblings(T, h.childA1.id).map((a) => a.id), [h.childA2.id]);
  assert.deepEqual(r.cousins(T, h.childA1.id).map((a) => a.id), [h.childB1.id]);
  assert.deepEqual(r.cousins(T, h.childB1.id).map((a) => a.id).sort(), [h.childA1.id, h.childA2.id].sort());
  assert.equal(r.grandparent(T, h.childA1.id).id, h.root.id);
  assert.deepEqual(r.ancestors(T, h.childA1.id).map((a) => a.id), [h.parentA.id, h.root.id]);
  assert.equal(r.descendants(T, h.root.id).length, 5);
  assert.ok(r.relationships(T, h.root.id, { type: "supervises" }).some((e) => e.to === h.childA1.id));
  assert.deepEqual(r.relationships(T, h.childA1.id, { type: "parent_of" }), [{ from: h.parentA.id, to: h.childA1.id, type: "parent_of" }]);
});

test("cousin collaboration only between real cousins; cross-family help shares no authority", () => {
  const h = harness();
  const { registry: r, delegation: d } = h;
  r.addRelationship(T, { from: h.childA1.id, to: h.childB1.id, type: "cousin_collaboration" });
  assert.throws(() => r.addRelationship(T, { from: h.childA1.id, to: h.childA2.id, type: "cousin_collaboration" }), code("NOT_COUSINS"));

  d.delegateTask({ tenantId: T, fromAgentId: h.parentA.id, toAgentId: h.childA1.id, taskId: "task-ui" });
  const before = r.getAgent(T, h.childB1.id).permissions;
  assert.throws(() => d.requestCrossFamilyHelp({ tenantId: T, fromAgentId: h.childA1.id, toAgentId: h.childB1.id, taskId: "task-ui", scope: { query: "x", apiKey: "sk-1" } }), code("SCOPE_LEAKS_AUTHORITY"));
  assert.throws(() => d.requestCrossFamilyHelp({ tenantId: T, fromAgentId: h.childA1.id, toAgentId: h.childA2.id, taskId: "task-ui", scope: { q: 1 } }), code("SAME_FAMILY"));
  const help = d.requestCrossFamilyHelp({ tenantId: T, fromAgentId: h.childA1.id, toFamily: "research", taskId: "task-ui", subtaskId: "task-ui-research", scope: { query: "a11y color contrast guidance" } });
  assert.equal(help.helper.id, h.childB1.id);
  assert.equal(help.message.type, "CROSS_FAMILY_REQUEST");
  assert.deepEqual(Object.keys(help.message.payload).sort(), ["parentTaskId", "requestId", "scope"]);
  assert.equal(d.getAssignment(T, "task-ui-research").ownerAgentId, h.childB1.id);
  assert.equal(d.getAssignment(T, "task-ui-research").kind, "cross_family");
  assert.deepEqual(r.getAgent(T, h.childB1.id).permissions, before);
  assert.equal(d.listCrossFamilyRequests(T).length, 1);
});

test("single accountable owner; reassign transfers explicitly", () => {
  const h = harness();
  const { delegation: d } = h;
  d.assignTask({ tenantId: T, agentId: h.parentA.id, taskId: "task-1" });
  d.delegateTask({ tenantId: T, fromAgentId: h.parentA.id, toAgentId: h.childA1.id, taskId: "task-1a", parentTaskId: "task-1" });
  assert.throws(() => d.delegateTask({ tenantId: T, fromAgentId: h.parentA.id, toAgentId: h.childA2.id, taskId: "task-1a", parentTaskId: "task-1" }), code("TASK_ALREADY_OWNED"));
  assert.equal(d.getAssignment(T, "task-1a").ownerAgentId, h.childA1.id);
  assert.throws(() => d.reassignTask({ tenantId: T, taskId: "task-1a", toAgentId: h.childA2.id, by: h.childB1.id }), code("NOT_ACCOUNTABLE_OWNER"));
  d.reassignTask({ tenantId: T, taskId: "task-1a", toAgentId: h.childA2.id, by: h.parentA.id });
  assert.equal(d.getAssignment(T, "task-1a").ownerAgentId, h.childA2.id);
  assert.deepEqual(d.ownershipHistory(T, "task-1a").map((e) => e.to), [h.childA1.id, h.childA2.id]);
  // only the owner may report
  assert.throws(() => d.submitResult({ tenantId: T, agentId: h.childA1.id, taskId: "task-1a", result: {}, verified: true }), code("NOT_ACCOUNTABLE_OWNER"));
});

test("delegation is downward only, never to self, never recursive, and requires the parent task's owner", () => {
  const h = harness();
  const { delegation: d } = h;
  d.assignTask({ tenantId: T, agentId: h.root.id, taskId: "t" });
  assert.throws(() => d.delegateTask({ tenantId: T, fromAgentId: h.root.id, toAgentId: h.root.id, taskId: "t1", parentTaskId: "t" }), code("SELF_DELEGATION"));
  assert.throws(() => d.delegateTask({ tenantId: T, fromAgentId: h.childA1.id, toAgentId: h.parentA.id, taskId: "t2" }), code("DELEGATION_NOT_DOWNWARD"));
  assert.throws(() => d.delegateTask({ tenantId: T, fromAgentId: h.parentA.id, toAgentId: h.childB1.id, taskId: "t3" }), code("DELEGATION_NOT_DOWNWARD"));
  assert.throws(() => d.delegateTask({ tenantId: T, fromAgentId: h.parentA.id, toAgentId: h.childA1.id, taskId: "t4", parentTaskId: "t" }), code("NOT_ACCOUNTABLE_OWNER"));
  d.delegateTask({ tenantId: T, fromAgentId: h.root.id, toAgentId: h.parentA.id, taskId: "t5", parentTaskId: "t" });
  // grandchild delegation via descendant is allowed
  d.delegateTask({ tenantId: T, fromAgentId: h.root.id, toAgentId: h.childA1.id, taskId: "t6", parentTaskId: "t" });
  // reassigning t5 up to root (already delegating the chain) is refused
  assert.throws(() => d.reassignTask({ tenantId: T, taskId: "t5", toAgentId: h.root.id, by: h.root.id }), code("RECURSIVE_DELEGATION"));
});

test("cycle prevention on parent edges", () => {
  const h = harness();
  const { registry: r } = h;
  assert.throws(() => r.reparentAgent(T, h.parentA.id, h.childA1.id), code("CYCLE_DETECTED"));
  assert.throws(() => r.addRelationship(T, { from: h.childA1.id, to: h.root.id, type: "parent_of" }), code("CYCLE_DETECTED"));
  assert.throws(() => r.reparentAgent(T, h.root.id, h.root.id), code("CYCLE_DETECTED"));
  assert.equal(r.parent(T, h.parentA.id).id, h.root.id);
  // a legal reparent (permissions covered) works and keeps depth consistent
  const moved = r.reparentAgent(T, h.childA2.id, h.root.id);
  assert.equal(moved.parentId, h.root.id);
  assert.equal(moved.depth, 1);
  assert.throws(() => r.reparentAgent(T, h.childA1.id, h.parentB.id), code("PERMISSION_ESCALATION"));
});

test("dependency completion: parent waits for both children's verified RESULTs", () => {
  const h = harness();
  const { delegation: d, bus } = h;
  d.assignTask({ tenantId: T, agentId: h.parentA.id, taskId: "feature" });
  d.delegateTask({ tenantId: T, fromAgentId: h.parentA.id, toAgentId: h.childA1.id, taskId: "impl", parentTaskId: "feature" });
  d.delegateTask({ tenantId: T, fromAgentId: h.parentA.id, toAgentId: h.childA2.id, taskId: "tests", parentTaskId: "feature" });
  d.waitForSubtasks({ tenantId: T, taskId: "feature", agentId: h.parentA.id, subtaskIds: ["impl", "tests"] });
  assert.equal(d.getAssignment(T, "feature").state, "waiting_for_dependency");
  assert.throws(() => d.mergeResults(T, "feature"), code("DEPENDENCIES_PENDING"));

  d.submitResult({ tenantId: T, agentId: h.childA1.id, taskId: "impl", result: { diff: "..." }, verified: true });
  assert.deepEqual(d.dependencyStatus(T, "feature").pending, ["tests"]);
  d.submitResult({ tenantId: T, agentId: h.childA2.id, taskId: "tests", result: { passed: 3 }, verified: false });
  assert.equal(d.getAssignment(T, "feature").state, "waiting_for_dependency");
  assert.throws(() => d.mergeResults(T, "feature"), code("UNVERIFIED_RESULT"));
  d.submitResult({ tenantId: T, agentId: h.childA2.id, taskId: "tests", result: { passed: 3 }, verified: true });
  assert.equal(d.getAssignment(T, "feature").state, "running");
  assert.deepEqual(d.mergeResults(T, "feature").results.map((x) => x.result), [{ diff: "..." }, { passed: 3 }]);
  const results = bus.listMessages(T, { agentId: h.parentA.id, type: "RESULT" });
  assert.equal(results.length, 3);
  // temporary children retire after their task completes; reservation returns to parent
  assert.equal(h.registry.getAgent(T, h.childA1.id).state, "retired");
  assert.deepEqual(h.registry.getAgent(T, h.parentA.id).allocated, budget(0));
});

test("permission inheritance: subset enforced, escalation refused, glob-aware", () => {
  const h = harness();
  const { registry: r } = h;
  const ok = r.spawnAgent({ tenantId: T, parentId: h.parentA.id, role: "x", family: "engineering", permissions: ["repo.read"], requestedBy: "u" }, { authorizer: "p" });
  assert.equal(ok.state, "authorized");
  const bad = r.proposeAgent({ tenantId: T, parentId: h.parentA.id, role: "x", family: "engineering", permissions: ["repo.read", "deploy.execute"], requestedBy: "u" });
  assert.throws(() => r.authorizeAgent(T, bad.id, { authorizer: "p" }), code("PERMISSION_ESCALATION"));
  assert.equal(r.getAgent(T, bad.id).state, "rejected");
  assert.deepEqual(r.transitions(T, bad.id).map((t) => t.to), ["proposed", "rejected"]);
  // parent browser.read, child browser.* → escalation
  assert.throws(() => r.spawnAgent({ tenantId: T, parentId: h.parentB.id, role: "x", family: "research", permissions: ["browser.*"], requestedBy: "u" }, { authorizer: "p" }), code("PERMISSION_ESCALATION"));
  // parent repo.* covers repo.write
  assert.equal(r.spawnAgent({ tenantId: T, parentId: h.parentA.id, role: "x", family: "engineering", permissions: ["repo.write"], requestedBy: "u" }, { authorizer: "p" }).state, "authorized");
  // policy deny list
  assert.throws(() => r.spawnAgent({ tenantId: T, parentId: h.parentA.id, role: "x", family: "engineering", permissions: ["repo.write"], requestedBy: "u" }, { authorizer: "p", policy: { deny: ["repo.write"] } }), code("POLICY_DENIED"));
});

test("role labels grant nothing", () => {
  const h = harness();
  const { registry: r } = h;
  for (const role of ["root", "admin", "guardian", "parent", "superuser"]) {
    const a = r.proposeAgent({ tenantId: T, parentId: h.childA2.id, role, family: "engineering", permissions: ["repo.write"], requestedBy: "u" });
    assert.throws(() => r.authorizeAgent(T, a.id, { authorizer: "p" }), code("PERMISSION_ESCALATION"), role);
    const b = r.proposeAgent({ tenantId: T, parentId: h.childA2.id, role, family: "engineering", permissions: ["repo.read"], requestedBy: "u" });
    assert.equal(r.authorizeAgent(T, b.id, { authorizer: "p" }).permissions.join(), "repo.read", role);
    assert.deepEqual(r.getAgent(T, b.id).permissions, ["repo.read"]);
  }
});

test("budget limits: child allocation exceeding parent's remaining is refused", () => {
  const h = harness();
  const { registry: r } = h;
  // parentA has 40, children hold 10 + 10 → 20 remaining
  assert.deepEqual(r.getAgent(T, h.parentA.id).remaining, budget(20));
  assert.throws(() => r.spawnAgent({ tenantId: T, parentId: h.parentA.id, role: "x", family: "engineering", permissions: ["repo.read"], budget: budget(21), requestedBy: "u" }, { authorizer: "p" }), code("BUDGET_EXCEEDS_PARENT"));
  r.spawnAgent({ tenantId: T, parentId: h.parentA.id, role: "x", family: "engineering", permissions: ["repo.read"], budget: budget(20), requestedBy: "u" }, { authorizer: "p" });
  assert.deepEqual(r.getAgent(T, h.parentA.id).remaining, budget(0));
  assert.throws(() => r.spawnAgent({ tenantId: T, parentId: h.parentA.id, role: "x", family: "engineering", permissions: ["repo.read"], budget: { toolCalls: 1 }, requestedBy: "u" }, { authorizer: "p" }), code("BUDGET_EXCEEDS_PARENT"));
  assert.throws(() => r.chargeBudget(T, h.childA1.id, { toolCalls: 11 }), code("BUDGET_EXHAUSTED"));
});

test("caps: depth, children per parent, total agents, concurrency, per task", () => {
  const h = harness({ maxDepth: 2, maxChildrenPerParent: 2, maxAgents: 7, maxConcurrentRunning: 1, maxAgentsPerTask: 1 });
  const { registry: r } = h;
  assert.throws(() => r.spawnAgent({ tenantId: T, parentId: h.childA1.id, role: "x", family: "e", permissions: ["repo.read"], requestedBy: "u" }, { authorizer: "p" }), code("CAP_MAX_DEPTH"));
  assert.throws(() => r.spawnAgent({ tenantId: T, parentId: h.parentA.id, role: "x", family: "e", permissions: ["repo.read"], requestedBy: "u" }, { authorizer: "p" }), code("CAP_MAX_CHILDREN"));
  r.spawnAgent({ tenantId: T, parentId: h.parentB.id, role: "x", family: "r", permissions: ["web.search"], requestedBy: "u", taskId: "tk" }, { authorizer: "p" });
  assert.throws(() => r.spawnAgent({ tenantId: T, parentId: h.root.id, role: "x", family: "r", permissions: ["web.search"], requestedBy: "u" }, { authorizer: "p" }), code("CAP_MAX_AGENTS"));
  r.setTenantCaps(T, { maxAgents: 20, maxChildrenPerParent: 5 });
  assert.throws(() => r.spawnAgent({ tenantId: T, parentId: h.root.id, role: "x", family: "r", permissions: ["web.search"], requestedBy: "u", taskId: "tk" }, { authorizer: "p" }), code("CAP_MAX_AGENTS_PER_TASK"));
  r.markRunning(T, h.childA1.id);
  assert.throws(() => r.markRunning(T, h.childA2.id), code("CAP_MAX_RUNNING"));
  // caps are per tenant
  assert.equal(r.getTenantCaps(U).maxAgents, 7);
});

test("lifecycle: persistent agents return to idle and are reused before spawning", () => {
  const h = harness();
  const { registry: r } = h;
  assert.equal(r.findReusableAgent(T, { family: "research", requiredPermissions: ["web.search"] })?.persistent, true);
  assert.equal(r.findReusableAgent(T, { family: "engineering", role: "frontend", requiredPermissions: ["repo.read"] }), null, "temporary agents are not reused");
  assert.equal(r.findReusableAgent(T, { requiredPermissions: ["deploy.execute"] }), null);
  r.markRunning(T, h.childB1.id);
  assert.equal(r.findReusableAgent(T, { family: "research", role: "web_research" }), null);
  r.completeAgentWork(T, h.childB1.id);
  assert.equal(r.getAgent(T, h.childB1.id).state, "idle");
  assert.equal(r.findReusableAgent(T, { family: "research", role: "web_research", requiredPermissions: ["web.search"] }).id, h.childB1.id);
  r.completeAgentWork(T, h.childA1.id);
  assert.equal(r.getAgent(T, h.childA1.id).state, "retired");
  assert.deepEqual(r.transitions(T, h.childB1.id).map((t) => t.to), ["proposed", "authorized", "running", "idle"]);
});

test("cancellation propagates to all delegated descendants", () => {
  const h = harness();
  const { delegation: d, bus } = h;
  d.assignTask({ tenantId: T, agentId: h.root.id, taskId: "big" });
  d.delegateTask({ tenantId: T, fromAgentId: h.root.id, toAgentId: h.parentA.id, taskId: "eng", parentTaskId: "big" });
  d.delegateTask({ tenantId: T, fromAgentId: h.parentA.id, toAgentId: h.childA1.id, taskId: "eng-1", parentTaskId: "eng" });
  d.delegateTask({ tenantId: T, fromAgentId: h.parentA.id, toAgentId: h.childA2.id, taskId: "eng-2", parentTaskId: "eng" });
  d.requestCrossFamilyHelp({ tenantId: T, fromAgentId: h.childA1.id, toAgentId: h.childB1.id, taskId: "eng-1", subtaskId: "eng-1-help", scope: { q: "x" } });
  d.delegateTask({ tenantId: T, fromAgentId: h.root.id, toAgentId: h.parentB.id, taskId: "res", parentTaskId: "big" });
  d.submitResult({ tenantId: T, agentId: h.parentB.id, taskId: "res", result: {}, verified: true });
  const cancelled = d.cancelTask(T, "big", { reason: "user aborted" });
  assert.deepEqual(cancelled.map((a) => a.taskId).sort(), ["big", "eng", "eng-1", "eng-1-help", "eng-2"]);
  assert.ok(cancelled.every((a) => a.state === "cancelled"));
  assert.equal(d.getAssignment(T, "res").state, "completed", "completed work is not cancelled");
  const cancels = bus.listMessages(T, { type: "CANCEL" });
  assert.deepEqual(new Set(cancels.map((m) => m.destination)), new Set([h.root.id, h.parentA.id, h.childA1.id, h.childA2.id, h.childB1.id]));
  assert.deepEqual(d.cancelTask(T, "big"), [], "idempotent");
});

test("messages are schema-validated, append-only, and dead-lettered for retired agents", () => {
  const h = harness();
  const { registry: r, bus } = h;
  const ok = bus.sendMessage({ tenantId: T, type: "PROGRESS", source: h.childA1.id, destination: h.parentA.id, taskId: "t", payload: { pct: 50 } });
  assert.equal(ok.delivered, true);
  assert.equal(ok.message.schemaVersion, "atlas.v1");
  assert.match(ok.message.correlationId, /^cor_/);
  assert.throws(() => bus.sendMessage({ tenantId: T, type: "GOSSIP", source: h.childA1.id, destination: h.parentA.id, taskId: "t", payload: {} }), /SCHEMA|invalid/i);
  assert.throws(() => r.db.prepare("DELETE FROM agent_messages").run(), /append-only/);
  assert.throws(() => r.db.prepare("UPDATE agent_messages SET type = 'CANCEL'").run(), /append-only/);

  r.retireAgent(T, h.childA2.id);
  const dead = bus.sendMessage({ tenantId: T, type: "TASK_ASSIGNMENT", source: h.childA1.id, destination: h.childA2.id, taskId: "t", payload: {} });
  assert.equal(dead.delivered, false);
  assert.equal(dead.escalation.type, "ESCALATION");
  assert.equal(dead.escalation.destination, h.parentA.id);
  assert.equal(bus.listDeadLetters(T).length, 1);
  assert.equal(bus.listDeadLetters(T)[0].reason, "destination is retired");
  const unknown = bus.sendMessage({ tenantId: T, type: "PROGRESS", source: h.childA1.id, destination: "agt_nobody", taskId: "t", payload: {} });
  assert.equal(unknown.delivered, false);
  assert.equal(bus.listMessages(T, { type: "ESCALATION" }).length, 2);
  assert.equal(bus.listMessages(T, { taskId: "t", agentId: h.childA2.id }).length, 0, "dead letters are not delivered");
  // delegation to a retired agent is refused outright
  assert.throws(() => h.delegation.delegateTask({ tenantId: T, fromAgentId: h.parentA.id, toAgentId: h.childA2.id, taskId: "zz" }), code("AGENT_NOT_ACTIVE"));
});

test("tenant isolation: every read requires and filters by tenant", () => {
  const h = harness();
  const { registry: r, delegation: d, bus } = h;
  d.assignTask({ tenantId: T, agentId: h.root.id, taskId: "secret-task" });
  assert.equal(r.getAgent(U, h.root.id), null);
  assert.deepEqual(r.listAgents(U), []);
  assert.equal(d.getAssignment(U, "secret-task"), null);
  assert.deepEqual(bus.listMessages(U), []);
  assert.throws(() => r.children(undefined, h.root.id), code("TENANT_REQUIRED"));
  assert.throws(() => r.listAgents(""), code("TENANT_REQUIRED"));
  assert.throws(() => bus.listMessages(null), code("TENANT_REQUIRED"));
  // cross-tenant parent is invisible
  assert.throws(() => r.proposeAgent({ tenantId: U, parentId: h.root.id, role: "x", family: "f", permissions: [], requestedBy: "u" }), code("AGENT_NOT_FOUND"));
  assert.throws(() => d.delegateTask({ tenantId: U, fromAgentId: h.root.id, toAgentId: h.parentA.id, taskId: "x" }), code("AGENT_NOT_FOUND"));
  // same task id may exist independently in another tenant
  const other = r.spawnAgent({ tenantId: U, parentId: null, role: "root", family: "atlas", permissions: ["repo.read"], requestedBy: "u" }, { authorizer: "p" });
  d.assignTask({ tenantId: U, agentId: other.id, taskId: "secret-task" });
  assert.equal(d.getAssignment(T, "secret-task").ownerAgentId, h.root.id);
});

test("state is durable across registry instances", () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-family-"));
  try {
    const file = join(dir, "family.sqlite");
    const r1 = new AgentFamilyRegistry(file);
    const a = r1.spawnAgent({ tenantId: T, parentId: null, role: "root", family: "atlas", persistent: true, permissions: ["repo.read"], budget: budget(5), requestedBy: "u" }, { authorizer: "p" });
    new TaskDelegation(r1).assignTask({ tenantId: T, agentId: a.id, taskId: "persist" });
    r1.close();
    const r2 = new AgentFamilyRegistry(file);
    assert.equal(r2.getAgent(T, a.id).state, "authorized");
    assert.equal(new TaskDelegation(r2).getAssignment(T, "persist").ownerAgentId, a.id);
    assert.equal(new MessageBus(r2).listMessages(T, { taskId: "persist" }).length, 1);
    r2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("seedFamilies builds the default tree through the policy path and familyTree nests it", () => {
  const r = new AgentFamilyRegistry();
  const { rootId, agents } = seedFamilies(r, T);
  const tree = r.familyTree(T, rootId);
  assert.equal(tree.name, "Atlas Root");
  assert.deepEqual(tree.children.map((c) => c.name), [
    "Engineering Parent", "Computer Operations Parent", "Business Parent", "Research Parent",
    "Reviewer", "Guardian", "Mentor",
  ]);
  const byName = Object.fromEntries(tree.children.map((c) => [c.name, c]));
  assert.deepEqual(byName["Engineering Parent"].children.map((c) => c.name), ["Frontend Agent", "Backend Agent", "Database Agent", "Testing Agent", "Security Agent", "Deployment Agent"]);
  assert.deepEqual(byName["Computer Operations Parent"].children.map((c) => c.name), ["Browser Agent", "Desktop Agent", "Terminal Agent", "Recovery Agent"]);
  assert.deepEqual(byName["Business Parent"].children.map((c) => c.name), ["Sales Agent", "Marketing Agent", "Customer Support Agent"]);
  assert.deepEqual(byName["Research Parent"].children.map((c) => c.name), ["Web Research Agent", "Document Analysis Agent", "Fact Checking Agent"]);
  assert.equal(byName.Guardian.relationships.filter((e) => e.type === "guards").length, 4);
  assert.equal(byName.Reviewer.relationships.filter((e) => e.type === "reviews").length, 4);
  assert.equal(byName.Mentor.relationships.filter((e) => e.type === "mentors").length, 4);
  assert.equal(Object.keys(agents).length, 24);
  assert.ok(r.listAgents(T).every((a) => a.state === "authorized" && a.authorizedBy === "atlas.seed"));
  // conservative: nothing can deploy/send/pay directly
  assert.ok(!r.getAgent(T, rootId).permissions.some((p) => p === "*" || /^(deploy\.execute|email\.send|payment\.)/.test(p)));
  // idempotent
  assert.equal(seedFamilies(r, T).rootId, rootId);
  assert.equal(r.listAgents(T).length, 24);
  // cousins across families
  assert.ok(r.cousins(T, agents["Frontend Agent"]).some((c) => c.id === agents["Web Research Agent"]));
  // seeding with a policy that denies a needed permission fails atomically
  assert.throws(() => seedFamilies(r, U, { policy: { deny: ["deploy.propose"] } }), (e) => e.code === "POLICY_DENIED");
  assert.equal(r.listAgents(U).filter((a) => a.state !== "rejected").length, 0);
  assert.ok(DEFAULT_FAMILY_TREE.families.length === 4);
});
