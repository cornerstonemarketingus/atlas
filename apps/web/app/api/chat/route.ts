import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { conversationMessages, conversations, requestRateLimits } from "../../../db/schema";
import { authenticatedAccount } from "../tasks/operator-auth.mjs";
import { enforceRateLimit, rateLimitSubjectForAccount } from "../rate-limit.mjs";
import { isDeploymentOwner } from "../tasks/self-protection.mjs";
import { POST as startTask } from "../tasks/route";
import { SELF_REPOSITORY, TASK_TOOL, atlasSystemPrompt, describeStartedTask, taskRequestsFrom, taskRequestsFromCalls } from "./atlas-knowledge.mjs";
import { completionsUrl, replyText, resolveChatModel, threadTitle } from "./model-endpoint.mjs";
import { createDeltaParser, encodeEvent } from "./stream.mjs";

/** How much of a thread is replayed to the model. Enough for continuity, bounded so a long thread cannot grow a request without limit. */
const HISTORY_TURNS = 20;
const MAX_MESSAGE = 8000;
const REQUEST_TIMEOUT_MS = 60_000;

export async function POST(request: Request) {
  const account = await authenticatedAccount(request);
  if (!account) return Response.json({ message: "Sign in is required." }, { status: 401 });
  const limited = await enforceRateLimit({
    db: getDb,
    table: requestRateLimits,
    subject: rateLimitSubjectForAccount(account),
    route: "chat_post",
    limit: 40,
    windowSeconds: 15 * 60,
  });
  if (limited) return limited;

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
    { role: "system", content: atlasSystemPrompt({ isOwner: isDeploymentOwner(account), repository }) },
    ...history.slice(-HISTORY_TURNS).map((turn) => ({ role: turn.role === "assistant" ? "assistant" : "user", content: turn.content })),
    { role: "user", content: message },
  ];

  const startTasks = (calls: ReturnType<typeof taskRequestsFrom>) => startRequestedTasks(request, calls, { repository, branch, conversationId });

  if (body.stream === true) {
    return streamReply({ endpoint, turns, conversationId, stored, db, userId: account.userId, defaultRepository: repository || SELF_REPOSITORY, startTasks });
  }

  let payload: unknown;
  try {
    let response = await callModel(endpoint, turns, { stream: false, tools: true });
    if (response.status === 400 || response.status === 422) response = await callModel(endpoint, turns, { stream: false, tools: false });
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

  const started = await startTasks(taskRequestsFrom(payload, { defaultRepository: repository || SELF_REPOSITORY }));
  const reply = [replyText(payload), ...started].filter(Boolean).join("\n\n");
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
type TaskRequests = ReturnType<typeof taskRequestsFrom>;

/**
 * Tools first; an endpoint that does not support tool calling answers 400 or
 * 422, and the caller then retries without them rather than failing.
 */
function callModel(endpoint: Endpoint, turns: { role: string; content: string }[], { stream, tools }: { stream: boolean; tools: boolean }) {
  return fetch(completionsUrl(endpoint.baseUrl!), {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "content-type": "application/json", ...(stream ? { accept: "text/event-stream" } : {}), ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}) },
    body: JSON.stringify({ model: endpoint.model, messages: turns, stream, temperature: 0.2, max_tokens: 1200, ...(tools ? { tools: [TASK_TOOL], tool_choice: "auto" } : {}) }),
  });
}

/**
 * Starts each run the model asked for through /api/tasks exactly as the task
 * composer would, carrying this request's credentials, so allowlists, the
 * owner-only rule for Atlas's own repository, the coder objective check,
 * billing and merge policy all apply unchanged. Returns one honest line per
 * request.
 */
async function startRequestedTasks(request: Request, { requests, errors }: TaskRequests, context: { repository: string; branch: string; conversationId: string }) {
  const lines: string[] = [...errors];
  for (const task of requests) {
    const forwarded = new Headers();
    for (const name of ["authorization", "cookie", "oai-authenticated-user-id"]) {
      const value = request.headers.get(name);
      if (value) forwarded.set(name, value);
    }
    forwarded.set("content-type", "application/json");
    const taskBranch = task.repository === context.repository.toLowerCase() && context.branch ? context.branch : "main";
    let outcome: { ok: boolean; message: string; taskId?: string; mergePolicy?: string };
    try {
      const result = await startTask(new Request(new URL("/api/tasks", request.url), {
        method: "POST",
        headers: forwarded,
        body: JSON.stringify({ repository: task.repository, branch: taskBranch, mode: task.mode, objective: task.objective, conversationId: context.conversationId }),
      }));
      const body = await result.json().catch(() => ({})) as { message?: string; taskId?: string; mergePolicy?: string };
      outcome = result.ok
        ? { ok: true, message: "started", taskId: body.taskId, mergePolicy: body.mergePolicy }
        : { ok: false, message: body.message ?? `the task service answered ${result.status}` };
    } catch {
      outcome = { ok: false, message: "the task service could not be reached" };
    }
    lines.push(describeStartedTask(task, outcome));
  }
  return lines;
}

/**
 * Streams the reply as server-sent events: `meta` first (the conversation
 * id), then `delta` chunks, then `done` with the stored reply — or `error`
 * with a message a person can act on. The reply is persisted once, when the
 * model finishes, while the request is still open.
 */
function streamReply({ endpoint, turns, conversationId, stored, db, userId, defaultRepository, startTasks }: {
  endpoint: Endpoint; turns: { role: string; content: string }[]; conversationId: string; stored: boolean;
  db: ReturnType<typeof getDb>; userId: string; defaultRepository: string;
  startTasks: (calls: TaskRequests) => Promise<string[]>;
}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (type: string, data: unknown) => controller.enqueue(encoder.encode(encodeEvent(type, data)));
      emit("meta", { conversationId });
      let text = "";
      let calls: TaskRequests = { requests: [], errors: [] };
      try {
        let response = await callModel(endpoint, turns, { stream: true, tools: true });
        if (response.status === 400 || response.status === 422) response = await callModel(endpoint, turns, { stream: true, tools: false });
        if (!response.ok || !response.body) {
          emit("error", { message: `The model endpoint answered ${response.status}.` });
          controller.close();
          return;
        }
        if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
          // Some servers ignore stream:true; forward the whole reply as one delta.
          const payload = await response.json();
          text = replyText(payload);
          if (text) emit("delta", { text });
          calls = taskRequestsFrom(payload, { defaultRepository });
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
          calls = taskRequestsFromCalls(parser.toolCalls, { defaultRepository });
        }
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        emit("error", { message: timedOut ? "The model endpoint stopped answering before the reply finished." : "No model server answered. Check the endpoint in Connections." });
        controller.close();
        return;
      }
      // Runs the model asked for start after its words have streamed, and
      // each gets one line saying whether it started.
      const started = await startTasks(calls);
      if (started.length) {
        const addition = `${text.trim() ? "\n\n" : ""}${started.join("\n\n")}`;
        text += addition;
        emit("delta", { text: addition });
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
