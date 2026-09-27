import { existsSync } from "node:fs";
import { join } from "node:path";
import { classifyDifficulty, modelForDifficulty } from "../../agent/models/difficulty.mjs";
import { DEFAULT_MODEL_ENDPOINT, assertSafeEndpoint, buildCoderCli, createCoderBuilder, isLoopback } from "../self-improve/runtime.mjs";

/**
 * Genesis's coder: Atlas's existing coder (packages/atlas-cli `atlas code`),
 * driven exactly as the self-improvement loop drives it (runtime.mjs). It
 * edits the project workspace, runs the project's own checks, and repairs its
 * own edit before returning. Genesis adds only the choice of model and a
 * reachability check.
 *
 * Model choice, in order:
 * 1. the Intelligence Layer (`intelligence.modelFor`), when it answers;
 * 2. the owner's applied model plan (Models page), by task difficulty,
 *    through the existing agent/models routing: simple polish goes to the
 *    fast model, features and repairs to the coder model, and retries escalate;
 * 3. ATLAS_GENESIS_MODEL, or Atlas's default local coder model.
 *
 * The endpoint defaults to the local model server. A remote endpoint is only
 * used when the owner sets ATLAS_GENESIS_BASE_URL (and a key variable), so
 * Genesis never spends paid API credits on its own.
 */
export function createGenesisCoder({ atlasRoot, dataDirectory, environment = process.env, modelPlan = null, intelligence = null, fetchImpl = fetch, onOutput = null }) {
  const baseUrl = environment.ATLAS_GENESIS_BASE_URL || DEFAULT_MODEL_ENDPOINT.baseUrl;
  assertSafeEndpoint(baseUrl);
  const explicitModel = environment.ATLAS_GENESIS_MODEL || null;
  const apiKey = environment.ATLAS_GENESIS_API_KEY_ENV ? environment[environment.ATLAS_GENESIS_API_KEY_ENV] ?? "" : "";
  let cli = null;

  async function chooseModel(task, attempt, kind) {
    try {
      const chosen = await intelligence?.modelFor?.({ task, attempt, kind });
      if (chosen?.model) return { tag: chosen.model, context: chosen.context ?? 16_384, reason: chosen.reason ?? "intelligence layer" };
    } catch { /* fall through */ }
    if (explicitModel) return { tag: explicitModel, context: 16_384, reason: "ATLAS_GENESIS_MODEL" };
    const plan = modelPlan?.read?.() ?? null;
    const { level } = classifyDifficulty({ objective: task?.objective ?? "", kind: kind === "polish" ? "todo-comment" : kind === "repair" ? "failing-check" : "", attempt });
    const pick = modelForDifficulty(plan, level, { tag: DEFAULT_MODEL_ENDPOINT.model, context: 16_384 });
    return { ...pick, reason: plan ? `model plan (${level})` : "default local model" };
  }

  const coder = async ({ workspace, objective, task, attempt, kind }) => {
    const model = await chooseModel(task, attempt, kind);
    cli ??= buildCoderCli(atlasRoot, { stdio: "ignore" });
    const builder = createCoderBuilder({ atlasRoot, cli, runsDirectory: join(dataDirectory, "genesis", "runs"), endpoint: { baseUrl, model: model.tag, apiKey }, contextWindow: String(model.context ?? 16_384), onOutput });
    const result = await builder({ worktree: workspace, objective, verifyDirectory: "." });
    return { ...result, model: model.tag, modelReason: model.reason };
  };

  /** Whether a model server answers; remote endpoints the owner configured are assumed reachable. */
  coder.available = async () => {
    // An installed Atlas without its own source has no coder to run.
    if (!existsSync(join(atlasRoot, "packages", "atlas-cli", "package.json"))) return false;
    if (!isLoopback(baseUrl)) return true;
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/u, "")}/models`, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) return false;
      const body = await response.json().catch(() => ({}));
      return Array.isArray(body?.data) ? body.data.length > 0 : true;
    } catch {
      return false;
    }
  };
  coder.endpoint = baseUrl;
  return coder;
}
