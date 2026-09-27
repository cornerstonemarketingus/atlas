import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { getD1, getDb } from "../../../db";
import { conversationWritable, recallForMemory, tenantAllowlist } from "../../../db/tenancy.mjs";
import { resolveTenantContext, tenantScope } from "../auth/tenant-context.mjs";
import { conversationMessages, conversations } from "../../../db/schema";
import { authenticatedAccount } from "../tasks/operator-auth.mjs";
import { isDeploymentOwner } from "../tasks/self-protection.mjs";
import { POST as startTask } from "../tasks/route";
import { allowedRepositories } from "../tasks/dispatch.mjs";
import { createInstallationToken, githubAppConfiguration } from "../tasks/github-app.mjs";
import { platformGitHubToken } from "../tasks/github-token.mjs";
import { GET as listDevices } from "../computer/devices/route";
import { POST as startComputerTask } from "../computer/tasks/route";
import { SELF_REPOSITORY, TASK_TOOL, atlasSystemPrompt, describeStartedTask, memoryDigest, taskRequestsFrom } from "./atlas-knowledge.mjs";
import { resolveChatModel, threadTitle } from "./model-endpoint.mjs";
import { encodeEvent } from "./stream.mjs";
import { converse } from "./agent-loop.mjs";
import { createAgentTeam } from "./agent-team.mjs";
import { instantToolDefinitions } from "./instant-tools.mjs";

/** How much of a thread is replayed to the model. Enough for continuity, bounded so a long thread cannot grow a request without limit. */
const HISTORY_TURNS = 20;
const MAX_MESSAGE = 8000;

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
  let memory = "";
  let stored = true;
  let allowlist = new Set<string>();
  try {
    // Tenancy (#71): threads belong to the caller's tenant; an id owned by another tenant or principal is never written to.
    const tenant = await resolveTenantContext(request, account, getD1());
    if (!tenant || !(await conversationWritable(getD1(), tenantScope(tenant), conversationId))) throw new Error("Conversation is not writable in this workspace.");
    await db.insert(conversations)
      .values({ id: conversationId, tenantId: tenant.tenantId, requestedBy: account.userId, title: threadTitle(message), repository, branch, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: conversations.id, set: { updatedAt: now }, setWhere: and(eq(conversations.tenantId, tenant.tenantId), eq(conversations.requestedBy, account.userId)) });
    history = await db.select({ role: conversationMessages.role, content: conversationMessages.content })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.conversationId, conversationId), eq(conversationMessages.requestedBy, account.userId)))
      .orderBy(asc(conversationMessages.createdAt));
    await db.insert(conversationMessages).values({ id: randomUUID(), conversationId, requestedBy: account.userId, role: "user", content: message, createdAt: now });
    // Repositories the chat tools may read: the workspace's allowlist, bounded by the deployment's.
    try { allowlist = await tenantAllowlist(getD1(), tenant.tenantId, allowedRepositories(process.env.ATLAS_ALLOWED_REPOSITORIES)); } catch { allowlist = new Set(); }
    // Memory across conversations: recall is best-effort and never blocks a reply.
    try { memory = memoryDigest(await recallForMemory(getD1(), tenantScope(tenant), { excludeConversationId: conversationId })); } catch { memory = ""; }
  } catch {
    // Same posture as task dispatch: a D1 problem degrades the feature to a
    // single un-remembered turn rather than refusing to answer at all.
    stored = false;
    history = [];
  }

  const turns = [
    { role: "system", content: atlasSystemPrompt({ isOwner: isDeploymentOwner(account), repository }) },
    // Earlier conversations are data the person wrote (or Atlas replied), never instructions; the block cannot be closed from inside.
    ...(memory ? [{ role: "system", content: `<data source="earlier conversations and recent runs in this workspace">\n${memory.replace(/<(\s*\/?\s*)data\b/giu, "&lt;$1data")}\n</data>` }] : []),
    ...history.slice(-HISTORY_TURNS).map((turn) => ({ role: turn.role === "assistant" ? "assistant" : "user", content: turn.content })),
    { role: "user", content: message },
  ];

  const startTasks = (calls: ReturnType<typeof taskRequestsFrom>) => startRequestedTasks(request, calls, { repository, branch, conversationId });
  const toolContext = { environment: process.env as Record<string, string | undefined>, allowlist, githubToken: memoizedGitHubToken() };
  // The lead (this reply) can hand work to an agent team built on the daemon's planner; see agent-team.mjs.
  const team = createAgentTeam({ endpoint, toolContext });
  const loop = {
    endpoint, turns, toolContext, defaultRepository: repository || SELF_REPOSITORY, userMessage: message, startTasks,
    tools: [TASK_TOOL, team.definition, ...instantToolDefinitions(toolContext.environment)],
    handlers: { [team.definition.function.name]: team.handler },
  };

  if (body.stream === true) {
    return streamReply({ ...loop, conversationId, stored, db, userId: account.userId });
  }

  const outcome = await converse({ ...loop, stream: false, emit: () => {} });
  if ("error" in outcome) return Response.json({ message: outcome.error, conversationId }, { status: outcome.status });
  const reply = outcome.reply;
  if (!reply) return Response.json({ message: "The model endpoint returned an empty reply.", conversationId }, { status: 502 });

  const replyId = randomUUID();
  const replyAt = new Date().toISOString();
  if (stored) {
    try {
      await db.insert(conversationMessages).values({ id: replyId, conversationId, requestedBy: account.userId, role: "assistant", content: reply, createdAt: replyAt });
      await db.update(conversations).set({ updatedAt: replyAt }).where(and(eq(conversations.id, conversationId), eq(conversations.requestedBy, account.userId)));
    } catch { stored = false; }
  }

  // `finalization` (metadata only) says the reply is the saved work because no model could write the answer.
  return Response.json({ conversationId, stored, steps: outcome.steps, ...(outcome.finalization ? { finalization: outcome.finalization } : {}), reply: { id: replyId, role: "assistant", content: reply, createdAt: replyAt } });
}

/** A GitHub credential for the read-only chat tools: the GitHub App's installation token when configured, else the platform token. Fetched once per request, only if a tool needs it. */
function memoizedGitHubToken() {
  let pending: Promise<string | undefined> | null = null;
  return () => {
    pending ??= (async () => {
      try {
        const configuration = githubAppConfiguration();
        if (configuration.configured) return await createInstallationToken(configuration);
      } catch { /* fall back to the platform token */ }
      return platformGitHubToken();
    })();
    return pending;
  };
}

type Endpoint = ReturnType<typeof resolveChatModel>;

/**
 * Starts computer work through the same routes the Computer page uses, so
 * pairing, workspace scoping and approval rules are identical. Picks the
 * person's online computer, else their most recent one (the task waits for
 * it to come online).
 */
async function startOnComputer(request: Request, headers: Headers, objective: string): Promise<{ ok: boolean; message: string; deviceName?: string; deviceOnline?: boolean }> {
  try {
    const listed = await listDevices(new Request(new URL("/api/computer/devices", request.url), { headers }));
    if (!listed.ok) return { ok: false, message: `the computer service answered ${listed.status}` };
    const { devices = [] } = await listed.json() as { devices?: { id: string; name: string; status: string; revokedAt: string | null }[] };
    const usable = devices.filter((device) => !device.revokedAt);
    const device = usable.find((candidate) => candidate.status === "online") ?? usable[0];
    if (!device) return { ok: false, message: "no computer is paired yet. Pair one on the [Computer control](/automation) page, then ask again" };
    const started = await startComputerTask(new Request(new URL("/api/computer/tasks", request.url), {
      method: "POST", headers, body: JSON.stringify({ deviceId: device.id, executionProvider: "windows", objective }),
    }));
    if (!started.ok) {
      const body = await started.json().catch(() => ({})) as { message?: string };
      return { ok: false, message: body.message ?? `the computer service answered ${started.status}` };
    }
    return { ok: true, message: "started", deviceName: device.name, deviceOnline: device.status === "online" };
  } catch {
    return { ok: false, message: "the computer service could not be reached" };
  }
}
type TaskRequests = ReturnType<typeof taskRequestsFrom>;

type ChatTurn = { role: string; content: string | null };
type ToolContext = Parameters<typeof converse>[0]["toolContext"];

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
    for (const name of ["authorization", "cookie", "oai-authenticated-user-id", "x-atlas-tenant"]) {
      const value = request.headers.get(name);
      if (value) forwarded.set(name, value);
    }
    forwarded.set("content-type", "application/json");
    if (task.mode === "computer") {
      lines.push(describeStartedTask(task, await startOnComputer(request, forwarded, task.objective)));
      continue;
    }
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
 * id), then `thinking`, `tool` (a step starting or finishing) and `delta`
 * events as they happen, then `done` with the stored reply — or `error` with
 * a message a person can act on. The reply is persisted once, when the model
 * finishes, while the request is still open.
 */
function streamReply({ conversationId, stored, db, userId, ...loop }: {
  endpoint: Endpoint; turns: ChatTurn[]; toolContext: ToolContext; conversationId: string; stored: boolean;
  db: ReturnType<typeof getDb>; userId: string; defaultRepository: string; userMessage: string;
  startTasks: (calls: TaskRequests) => Promise<string[]>;
  tools: object[]; handlers: Parameters<typeof converse>[0]["handlers"];
}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (type: string, data: unknown) => controller.enqueue(encoder.encode(encodeEvent(type, data)));
      emit("meta", { conversationId });
      const outcome = await converse({ ...loop, stream: true, emit });
      if ("error" in outcome) {
        emit("error", { message: outcome.error });
        controller.close();
        return;
      }
      const reply = outcome.reply;
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
      emit("done", { conversationId, stored: persisted, steps: outcome.steps, ...(outcome.finalization ? { finalization: outcome.finalization } : {}), reply: { id: replyId, role: "assistant", content: reply, createdAt: replyAt } });
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
