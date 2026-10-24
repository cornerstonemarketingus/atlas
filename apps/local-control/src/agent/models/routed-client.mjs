import { ModelRequestError } from "../model-client.mjs";
import { NoRouteError } from "./router.mjs";
import { isLoopbackUrl, modelEgressPolicy } from "./egress.mjs";

const TERMINAL = new Set(["MODEL_NOT_AUTHORIZED", "MODEL_INVALID_INPUT"]);

/**
 * A model client that routes each request through the configured routes for
 * one task, with fallback, and otherwise behaves exactly like the client it
 * wraps. A model outage should not end a conversation or a mission.
 *
 * Failover happens only before the first streamed chunk: once text has
 * reached the person, switching models would duplicate or garble the answer,
 * so a mid-stream failure is reported instead. Authorization and invalid-input
 * errors are never retried elsewhere — they would fail identically.
 *
 * Routes whose model matches the one the session asked for are tried first,
 * so a person's explicit choice wins while the others remain as fallback.
 * `onRoute` records which model actually did the work.
 *
 * Local first: when the first route tried is on this machine, a remote route
 * is never used as its fallback unless the owner set
 * ATLAS_MODEL_REMOTE_FALLBACK=1 (`egress.remoteFallback`). A local outage
 * then ends in a clear error rather than a quiet switch to a hosted model.
 */
export function createRoutedClient({ routes = [], task = "planning", createClient, fallback, onRoute = () => {}, egress = undefined }) {
  const candidates = routes.filter((route) => route.task === task);
  if (!candidates.length) return fallback;
  return {
    endpoint: fallback?.endpoint ?? null,
    routes: candidates,
    async *stream(request) {
      const ordered = [...candidates.filter((r) => r.model === request.model), ...candidates.filter((r) => r.model !== request.model)];
      const failures = [];
      const policy = egress ?? modelEgressPolicy();
      const localFirst = ordered.length > 0 && isLoopbackUrl(ordered[0].endpoint);
      for (const route of ordered) {
        if (localFirst && !policy.remoteFallback && !isLoopbackUrl(route.endpoint)) {
          failures.push(`${route.model}: not tried, it is remote and the local route came first (set ATLAS_MODEL_REMOTE_FALLBACK=1 to allow that fallback)`);
          continue;
        }
        let started = false;
        try {
          for await (const chunk of createClient(route).stream({ ...request, model: route.model })) {
            if (!started) { started = true; onRoute(route, { failedOver: failures.length > 0 }); }
            yield chunk;
          }
          return;
        } catch (error) {
          if (started || request.signal?.aborted) throw error;
          if (error instanceof ModelRequestError && TERMINAL.has(error.code)) throw error;
          failures.push(`${route.model}: ${error?.message ?? "failed"}`);
        }
      }
      throw new NoRouteError(`Every ${task} model failed: ${failures.join("; ")}`);
    },
  };
}
