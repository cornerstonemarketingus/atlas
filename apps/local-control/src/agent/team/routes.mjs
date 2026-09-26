/**
 * HTTP surface for agent missions on the local control plane (after
 * authentication). Reading is open to any authenticated caller; starting and
 * controlling missions needs the owner token.
 */
const MISSION_ID = "team-[0-9a-f-]{36}";

export function createTeamRoutes({ team, parseBody, send }) {
  return async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (!url.pathname.startsWith("/v1/team/")) return false;
    const fail = (error) => send(response, error.code === "UNKNOWN_MISSION" ? 404 : error.code === "INVALID_GOAL" ? 400 : error.blocked ? 409 : 500, {
      code: error.code ?? "ERROR", message: error.message ?? "The request failed.", ...(error.blocked ? { blocked: error.blocked, unblock: error.unblock } : {}),
    });
    try {
      if (request.method === "GET" && url.pathname === "/v1/team/missions") return send(response, 200, { missions: team.list() });
      if (request.method === "GET" && url.pathname === "/v1/team/roster") return send(response, 200, { agents: team.roster() });
      const detail = request.method === "GET" ? new RegExp(`^/v1/team/missions/(${MISSION_ID})$`, "u").exec(url.pathname) : null;
      if (detail) {
        const mission = team.detail(detail[1]);
        return mission ? send(response, 200, { mission }) : send(response, 404, { code: "UNKNOWN_MISSION", message: "Mission not found." });
      }
      if (request.method !== "POST") return send(response, 405, { message: "Method not allowed." });
      if (identity.role !== "admin") return send(response, 403, { message: "Owner access required.", blocked: "BLOCKED_BY_PERMISSION", unblock: "Use the local owner token." });
      const body = await parseBody(request, response); if (!body) return true;
      if (url.pathname === "/v1/team/missions") {
        const started = await team.start({ goal: body.goal });
        return send(response, 202, { mission: team.detail(started.mission.id), plan: started.plan });
      }
      const control = new RegExp(`^/v1/team/missions/(${MISSION_ID})/(pause|resume|cancel)$`, "u").exec(url.pathname);
      if (control) return send(response, 200, { mission: team.control(control[1], control[2]) });
      return send(response, 404, { message: "Route not found." });
    } catch (error) {
      return fail(error);
    }
  };
}
