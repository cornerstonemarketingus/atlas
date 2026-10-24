/**
 * Which local model `repository.coder` (and every other caller of the isolated
 * local coder) runs, and the context window it is told about.
 *
 * Precedence, so a small machine's configuration is honored instead of being
 * overridden by a hard-coded larger model:
 *   1. a model the caller asked for by name,
 *   2. ATLAS_LOCAL_CODER_MODEL,
 *   3. the coder in the model plan the owner applied on the Models page,
 *   4. the legacy default.
 *
 * The legacy default counts as "not specified": the local UI's model pickers
 * offer only that one option, so a task carrying it has not chosen anything.
 */
export const LEGACY_DEFAULT_MODEL = "qwen2.5-coder:7b";
export const DEFAULT_CONTEXT_WINDOW = 16_384;
export const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;

function positive(value) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** Of the installed models, the one to use when nothing was configured: a coder model if there is one. */
export function pickInstalledCoder(installed) {
  const names = (Array.isArray(installed) ? installed : []).filter((name) => typeof name === "string" && name);
  return names.find((name) => /coder/iu.test(name)) ?? names[0] ?? null;
}

export function resolveLocalCoder({ requested = "", modelPlan = null, env = process.env, installed = null } = {}) {
  const asked = typeof requested === "string" ? requested.trim() : "";
  const coder = modelPlan?.read?.()?.coder ?? null;
  const configured = env.ATLAS_LOCAL_CODER_MODEL?.trim() || null;
  let model;
  let source;
  if (asked && asked !== LEGACY_DEFAULT_MODEL) { model = asked; source = "request"; }
  else if (configured) { model = configured; source = "ATLAS_LOCAL_CODER_MODEL"; }
  else if (coder?.tag) { model = coder.tag; source = "model plan"; }
  // Nothing configured: the legacy default if it is installed (or the list is unknown),
  // otherwise what is actually installed, so a machine with only a small model works.
  else if (Array.isArray(installed) && installed.length > 0 && !installed.includes(asked || LEGACY_DEFAULT_MODEL)) { model = pickInstalledCoder(installed); source = "installed"; }
  else { model = asked || LEGACY_DEFAULT_MODEL; source = "default"; }
  const planned = coder?.tag === model ? positive(coder.context) : null;
  const contextWindow = positive(env.ATLAS_LOCAL_CODER_CONTEXT_WINDOW) ?? planned ?? DEFAULT_CONTEXT_WINDOW;
  const requestedOutput = positive(env.ATLAS_LOCAL_CODER_MAX_OUTPUT_TOKENS) ?? DEFAULT_MAX_OUTPUT_TOKENS;
  // An output ceiling at or above the window leaves no room for a prompt; the CLI refuses it.
  const maxOutputTokens = Math.min(requestedOutput, Math.max(256, Math.floor(contextWindow / 2)));
  const baseUrl = env.ATLAS_OLLAMA_URL?.trim() || null;
  return { model, contextWindow, maxOutputTokens, baseUrl, source };
}
