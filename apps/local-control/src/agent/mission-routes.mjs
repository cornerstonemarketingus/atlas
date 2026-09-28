const MAX_BODY_BYTES = 256 * 1024;
const SSE_KEEPALIVE_MS = 15_000;
const MISSION_ID = "[A-Za-z0-9_-]{1,128}";

/** Authenticated HTTP adapter for the durable mission service. */
export function createMissionRoutes({ missionService, keepaliveMs = SSE_KEEPALIVE_MS }) {
  if (!missionService) throw new TypeError("missionService is required.");

  async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    const path = url.pathname;

    if (request.method === "GET" && path === "/v1/missions") {
      try {
        return send(response, 200, { missions: await missionService.list() });
      } catch (error) {
        return sendError(response, error);
      }
    }

    if (request.method === "POST" && path === "/v1/missions") {
      if (identity.role !== "admin") return send(response, 403, { message: "Only the local owner can create missions." });
      const body = await readJson(request, response);
      if (body === null) return true;
      try {
        return send(response, 201, { mission: await missionService.create(body) });
      } catch (error) {
        return sendError(response, error);
      }
    }

    const lane = new RegExp(`^/v1/missions/(${MISSION_ID})/lanes/([a-z0-9][a-z0-9._-]{0,63})/control$`, "u").exec(path);
    if (lane && request.method === "POST") {
      if (identity.role !== "admin") return send(response, 403, { message: "Only the local owner can control missions." });
      const body = await readJson(request, response);
      if (body === null) return true;
      const action = typeof body.action === "string" ? body.action.trim() : "";
      if (!["pause", "resume", "cancel", "retry"].includes(action)) {
        return send(response, 400, { message: "action must be pause, resume, cancel, or retry." });
      }
      try {
        return send(response, 200, { mission: await missionService.controlLane(lane[1], lane[2], action) });
      } catch (error) {
        return sendError(response, error);
      }
    }

    const match = new RegExp(`^/v1/missions/(${MISSION_ID})(?:/(control|events))?$`, "u").exec(path);
    if (!match) return false;
    const [, missionId, suffix] = match;

    if (request.method === "GET" && !suffix) {
      try {
        const mission = await missionService.get(missionId);
        return mission ? send(response, 200, { mission }) : send(response, 404, { message: "Mission not found." });
      } catch (error) {
        return sendError(response, error);
      }
    }

    if (request.method === "POST" && suffix === "control") {
      if (identity.role !== "admin") return send(response, 403, { message: "Only the local owner can control missions." });
      const body = await readJson(request, response);
      if (body === null) return true;
      const action = typeof body.action === "string" ? body.action.trim() : "";
      if (!["pause", "resume", "cancel"].includes(action)) {
        return send(response, 400, { message: "action must be pause, resume, or cancel." });
      }
      try {
        const mission = await missionService.control(missionId, action);
        return mission ? send(response, 200, { mission }) : send(response, 404, { message: "Mission not found." });
      } catch (error) {
        return sendError(response, error);
      }
    }

    if (request.method === "GET" && suffix === "events") {
      try {
        const mission = await missionService.get(missionId);
        if (!mission) return send(response, 404, { message: "Mission not found." });
        return streamEvents(request, response, missionService, missionId, url, keepaliveMs);
      } catch (error) {
        return sendError(response, error);
      }
    }

    return false;
  }

  return { handle };
}

function streamEvents(request, response, missionService, missionId, url, keepaliveMs) {
  const rawCursor = request.headers["last-event-id"] ?? url.searchParams.get("after") ?? "0";
  const cursor = Math.max(0, Number.parseInt(rawCursor, 10) || 0);

  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");
  response.writeHead(200);
  response.write("retry: 2000\n\n");

  let unsubscribe = () => {};
  const keepalive = setInterval(() => response.write(": keepalive\n\n"), keepaliveMs);
  if (typeof keepalive.unref === "function") keepalive.unref();
  const close = () => { clearInterval(keepalive); unsubscribe(); };

  unsubscribe = missionService.subscribe(missionId, cursor, (event) => {
    const sequence = Number.isSafeInteger(event?.sequence) ? event.sequence : undefined;
    const kind = safeEventName(event?.kind);
    response.write(`${sequence === undefined ? "" : `id: ${sequence}\n`}event: ${kind}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  request.once("close", close);
  response.once("close", close);
  return true;
}

function safeEventName(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/u.test(value) ? value : "mission";
}

async function readJson(request, response) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) {
      send(response, 413, { message: "Request body is too large." });
      return null;
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError();
    return value;
  } catch {
    send(response, 400, { message: "Request body must be a JSON object." });
    return null;
  }
}

function sendError(response, error) {
  const status = error?.statusCode ?? ({
    UNKNOWN_MISSION: 404,
    UNKNOWN_LANE: 404,
    MISSION_NOT_FOUND: 404,
    MISSION_EXISTS: 409,
    INVALID_STATE: 409,
    INVALID_MISSION: 400,
    INVALID_CONCURRENCY: 400,
    INVALID_ACTION: 400,
  }[error?.code] ?? 400);
  return send(response, status, { message: error instanceof Error ? error.message : "Mission request failed." });
}

function send(response, status, value) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.writeHead(status);
  response.end(JSON.stringify(value));
  return true;
}
