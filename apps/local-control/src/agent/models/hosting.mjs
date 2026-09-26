import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assessCatalog, catalogEntry, planModels } from "./catalog.mjs";
import { ModelManagerError, assertModelTag } from "./manager.mjs";

/**
 * Models → Install → Run: the daemon side of native model hosting.
 *
 * GET  /v1/models/hosting            hardware, runtime status, the catalog as it
 *                                    fits this machine, the recommended plan and
 *                                    the plan the owner applied.
 * POST /v1/models/hosting/server     { action: "start"|"stop" }
 * POST /v1/models/hosting/install    { tag }            (background, poll GET)
 * POST /v1/models/hosting/remove     { tag }
 * POST /v1/models/hosting/warm       { tag, context }
 * POST /v1/models/hosting/plan       { coder, reviewer, fast } or {} for the recommendation
 *
 * Reading needs any authenticated caller; everything else needs the owner.
 * The applied plan is a small JSON file in the data directory, read by the
 * self-improvement loop (and anything else that routes by difficulty).
 */

const ROLES = ["coder", "reviewer", "fast"];

export class ModelPlanStore {
  constructor(path) {
    this.path = path;
  }

  read() {
    if (!existsSync(this.path)) return null;
    try {
      const plan = JSON.parse(readFileSync(this.path, "utf8"));
      return plan && typeof plan === "object" && plan.coder?.tag ? plan : null;
    } catch {
      return null;
    }
  }

  write(plan) {
    const clean = { appliedAt: new Date().toISOString() };
    for (const role of ROLES) {
      const entry = plan[role];
      if (!entry) continue;
      const tag = assertModelTag(typeof entry === "string" ? entry : entry.tag);
      const context = Math.max(2_048, Math.min(131_072, Number(entry.context) || catalogEntry(tag)?.nativeContext || 16_384));
      clean[role] = { tag, context };
    }
    if (!clean.coder) throw new ModelManagerError("INVALID_PLAN", "A plan needs at least a coder model.");
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, `${JSON.stringify(clean, null, 2)}\n`);
    renameSync(`${this.path}.tmp`, this.path);
    return clean;
  }
}

const STATUS = { INVALID_MODEL: 400, INVALID_PLAN: 400, NO_RUNTIME: 409, START_FAILED: 502, PULL_FAILED: 502, REMOVE_FAILED: 409, WARM_FAILED: 502, NOT_LOOPBACK: 400 };

export function createModelHostingRoutes({ manager, planStore, detectHardware, parseBody, send }) {
  let hardwareCache = null;
  const hardware = async () => {
    if (!hardwareCache || Date.now() - hardwareCache.at > 60_000) hardwareCache = { at: Date.now(), value: await detectHardware() };
    return hardwareCache.value;
  };

  async function overview() {
    const [machine, runtime] = await Promise.all([hardware(), manager.status()]);
    const installedTags = runtime.installed.map((entry) => entry.tag);
    return {
      hardware: machine,
      runtime,
      catalog: assessCatalog(machine, installedTags),
      recommended: planModels(machine, installedTags),
      recommendedInstalled: planModels(machine, installedTags, { preferInstalled: true }),
      applied: planStore.read(),
    };
  }

  return async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (!url.pathname.startsWith("/v1/models/hosting")) return false;
    try {
      if (request.method === "GET" && url.pathname === "/v1/models/hosting") return send(response, 200, await overview());
      if (request.method !== "POST") return send(response, 405, { message: "Method not allowed." });
      if (identity.role !== "admin") return send(response, 403, { message: "Owner access required.", unblock: "Use the local owner token." });
      const body = await parseBody(request, response); if (!body) return true;
      switch (url.pathname) {
        case "/v1/models/hosting/server":
          if (body.action === "stop") return send(response, 200, manager.stopServer());
          return send(response, 200, await manager.ensureServer({ contextLength: Number(body.context) || 16_384 }));
        case "/v1/models/hosting/install": {
          const { promise, ...job } = manager.install(body.tag);
          promise?.catch(() => {});
          return send(response, 202, { job });
        }
        case "/v1/models/hosting/remove":
          return send(response, 200, await manager.remove(body.tag));
        case "/v1/models/hosting/warm":
          return send(response, 200, await manager.warm(body.tag, body.context));
        case "/v1/models/hosting/plan": {
          const plan = ROLES.some((role) => body[role]) ? body : (await overview()).recommended;
          return send(response, 200, { applied: planStore.write(plan) });
        }
        default:
          return send(response, 404, { message: "Route not found." });
      }
    } catch (error) {
      if (error instanceof ModelManagerError) return send(response, STATUS[error.code] ?? 400, { code: error.code, message: error.message });
      return send(response, 500, { message: error instanceof Error ? error.message : "The request failed." });
    }
  };
}
