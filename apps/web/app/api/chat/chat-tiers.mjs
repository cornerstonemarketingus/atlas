import { resolveChatProvider, workersAIModel } from "./providers.mjs";
import { workersAIBindingModel } from "./workers-ai-binding.mjs";

// Public choices never accept raw provider IDs or model names.
export function normalizeChatTier(value) {
  if (value === undefined || value === "auto" || value === "atlas") return "atlas";
  return value === "super-atlas" ? value : null;
}

export function hasSuperAtlas(plan) {
  return plan?.status === "active" && ["pro", "team"].includes(plan?.tier);
}

export async function superAtlasAccess(account, loadPlan) {
  if (!account || account.dbUserId == null) return false;
  try { return hasSuperAtlas(await loadPlan(account.dbUserId)); }
  catch { return false; }
}

export function resolveTierModel(tier, environment = process.env, bindings = {}) {
  if (tier === "super-atlas") return resolveChatProvider(environment, "auto", bindings);
  if (tier !== "atlas") return { configured: false, reason: "Unknown Atlas mode." };
  // Basic Atlas cannot fall back to a premium provider or an expensive model.
  const basicEnv = { ...environment, ATLAS_WORKERS_AI_MODEL: "@cf/meta/llama-3.1-8b-instruct-fp8-fast" };
  const endpoint = workersAIBindingModel(bindings, basicEnv) ?? workersAIModel(basicEnv);
  return endpoint ? { ...endpoint, fallbackModel: null } : { configured: false, reason: "Atlas is temporarily unavailable. Please try again later." };
}

export function atlasChoices(environment, bindings, paid) {
  return [
    { id: "atlas", label: "Atlas", available: resolveTierModel("atlas", environment, bindings).configured },
    { id: "super-atlas", label: "Super Atlas", paid: true, locked: !paid,
      available: paid && resolveTierModel("super-atlas", environment, bindings).configured },
  ];
}
