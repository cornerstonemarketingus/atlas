import assert from "node:assert/strict";
import test from "node:test";

import { DatabaseSync } from "node:sqlite";

import {
  memoryPromptContext,
  memoryTableMissing,
  recallMemories,
  rememberMemory,
  resolveTenant,
} from "../db/tenancy.mjs";
import { applyMigrations, d1FromSqlite, migratedDatabase } from "./helpers/d1-sqlite.mjs";

const alice = { userId: "github:alice", dbUserId: 1 };
const bob = { userId: "github:bob", dbUserId: 2 };

async function scopes() {
  const { sqlite, d1 } = migratedDatabase({ users: [[1, "alice"], [2, "bob"]] });
  const tenantA = await resolveTenant(d1, alice);
  const tenantB = await resolveTenant(d1, bob);
  return {
    sqlite,
    d1,
    scopeA: { tenantId: tenantA.tenantId, principal: alice.userId },
    scopeB: { tenantId: tenantB.tenantId, principal: bob.userId },
  };
}

test("remembered memories stay inside one tenant and principal", async () => {
  const { sqlite, d1, scopeA, scopeB } = await scopes();
  await rememberMemory(d1, scopeA, { kind: "convention", content: "We always use pnpm in this repo.", repository: "acme/app" }, "2026-09-26T12:00:00Z");
  await rememberMemory(d1, scopeB, { kind: "convention", content: "We always use yarn in this repo.", repository: "acme/app" }, "2026-09-26T12:05:00Z");

  const aliceRows = await recallMemories(d1, scopeA, { query: "pnpm", repository: "acme/app" }, "2026-09-26T12:10:00Z");
  const bobRows = await recallMemories(d1, scopeB, { query: "yarn", repository: "acme/app" }, "2026-09-26T12:10:00Z");

  assert.deepEqual(aliceRows.map((row) => row.content), ["We always use pnpm in this repo."]);
  assert.deepEqual(bobRows.map((row) => row.content), ["We always use yarn in this repo."]);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM memories WHERE requested_by = 'github:alice' AND tenant_id = ?").get(scopeB.tenantId).n, 0);
  sqlite.close();
});

test("remember updates near-duplicates and evicts the oldest unused memory beyond 500", async () => {
  const { sqlite, d1 } = migratedDatabase({ users: [[1, "alice"]] });
  const tenant = await resolveTenant(d1, alice);
  const scope = { tenantId: tenant.tenantId, principal: alice.userId };
  for (let index = 0; index < 500; index += 1) {
    sqlite.prepare(
      "INSERT INTO memories (id, tenant_id, requested_by, kind, content, created_at, updated_at) VALUES (?, ?, ?, 'fact', ?, ?, ?)",
    ).run(`m-${index}`, scope.tenantId, scope.principal, `Memory ${index}`, `2026-09-26T00:${String(index % 60).padStart(2, "0")}:00Z`, `2026-09-26T00:${String(index % 60).padStart(2, "0")}:00Z`);
  }

  const first = await rememberMemory(d1, scope, { kind: "fact", content: "Build command: pnpm install && pnpm test" }, "2026-09-26T13:00:00Z");
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM memories").get().n, 500);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM memories WHERE id = 'm-0'").get().n, 0);
  assert.equal(first.created, true);

  const second = await rememberMemory(d1, scope, { kind: "fact", content: "Build command: pnpm install && pnpm test --filter web" }, "2026-09-26T13:05:00Z");
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM memories").get().n, 500);
  assert.equal(second.created, false);
  assert.match(second.memory.content, /--filter web/u);
  sqlite.close();
});

test("memory prompt context includes repository-specific memories beyond the general recent set", async () => {
  const { sqlite, d1 } = migratedDatabase({ users: [[1, "alice"]] });
  const tenant = await resolveTenant(d1, alice);
  const scope = { tenantId: tenant.tenantId, principal: alice.userId };
  for (let index = 0; index < 21; index += 1) {
    sqlite.prepare(
      "INSERT INTO memories (id, tenant_id, requested_by, kind, content, created_at, updated_at) VALUES (?, ?, ?, 'fact', ?, ?, ?)",
    ).run(`recent-${index}`, scope.tenantId, scope.principal, `Recent ${index}`, `2026-09-26T12:${String(index).padStart(2, "0")}:00Z`, `2026-09-26T12:${String(index).padStart(2, "0")}:00Z`);
  }
  sqlite.prepare(
    "INSERT INTO memories (id, tenant_id, requested_by, kind, repository, content, created_at, updated_at) VALUES ('repo-note', ?, ?, 'convention', 'acme/app', 'We always use pnpm in this repo.', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')",
  ).run(scope.tenantId, scope.principal);

  const context = await memoryPromptContext(d1, scope, { repository: "acme/app" }, "2026-09-26T14:00:00Z");
  assert.equal(context.memories.length, 20);
  assert.deepEqual(context.repositoryMemories.map((row) => row.id), ["repo-note"]);
  sqlite.close();
});

test("memory helpers detect when migration 0016 has not been applied yet", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    applyMigrations(sqlite, { until: 15 });
    sqlite.prepare("INSERT INTO users (id, github_user_id, github_login) VALUES (1, 101, 'alice')").run();
    const d1 = d1FromSqlite(sqlite);
    const tenant = await resolveTenant(d1, alice);
    const scope = { tenantId: tenant.tenantId, principal: alice.userId };
    await assert.rejects(() => rememberMemory(d1, scope, { kind: "fact", content: "x" }), (error) => memoryTableMissing(error));
  } finally {
    sqlite.close();
  }
});
