import assert from "node:assert/strict";
import test from "node:test";
import { migratedDatabase } from "./helpers/d1-sqlite.mjs";
import { resolveTenant, getConversation } from "../db/tenancy.mjs";
import { createProjectConversation, reserveProjectReceipt, recoverableProjectCreator } from "../app/api/genesis/receipts.mjs";
import { projectReceipts, latestProjectReceipt } from "../app/chat/project-receipts.mjs";
import { projectBackend } from "../app/api/genesis/project-backend.mjs";
import { hostedSiteStore } from "../db/hosted-sites.mjs";

async function fixture(t) {
  const { sqlite, d1 } = migratedDatabase({ users: [[1, "alice"], [2, "bob"]] });
  t.after(() => sqlite.close());
  const tenant = await resolveTenant(d1, { userId: "github:alice", dbUserId: 1 });
  const scope = { tenantId: tenant.tenantId, principal: "github:alice" };
  sqlite.prepare("INSERT INTO conversations (id, tenant_id, requested_by, title, repository, branch) VALUES (?, ?, ?, 'Project', '', 'main')").run("thread", scope.tenantId, scope.principal);
  return { sqlite, d1, scope };
}
const operationId = "operation_123456789";

test("hosted fallback saves its actual operation id before persistence and recovers without creation", async t => {
  const { d1, scope } = await fixture(t);
  const store = hostedSiteStore(d1);
  const bridge = { available: false, create: () => assert.fail("No external node"), status: () => assert.fail("Hosted receipt must use hosted status") };
  const backend = projectBackend({ bridge, hosted: { store, scope }, reserve: id => reserveProjectReceipt(d1, scope, "thread", id) });
  const requestId = "11111111-1111-4111-8111-111111111111";
  const description = "Build a website for Acme Roofing in Duluth, Minnesota, with roofing and repair services.";
  // Discard the creation response, as on a lost connection.
  await backend.create({ requestId, description });
  const [receipt] = projectReceipts((await getConversation(d1, scope, "thread")).events);
  assert.equal(receipt.operationId, `gen_${requestId}`);
  const recovered = await backend.status(receipt.operationId);
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.deploymentState, "not-deployed");
  const blocked = projectBackend({ bridge, hosted: { store, scope }, reserve: async () => { throw new Error("History offline"); } });
  const refusedId = "22222222-2222-4222-8222-222222222222";
  const refused = await blocked.create({ requestId: refusedId, description });
  assert.equal(refused.status, "unavailable");
  assert.equal(refused.reason, "history_required");
  assert.match(refused.nextStep, /saved conversation history/);
  assert.equal(await store.get(scope, `gen_${refusedId}`), null);
});

test("lost creation response leaves a scoped durable receipt that reopening history recovers without executing again", async t => {
  const { d1, scope } = await fixture(t);
  let calls = 0;
  const create = recoverableProjectCreator({ reserve: id => reserveProjectReceipt(d1, scope, "thread", id), create: async () => { calls++; throw new Error("response lost after acceptance"); } });
  await assert.rejects(create({ requestId: operationId, description: "Do not store my prompt or secret" }));
  const restored = projectReceipts((await getConversation(d1, scope, "thread")).events);
  assert.deepEqual(restored, [{ operationId, status: "recovering" }]);
  assert.equal(calls, 1);
  assert.equal(await getConversation(d1, { ...scope, principal: "github:bob" }, "thread"), null);
  assert.equal(await getConversation(d1, { ...scope, tenantId: 999999 }, "thread"), null);
});

test("missing, archived, foreign or unavailable history blocks external creation", async t => {
  const { d1, sqlite, scope } = await fixture(t);
  let calls = 0;
  for (const [context, thread] of [[scope,"missing"], [{ ...scope, principal: "github:bob" },"thread"], [{ ...scope, tenantId: 999999 },"thread"], [null,"thread"]]) {
    const result = await recoverableProjectCreator({ reserve: id => reserveProjectReceipt(d1, context, thread, id), create: async () => { calls++; } })({ requestId: operationId });
    assert.equal(result.status, "unavailable");
  }
  sqlite.prepare("UPDATE conversations SET archived_at = 'closed'").run();
  await assert.rejects(reserveProjectReceipt(d1, scope, "thread", operationId));
  const result = await recoverableProjectCreator({ reserve: async () => { throw new Error("D1 offline"); }, create: async () => { calls++; } })({ requestId: operationId });
  assert.equal(result.status, "unavailable");
  assert.equal(calls, 0);
});

test("receipt reservation is idempotent and retains multiple project ids without private payloads", async t => {
  const { d1, scope } = await fixture(t);
  await reserveProjectReceipt(d1, scope, "thread", operationId);
  await reserveProjectReceipt(d1, scope, "thread", operationId);
  await reserveProjectReceipt(d1, scope, "thread", "operation_987654321");
  const detail = await getConversation(d1, scope, "thread");
  assert.equal(detail.events.length, 2);
  assert.equal(projectReceipts(detail.events).length, 2);
  assert.deepEqual(projectReceipts([{kind:"project",detail:'{"operationId":"bad"}'},{kind:"project",detail:"invalid"},{kind:"result",detail:JSON.stringify({operationId})}]), []);
});

test("history refresh keeps live project snapshots stable without restarting status polling", () => {
  const previous = { operationId, status: "published", repository: {fullName:"acme/app"} };
  const events = [{kind:"project",detail:JSON.stringify({operationId})}];
  assert.equal(latestProjectReceipt(events, previous), previous);
  assert.equal(latestProjectReceipt([], previous), previous);
  assert.equal(latestProjectReceipt(events, null).status, "recovering");
});

test("direct creation can save a new owned conversation before reserving its receipt", async t => {
  const {d1, scope} = await fixture(t);
  await createProjectConversation(d1, scope, "new-thread");
  await reserveProjectReceipt(d1, scope, "new-thread", operationId);
  const saved = await getConversation(d1, scope, "new-thread");
  assert.equal(saved.conversation.title,"New project");
  assert.equal(projectReceipts(saved.events)[0].operationId,operationId);
  await assert.rejects(createProjectConversation(d1, scope, "new-thread"));
});
