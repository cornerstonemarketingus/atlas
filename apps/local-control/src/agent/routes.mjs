import { AgentRuntimeError } from "./runtime.mjs";

const MAX_TURN_CHARACTERS = 10_000;
const SSE_KEEPALIVE_MS = 15_000;

/**
 * HTTP surface for the runtime.
 *
 * Returns true when it has handled the request, so the control plane can
 * keep its existing routing shape. Creating work stays owner-only; a paired
 * phone can watch a session and answer approvals, which is the split the
 * local control plane already draws for tasks.
 */
export function createAgentRoutes({ runtime, keepaliveMs = SSE_KEEPALIVE_MS }) {
  async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    const path = url.pathname;

    if (request.method === "GET" && path === "/v1/executors") {
      return send(response, 200, { executors: runtime.executorIds() });
    }

    if (request.method === "GET" && path === "/v1/sessions") {
      return send(response, 200, { sessions: runtime.listSessions() });
    }

    if (request.method === "POST" && path === "/v1/sessions") {
      if (identity.role !== "admin") return send(response, 403, { message: "Only the local owner can open a session." });
      const body = await readJson(request, response);
      if (!body) return true;
      const title = trimmed(body.title, 200);
      const repository = body.repository === undefined || body.repository === null ? null : trimmed(body.repository, 4096);
      const model = trimmed(body.model, 200);
      if (!title || !model) return send(response, 400, { message: "title and model are required." });
      try {
        return send(response, 201, { session: runtime.createSession({ title, repository, model, executor: trimmed(body.executor, 64) || "local", budget: body.budget ?? {} }) });
      } catch (error) {
        return send(response, statusForError(error), { message: error.message });
      }
    }

    const sessionMatch = /^\/v1\/sessions\/([0-9a-f-]{36})(\/[a-z]+)?$/u.exec(path);
    if (!sessionMatch) return false;
    const [, sessionId, suffix] = sessionMatch;

    if (request.method === "GET" && !suffix) {
      const session = runtime.getSession(sessionId);
      return session
        ? send(response, 200, { session, turns: runtime.getTurns(sessionId) })
        : send(response, 404, { message: "Session not found." });
    }

    if (request.method === "GET" && suffix === "/events") {
      return streamEvents(request, response, runtime, sessionId, url, keepaliveMs);
    }

    if (request.method === "POST" && suffix === "/turns") {
      if (identity.role !== "admin") return send(response, 403, { message: "Only the local owner can send a turn." });
      const body = await readJson(request, response);
      if (!body) return true;
      const text = trimmed(body.text, MAX_TURN_CHARACTERS);
      if (!text) return send(response, 400, { message: `text is required and must be at most ${MAX_TURN_CHARACTERS} characters.` });
      try {
        return send(response, 202, runtime.submitTurn(sessionId, { text, attachments: normalizeAttachments(body.attachments) }));
      } catch (error) {
        return send(response, statusForError(error), { message: error.message });
      }
    }

    if (request.method === "POST" && suffix === "/control") {
      if (identity.role !== "admin") return send(response, 403, { message: "Only the local owner can control a run." });
      const body = await readJson(request, response);
      if (!body) return true;
      const action = trimmed(body.action, 20);
      if (!["pause", "resume", "cancel", "retry"].includes(action)) {
        return send(response, 400, { message: "action must be pause, resume, cancel, or retry." });
      }
      try {
        return send(response, 200, { session: runtime[action](sessionId) });
      } catch (error) {
        return send(response, statusForError(error), { message: error.message });
      }
    }

    return false;
  }

  return { handle };
}

/**
 * Server-sent events, resumable by sequence number.
 *
 * The cursor comes from `Last-Event-ID` when the browser reconnects on its
 * own and from `?after=` when a client reopens deliberately. Either way the
 * client names what it has already seen, so reopening the UI mid-run replays
 * the gap instead of starting from an empty transcript.
 */
function streamEvents(request, response, runtime, sessionId, url, keepaliveMs) {
  if (!runtime.getSession(sessionId)) return send(response, 404, { message: "Session not found." });
  const header = request.headers["last-event-id"];
  const query = url.searchParams.get("after");
  const after = Math.max(0, Number.parseInt(header ?? query ?? "0", 10) || 0);

  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");
  response.writeHead(200);
  response.write(`retry: 2000\n\n`);

  let unsubscribe = () => {};
  const keepalive = setInterval(() => response.write(": keepalive\n\n"), keepaliveMs);
  if (typeof keepalive.unref === "function") keepalive.unref();
  const close = () => { clearInterval(keepalive); unsubscribe(); };

  unsubscribe = runtime.subscribe(sessionId, after, (event) => {
    response.write(`id: ${event.sequence}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
  });

  request.on("close", close);
  response.on("close", close);
  return true;
}

function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((entry) => ({
    kind: trimmed(entry?.kind, 40) || "file",
    name: trimmed(entry?.name, 200) || "attachment",
    path: entry?.path === undefined ? null : trimmed(entry.path, 4096),
    mediaType: trimmed(entry?.mediaType, 100) || null,
  }));
}

function statusForError(error) {
  if (!(error instanceof AgentRuntimeError)) return 400;
  return { UNKNOWN_SESSION: 404, UNKNOWN_EXECUTOR: 400, ALREADY_RUNNING: 409, NOT_RUNNING: 409, NOT_RESUMABLE: 409, NOT_RETRYABLE: 409, NOTHING_TO_RETRY: 409 }[error.code] ?? 400;
}

function trimmed(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function readJson(request, response) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 256 * 1024) { send(response, 413, { message: "Request body is too large." }); return null; }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    send(response, 400, { message: "Request body must be JSON." });
    return null;
  }
}

function send(response, status, value) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.writeHead(status);
  response.end(JSON.stringify(value));
  return true;
}
