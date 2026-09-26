import { existsSync } from "node:fs";
import { join } from "node:path";
import { SelfImprovementLoop } from "./loop.mjs";
import { DEFAULT_MODEL_ENDPOINT, buildCoderCli, createCoderBuilder, createReviewer, runCheck } from "./runtime.mjs";
import { SelfImprovementService, createSelfImproveRoutes } from "./service.mjs";

export { SelfImprovementLoop, SelfImprovementService, createSelfImproveRoutes };

/**
 * The daemon's self-improvement service, or null when Atlas is not running
 * from a git checkout of itself (an installed build has nothing to improve).
 *
 * Configuration (all optional): ATLAS_SELF_IMPROVE_BASE_URL, _MODEL,
 * _REVIEW_MODEL, _API_KEY_ENV, _VERIFY_DIR (default apps/local-control).
 * The coder CLI is built on first use, not at daemon start.
 */
export function createDaemonSelfImprovement({ atlasRoot, dataDirectory, environment = process.env }) {
  if (!existsSync(join(atlasRoot, ".git")) || !existsSync(join(atlasRoot, "packages", "atlas-cli"))) return null;
  const home = join(dataDirectory, "self-improve");
  const baseUrl = environment.ATLAS_SELF_IMPROVE_BASE_URL || DEFAULT_MODEL_ENDPOINT.baseUrl;
  const model = environment.ATLAS_SELF_IMPROVE_MODEL || DEFAULT_MODEL_ENDPOINT.model;
  const reviewModel = environment.ATLAS_SELF_IMPROVE_REVIEW_MODEL || model;
  const apiKey = environment.ATLAS_SELF_IMPROVE_API_KEY_ENV ? environment[environment.ATLAS_SELF_IMPROVE_API_KEY_ENV] ?? "" : "";
  let cli = null;
  return new SelfImprovementService({
    repository: atlasRoot,
    decisionsPath: join(home, "decisions.jsonl"),
    createLoop: ({ log, onOutput }) => {
      const builder = async (input) => {
        cli ??= buildCoderCli(atlasRoot, { stdio: "ignore" });
        return createCoderBuilder({ atlasRoot, cli, runsDirectory: join(home, "runs"), endpoint: { baseUrl, model, apiKey }, onOutput })(input);
      };
      return new SelfImprovementLoop({
        repository: atlasRoot,
        worktreeRoot: join(home, "worktrees"),
        ledgerPath: join(home, "ledger.jsonl"),
        patchesDirectory: join(home, "patches"),
        verifyDirectory: environment.ATLAS_SELF_IMPROVE_VERIFY_DIR || "apps/local-control",
        builder,
        runCheck,
        reviewer: createReviewer({ baseUrl, model: reviewModel, apiKey }),
        log,
      });
    },
  });
}

/** The chat tool: "improve yourself" starts a run; the owner approves starting it, and separately approves any merge. */
export function registerSelfImproveTool(registry, service) {
  registry.register({
    name: "atlas.improve_self",
    description: "Start Atlas's self-improvement loop on Atlas's own code: it picks small improvements (failing checks first, then TODOs), makes each in an isolated worktree, re-runs the checks, applies the self-modification policy and has a separate reviewer approve. Accepted changes wait on the Improve Atlas page for the owner to merge or reject; nothing is merged by this tool. Use when the person asks Atlas to improve, fix or work on itself.",
    capability: "atlas.self_improve",
    risk: "moderate",
    timeoutMs: 10_000,
    maxOutputCharacters: 2_000,
    requiresApproval: true,
    inputSchema: {
      type: "object",
      required: [],
      properties: { iterations: { type: "integer", minimum: 1, maximum: 5, default: 1 } },
    },
    async execute({ input }) {
      if (!service) return "Self-improvement is unavailable: this Atlas is not running from a git checkout of its own source.";
      try {
        const status = service.start({ iterations: input.iterations ?? 1 });
        status.promise.catch(() => {});
        return `Started a self-improvement run (${status.run.iterations} iteration(s)). Progress and any changes waiting for approval are on the Improve Atlas page (#/improve). Current streak of accepted changes: ${status.streak}.`;
      } catch (error) {
        return `Could not start: ${error instanceof Error ? error.message : "unknown error"}`;
      }
    },
  });
}
