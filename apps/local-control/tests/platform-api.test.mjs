import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PlatformTaskStore } from "../src/platform/index.mjs";
import { AgentFamilyRegistry } from "../src/platform/family/index.mjs";
import { ScopedMemoryStore } from "../src/platform/memory/memory-store.mjs";
import { TerminalController } from "../src/platform/terminal/terminal-controller.mjs";
import { McpGateway } from "../src/platform/mcp/gateway.mjs";
import { LOCAL_TENANT_ID } from "../src/platform/api-routes.mjs";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";
const DEVICE_TOKEN = "device-token-device-token-device-token";
const T = LOCAL_TENANT_ID;

async function harness(t, { services = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-platform-api-"));
  const store = new LocalTaskStore(join(directory, "atlas.sqlite"));
  store.addDevice("Phone", createHash("sha256").update(DEVICE_TOKEN).digest("hex"));
  const platformStore = new PlatformTaskStore(join(directory, "platform.sqlite"));
  const family = services ? new AgentFamilyRegistry(join(directory, "family.sqlite")) : null;
  const memory = services ? new ScopedMemoryStore(join(directory, "memory.sqlite")) : null;
  const terminal = services ? new TerminalController({ rootDirectory: join(directory, "workspaces"), prlimit: false }) : null;
  const mcp = services ? new McpGateway({}) : null;
  const server = createLocalControlServer({
    store, token: TOKEN, runTask: async () => ({ ok: true, message: "ok" }), platformStore,
    platformServices: services ? { family, memory, terminal, mcp, browserProbe: () => ({ available: false, reason: "not installed in test" }) } : {},
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    platformStore.close();
    family?.close();
    memory?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (method, path, { body, token = TOKEN, headers = {}, raw } = {}) => {
    const init = { method, headers: { ...(token && { authorization: `Bearer ${token}` }), ...headers } };
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    const response = await fetch(`${origin}/v1/platform${path}`, init);
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, headers: response.headers, data };
  };
  return { origin, request, store, platformStore, family, memory };
}

const newTask = (overrides = {}) => ({ objective: "Summarize open invoices.", successCriteria: ["Every open invoice is listed."], budget: { toolCalls: 10 }, ...overrides });

test("platform API requires a token, and a paired device may read but never write", async (t) => {
  const { request } = await harness(t);
  assert.equal((await request("GET", "/approvals", { token: null })).status, 401);
  assert.equal((await request("POST", "/tasks", { token: null, body: newTask() })).status, 401);

  const device = await request("GET", "/whoami", { token: DEVICE_TOKEN });
  assert.equal(device.status, 200);
  assert.equal(device.data.canWrite, false);
  assert.equal((await request("GET", "/approvals", { token: DEVICE_TOKEN })).status, 200);
  for (const [method, path, body] of [
    ["POST", "/tasks", newTask()],
    ["POST", "/emergency-stop", { confirm: true }],
    ["POST", "/memory", { content: "x" }],
    ["POST", "/agents", { role: "x", family: "y", permissions: [] }],
  ]) {
    const response = await request(method, path, { token: DEVICE_TOKEN, body });
    assert.equal(response.status, 403, `${method} ${path}`);
  }
  assert.equal((await request("GET", "/memory/export", { token: DEVICE_TOKEN })).status, 403);
  assert.equal((await request("GET", "/whoami")).data.canWrite, true);
});

test("create → authorize → queue → cancel, with cancellation reaching child tasks", async (t) => {
  const { request, platformStore } = await harness(t);
  const created = await request("POST", "/tasks", { body: newTask() });
  assert.equal(created.status, 201);
  const task = created.data.task;
  assert.equal(task.status, "proposed");
  assert.deepEqual(task.budget, { toolCalls: 10 });

  assert.equal((await request("POST", `/tasks/${task.id}/transitions`, { body: { to: "queued" } })).status, 409, "cannot skip authorization");
  assert.equal((await request("POST", `/tasks/${task.id}/transitions`, { body: { to: "running" } })).status, 422, "owner cannot force running");
  const authorized = await request("POST", `/tasks/${task.id}/transitions`, { body: { to: "authorized", reason: "looks fine" } });
  assert.equal(authorized.data.task.status, "authorized");
  const queued = await request("POST", `/tasks/${task.id}/transitions`, { body: { to: "queued" } });
  assert.equal(queued.data.task.status, "queued");

  const child = platformStore.createTask({ tenantId: T, userId: "owner", parentTaskId: task.id, objective: "Child", successCriteria: ["x"], budget: {} });
  const grandchild = platformStore.createTask({ tenantId: T, userId: "owner", parentTaskId: child.id, objective: "Grandchild", successCriteria: ["x"], budget: {} });
  platformStore.transitionTask(T, child.id, "authorized");

  const cancelled = await request("POST", `/tasks/${task.id}/cancel`, { body: { reason: "changed my mind" } });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.task.status, "cancelled");
  assert.deepEqual(new Set(cancelled.data.cancelled), new Set([task.id, child.id, grandchild.id]));
  assert.equal(platformStore.getTask(T, grandchild.id).status, "cancelled");
  assert.equal((await request("POST", `/tasks/${task.id}/cancel`, { body: {} })).status, 409);

  const timeline = await request("GET", `/tasks/${task.id}/timeline`);
  assert.deepEqual(timeline.data.entries.filter((e) => e.kind === "transition").map((e) => e.to), ["authorized", "queued", "cancelled"]);
  assert.equal((await request("GET", `/tasks/tsk_${"0".repeat(32)}/timeline`)).status, 404);
});

test("create_task is idempotent per Idempotency-Key and refuses a reused key with a different body", async (t) => {
  const { request, platformStore } = await harness(t);
  const headers = { "idempotency-key": "create-once-123" };
  const first = await request("POST", "/tasks", { body: newTask(), headers });
  const second = await request("POST", "/tasks", { body: newTask(), headers });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("idempotent-replay"), "true");
  assert.equal(second.data.task.id, first.data.task.id);
  assert.equal(platformStore.listTasks(T).length, 1);
  assert.equal((await request("POST", "/tasks", { body: newTask({ objective: "Something else." }), headers })).status, 422);
  assert.equal((await request("POST", "/tasks", { body: newTask(), headers: { "idempotency-key": "bad key!" } })).status, 400);
});

test("request bodies are validated strictly", async (t) => {
  const { request } = await harness(t);
  assert.equal((await request("POST", "/tasks", { body: { objective: "x", successCriteria: ["y"] } })).status, 422, "budget required");
  assert.equal((await request("POST", "/tasks", { body: newTask({ extra: true }) })).status, 422, "unknown property");
  assert.equal((await request("POST", "/tasks", { body: newTask({ successCriteria: [] }) })).status, 422);
  assert.equal((await request("POST", "/tasks", { body: newTask({ budget: { toolCalls: -1 } }) })).status, 422);
  assert.equal((await request("POST", "/tasks", { body: newTask({ budget: { dollars: 5 } }) })).status, 422);
  assert.equal((await request("POST", "/tasks", { raw: "{not json", headers: { "content-type": "application/json" } })).status, 400);
  assert.equal((await request("POST", "/tasks", { raw: JSON.stringify(newTask()), headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await request("POST", "/tasks", { raw: JSON.stringify(newTask({ objective: "x".repeat(40_000) })), headers: { "content-type": "application/json" } })).status, 413);
  assert.equal((await request("POST", "/emergency-stop", { body: {} })).status, 422, "stop needs explicit confirmation");
  assert.equal((await request("POST", "/emergency-stop", { body: { confirm: "yes" } })).status, 422);
  assert.equal((await request("GET", "/approvals?status=bogus")).status, 422);
  assert.equal((await request("DELETE", "/tasks")).status, 405);
});

test("approvals inbox: approve once, reject fails the waiting task, second decision is refused", async (t) => {
  const { request, platformStore } = await harness(t);
  const task = platformStore.createTask({ tenantId: T, userId: "owner", objective: "Send the invoice email.", successCriteria: ["sent"], budget: {} });
  for (const to of ["authorized", "queued", "running", "waiting_for_approval"]) platformStore.transitionTask(T, task.id, to);
  const first = platformStore.createApproval({ tenantId: T, taskId: task.id, tool: "email.send", actionDigest: "sha256:a", requestedBy: "agent" });
  const second = platformStore.createApproval({ tenantId: T, taskId: task.id, tool: "email.send", actionDigest: "sha256:b", requestedBy: "agent" });

  const blockers = await request("GET", `/tasks/${task.id}/blockers`);
  assert.equal(blockers.data.blocked, true);
  assert.match(blockers.data.reason, /approval of email\.send/u);

  const inbox = await request("GET", "/approvals?status=pending");
  assert.equal(inbox.data.approvals.length, 2);
  assert.equal(inbox.data.approvals[0].task.objective, "Send the invoice email.");

  const approved = await request("POST", `/approvals/${first.id}/decision`, { body: { decision: "approve" } });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.approval.status, "approved");
  assert.equal(approved.data.approval.resolvedBy, "owner");
  assert.equal((await request("POST", `/approvals/${first.id}/decision`, { body: { decision: "reject" } })).status, 409);
  assert.equal((await request("POST", `/approvals/${first.id}/decision`, { body: { decision: "maybe" } })).status, 422);
  assert.equal((await request("POST", `/approvals/apr_${"0".repeat(32)}/decision`, { body: { decision: "approve" } })).status, 404);

  const rejected = await request("POST", `/approvals/${second.id}/decision`, { body: { decision: "reject", reason: "wrong recipient" } });
  assert.equal(rejected.data.approval.status, "rejected");
  assert.equal(rejected.data.task.status, "failed");
  assert.equal((await request("GET", "/approvals?status=pending")).data.approvals.length, 0);
});

test("artifacts and a secret-free replay timeline", async (t) => {
  const { request, platformStore } = await harness(t);
  const task = platformStore.createTask({ tenantId: T, userId: "owner", objective: "Fetch data.", successCriteria: ["done"], budget: {} });
  for (const to of ["authorized", "queued", "running"]) platformStore.transitionTask(T, task.id, to);
  const call = platformStore.recordToolCall({
    tenantId: T, taskId: task.id, userId: "owner", tool: "http.fetch", idempotencyKey: "k1",
    input: { url: "https://user:hunter2hunter2@example.com/x", apiKey: "plain-secret-value", note: "Bearer abcdefghijklmnopqrstuvwxyz0123" },
  });
  platformStore.updateToolCall(T, call.id, { status: "succeeded", output: { body: "token=supersecretvalue99", inputTokens: 12 }, durationMs: 5 });
  platformStore.submitArtifact({ tenantId: T, taskId: task.id, kind: "report", content: { rows: 3 } });

  const artifacts = await request("GET", `/tasks/${task.id}/artifacts`);
  assert.equal(artifacts.data.artifacts[0].kind, "report");

  const timeline = await request("GET", `/tasks/${task.id}/timeline`);
  const text = JSON.stringify(timeline.data);
  for (const secret of ["hunter2hunter2", "plain-secret-value", "abcdefghijklmnopqrstuvwxyz0123", "supersecretvalue99"]) {
    assert.ok(!text.includes(secret), `timeline leaked ${secret}`);
  }
  const kinds = timeline.data.entries.map((e) => e.kind);
  assert.ok(kinds.includes("transition") && kinds.includes("tool_call") && kinds.includes("event"));
  const times = timeline.data.entries.map((e) => e.at);
  assert.deepEqual(times, [...times].sort());
  const toolEntry = timeline.data.entries.find((e) => e.kind === "tool_call");
  assert.equal(toolEntry.output.inputTokens, 12, "usage counters are not mistaken for secrets");
});

test("family: propose and authorize, refusing privilege escalation; delegate and cross-family help", async (t) => {
  const { request } = await harness(t);
  const root = await request("POST", "/agents", { body: { role: "root", family: "atlas", name: "Root", permissions: ["repo.*", "web.search"], budget: { toolCalls: 100 } } });
  assert.equal(root.status, 201);
  assert.equal(root.data.agent.state, "proposed");
  assert.equal((await request("POST", `/agents/${root.data.agent.id}/authorize`, { body: {} })).data.agent.state, "authorized");

  const escalating = await request("POST", "/agents", { body: { parentId: root.data.agent.id, role: "deployer", family: "engineering", permissions: ["deploy.production"] } });
  assert.equal(escalating.status, 201);
  const refused = await request("POST", `/agents/${escalating.data.agent.id}/authorize`, { body: {} });
  assert.equal(refused.status, 403);
  assert.equal(refused.data.code, "PERMISSION_ESCALATION");
  const overBudget = await request("POST", "/agents", { body: { parentId: root.data.agent.id, role: "big", family: "engineering", permissions: ["repo.read"], budget: { toolCalls: 1000 } } });
  assert.equal((await request("POST", `/agents/${overBudget.data.agent.id}/authorize`, { body: {} })).status, 422);
  assert.equal((await request("POST", "/agents", { body: { role: "x", family: "y", permissions: ["NOT VALID"] } })).status, 422);
  assert.equal((await request("POST", `/agents/agt_${"0".repeat(32)}/authorize`, { body: {} })).status, 404);

  const coder = await request("POST", "/agents", { body: { parentId: root.data.agent.id, role: "backend", family: "atlas", permissions: ["repo.read"], budget: { toolCalls: 10 } } });
  await request("POST", `/agents/${coder.data.agent.id}/authorize`, { body: {} });
  const researcher = await request("POST", "/agents", { body: { parentId: root.data.agent.id, role: "web_research", family: "research", permissions: ["web.search"], budget: { toolCalls: 10 } } });
  await request("POST", `/agents/${researcher.data.agent.id}/authorize`, { body: {} });

  const tree = await request("GET", "/family");
  assert.equal(tree.data.trees.length, 1);
  const states = Object.fromEntries(tree.data.trees[0].children.map((c) => [c.role, c.state]));
  assert.deepEqual(states, { deployer: "rejected", big: "rejected", backend: "authorized", web_research: "authorized" });

  const task = (await request("POST", "/tasks", { body: newTask() })).data.task;
  const delegated = await request("POST", `/tasks/${task.id}/delegate`, {
    body: { fromAgentId: root.data.agent.id, toAgentId: coder.data.agent.id, objective: "Read the repo.", successCriteria: ["files listed"] },
  });
  assert.equal(delegated.status, 201, JSON.stringify(delegated.data));
  assert.equal(delegated.data.task.parentTaskId, task.id);
  assert.equal(delegated.data.task.agentId, coder.data.agent.id);
  const upward = await request("POST", `/tasks/${task.id}/delegate`, {
    body: { fromAgentId: coder.data.agent.id, toAgentId: root.data.agent.id, objective: "Up.", successCriteria: ["x"] },
  });
  assert.equal(upward.status, 403);

  const help = await request("POST", `/tasks/${task.id}/cross-family-help`, { body: { fromAgentId: root.data.agent.id, toFamily: "research", scope: { question: "Find the API docs" } } });
  assert.equal(help.status, 201);
  assert.equal(help.data.helper.family, "research");
  assert.equal((await request("GET", "/family")).data.crossFamilyRequests.length, 1);

  const cancelled = await request("POST", `/tasks/${task.id}/cancel`, { body: {} });
  assert.equal(cancelled.data.cancelled.length, 3, "delegated and helper subtasks are cancelled with the parent");
  assert.ok(cancelled.data.cancelledAssignments.length >= 1);
});

test("memory: write, search, correct, export and delete", async (t) => {
  const { request } = await harness(t);
  const written = await request("POST", "/memory", { body: { content: "The staging database lives on port 5433." } });
  assert.equal(written.status, 201);
  const id = written.data.entry.id;
  assert.equal((await request("POST", "/memory", { body: { content: "x", kind: "verified_fact" } })).status, 422, "facts need promotion");

  const secret = await request("POST", "/memory", { body: { content: "api_key=sk-ant-abcdefghijklmnopqrstuvwx" } });
  assert.equal(secret.data.entry.redacted, true);
  assert.ok(!secret.data.entry.content.includes("abcdefghijklmnop"));

  const found = await request("GET", "/memory?query=staging");
  assert.deepEqual(found.data.entries.map((e) => e.id), [id]);

  const corrected = await request("POST", `/memory/${id}/correct`, { body: { content: "The staging database lives on port 5434.", reason: "port changed" } });
  assert.equal(corrected.status, 201);
  assert.equal(corrected.data.entry.version, 2);
  assert.equal((await request("POST", `/memory/${id}/correct`, { body: { content: "again", reason: "r" } })).status, 409);

  const exported = await request("GET", "/memory/export");
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-disposition"), /attachment/u);
  assert.ok(exported.data.entries.some((e) => e.content.includes("5434")));

  const deleted = await request("DELETE", `/memory/${corrected.data.entry.id}`);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.erasedIds.length, 2, "the whole version lineage is erased");
  assert.equal((await request("GET", "/memory?query=staging")).data.entries.length, 0);
  assert.equal((await request("DELETE", `/memory/mem_${"0".repeat(32)}`)).status, 404);
});

test("emergency stop cancels everything in flight, rejects pending approvals and is audited", async (t) => {
  const { request, platformStore, store } = await harness(t);
  const make = (objective, path) => {
    const task = platformStore.createTask({ tenantId: T, userId: "owner", objective, successCriteria: ["x"], budget: {} });
    for (const to of path) platformStore.transitionTask(T, task.id, to);
    return task;
  };
  const running = make("Running", ["authorized", "queued", "running"]);
  const waiting = make("Waiting", ["authorized", "queued", "running", "waiting_for_approval"]);
  const verifying = make("Verifying", ["authorized", "queued", "running", "verifying"]);
  const proposed = make("Proposed", []);
  const done = make("Done", ["authorized", "queued", "running", "verifying", "completed"]);
  const approval = platformStore.createApproval({ tenantId: T, taskId: waiting.id, tool: "payment.send", actionDigest: "sha256:c" });

  const stop = await request("POST", "/emergency-stop", { body: { confirm: true, reason: "test" } });
  assert.equal(stop.status, 200);
  assert.deepEqual(new Set(stop.data.cancelled), new Set([running.id, waiting.id, verifying.id]));
  assert.deepEqual(stop.data.rejectedApprovals, [approval.id]);
  for (const task of [running, waiting, verifying]) assert.equal(platformStore.getTask(T, task.id).status, "cancelled");
  assert.equal(platformStore.getTask(T, proposed.id).status, "proposed", "a proposal was never in flight");
  assert.equal(platformStore.getTask(T, done.id).status, "completed");
  assert.equal(platformStore.getApproval(T, approval.id).status, "rejected");
  assert.ok(store.auditEvents().some((event) => event.category === "platform.emergency_stop"));
});

test("costs aggregate usage, and worker health reports every subsystem", async (t) => {
  const { request, platformStore } = await harness(t);
  const a = platformStore.createTask({ tenantId: T, userId: "owner", agentId: "agt_" + "1".repeat(32), objective: "A", successCriteria: ["x"], budget: {} });
  const b = platformStore.createTask({ tenantId: T, userId: "owner", objective: "B", successCriteria: ["x"], budget: {} });
  platformStore.recordUsage(T, a.id, { toolCalls: 3, costMicroUsd: 1500 });
  platformStore.recordUsage(T, b.id, { toolCalls: 2, costMicroUsd: 500 });
  const costs = await request("GET", "/costs");
  assert.equal(costs.data.totals.toolCalls, 5);
  assert.equal(costs.data.totals.costMicroUsd, 2000);
  assert.equal(costs.data.agents.length, 2);

  const workers = await request("GET", "/workers");
  assert.equal(workers.data.browser.available, false);
  assert.equal(workers.data.terminal.available, true);
  assert.equal(workers.data.terminal.capabilities.noShell, true);
  assert.deepEqual(workers.data.mcp.servers, []);
  assert.equal(workers.data.memory.available, true);
});

test("without family or memory services those routes say so", async (t) => {
  const { request } = await harness(t, { services: false });
  assert.equal((await request("GET", "/family")).status, 503);
  assert.equal((await request("GET", "/memory")).status, 503);
  assert.equal((await request("GET", "/workers")).data.terminal.available, false);
  assert.equal((await request("POST", "/tasks", { body: newTask() })).status, 201);
});
