import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { conversationMessages, conversations } from "../../../db/schema";
import { authenticatedAccount } from "../tasks/operator-auth.mjs";
import { completionsUrl, replyText, resolveChatModel, threadTitle } from "./model-endpoint.mjs";
import { createDeltaParser, encodeEvent } from "./stream.mjs";

/** How much of a thread is replayed to the model. Enough for continuity, bounded so a long thread cannot grow a request without limit. */
const HISTORY_TURNS = 20;
const MAX_MESSAGE = 8000;
const REQUEST_TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = [
  "You are Atlas, an autonomous AI workspace that builds software, operates computers and turns successful work into persistent automations.",
  "In this chat you answer questions, plan work, and help the user make clear decisions about software, products and computer work. Be concrete and brief; use Markdown for lists and code.",
  "When the user wants work done on a connected project or on their computer, the interface offers to start an approved task — you do not start it yourself. Say what the task would do if that helps.",
  "Never claim to have run, built, deployed, or clicked anything unless the conversation includes a verified task result.",
].join(" ");

export async function POST(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });

  let body: { conversationId?: unknown; message?: unknown; repository?: unknown; branch?: unknown; stream?: unknown };
  try { body = await request.json() as typeof body; } catch { return Response.json({ message: "Request body must be valid JSON." }, { status: 400 }); }

  const message = typeof body.message === "string" ? body.message.trim().slice(0, MAX_MESSAGE) : "";
  if (!message) return Response.json({ message: "Say something for Atlas to reply to." }, { status: 400 });
  const repository = typeof body.repository === "string" ? body.repository.slice(0, 140) : "";
  const branch = typeof body.branch === "string" ? body.branch.slice(0, 140) : "";
  const requested = typeof body.conversationId === "string" ? body.conversationId : "";
  const conversationId = /^[0-9a-f-]{36}$/u.test(requested) ? requested : randomUUID();

  // Checked before anything is written: a thread whose only content is a
  // question that was never sent anywhere is worse than no thread.
  const endpoint = resolveChatModel(process.env);
  if (!endpoint.configured) {
    return Response.json({ message: endpoint.reason, needsModelEndpoint: true }, { status: 503 });
  }

  const db = getDb();
  const now = new Date().toISOString();
  let history: { role: string; content: string }[] = [];
  let stored = true;
  try {
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

  if (body.stream === true) {
    return streamReply({ endpoint, turns, conversationId, stored, db, userId: account.userId });
  }

  let payload: unknown;
  try {
    const response = await fetch(completionsUrl(endpoint.baseUrl!), {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "content-type": "application/json", ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}) },
      body: JSON.stringify({ model: endpoint.model, messages: turns, stream: false, temperature: 0.2, max_tokens: 1200 }),
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
  if (stored) {
    try {
      await db.insert(conversationMessages).values({ id: replyId, conversationId, requestedBy: account.userId, role: "assistant", content: reply, createdAt: replyAt });
      await db.update(conversations).set({ updatedAt: replyAt }).where(and(eq(conversations.id, conversationId), eq(conversations.requestedBy, account.userId)));
    } catch { stored = false; }
  }

  return Response.json({ conversationId, stored, reply: { id: replyId, role: "assistant", content: reply, createdAt: replyAt } });
}

type Endpoint = ReturnType<typeof resolveChatModel>;

/**
 * Streams the reply as server-sent events: `meta` first (the conversation
 * id), then `delta` chunks, then `done` with the stored reply — or `error`
 * with a message a person can act on. The reply is persisted once, when the
 * model finishes, while the request is still open.
 */
function streamReply({ endpoint, turns, conversationId, stored, db, userId }: {
  endpoint: Endpoint; turns: { role: string; content: string }[]; conversationId: string; stored: boolean;
  db: ReturnType<typeof getDb>; userId: string;
}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (type: string, data: unknown) => controller.enqueue(encoder.encode(encodeEvent(type, data)));
      emit("meta", { conversationId });
      let text = "";
      try {
        const response = await fetch(completionsUrl(endpoint.baseUrl!), {
          method: "POST",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { "content-type": "application/json", accept: "text/event-stream", ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}) },
          body: JSON.stringify({ model: endpoint.model, messages: turns, stream: true, temperature: 0.2, max_tokens: 1200 }),
        });
        if (!response.ok || !response.body) {
          emit("error", { message: `The model endpoint answered ${response.status}.` });
          controller.close();
          return;
        }
        if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
          // Some servers ignore stream:true; forward the whole reply as one delta.
          text = replyText(await response.json());
          if (text) emit("delta", { text });
        } else {
          const parser = createDeltaParser();
          const decoder = new TextDecoder();
          const reader = response.body.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const delta of parser.push(decoder.decode(value, { stream: true }))) {
              text += delta;
              emit("delta", { text: delta });
            }
          }
        }
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        emit("error", { message: timedOut ? "The model endpoint stopped answering before the reply finished." : "No model server answered. Check the endpoint in Connections." });
        controller.close();
        return;
      }
      const reply = text.trim();
      if (!reply) {
        emit("error", { message: "The model endpoint returned an empty reply." });
        controller.close();
        return;
      }
      const replyId = randomUUID();
      const replyAt = new Date().toISOString();
      let persisted = stored;
      if (persisted) {
        try {
          await db.insert(conversationMessages).values({ id: replyId, conversationId, requestedBy: userId, role: "assistant", content: reply, createdAt: replyAt });
          await db.update(conversations).set({ updatedAt: replyAt }).where(and(eq(conversations.id, conversationId), eq(conversations.requestedBy, userId)));
        } catch { persisted = false; }
      }
      emit("done", { conversationId, stored: persisted, reply: { id: replyId, role: "assistant", content: reply, createdAt: replyAt } });
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}

/**
 * Whether chat can answer at all, so the composer can say so before someone
 * types a paragraph and presses send — the reason a dead button feels broken
 * is almost always that it looked alive.
 */
export async function GET(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  const endpoint = resolveChatModel(process.env);
  return Response.json({ configured: endpoint.configured, reason: endpoint.reason ?? null }, { headers: { "cache-control": "no-store" } });
}
