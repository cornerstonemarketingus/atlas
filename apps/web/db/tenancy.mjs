// Tenant model and tenant-scoped data access (blueprint §15 / Phase 9, #71).
//
// Written against the Cloudflare D1 binding API (prepare/bind/first/all/run/
// batch) in plain SQL, so it runs unmodified in the Worker and against an
// in-memory SQLite database in tests. Every read and write of tenant-owned
// rows takes a `scope` = { tenantId, principal } and filters on BOTH: the
// tenant is the isolation boundary, the principal keeps one member's
// conversations and task objectives private from another member of the same
// tenant (the pre-tenancy behaviour). A row outside the scope is
// indistinguishable from a missing one, so routes answer 404.

export const TENANT_ROLES = ["owner", "admin", "member"];
export const DEFAULT_TENANT_SLUG = "default";
export const OPERATOR_PRINCIPAL = "operator";
export const MEMORY_KINDS = ["fact", "preference", "decision", "convention", "failure", "command"];

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const memoryColumns = "id, tenant_id AS tenantId, requested_by AS requestedBy, kind, repository, content, source_conversation_id AS sourceConversationId, created_at AS createdAt, updated_at AS updatedAt, last_used_at AS lastUsedAt";

function isScope(scope) {
  return Boolean(scope) && Number.isSafeInteger(scope.tenantId) && typeof scope.principal === "string" && scope.principal !== "";
}

function requireScope(scope) {
  if (!isScope(scope)) throw new TypeError("A tenant scope ({ tenantId, principal }) is required.");
}

export function memoryTableMissing(error) {
  return /no such table:\s*memories/iu.test(String(error?.message ?? error) + String(error?.cause?.message ?? ""));
}

export function canManageTenant(role) {
  return role === "owner" || role === "admin";
}

/**
 * The default tenant created by migration 0015: owned by the deployment owner
 * ("operator"), holding every pre-tenancy row. Created here too so a database
 * provisioned without the backfill still resolves.
 */
export async function ensureDefaultTenant(d1) {
  await d1.prepare("INSERT INTO tenants (slug, name, kind, owner_principal) VALUES (?, 'Default workspace', 'default', ?) ON CONFLICT DO NOTHING")
    .bind(DEFAULT_TENANT_SLUG, OPERATOR_PRINCIPAL).run();
  const tenantId = await d1.prepare("SELECT id FROM tenants WHERE slug = ?").bind(DEFAULT_TENANT_SLUG).first("id");
  if (tenantId === null) throw new Error("Default tenant was not persisted.");
  return tenantId;
}

/** A GitHub user's own tenant (first request after sign-up), with an owner membership. */
export async function ensurePersonalTenant(d1, { userId, principal }) {
  if (!Number.isSafeInteger(userId)) throw new TypeError("userId must be an integer.");
  await d1.prepare("INSERT INTO tenants (slug, name, kind, owner_principal, personal_user_id) VALUES (?, ?, 'personal', ?, ?) ON CONFLICT DO NOTHING")
    .bind(`user-${userId}`, String(principal ?? `user-${userId}`).replace(/^github:/u, ""), String(principal ?? `user:${userId}`), userId).run();
  const tenantId = await d1.prepare("SELECT id FROM tenants WHERE personal_user_id = ?").bind(userId).first("id");
  if (tenantId === null) throw new Error("Personal tenant was not persisted.");
  await addMembership(d1, { tenantId, userId, role: "owner" });
  return tenantId;
}

export async function addMembership(d1, { tenantId, userId, role = "member" }) {
  if (!TENANT_ROLES.includes(role)) throw new RangeError("Unknown tenant role.");
  await d1.prepare("INSERT INTO tenant_members (tenant_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = excluded.role")
    .bind(tenantId, userId, role).run();
}

export async function membershipsForUser(d1, userId) {
  const { results } = await d1.prepare(
    "SELECT t.id AS tenantId, t.slug AS slug, t.name AS name, t.kind AS kind, m.role AS role FROM tenant_members m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = ? ORDER BY t.id",
  ).bind(userId).all();
  return results;
}

export async function isDefaultTenant(d1, tenantId) {
  return (await d1.prepare("SELECT slug FROM tenants WHERE id = ?").bind(tenantId).first("slug")) === DEFAULT_TENANT_SLUG;
}

/**
 * Resolves the caller's tenant from an authenticatedAccount() result.
 *
 * - GitHub users act in one of their memberships: `requestedTenantId` (the
 *   `x-atlas-tenant` header) when they are a member of it, otherwise their
 *   oldest membership — the default tenant for users that existed before
 *   tenancy, their personal tenant (created now) for everyone else. Asking for
 *   a tenant they are not a member of resolves to null, never to a fallback.
 * - Principals without a users row (the operator, trusted platform ids) act
 *   in the default tenant; the operator owns it, platform ids are members.
 *
 * Returns { tenantId, role, principal } or null.
 */
export async function resolveTenant(d1, account, { requestedTenantId = null } = {}) {
  if (!account || typeof account.userId !== "string" || account.userId === "") return null;
  const principal = account.userId;
  if (Number.isSafeInteger(account.dbUserId)) {
    let memberships = await membershipsForUser(d1, account.dbUserId);
    if (memberships.length === 0) {
      await ensurePersonalTenant(d1, { userId: account.dbUserId, principal });
      memberships = await membershipsForUser(d1, account.dbUserId);
    }
    const chosen = requestedTenantId === null ? memberships[0] : memberships.find((membership) => membership.tenantId === requestedTenantId);
    return chosen ? { tenantId: chosen.tenantId, role: chosen.role, principal } : null;
  }
  if (principal.startsWith("github:")) return null;
  const tenantId = await ensureDefaultTenant(d1);
  return { tenantId, role: principal === OPERATOR_PRINCIPAL ? "owner" : "member", principal };
}

/** Parses the optional `x-atlas-tenant` header: undefined → null, malformed → NaN (resolves to nothing). */
export function requestedTenantFromHeader(value) {
  if (value === null || value === undefined || value === "") return null;
  return /^[1-9][0-9]{0,15}$/u.test(value) ? Number(value) : Number.NaN;
}

// ---- Repositories: the per-tenant allowlist and merge policy -------------

export async function listTenantRepositories(d1, tenantId) {
  const { results } = await d1.prepare(
    "SELECT id, tenant_id AS tenantId, owner, name, merge_policy AS mergePolicy, created_at AS createdAt, updated_at AS updatedAt FROM repositories WHERE tenant_id = ? ORDER BY updated_at DESC, id DESC",
  ).bind(tenantId).all();
  return results;
}

export async function upsertTenantRepository(d1, tenantId, { owner, name, mergePolicy }, now = new Date().toISOString()) {
  await d1.prepare(
    "INSERT INTO repositories (tenant_id, owner, name, merge_policy, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (tenant_id, owner, name) DO UPDATE SET merge_policy = excluded.merge_policy, updated_at = excluded.updated_at",
  ).bind(tenantId, owner, name, mergePolicy, now).run();
}

export async function deleteTenantRepository(d1, tenantId, { owner, name }) {
  const result = await d1.prepare("DELETE FROM repositories WHERE tenant_id = ? AND owner = ? AND name = ?").bind(tenantId, owner, name).run();
  return (result?.meta?.changes ?? 0) > 0;
}

/**
 * The repositories a tenant may dispatch to: its own rows intersected with the
 * deployment-wide ATLAS_ALLOWED_REPOSITORIES upper bound. The default tenant
 * (deployment owner and every pre-tenancy user) keeps the whole deployment
 * allowlist, exactly as before tenancy.
 */
export async function tenantAllowlist(d1, tenantId, deploymentAllowlist) {
  const upperBound = new Set([...deploymentAllowlist].map((value) => String(value).toLowerCase()));
  if (await isDefaultTenant(d1, tenantId)) return upperBound;
  const rows = await listTenantRepositories(d1, tenantId);
  const allowed = new Set();
  for (const row of rows) {
    const full = `${row.owner}/${row.name}`.toLowerCase();
    if (upperBound.has(full)) allowed.add(full);
  }
  return allowed;
}

export async function tenantMergePolicy(d1, tenantId, repository) {
  if (typeof repository !== "string" || !repositoryPattern.test(repository)) return null;
  const [owner, name] = repository.toLowerCase().split("/");
  return d1.prepare("SELECT merge_policy FROM repositories WHERE tenant_id = ? AND owner = ? AND name = ?").bind(tenantId, owner, name).first("merge_policy");
}

// ---- Conversations -------------------------------------------------------

const conversationColumns = "id, tenant_id AS tenantId, requested_by AS requestedBy, title, repository, branch, created_at AS createdAt, updated_at AS updatedAt, archived_at AS archivedAt";
const taskColumns = "id, task_id AS taskId, tenant_id AS tenantId, user_id AS userId, requested_by AS requestedBy, repository, branch, mode, objective, merge_policy AS mergePolicy, github_run_id AS githubRunId, conversation_id AS conversationId, execution_provider AS executionProvider, correlation_id AS correlationId, created_at AS createdAt";

export async function listConversations(d1, scope, limit = 50) {
  requireScope(scope);
  const { results } = await d1.prepare(
    `SELECT ${conversationColumns} FROM conversations WHERE tenant_id = ? AND requested_by = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT ?`,
  ).bind(scope.tenantId, scope.principal, limit).all();
  return results;
}

export async function getConversation(d1, scope, id) {
  requireScope(scope);
  const conversation = await d1.prepare(`SELECT ${conversationColumns} FROM conversations WHERE id = ? AND tenant_id = ? AND requested_by = ?`)
    .bind(id, scope.tenantId, scope.principal).first();
  if (!conversation) return null;
  const [messages, events, tasks] = await Promise.all([
    d1.prepare("SELECT id, conversation_id AS conversationId, requested_by AS requestedBy, role, content, attachments_json AS attachmentsJson, created_at AS createdAt FROM conversation_messages WHERE conversation_id = ? AND requested_by = ? ORDER BY created_at ASC")
      .bind(id, scope.principal).all(),
    d1.prepare("SELECT id, conversation_id AS conversationId, task_id AS taskId, requested_by AS requestedBy, kind, label, detail, created_at AS createdAt FROM run_events WHERE conversation_id = ? AND requested_by = ? ORDER BY created_at ASC")
      .bind(id, scope.principal).all(),
    d1.prepare(`SELECT ${taskColumns} FROM tasks WHERE conversation_id = ? AND tenant_id = ? AND requested_by = ? ORDER BY created_at ASC`)
      .bind(id, scope.tenantId, scope.principal).all(),
  ]);
  return { conversation, messages: messages.results, events: events.results, tasks: tasks.results };
}

export async function archiveConversation(d1, scope, id, now = new Date().toISOString()) {
  requireScope(scope);
  const result = await d1.prepare("UPDATE conversations SET archived_at = ? WHERE id = ? AND tenant_id = ? AND requested_by = ?")
    .bind(now, id, scope.tenantId, scope.principal).run();
  return (result?.meta?.changes ?? 0) > 0;
}

/**
 * Whether a caller-supplied conversation id may be written to in this scope:
 * true when it is new, or already belongs to this tenant and principal. An id
 * owned by anyone else must not be appended to.
 */
export async function conversationWritable(d1, scope, id) {
  requireScope(scope);
  const existing = await d1.prepare("SELECT tenant_id AS tenantId, requested_by AS requestedBy FROM conversations WHERE id = ?").bind(id).first();
  return !existing || (existing.tenantId === scope.tenantId && existing.requestedBy === scope.principal);
}

/**
 * What Atlas recalls from this person's other conversations in the same
 * workspace: the most recent threads with their last few messages, and
 * their most recent runs. Bounded here (rows) and again when formatted
 * (characters), so recall never crowds out the current conversation.
 */
export async function recallForMemory(d1, scope, { excludeConversationId = "", conversationLimit = 8, messagesPerConversation = 4, taskLimit = 8 } = {}) {
  requireScope(scope);
  const { results: threads } = await d1.prepare(
    `SELECT id, title, repository, updated_at AS updatedAt FROM conversations
      WHERE tenant_id = ? AND requested_by = ? AND archived_at IS NULL AND id != ?
      ORDER BY updated_at DESC LIMIT ?`,
  ).bind(scope.tenantId, scope.principal, excludeConversationId, conversationLimit).all();
  const conversations = await Promise.all(threads.map(async (thread) => {
    const { results } = await d1.prepare(
      `SELECT role, content, created_at AS createdAt FROM conversation_messages
        WHERE conversation_id = ? AND requested_by = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).bind(thread.id, scope.principal, messagesPerConversation).all();
    return { ...thread, messages: results.reverse() };
  }));
  const tasks = await listTasks(d1, scope, taskLimit);
  return { conversations, tasks };
}

function memoryTokens(query) {
  return String(query ?? "").toLowerCase().split(/[^a-z0-9_.:/-]+/u).filter(Boolean).slice(0, 8);
}

function escapeLike(value) {
  return String(value ?? "").replace(/[\\%_]/gu, "\\$&");
}

function memoryRepository(repository) {
  if (typeof repository !== "string") return null;
  const normalized = repository.trim().toLowerCase();
  return normalized && repositoryPattern.test(normalized) ? normalized : null;
}

async function touchMemories(d1, scope, ids, now = new Date().toISOString()) {
  requireScope(scope);
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id))];
  if (unique.length === 0) return;
  await d1.batch(unique.map((id) => d1.prepare(
    "UPDATE memories SET last_used_at = ? WHERE id = ? AND tenant_id = ? AND requested_by = ?",
  ).bind(now, id, scope.tenantId, scope.principal)));
}

export async function listMemories(d1, scope, { query = "", repository = null, limit = 50, markUsed = false } = {}, now = new Date().toISOString()) {
  requireScope(scope);
  const tokens = memoryTokens(query);
  const selectedRepository = memoryRepository(repository);
  const filters = ["tenant_id = ?", "requested_by = ?"];
  const binds = [scope.tenantId, scope.principal];
  let order = "COALESCE(last_used_at, updated_at) DESC, updated_at DESC, id DESC";
  if (selectedRepository) {
    filters.push("(repository = ? OR repository IS NULL)");
    binds.push(selectedRepository);
    order = "CASE WHEN repository = ? THEN 0 WHEN repository IS NULL THEN 1 ELSE 2 END, " + order;
  }
  for (const token of tokens) {
    filters.push("lower(content) LIKE ? ESCAPE '\\'");
    binds.push(`%${escapeLike(token)}%`);
  }
  if (selectedRepository) binds.push(selectedRepository);
  binds.push(Math.max(1, Math.min(Number(limit) || 50, 200)));
  const { results } = await d1.prepare(
    `SELECT ${memoryColumns} FROM memories WHERE ${filters.join(" AND ")} ORDER BY ${order} LIMIT ?`,
  ).bind(...binds).all();
  const rows = results ?? [];
  if (markUsed) await touchMemories(d1, scope, rows.map((row) => row.id), now);
  return rows;
}

export async function memoryPromptContext(d1, scope, { repository = null, limit = 20 } = {}, now = new Date().toISOString()) {
  requireScope(scope);
  const recent = await listMemories(d1, scope, { limit, markUsed: false }, now);
  const selectedRepository = memoryRepository(repository);
  let repositoryMemories = [];
  if (selectedRepository) {
    const { results } = await d1.prepare(
      `SELECT ${memoryColumns} FROM memories
        WHERE tenant_id = ? AND requested_by = ? AND repository = ?
        ORDER BY COALESCE(last_used_at, updated_at) DESC, updated_at DESC, id DESC LIMIT 100`,
    ).bind(scope.tenantId, scope.principal, selectedRepository).all();
    const seen = new Set(recent.map((row) => row.id));
    repositoryMemories = (results ?? []).filter((row) => !seen.has(row.id));
  }
  await touchMemories(d1, scope, [...recent, ...repositoryMemories].map((row) => row.id), now);
  return { memories: recent, repositoryMemories };
}

export async function rememberMemory(d1, scope, { kind, content, repository = null, sourceConversationId = null } = {}, now = new Date().toISOString()) {
  requireScope(scope);
  if (!MEMORY_KINDS.includes(kind)) throw new RangeError("Unknown memory kind.");
  const text = typeof content === "string" ? content.trim().slice(0, 1000) : "";
  if (!text) throw new RangeError("Memory content is required.");
  const normalized = text.toLowerCase();
  const selectedRepository = memoryRepository(repository);
  const existing = await d1.prepare(
    `SELECT id FROM memories
      WHERE tenant_id = ? AND requested_by = ? AND kind = ?
        AND ((repository IS NULL AND ? IS NULL) OR repository = ?)
        AND (lower(content) LIKE ? ESCAPE '\\' OR ? LIKE lower(content) || '%')
      ORDER BY updated_at DESC, id DESC LIMIT 1`,
  ).bind(scope.tenantId, scope.principal, kind, selectedRepository, selectedRepository, `${escapeLike(normalized)}%`, normalized).first("id");
  if (existing) {
    await d1.prepare(
      "UPDATE memories SET repository = ?, content = ?, source_conversation_id = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND requested_by = ?",
    ).bind(selectedRepository, text, sourceConversationId, now, existing, scope.tenantId, scope.principal).run();
  } else {
    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await d1.prepare(
      "INSERT INTO memories (id, tenant_id, requested_by, kind, repository, content, source_conversation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, scope.tenantId, scope.principal, kind, selectedRepository, text, sourceConversationId, now, now).run();
  }
  const total = await d1.prepare("SELECT count(*) AS n FROM memories WHERE tenant_id = ? AND requested_by = ?").bind(scope.tenantId, scope.principal).first("n");
  const excess = Math.max(0, Number(total ?? 0) - 500);
  if (excess > 0) {
    await d1.prepare(
      `DELETE FROM memories
        WHERE id IN (
          SELECT id FROM memories
          WHERE tenant_id = ? AND requested_by = ?
          ORDER BY CASE WHEN last_used_at IS NULL THEN 0 ELSE 1 END ASC, COALESCE(last_used_at, updated_at) ASC, updated_at ASC, id ASC
          LIMIT ?
        )`,
    ).bind(scope.tenantId, scope.principal, excess).run();
  }
  const rows = await listMemories(d1, scope, { query: text, repository: selectedRepository, limit: 20 }, now);
  const memory = rows.find((row) => row.kind === kind && row.content === text && row.repository === selectedRepository) ?? rows[0] ?? null;
  return { created: !existing, memory };
}

export async function updateMemory(d1, scope, { id, kind, content, repository } = {}, now = new Date().toISOString()) {
  requireScope(scope);
  if (typeof id !== "string" || !id) throw new RangeError("Memory id is required.");
  const existing = await d1.prepare(`SELECT ${memoryColumns} FROM memories WHERE id = ? AND tenant_id = ? AND requested_by = ?`)
    .bind(id, scope.tenantId, scope.principal).first();
  if (!existing) return null;
  const nextKind = kind === undefined ? existing.kind : kind;
  if (!MEMORY_KINDS.includes(nextKind)) throw new RangeError("Unknown memory kind.");
  const nextContent = content === undefined ? existing.content : String(content).trim().slice(0, 1000);
  if (!nextContent) throw new RangeError("Memory content is required.");
  const nextRepository = repository === undefined ? existing.repository : memoryRepository(repository);
  await d1.prepare(
    "UPDATE memories SET kind = ?, repository = ?, content = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND requested_by = ?",
  ).bind(nextKind, nextRepository, nextContent, now, id, scope.tenantId, scope.principal).run();
  return d1.prepare(`SELECT ${memoryColumns} FROM memories WHERE id = ? AND tenant_id = ? AND requested_by = ?`)
    .bind(id, scope.tenantId, scope.principal).first();
}

export async function forgetMemory(d1, scope, id) {
  requireScope(scope);
  const result = await d1.prepare("DELETE FROM memories WHERE id = ? AND tenant_id = ? AND requested_by = ?").bind(id, scope.tenantId, scope.principal).run();
  return (result?.meta?.changes ?? 0) > 0;
}

export async function forgetAllMemories(d1, scope) {
  requireScope(scope);
  const result = await d1.prepare("DELETE FROM memories WHERE tenant_id = ? AND requested_by = ?").bind(scope.tenantId, scope.principal).run();
  return Number(result?.meta?.changes ?? 0);
}

export async function recallMemories(d1, scope, { query = "", repository = null, limit = 15 } = {}, now = new Date().toISOString()) {
  requireScope(scope);
  const rows = await listMemories(d1, scope, { query, repository, limit, markUsed: true }, now);
  return rows;
}

// ---- Tasks ---------------------------------------------------------------

export async function listTasks(d1, scope, limit = 10) {
  requireScope(scope);
  const { results } = await d1.prepare(`SELECT ${taskColumns} FROM tasks WHERE tenant_id = ? AND requested_by = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(scope.tenantId, scope.principal, limit).all();
  return results;
}

export async function setTaskRunId(d1, scope, taskId, runId) {
  requireScope(scope);
  const result = await d1.prepare("UPDATE tasks SET github_run_id = ? WHERE task_id = ? AND tenant_id = ? AND requested_by = ?")
    .bind(runId, taskId, scope.tenantId, scope.principal).run();
  return (result?.meta?.changes ?? 0) > 0;
}
