import { createModelClient, ModelRequestError } from "../model-client.mjs";
import { inferContextWindow } from "./discovery.mjs";

export const ROUTABLE_TASKS = ["planning", "coding", "vision", "summarization"];
export class NoRouteError extends Error { constructor(message) { super(message); this.name = "NoRouteError"; this.code = "NO_ROUTE"; } }

export function parseRoutes(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((route) => ROUTABLE_TASKS.includes(route?.task) && typeof route.model === "string" && typeof route.endpoint === "string").map((route) => ({
    ...route,
    ...(Number.isFinite(route.contextWindow) ? { contextSource: "configured" } : { contextWindow: inferContextWindow(route.model).contextWindow, contextSource: "inferred" }),
  }));
}

export function createModelRouter({ routes = [], createClient = (route) => createModelClient({ baseUrl: route.endpoint }) } = {}) {
  for (const route of routes) {
    if (!ROUTABLE_TASKS.includes(route.task)) throw new Error(`Unknown routing task: ${route.task}`);
    if (!route.endpoint || !route.model) throw new Error(`A ${route.task} route needs an endpoint and a model.`);
  }
  return {
    routes,
    async run(task, operation) {
      const choices = routes.filter((route) => route.task === task);
      if (choices.length === 0) throw new NoRouteError(`No route is configured for ${task}.`);
      const failures = [];
      for (const route of choices) {
        try { return { value: await operation(createClient(route), route), route }; }
        catch (error) {
          if (error instanceof ModelRequestError && ["MODEL_NOT_AUTHORIZED", "MODEL_INVALID_INPUT"].includes(error.code)) throw error;
          failures.push(`${route.model}: ${error.message}`);
        }
      }
      throw new NoRouteError(`Every ${task} route failed: ${failures.join("; ")}`);
    },
  };
}

export function describeRoutes(router) {
  return router.routes.map((route) => {
    const url = new URL(route.endpoint);
    return { task: route.task, model: route.model, location: ["127.0.0.1", "localhost", "::1"].includes(url.hostname) ? "this machine" : url.host, contextWindow: route.contextWindow, contextSource: route.contextSource };
  });
}
