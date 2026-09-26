import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../db";
import { automationRuns, automations } from "../../../db/schema";
import { allowedRepositories } from "../tasks/dispatch.mjs";
import { authenticatedAccount } from "../tasks/operator-auth.mjs";
import { automationView } from "./runner";
import { validateAutomation } from "./automation-rules.mjs";

export async function GET(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  const db = getDb();
  const rows = await db.select().from(automations).where(eq(automations.requestedBy, account.userId)).orderBy(desc(automations.createdAt));
  if (rows.length === 0) return Response.json({ automations: [] }, { headers: { "cache-control": "no-store" } });
  const ids = rows.map((row) => row.id);
  const runs = await db.select().from(automationRuns).where(inArray(automationRuns.automationId, ids)).orderBy(desc(automationRuns.triggeredAt)).limit(200);
  return Response.json({
    automations: rows.map((row) => automationView(row, runs.filter((run) => run.automationId === row.id).slice(0, 10))),
  }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }
  const validated = validateAutomation(body, allowedRepositories(process.env.ATLAS_ALLOWED_REPOSITORIES));
  if ("error" in validated) return Response.json({ message: validated.error }, { status: validated.status });
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(automations).values({
    id,
    requestedBy: account.userId,
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
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(automations).where(and(eq(automations.id, id), eq(automations.requestedBy, account.userId))).limit(1);
  if (!row) return Response.json({ message: "Automation could not be saved." }, { status: 500 });
  return Response.json({ automation: automationView(row, []) }, { status: 201 });
}
