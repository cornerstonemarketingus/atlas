import { desc } from "drizzle-orm";
import { getDb } from "../../../../db";
import { repositories } from "../../../../db/schema";
import { authenticatedUserId } from "../../tasks/operator-auth.mjs";
import { validateRepositorySetting } from "./validation.mjs";

export async function GET(request: Request) {
  if (!authenticatedUserId(request)) return Response.json({ message: "Sign in is required." }, { status: 401 });
  try {
    const db = getDb();
    const rows = await db.select().from(repositories).orderBy(desc(repositories.updatedAt));
    return Response.json({ repositories: rows });
  } catch (error) {
    return Response.json({ message: toErrorMessage(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  if (!authenticatedUserId(request)) return Response.json({ message: "Sign in is required." }, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ message: "Request body must be valid JSON." }, { status: 400 });
  }
  const validated = validateRepositorySetting(body);
  if ("error" in validated) return Response.json({ message: validated.error }, { status: validated.status });

  try {
    const db = getDb();
    const now = new Date().toISOString();
    await db
      .insert(repositories)
      .values({ owner: validated.setting.owner, name: validated.setting.name, mergePolicy: validated.setting.mergePolicy, updatedAt: now })
      .onConflictDoUpdate({
        target: [repositories.owner, repositories.name],
        set: { mergePolicy: validated.setting.mergePolicy, updatedAt: now },
      });
    return Response.json(validated.setting, { status: 200 });
  } catch (error) {
    return Response.json({ message: toErrorMessage(error) }, { status: 500 });
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.includes("no such table")) {
    return "The repositories table is unavailable. Run the D1 migration before using repository settings.";
  }
  return error instanceof Error ? error.message : "Unexpected error.";
}
