/**
 * Every vendor a cloud coder run may use, with the variable its key lives in,
 * its default coder model and its trust tier (packages/atlas-inference/src/catalog.mjs).
 * A `trains` vendor's free tier may use prompts to improve its products, so it
 * joins the coder's automatic fallbacks only when the owner sets
 * ATLAS_ALLOW_TRAINING_PROVIDERS=all (chat alone uses "1").
 */
const VENDORS = Object.freeze({
  groq: { key: "GROQ_API_KEY", model: "openai/gpt-oss-120b", tier: "vendor" },
  anthropic: { key: "ANTHROPIC_API_KEY", model: undefined, tier: "vendor" },
  openai: { key: "OPENAI_API_KEY", model: "gpt-5.4-mini", tier: "vendor" },
  "workers-ai": { key: "ATLAS_WORKERS_AI_TOKEN", model: "@cf/openai/gpt-oss-120b", tier: "vendor" },
  cerebras: { key: "CEREBRAS_API_KEY", model: "gpt-oss-120b", tier: "vendor" },
  gemini: { key: "GEMINI_API_KEY", model: "gemini-2.5-flash", tier: "trains" },
  openrouter: { key: "OPENROUTER_API_KEY", model: "openai/gpt-oss-20b:free", tier: "trains" },
  mistral: { key: "MISTRAL_API_KEY", model: "devstral-small-latest", tier: "trains" },
});
export const PROVIDER_KEY_VARIABLES = Object.freeze(Object.fromEntries(Object.entries(VENDORS).map(([id, vendor]) => [id, vendor.key])));
/** provider:model:ITS_KEY_VARIABLE; the model may contain colons (OpenRouter's ":free"). */
export function isValidRoute(route) {
  const parts = String(route).split(":");
  if (parts.length < 3) return false;
  const [id, key] = [parts[0], parts.at(-1)];
  const model = parts.slice(1, -1).join(":");
  return Object.hasOwn(VENDORS, id) && key === VENDORS[id].key && /^[A-Za-z0-9@._/:-]{1,128}$/u.test(model);
}

// Automatic order when nothing is chosen, and the order fallbacks are added in.
const AUTOMATIC = ["workers-ai", "openai", "groq", "cerebras", "gemini", "openrouter", "mistral"];

export function resolveCoderRoutes(environment) {
  const allowsTraining = (environment.ATLAS_ALLOW_TRAINING_PROVIDERS ?? "").trim().toLowerCase() === "all";
  const tier = (id) => VENDORS[id].tier === "trains" && (environment[`ATLAS_${id.toUpperCase().replace("-", "_")}_TIER`] ?? "").trim().toLowerCase() === "paid" ? "vendor" : VENDORS[id].tier;
  const configured = (id) => Boolean(environment[VENDORS[id].key]?.trim()) && (id !== "workers-ai" || /^[a-f0-9]{32}$/iu.test(environment.CLOUDFLARE_ACCOUNT_ID ?? ""));
  const usable = (id) => configured(id) && (tier(id) !== "trains" || allowsTraining);
  const modelFor = (id) => (id === "workers-ai" ? environment.ATLAS_WORKERS_AI_MODEL : environment[`ATLAS_${id.toUpperCase()}_MODEL`])?.trim() || VENDORS[id].model;
  const explicit = (environment.ATLAS_CODER_PROVIDER ?? "").trim().toLowerCase();
  const selectedModel = (environment.ATLAS_CODER_MODEL ?? "").trim();
  const inferred = selectedModel.startsWith("@cf/") ? "workers-ai" : /^(gpt-|o[134](-|$))/iu.test(selectedModel) ? "openai" : /^(anthropic\/)?claude[-.]/iu.test(selectedModel) ? "anthropic"
    : selectedModel.endsWith(":free") ? "openrouter" : /^gemini-/iu.test(selectedModel) ? "gemini" : /^(?:mistral|devstral|codestral|magistral)-/iu.test(selectedModel) ? "mistral" : "groq";
  const provider = explicit || (selectedModel || environment.ATLAS_CODER_BASE_URL ? inferred : AUTOMATIC.find(usable) ?? "groq");
  if (!Object.hasOwn(VENDORS, provider)) throw new Error(`ATLAS_CODER_PROVIDER must be one of: ${Object.keys(VENDORS).join(", ")}.`);
  const model = selectedModel || modelFor(provider);
  if (!model) throw new Error("Set ATLAS_CODER_MODEL for the selected provider.");
  const spec = (environment.ATLAS_CODER_FALLBACKS ?? "").trim();
  const fallbacks = spec.toLowerCase() === "none" ? [] : spec.split(",").map((route) => route.trim()).filter(Boolean);
  for (const route of fallbacks) if (!isValidRoute(route)) throw new Error("Invalid coder fallback; use provider:model:its_provider_key_environment.");
  // A custom/private server never acquires public fallbacks implicitly.
  if (spec.toLowerCase() !== "none" && !environment.ATLAS_CODER_BASE_URL) {
    for (const id of AUTOMATIC) if (id !== provider && usable(id) && !fallbacks.some((route) => route.startsWith(id + ":"))) fallbacks.push(id + ":" + modelFor(id) + ":" + VENDORS[id].key);
  }
  return { provider, model, apiKeyVariable: VENDORS[provider].key, fallbacks };
}
