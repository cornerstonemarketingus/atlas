import { OpportunityError } from "./service.mjs";
import { EXECUTION_CLASSES, STATUSES } from "./model.mjs";

/**
 * /v1/opportunities — what Atlas found, ranked, and what the owner decides.
 * Reading is open to any authenticated caller; hunting and deciding need the owner.
 *
 * GET    /v1/opportunities                        ?status=&class=&hunt=  ranked list and counts
 * GET    /v1/opportunities/:id                    one record and its history
 * POST   /v1/opportunities/:id/decision           { decision: approve|take_over|skip|applied|won|lost, digest?, amountUsd? }
 * POST   /v1/opportunities/hunts                  { goal, model? }  start a hunt (202)
 * GET    /v1/opportunities/hunts                  list
 * GET    /v1/opportunities/hunts/:id              one hunt with its progress toward the target
 * DELETE /v1/opportunities/hunts/:id              cancel a running hunt
 */
const STATUS = {
  INVALID_GOAL: 400, INVALID_DECISION: 400, NO_SEARCH: 503, UNKNOWN_OPPORTUNITY: 404, UNKNOWN_HUNT: 404,
  HUNT_RUNNING: 409, MANUAL_ONLY: 409, DIGEST_MISMATCH: 409, INVALID_TRANSITION: 409, NOT_CLAIMABLE: 409,
};
const HUNT_ID = "hunt-[0-9a-f-]{36}";
const OPPORTUNITY_ID = "opp-[0-9a-f-]{36}";

export function createOpportunityRoutes({ opportunities, parseBody, send }) {
  const fail = (response, error) => (error instanceof OpportunityError
    ? send(response, STATUS[error.code] ?? 400, { code: error.code, message: error.message })
    : send(response, 500, { message: error instanceof Error ? error.message : "The request failed." }));
  const owner = (identity, response) => (identity.role === "admin" ? true : (send(response, 403, { message: "Owner access required." }), false));

  return async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (!url.pathname.startsWith("/v1/opportunities")) return false;
    try {
      if (url.pathname === "/v1/opportunities") {
        if (request.method !== "GET") return send(response, 405, { message: "Method not allowed." });
        const status = url.searchParams.get("status");
        const executionClass = url.searchParams.get("class");
        if ((status && !STATUSES.includes(status)) || (executionClass && !EXECUTION_CLASSES.includes(executionClass))) return send(response, 400, { message: "Unknown status or class." });
        return send(response, 200, { opportunities: opportunities.list({ status, executionClass, huntId: url.searchParams.get("hunt") }), counts: opportunities.counts() });
      }
      if (url.pathname === "/v1/opportunities/hunts") {
        if (request.method === "GET") return send(response, 200, { hunts: opportunities.hunts() });
        if (request.method !== "POST") return send(response, 405, { message: "Method not allowed." });
        if (!owner(identity, response)) return true;
        const body = await parseBody(request, response); if (!body) return true;
        return send(response, 202, { hunt: opportunities.startHunt({ goal: body.goal, model: body.model }) });
      }
      const hunt = new RegExp(`^/v1/opportunities/hunts/(${HUNT_ID})$`, "u").exec(url.pathname);
      if (hunt) {
        if (request.method === "GET") {
          const found = opportunities.hunt(hunt[1]);
          return found ? send(response, 200, { hunt: found }) : send(response, 404, { message: "Hunt not found." });
        }
        if (request.method !== "DELETE") return send(response, 405, { message: "Method not allowed." });
        if (!owner(identity, response)) return true;
        return send(response, 200, { hunt: opportunities.cancelHunt(hunt[1]) });
      }
      const one = new RegExp(`^/v1/opportunities/(${OPPORTUNITY_ID})(?:/(decision))?$`, "u").exec(url.pathname);
      if (!one) return send(response, 404, { message: "Route not found." });
      const [, id, action] = one;
      if (request.method === "GET" && !action) {
        const found = opportunities.get(id);
        return found ? send(response, 200, { opportunity: found }) : send(response, 404, { message: "Opportunity not found." });
      }
      if (request.method === "POST" && action === "decision") {
        if (!owner(identity, response)) return true;
        const body = await parseBody(request, response); if (!body) return true;
        return send(response, 200, { opportunity: opportunities.decide(id, { decision: body.decision, digest: body.digest, amountUsd: body.amountUsd ?? null }) });
      }
      return send(response, 405, { message: "Method not allowed." });
    } catch (error) {
      return fail(response, error);
    }
  };
}
