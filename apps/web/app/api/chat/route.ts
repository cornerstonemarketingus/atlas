import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { conversationMessages, conversations } from "../../../db/schema";
import { authenticatedAccount } from "../tasks/operator-auth.mjs";
import { completionsUrl, replyText, selectChatModel, publicChatModels, threadTitle, chatRequestBody } from "./model-endpoint.mjs";

/** How much of a thread is replayed to the model. Enough for continuity, bounded so a long thread cannot grow a request without limit. */
const HISTORY_TURNS = 20;
const MAX_MESSAGE = 8000;
const REQUEST_TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = [
  "You are Atlas, a private AI assistant. Help the user understand ideas, plan work, and make clear decisions about software, products, and computer work.",
  "Be concrete and brief. The interface may start a separate approved task when the user asks Atlas to work on a connected project.",
  "Never claim to have run, built, deployed, or clicked anything unless the conversation includes a verified task result.",
].join(" ");

export async function POST(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });

  let body: { conversationId?: unknown; message?: unknown; repository?: unknown; branch?: unknown; modelId?: unknown };
  try { body = await request.json() as typeof body; } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }

  const message = typeof body.message === "string" ? body.message.trim().slice(0, MAX_MESSAGE) : "";
  if (!message) return Response.json({ message: "Say something for Atlas to reply to." }, { status: 400 });
  const repository = typeof body.repository === "string" ? body.repository.slice(0, 140) : "";
  const branch = typeof body.branch === "string" ? body.branch.slice(0, 140) : "";
  const requested = typeof body.conversationId === "string" ? body.conversationId : "";
  const conversationId = /^[0-9a-f-]{36}$/u.test(requested) ? requested : randomUUID();

  // Checked before anything is written: a thread whose only content is a
  // question that was never sent anywhere is worse than no thread.
  const endpoint = selectChatModel(process.env, body.modelId);
  if (!endpoint.configured) {
    return Response.json({ message: endpoint.reason, needsModelEndpoint: !endpoint.invalidSelection }, { status: endpoint.invalidSelection ? 400 : 503 });
  }

  let db: ReturnType<typeof getDb> | undefined;
  const now = new Date().toISOString();
  let history: { role: string; content: string }[] = [];
  let stored = true;
  try {
    db = getDb();
    await db.insert(conversations)
      .values({ id: conversationId, requestedBy: account.userId, title: threadTitle(message), repository, branch, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: conversations.id, set: { updatedAt: now } });
    history = await db.select({ role: conversationMessages.role, content: conversationMessages.content })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.requestedBy, account.userId)))
      .orderBy(asc(conversationMessages.createdAt));
    await db.insert(conversationMessages).values({ id: randomUUID(), conversationId, requestedBy: account.userId, role: "user", content: message, createdAt: now });
  } catch {
    // Same posture as task dispatch: a D1 problem degrades the feature to a
    // single un-remembered turn rather than refusing to answer at all.
    stored = false;
    history = [];
  }

  const turns = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.slice(-HISTORY_TURNS).map((turn) => ({ role: turn.role === "assistant" ? "assistant" : "user", content: turn.content })),
    { role: "user", content: message },
  ];

  let payload: unknown;
  try {
    const response = await fetch(completionsUrl(endpoint.baseUrl!), {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "content-type": "application/json", ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}) },
      body: JSON.stringify(chatRequestBody(endpoint, turns)),
    });
    if (!response.ok) {
      // The status is the actionable part; the body can contain the prompt
      // echoed back, which does not belong in a client-facing message.
      return Response.json({ message: `The model endpoint answered ${response.status}.`, conversationId }, { status: 502 });
    }
    payload = await response.json();
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return Response.json({ message: timedOut ? "The model endpoint did not answer in time." : "No model server answered. Check the endpoint in Connections.", conversationId }, { status: 504 });
  }

  const reply = replyText(payload);
  if (!reply) return Response.json({ message: "The model endpoint returned an empty reply.", conversationId }, { status: 502 });

  const replyId = randomUUID();
  const replyAt = new Date().toISOString();
  if (stored && db) {
    try {
      await db.insert(conversationMessages).values({ id: replyId, conversationId, requestedBy: account.userId, role: "assistant", content: reply, createdAt: replyAt });
      await db.update(conversations).set({ updatedAt: replyAt }).where(and(eq(conversations.id, conversationId), eq(conversations.requestedBy, account.userId)));
    } catch { stored = false; }
  }

  return Response.json({ conversationId, stored, modelId: endpoint.id, reply: { id: replyId, role: "assistant", content: reply, createdAt: replyAt } });
}

/**
 * Whether chat can answer at all, so the composer can say so before someone
 * types a paragraph and presses send — the reason a dead button feels broken
 * is almost always that it looked alive.
 */
export async function GET(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  return Response.json(publicChatModels(process.env), { headers: { "cache-control": "no-store" } });
}
