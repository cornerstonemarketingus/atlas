import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { conversationMessages, conversations, runEvents, tasks } from "../../../../db/schema";
import { authenticatedAccount } from "../../tasks/operator-auth.mjs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  const { id } = await context.params;
  const db = getDb();
  try {
    const [conversation] = await db.select().from(conversations).where(and(eq(conversations.id, id), eq(conversations.requestedBy, account.userId))).limit(1);
    if (!conversation) return Response.json({ message: "Conversation not found." }, { status: 404 });
    const [messages, events, conversationTasks] = await Promise.all([
      db.select().from(conversationMessages).where(and(eq(conversationMessages.conversationId, id), eq(conversationMessages.requestedBy, account.userId))).orderBy(asc(conversationMessages.createdAt)),
      db.select().from(runEvents).where(and(eq(runEvents.conversationId, id), eq(runEvents.requestedBy, account.userId))).orderBy(asc(runEvents.createdAt)),
      db.select().from(tasks).where(and(eq(tasks.conversationId, id), eq(tasks.requestedBy, account.userId))).orderBy(asc(tasks.createdAt)),
    ]);
    return Response.json({ conversation, messages, events, tasks: conversationTasks }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ message: "Conversation history is unavailable." }, { status: 503 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  const { id } = await context.params;
  try {
    const rows = await getDb().update(conversations).set({ archivedAt: new Date().toISOString() })
      .where(and(eq(conversations.id, id), eq(conversations.requestedBy, account.userId))).returning({ id: conversations.id });
    if (!rows.length) return Response.json({ message: "Conversation not found." }, { status: 404 });
    return Response.json({ closed: true, id });
  } catch {
    return Response.json({ message: "The conversation could not be closed." }, { status: 503 });
  }
}
