import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { newCorrelationId } from "../../../packages/atlas-contracts/src/index.mjs";
import { AuthorizedToolExecutor, PlatformTaskStore, PolicyEngine } from "../../local-control/src/platform/index.mjs";
import { BrowserWorker, browserToolDefinitions } from "../src/index.mjs";
import { runVerifiedExtraction } from "../src/verified-extraction.mjs";
import { skipBrowser, startServer } from "./helpers.mjs";

/**
 * Blueprint §21 item 5: a single agent opens a local test page, extracts a
 * value and returns a verified artifact — with every step authorized by the
 * policy engine, charged to the task budget and recorded in the audit log
 * under one correlation id.
 */
const TENANT = "tenant-demo";
const USER = "user-demo";
const AGENT = "agent-browser-child";
const BROWSER_PERMISSIONS = ["browser.*"];

async function harness(t, { policyRules = [], budget } = {}) {
  const site = await startServer();
  const directory = await mkdtemp(join(tmpdir(), "atlas-slice-"));
  const store = new PlatformTaskStore(join(directory, "platform.sqlite"));
  const policy = new PolicyEngine({
    version: "slice.1",
    rules: [
      { id: "navigate-only-to-fixture", tool: "browser.navigate", allowOrigins: [site.origin] },
      { id: "submit-needs-a-human", tool: "browser.submit", effect: "require_approval" },
      ...policyRules,
    ],
  });
  const executor = new AuthorizedToolExecutor({ store, policy, defaultTimeoutMs: 20_000 });
  const worker = new BrowserWorker({ allowedOrigins: [site.origin] });
  for (const tool of browserToolDefinitions(worker)) executor.register(tool);
  t.after(async () => {
    await worker.closeAll();
    store.close();
    await site.close();
    await rm(directory, { recursive: true, force: true });
  });
  const run = (overrides = {}) => runVerifiedExtraction({
    store, executor, tenantId: TENANT, userId: USER, agentId: AGENT,
    objective: "Read the quote total from the fixture site.",
    startUrl: `${site.origin}/`,
    allowedOrigins: [site.origin],
    navigateSteps: [{ role: "link", name: "View quote" }],
    fields: { total: { testId: "quote-total" } },
    expected: { total: "1,234.56" },
    grantedPermissions: BROWSER_PERMISSIONS,
    ...(budget ? { budget } : {}),
    ...overrides,
  });
  return { site, store, executor, run };
}

test("one agent extracts a value and returns a verified artifact through the authorized executor", { skip: skipBrowser }, async (t) => {
  const { store, run } = await harness(t);
  const correlationId = newCorrelationId();
  const { task, artifact } = await run({ correlationId });

  assert.equal(task.status, "completed");
  assert.equal(task.correlationId, correlationId);
  assert.equal(artifact.verification, "verified");
  assert.equal(artifact.content.values.total, "1,234.56");
  assert.equal(artifact.content.untrusted, true);
  assert.match(artifact.content.screenshotDigest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(artifact.verificationEvidence.some((e) => e.check === "field" && e.ok === true));

  // Every state change was stored, in the legal order.
  const path = store.listTransitions(TENANT, task.id).map((row) => row.to ?? row.toStatus ?? row.to_status);
  assert.deepEqual(path, ["authorized", "queued", "running", "verifying", "completed"]);

  // Every tool call was authorized and succeeded; the session was closed before completion.
  const calls = store.getToolCalls(TENANT, task.id);
  assert.deepEqual(calls.map((c) => c.tool), [
    "browser.create_session", "browser.navigate", "browser.click", "browser.extract", "browser.screenshot", "browser.close_session",
  ]);
  assert.equal(calls.at(-1).status, "succeeded", "the browser session is closed through the executor");
  assert.ok(calls.every((c) => c.status === "succeeded" && c.policyDecisionId));

  // The budget saw each call.
  assert.equal(store.getTask(TENANT, task.id).usage.toolCalls, calls.length);

  // All audit events for the task correlate, and cover the full story.
  const events = store.listEvents(TENANT, { taskId: task.id });
  assert.ok(events.length > 0);
  assert.ok(events.every((e) => e.correlationId === correlationId));
  const types = new Set(events.map((e) => e.type));
  for (const type of ["task.created", "task.transitioned", "tool_call.requested", "tool_call.decided", "tool_call.completed", "artifact.submitted", "artifact.verified"]) {
    assert.ok(types.has(type), `missing ${type} event`);
  }

  // Another tenant sees none of it.
  assert.equal(store.getTask("tenant-other", task.id), null);
  assert.deepEqual(store.listEvents("tenant-other", { taskId: task.id }), []);
});

test("a wrong expected value fails verification instead of being reported as done", { skip: skipBrowser }, async (t) => {
  const { run } = await harness(t);
  const { task, artifact } = await run({ expected: { total: "9,999.99" } });
  assert.equal(artifact.verification, "rejected");
  assert.equal(task.status, "failed");
});

test("policy refuses navigation outside the allowed origins before the browser is asked", { skip: skipBrowser }, async (t) => {
  const { store, run } = await harness(t);
  await assert.rejects(() => run({ startUrl: "http://127.0.0.1:9/elsewhere" }), (error) => {
    assert.equal(error.outcome.status, "denied");
    return true;
  });
  const [task] = store.listTasks(TENANT, {});
  assert.equal(task.status, "failed");
  const navigate = store.getToolCalls(TENANT, task.id).find((c) => c.tool === "browser.navigate");
  assert.equal(navigate.status, "denied");
});

test("without a browser grant, default deny stops the agent at the first tool", { skip: skipBrowser }, async (t) => {
  const { store, run } = await harness(t);
  await assert.rejects(() => run({ grantedPermissions: ["terminal.*"] }), { code: "STEP_FAILED" });
  const [task] = store.listTasks(TENANT, {});
  const calls = store.getToolCalls(TENANT, task.id);
  assert.ok(calls.every((c) => c.status === "denied"));
});

test("the task budget stops a run that needs more tool calls than it was given", { skip: skipBrowser }, async (t) => {
  const { store, run } = await harness(t, { budget: { toolCalls: 3 } });
  await assert.rejects(() => run(), { code: "STEP_FAILED" });
  const [task] = store.listTasks(TENANT, {});
  assert.equal(task.status, "failed");
  assert.ok(store.getTask(TENANT, task.id).usage.toolCalls <= 3);
});

test("a consequential submit waits for a human approval", { skip: skipBrowser }, async (t) => {
  const { store, executor, site } = await harness(t);
  const task = store.createTask({
    tenantId: TENANT, userId: USER, agentId: AGENT, objective: "Place an order.",
    successCriteria: ["order placed"], budget: { toolCalls: 10 },
  });
  for (const to of ["authorized", "queued", "running"]) store.transitionTask(TENANT, task.id, to, { reason: to, actor: USER });
  const invoke = (tool, input, extra = {}) => executor.invoke({
    tenantId: TENANT, userId: USER, agentId: AGENT, taskId: task.id, tool, input, grantedPermissions: BROWSER_PERMISSIONS, ...extra,
  });
  const { result } = await invoke("browser.create_session", { allowedOrigins: [site.origin] });
  const { sessionId } = result.output;
  await invoke("browser.navigate", { sessionId, url: `${site.origin}/quote.html` });
  const submit = await invoke("browser.submit", { sessionId, target: { role: "button", name: "Place order" }, intent: "Place the order" });
  assert.equal(submit.status, "awaiting_approval");
  assert.ok(submit.approvalId);
  assert.ok(!site.hits.some((hit) => hit.startsWith("/thanks.html")), "nothing may be submitted before approval");
  await invoke("browser.close_session", { sessionId });
});
