import { GoalError } from "./goals.mjs";

/**
 * /v1/goals — goals that sleep between events. Reading is open to any
 * authenticated caller; creating, waking and cancelling need the owner.
 *
 * GET    /v1/goals                  list
 * POST   /v1/goals                  { objective, repository, model, watch: { repository, pullRequest? }, wakeOn?, until?, maxWakes?, expiresInHours?, startNow? }
 * GET    /v1/goals/:id              one goal and its history
 * DELETE /v1/goals/:id              cancel
 * POST   /v1/goals/:id/wake         wake now
 */
const ID = "goal-[0-9a-f-]{36}";
const STATUS = { INVALID_GOAL: 400, UNKNOWN_GOAL: 404, GOAL_FINISHED: 409 };

export function createGoalRoutes({ goals, parseBody, send }) {
  const fail = (response, error) => (error instanceof GoalError
    ? send(response, STATUS[error.code] ?? 400, { code: error.code, message: error.message })
    : send(response, 500, { message: error instanceof Error ? error.message : "The request failed." }));

  return async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (!url.pathname.startsWith("/v1/goals")) return false;
    try {
      if (url.pathname === "/v1/goals") {
        if (request.method === "GET") return send(response, 200, { goals: goals.list() });
        if (request.method !== "POST") return send(response, 405, { message: "Method not allowed." });
        if (identity.role !== "admin") return send(response, 403, { message: "Owner access required." });
        const body = await parseBody(request, response); if (!body) return true;
        return send(response, 201, { goal: goals.create(body) });
      }
      const match = new RegExp(`^/v1/goals/(${ID})(?:/(wake))?$`, "u").exec(url.pathname);
      if (!match) return send(response, 404, { message: "Route not found." });
      const [, id, action] = match;
      if (request.method === "GET" && !action) {
        const goal = goals.get(id);
        return goal ? send(response, 200, { goal }) : send(response, 404, { message: "Goal not found." });
      }
      if (identity.role !== "admin") return send(response, 403, { message: "Owner access required." });
      if (request.method === "DELETE" && !action) return send(response, 200, { goal: goals.cancel(id) });
      if (request.method === "POST" && action === "wake") return send(response, 200, { goal: goals.wakeNow(id) });
      return send(response, 405, { message: "Method not allowed." });
    } catch (error) {
      return fail(response, error);
    }
  };
}
