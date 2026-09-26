import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  addMembership,
  archiveConversation,
  conversationWritable,
  deleteTenantRepository,
  ensureDefaultTenant,
  getConversation,
  listConversations,
  listTasks,
  listTenantRepositories,
  requestedTenantFromHeader,
  resolveTenant,
  setTaskRunId,
  tenantAllowlist,
  tenantMergePolicy,
  upsertTenantRepository,
} from "../db/tenancy.mjs";
import { resolveTenantContext, TENANT_HEADER } from "../app/api/auth/tenant-context.mjs";
import { tenantRepositoryDecision, validateRepositoryReference } from "../app/api/settings/repositories/validation.mjs";
import { visibleTasks } from "../app/api/tasks/run-status.mjs";
import { applyMigrations, d1FromSqlite, migratedDatabase } from "./helpers/d1-sqlite.mjs";

const alice = { userId: "github:alice", dbUserId: 1 };
const bob = { userId: "github:bob", dbUserId: 2 };
const deployment = new Set(["acme/app", "acme/site", "cornerstonemarketingus/atlas"]);

function insertConversation(sqlite, { id, tenantId, principal }) {
  sqlite.prepare("INSERT INTO conversations (id, tenant_id, requested_by, title, repository, branch) VALUES (?, ?, ?, 'title', 'acme/app', 'main')").run(id, tenantId, principal);
  sqlite.prepare("INSERT INTO conversation_messages (id, conversation_id, requested_by, role, content) VALUES (?, ?, ?, 'user', ?)").run(`${id}-m`, id, principal, `secret of ${principal}`);
}

function insertTask(sqlite, { taskId, tenantId, principal, conversationId = null }) {
  sqlite.prepare("INSERT INTO tasks (task_id, tenant_id, requested_by, repository, branch, mode, objective, conversation_id) VALUES (?, ?, ?, 'acme/app', 'main', 'inspect', ?, ?)")
    .run(taskId, tenantId, principal, `objective of ${principal}`, conversationId);
}

/** Two new users, each in their own personal tenant, each owning a conversation and a task. */
async function twoTenants() {
  const { sqlite, d1 } = migratedDatabase({ users: [[1, "alice"], [2, "bob"]] });
  const a = await resolveTenant(d1, alice);
  const b = await resolveTenant(d1, bob);
  insertConversation(sqlite, { id: "conv-a", tenantId: a.tenantId, principal: alice.userId });
  insertConversation(sqlite, { id: "conv-b", tenantId: b.tenantId, principal: bob.userId });
  insertTask(sqlite, { taskId: "task-a", tenantId: a.tenantId, principal: alice.userId, conversationId: "conv-a" });
  insertTask(sqlite, { taskId: "task-b", tenantId: b.tenantId, principal: bob.userId, conversationId: "conv-b" });
  return { sqlite, d1, a, b, scopeA: { tenantId: a.tenantId, principal: alice.userId }, scopeB: { tenantId: b.tenantId, principal: bob.userId } };
}

test("migration 0015 backfills every existing row to one default tenant owned by the deployment owner", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    applyMigrations(sqlite, { until: 14 });
    sqlite.exec(`
      INSERT INTO users (id, github_user_id, github_login) VALUES (1, 101, 'alice'), (2, 102, 'bob');
      INSERT INTO repositories (owner, name, merge_policy) VALUES ('acme', 'app', 'ci-gated');
      INSERT INTO tasks (task_id, user_id, requested_by, repository, branch, mode, objective) VALUES ('t1', 1, 'github:alice', 'acme/app', 'main', 'inspect', 'x'), ('t2', NULL, 'operator', 'acme/app', 'main', 'coder', 'y');
      INSERT INTO conversations (id, requested_by, title, repository, branch) VALUES ('c1', 'github:bob', 't', 'acme/app', 'main');
      INSERT INTO computer_devices (id, requested_by, name, secret_hash) VALUES ('d1', 'github:alice', 'pc', 'hash');
      INSERT INTO computer_tasks (id, requested_by, device_id, objective) VALUES ('ct1', 'github:alice', 'd1', 'o');
      INSERT INTO computer_approvals (id, task_id, requested_by, action_hash, summary, expires_at) VALUES ('a1', 'ct1', 'github:alice', 'h', 's', '2030-01-01');
    `);
    applyMigrations(sqlite, { from: 15 });
    const tenant = sqlite.prepare("SELECT id, slug, kind, owner_principal FROM tenants").all();
    assert.equal(tenant.length, 1);
    assert.deepEqual({ ...tenant[0] }, { id: tenant[0].id, slug: "default", kind: "default", owner_principal: "operator" });
    for (const table of ["repositories", "tasks", "conversations", "computer_devices", "computer_approvals"]) {
      const rows = sqlite.prepare(`SELECT tenant_id FROM ${table}`).all();
      assert.ok(rows.length > 0, table);
      assert.ok(rows.every((row) => row.tenant_id === tenant[0].id), `${table} backfilled`);
    }
    const members = sqlite.prepare("SELECT user_id, role FROM tenant_members ORDER BY user_id").all().map((row) => ({ ...row }));
    assert.deepEqual(members, [{ user_id: 1, role: "member" }, { user_id: 2, role: "member" }]);
    // The allowlist is per tenant now: the same repository may appear once per tenant.
    sqlite.exec("INSERT INTO tenants (slug, name, kind, owner_principal) VALUES ('other', 'Other', 'team', 'github:bob')");
    sqlite.prepare("INSERT INTO repositories (tenant_id, owner, name) VALUES ((SELECT id FROM tenants WHERE slug = 'other'), 'acme', 'app')").run();
    assert.throws(() => sqlite.prepare("INSERT INTO repositories (tenant_id, owner, name) VALUES (?, 'acme', 'app')").run(tenant[0].id), /UNIQUE/u);
  } finally { sqlite.close(); }
});

test("pre-tenancy users, the operator and platform principals resolve to the default tenant", async () => {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite, { until: 14 });
  sqlite.exec("INSERT INTO users (id, github_user_id, github_login) VALUES (1, 101, 'alice')");
  applyMigrations(sqlite, { from: 15 });
  const d1 = d1FromSqlite(sqlite);
  const defaultId = await ensureDefaultTenant(d1);
  assert.deepEqual(await resolveTenant(d1, alice), { tenantId: defaultId, role: "member", principal: "github:alice" });
  assert.deepEqual(await resolveTenant(d1, { userId: "operator", dbUserId: null }), { tenantId: defaultId, role: "owner", principal: "operator" });
  assert.deepEqual(await resolveTenant(d1, { userId: "platform-7", dbUserId: null }), { tenantId: defaultId, role: "member", principal: "platform-7" });
  // A GitHub principal without a users row cannot borrow the default tenant.
  assert.equal(await resolveTenant(d1, { userId: "github:ghost", dbUserId: null }), null);
  assert.equal(await resolveTenant(d1, null), null);
  sqlite.close();
});

test("a new user gets a personal tenant they own, separate from every other tenant", async () => {
  const { sqlite, d1, a, b } = await twoTenants();
  assert.equal(a.role, "owner");
  assert.equal(b.role, "owner");
  assert.notEqual(a.tenantId, b.tenantId);
  assert.notEqual(a.tenantId, await ensureDefaultTenant(d1));
  // Idempotent: resolving again does not mint another tenant.
  assert.deepEqual(await resolveTenant(d1, alice), a);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM tenants WHERE kind = 'personal'").get().n, 2);
  sqlite.close();
});

test("the tenant header selects only a tenant the caller is a member of", async () => {
  const { sqlite, d1, a, b } = await twoTenants();
  const request = (value) => new Request("https://atlas.test/api/tasks", { headers: value === undefined ? {} : { [TENANT_HEADER]: value } });
  assert.equal((await resolveTenantContext(request(undefined), alice, d1)).tenantId, a.tenantId);
  assert.equal((await resolveTenantContext(request(String(a.tenantId)), alice, d1)).tenantId, a.tenantId);
  // Naming someone else's tenant never falls back to your own: it resolves to nothing (403).
  assert.equal(await resolveTenantContext(request(String(b.tenantId)), alice, d1), null);
  assert.equal(await resolveTenantContext(request("1 OR 1=1"), alice, d1), null);
  // Once invited, the same header works.
  await addMembership(d1, { tenantId: b.tenantId, userId: 1, role: "admin" });
  assert.deepEqual(await resolveTenantContext(request(String(b.tenantId)), alice, d1), { tenantId: b.tenantId, role: "admin", principal: "github:alice" });
  assert.equal(requestedTenantFromHeader(null), null);
  assert.ok(Number.isNaN(requestedTenantFromHeader("0")));
  sqlite.close();
});

test("cross-tenant: conversations of another tenant are invisible and read as not found", async () => {
  const { sqlite, d1, scopeA, scopeB } = await twoTenants();
  assert.deepEqual((await listConversations(d1, scopeA)).map((row) => row.id), ["conv-a"]);
  assert.deepEqual((await listConversations(d1, scopeB)).map((row) => row.id), ["conv-b"]);
  assert.equal(await getConversation(d1, scopeA, "conv-b"), null);
  const own = await getConversation(d1, scopeA, "conv-a");
  assert.deepEqual(own.messages.map((row) => row.content), ["secret of github:alice"]);
  assert.deepEqual(own.tasks.map((row) => row.taskId), ["task-a"]);
  // The same principal in the wrong tenant sees nothing either.
  assert.equal(await getConversation(d1, { tenantId: scopeB.tenantId, principal: "github:alice" }, "conv-a"), null);
  sqlite.close();
});

test("cross-tenant: another tenant's conversation cannot be archived or appended to", async () => {
  const { sqlite, d1, scopeA, scopeB } = await twoTenants();
  assert.equal(await archiveConversation(d1, scopeA, "conv-b"), false);
  assert.equal(sqlite.prepare("SELECT archived_at FROM conversations WHERE id = 'conv-b'").get().archived_at, null);
  assert.equal(await conversationWritable(d1, scopeA, "conv-b"), false);
  assert.equal(await conversationWritable(d1, scopeA, "conv-a"), true);
  assert.equal(await conversationWritable(d1, scopeA, "brand-new"), true);
  assert.equal(await archiveConversation(d1, scopeB, "conv-b"), true);
  assert.deepEqual(await listConversations(d1, scopeB), []);
  sqlite.close();
});

test("cross-tenant: tasks of another tenant are neither listed nor updatable", async () => {
  const { sqlite, d1, scopeA, scopeB } = await twoTenants();
  assert.deepEqual((await listTasks(d1, scopeA)).map((row) => row.taskId), ["task-a"]);
  assert.deepEqual((await listTasks(d1, scopeB)).map((row) => row.taskId), ["task-b"]);
  assert.equal(await setTaskRunId(d1, scopeA, "task-b", 99), false);
  assert.equal(sqlite.prepare("SELECT github_run_id FROM tasks WHERE task_id = 'task-b'").get().github_run_id, null);
  assert.equal(await setTaskRunId(d1, scopeA, "task-a", 42), true);
  await assert.rejects(() => listTasks(d1, { tenantId: null, principal: "github:alice" }), TypeError);
  sqlite.close();
});

test("visibleTasks re-filters rows to the caller's tenant as defence in depth", () => {
  const rows = [
    { taskId: "1", tenantId: 10, requestedBy: "github:alice" },
    { taskId: "2", tenantId: 11, requestedBy: "github:alice" },
    { taskId: "3", tenantId: null, requestedBy: "github:alice" },
  ];
  assert.deepEqual(visibleTasks(rows, { ...alice, tenantId: 10 }).map((row) => row.taskId), ["1"]);
  assert.deepEqual(visibleTasks(rows, { ...alice, tenantId: null }), []);
  // Callers that predate tenancy (no tenantId key) keep the principal-only filter.
  assert.deepEqual(visibleTasks(rows, alice).map((row) => row.taskId), ["1", "2", "3"]);
});

test("cross-tenant: repository allowlists and merge policies are per tenant, bounded by the deployment", async () => {
  const { sqlite, d1, a, b } = await twoTenants();
  const defaultId = await ensureDefaultTenant(d1);
  // The default tenant keeps the full deployment allowlist, as before tenancy.
  assert.deepEqual([...await tenantAllowlist(d1, defaultId, deployment)].sort(), [...deployment].sort());
  // A new tenant starts with nothing and gains only what its owner adds.
  assert.deepEqual([...await tenantAllowlist(d1, a.tenantId, deployment)], []);
  await upsertTenantRepository(d1, a.tenantId, { owner: "acme", name: "app", mergePolicy: "ci-gated" });
  await upsertTenantRepository(d1, a.tenantId, { owner: "evil", name: "outside", mergePolicy: "manual" });
  await upsertTenantRepository(d1, a.tenantId, { owner: "genesis", name: "roofing-crm", mergePolicy: "manual" });
  await upsertTenantRepository(d1, b.tenantId, { owner: "acme", name: "app", mergePolicy: "manual" });
  assert.deepEqual([...await tenantAllowlist(d1, a.tenantId, deployment)], ["acme/app"]);
  assert.deepEqual([...await tenantAllowlist(d1, a.tenantId, deployment, { namespaceOwners: ["genesis"] })].sort(), ["acme/app", "genesis/roofing-crm"]);
  assert.deepEqual([...await tenantAllowlist(d1, b.tenantId, deployment)], ["acme/app"]);
  assert.equal(await tenantMergePolicy(d1, a.tenantId, "acme/app"), "ci-gated");
  assert.equal(await tenantMergePolicy(d1, b.tenantId, "acme/app"), "manual");
  assert.equal(await tenantMergePolicy(d1, b.tenantId, "acme/site"), null);
  // Deleting in one tenant never touches another's row.
  assert.equal(await deleteTenantRepository(d1, b.tenantId, { owner: "evil", name: "outside" }), false);
  assert.equal((await listTenantRepositories(d1, a.tenantId)).length, 3);
  assert.equal(await deleteTenantRepository(d1, b.tenantId, { owner: "acme", name: "app" }), true);
  assert.equal(await tenantMergePolicy(d1, a.tenantId, "acme/app"), "ci-gated");
  sqlite.close();
});

test("tenant repository settings stay inside the deployment allowlist, and only the default tenant may pick 'none'", () => {
  const setting = (owner, name, mergePolicy) => ({ owner, name, mergePolicy });
  assert.equal(tenantRepositoryDecision(setting("acme", "app", "ci-gated"), { deploymentAllowlist: deployment, defaultTenant: false }).allowed, true);
  assert.equal(tenantRepositoryDecision(setting("other", "repo", "manual"), { deploymentAllowlist: deployment, defaultTenant: false }).status, 403);
  assert.equal(tenantRepositoryDecision(setting("acme", "app", "none"), { deploymentAllowlist: deployment, defaultTenant: false }).status, 403);
  assert.equal(tenantRepositoryDecision(setting("acme", "app", "none"), { deploymentAllowlist: deployment, defaultTenant: true }).allowed, true);
  assert.deepEqual(validateRepositoryReference({ owner: "Acme", name: "App" }), { reference: { owner: "acme", name: "app" } });
  assert.equal(validateRepositoryReference({ owner: "-x-", name: "app" }).status, 400);
  assert.equal(validateRepositoryReference(null).status, 400);
});
