import { getD1 } from "../../../db";
import { forgetAllMemories, forgetMemory, listMemories, MEMORY_KINDS, memoryTableMissing, updateMemory } from "../../../db/tenancy.mjs";
import { NO_TENANT_MESSAGE, resolveTenantContext, tenantScope } from "../auth/tenant-context.mjs";
import { authenticatedAccount } from "../tasks/operator-auth.mjs";
import { memoryContentLooksSecret } from "../chat/memory-safety.mjs";

const REPOSITORY_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u;

function normalizedRepository(value: unknown) {
  const repository = typeof value === "string" ? value.trim().toLowerCase() : "";
  return repository && REPOSITORY_PATTERN.test(repository) ? repository : null;
}

export async function GET(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  try {
    const d1 = getD1();
    const tenant = await resolveTenantContext(request, account, d1);
    if (!tenant) return Response.json({ message: NO_TENANT_MESSAGE }, { status: 403 });
    const url = new URL(request.url);
    const query = url.searchParams.get("q") ?? "";
    const repository = normalizedRepository(url.searchParams.get("repository"));
    const memories = await listMemories(d1, tenantScope(tenant), { query, repository, limit: 100 });
    return Response.json({ available: true, memories }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (memoryTableMissing(error)) return Response.json({ available: false, memories: [], message: "Memory is not set up yet." }, { headers: { "cache-control": "no-store" } });
    return Response.json({ available: false, memories: [], message: "Memory is unavailable." }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  let body: { id?: unknown; content?: unknown; kind?: unknown; repository?: unknown };
  try { body = await request.json() as typeof body; } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const content = typeof body.content === "string" ? body.content.trim().slice(0, 1000) : "";
  const kind = body.kind === undefined ? undefined : typeof body.kind === "string" ? body.kind.trim() : "";
  const repository = body.repository === undefined ? undefined : normalizedRepository(body.repository);
  if (!id || !content) return Response.json({ message: "Memory id and content are required." }, { status: 400 });
  if (kind !== undefined && !MEMORY_KINDS.includes(kind)) return Response.json({ message: "Memory kind is not valid." }, { status: 400 });
  if (memoryContentLooksSecret(content)) return Response.json({ message: "Atlas will not store secrets in memory." }, { status: 400 });
  try {
    const d1 = getD1();
    const tenant = await resolveTenantContext(request, account, d1);
    if (!tenant) return Response.json({ message: NO_TENANT_MESSAGE }, { status: 403 });
    const memory = await updateMemory(d1, tenantScope(tenant), { id, content, kind, repository });
    if (!memory) return Response.json({ message: "Memory not found." }, { status: 404 });
    return Response.json({ memory });
  } catch (error) {
    if (memoryTableMissing(error)) return Response.json({ message: "Memory is not set up yet." }, { status: 503 });
    return Response.json({ message: "The memory could not be updated." }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  let body: { id?: unknown; all?: unknown } = {};
  try { body = await request.json() as typeof body; } catch { /* empty body is handled below */ }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const all = body.all === true;
  if (!all && !id) return Response.json({ message: "Provide a memory id, or set all=true." }, { status: 400 });
  try {
    const d1 = getD1();
    const tenant = await resolveTenantContext(request, account, d1);
    if (!tenant) return Response.json({ message: NO_TENANT_MESSAGE }, { status: 403 });
    if (all) return Response.json({ deleted: await forgetAllMemories(d1, tenantScope(tenant)) });
    if (!(await forgetMemory(d1, tenantScope(tenant), id))) return Response.json({ message: "Memory not found." }, { status: 404 });
    return Response.json({ deleted: 1, id });
  } catch (error) {
    if (memoryTableMissing(error)) return Response.json({ message: "Memory is not set up yet." }, { status: 503 });
    return Response.json({ message: "The memory could not be deleted." }, { status: 503 });
  }
}
