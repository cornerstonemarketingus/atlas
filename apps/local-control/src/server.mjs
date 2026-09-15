import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { LOCAL_UI_CSS, LOCAL_UI_HTML, LOCAL_UI_JS } from "./ui.mjs";

const MAX_BODY_BYTES = 64 * 1024;

export function createLocalControlServer({ store, token, runTask, model = "qwen2.5-coder:7b" }) {
  if (!token || token.length < 32) throw new Error("ATLAS_LOCAL_TOKEN must contain at least 32 characters.");
  const expected = createHash("sha256").update(token).digest();

  return createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (request.method === "GET" && request.url === "/") return sendText(response, 200, "text/html; charset=utf-8", LOCAL_UI_HTML);
    if (request.method === "GET" && request.url === "/app.css") return sendText(response, 200, "text/css; charset=utf-8", LOCAL_UI_CSS);
    if (request.method === "GET" && request.url === "/app.js") return sendText(response, 200, "text/javascript; charset=utf-8", LOCAL_UI_JS);
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.method === "GET" && request.url === "/health") return send(response, 200, { status: "ok", mode: "sovereign", model });
    if (!authorized(request.headers.authorization, expected)) return send(response, 401, { message: "A valid local Atlas token is required." });

    if (request.method === "GET" && request.url === "/v1/tasks") return send(response, 200, { tasks: store.list() });
    if (request.method === "POST" && request.url === "/v1/tasks") {
      let body;
      try { body = JSON.parse(await readBody(request)); }
      catch (error) { return send(response, error?.code === "BODY_TOO_LARGE" ? 413 : 400, { message: error.message }); }
      const repository = typeof body.repository === "string" ? body.repository.trim() : "";
      const objective = typeof body.objective === "string" ? body.objective.trim() : "";
      if (!repository || repository.length > 4096 || !objective || objective.length > 10_000) {
        return send(response, 400, { message: "repository and objective are required and must be within bounds." });
      }
      const task = store.create({ repository, objective, model: typeof body.model === "string" && body.model.trim() ? body.model.trim() : model });
      queueMicrotask(async () => {
        store.markRunning(task.id);
        try {
          const result = await runTask(store.get(task.id));
          store.finish(task.id, result.ok ? "completed" : "failed", result.message);
        } catch (error) {
          store.finish(task.id, "failed", error instanceof Error ? error.message : "Unknown local runner failure.");
        }
      });
      return send(response, 202, { task });
    }
    const match = request.method === "GET" ? /^\/v1\/tasks\/([0-9a-f-]+)$/u.exec(request.url ?? "") : null;
    if (match) {
      const task = store.get(match[1]);
      return task ? send(response, 200, { task }) : send(response, 404, { message: "Task not found." });
    }
    return send(response, 404, { message: "Route not found." });
  });
}

function authorized(header, expected) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const actual = createHash("sha256").update(header.slice(7)).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(request) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) { const error = new Error("Request body is too large."); error.code = "BODY_TOO_LARGE"; throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response, status, value) { response.writeHead(status); response.end(JSON.stringify(value)); }
function sendText(response, status, contentType, value) { response.setHeader("content-type", contentType); response.writeHead(status); response.end(value); }
