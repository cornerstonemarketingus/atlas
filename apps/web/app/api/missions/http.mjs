import { CloudMissions, MissionError } from "./service.mjs";
async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new MissionError("A JSON request body is required.");
  const chunks = []; let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 64000) { await reader.cancel(); throw new MissionError("Mission request exceeds 64 KB.", 413); }
    chunks.push(value);
  }
  const content = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.byteLength; }
  try { const body = JSON.parse(new TextDecoder().decode(content)); if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(); return body; }
  catch { throw new MissionError("Request body must be a JSON object."); }
}
export function missionRoutes({ authenticate, resolveScope, database, dispatch, receipt, outcome }) {
  /** @param {Request} request @param {string|null} [id] */
  return async (request, id = null) => {
    const headers = { "cache-control": "no-store" };
    try {
      const account = await authenticate(request);
      if (!account) return Response.json({ message: "Sign in is required." }, { status: 401, headers });
      const db = database();
      const scope = await resolveScope(request, account, db);
      if (!scope) return Response.json({ message: "Workspace access denied." }, { status: 403, headers });
      if (id !== null && !/^[0-9a-f-]{36}$/u.test(id)) throw new MissionError("Mission not found.", 404);
      const service = new CloudMissions({ db,
        dispatch: (scope, step) => dispatch(request, scope, step), receipt: (scope, correlationId, step) => receipt(request, scope, correlationId, step),
        outcome: (scope, taskId, step) => outcome(request, scope, taskId, step) });
      if (request.method === "GET") return Response.json(id ? { mission: await service.require(scope, id) } : { missions: await service.list(scope) }, { headers });
      if (request.method !== "POST") throw new MissionError("Method not allowed.", 405);
      const body = await readBody(request);
      if (!id) return Response.json({ mission: await service.create(scope, body) }, { status: 201, headers });
      if (body.action === "resume") { await service.control(scope, id, "resume"); return Response.json({ mission: await service.advance(scope, id) }, { headers }); }
      const mission = body.action === "advance" ? await service.advance(scope, id) : await service.control(scope, id, body.action);
      return Response.json({ mission }, { headers });
    } catch (error) {
      return Response.json({ message: error instanceof MissionError ? error.message : "Cloud mission storage or execution is unavailable. Check migration 0021 and task setup." }, { status: error instanceof MissionError ? error.status : 503, headers });
    }
  };
}
