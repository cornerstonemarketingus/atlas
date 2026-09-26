import { randomUUID } from "node:crypto";
import { getD1 } from "../../../db";
import { listAutomations, listAutomationRuns, insertAutomation, tenantAllowlist } from "../../../db/tenancy.mjs";
import { NO_TENANT_MESSAGE, resolveTenantContext, tenantScope } from "../auth/tenant-context.mjs";
import { allowedRepositories } from "../tasks/dispatch.mjs";
import { authenticatedAccount } from "../tasks/operator-auth.mjs";
import { automationView } from "./runner";
import { validateAutomation } from "./automation-rules.mjs";

export async function GET(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  let tenant: { tenantId: number; role: string; principal: string } | null;
  let rows;
  try {
    tenant = await resolveTenantContext(request, account, getD1());
    if (!tenant) return Response.json({ message: NO_TENANT_MESSAGE }, { status: 403 });
    rows = await listAutomations(getD1(), tenantScope(tenant), 100);
  } catch {
    return Response.json({ message: "Automations are temporarily unavailable. Apply D1 tenancy migrations." }, { status: 503 });
  }
  if (rows.length === 0) return Response.json({ automations: [] }, { headers: { "cache-control": "no-store" } });
  const runs = await listAutomationRuns(getD1(), tenantScope(tenant), rows.map((row) => row.id), 200);
  return Response.json({
    automations: rows.map((row) => automationView(row, runs.filter((run) => run.automationId === row.id).slice(0, 10))),
  }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  let tenant: { tenantId: number; role: string; principal: string } | null;
  let allowlist: Set<string>;
  try {
    tenant = await resolveTenantContext(request, account, getD1());
    if (!tenant) return Response.json({ message: NO_TENANT_MESSAGE }, { status: 403 });
    allowlist = await tenantAllowlist(getD1(), tenant.tenantId, allowedRepositories(process.env.ATLAS_ALLOWED_REPOSITORIES));
  } catch {
    return Response.json({ message: "Automations are temporarily unavailable. Apply D1 tenancy migrations." }, { status: 503 });
  }
  const validated = validateAutomation(body, allowlist);
  if ("error" in validated) return Response.json({ message: validated.error }, { status: validated.status });
  const now = new Date().toISOString();
  const id = randomUUID();
  await insertAutomation(getD1(), tenantScope(tenant), {
    id,
    userId: account.dbUserId,
    name: validated.automation.name,
    repository: validated.automation.repository,
    branch: validated.automation.branch,
    mode: validated.automation.mode,
    objective: validated.automation.objective,
    triggerType: validated.automation.triggerType,
    triggerConfig: JSON.stringify(validated.automation.trigger),
    budgetLimit: validated.automation.budgetLimit,
    budgetWindowDays: validated.automation.budgetWindowDays,
    pausedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await listAutomations(getD1(), tenantScope(tenant), 100).then((items) => items.filter((item) => item.id === id));
  if (!row) return Response.json({ message: "Automation could not be saved." }, { status: 500 });
  return Response.json({ automation: automationView(row, []) }, { status: 201 });
}
