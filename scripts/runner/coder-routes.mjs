const KEYS = Object.freeze({ groq: "GROQ_API_KEY", anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", "workers-ai": "ATLAS_WORKERS_AI_TOKEN" });
const MODELS = Object.freeze({ groq: "openai/gpt-oss-120b", openai: "gpt-5.4-mini", "workers-ai": "@cf/openai/gpt-oss-120b" });
export function resolveCoderRoutes(environment) {
  const configured = (id) => Boolean(environment[KEYS[id]]?.trim()) && (id !== "workers-ai" || /^[a-f0-9]{32}$/iu.test(environment.CLOUDFLARE_ACCOUNT_ID ?? ""));
  const explicit = (environment.ATLAS_CODER_PROVIDER ?? "").trim().toLowerCase();
  const selectedModel = (environment.ATLAS_CODER_MODEL ?? "").trim();
  const inferred = selectedModel.startsWith("@cf/") ? "workers-ai" : /^(gpt-|o[134](-|$))/iu.test(selectedModel) ? "openai" : /^(anthropic\/)?claude[-.]/iu.test(selectedModel) ? "anthropic" : "groq";
  const provider = explicit || (selectedModel || environment.ATLAS_CODER_BASE_URL ? inferred : ["workers-ai", "openai", "groq"].find(configured) ?? "groq");
  if (!Object.hasOwn(KEYS, provider)) throw new Error("ATLAS_CODER_PROVIDER must be groq, anthropic, openai, or workers-ai.");
  const model = selectedModel || (provider === "workers-ai" ? environment.ATLAS_WORKERS_AI_MODEL : undefined) || MODELS[provider];
  if (!model) throw new Error("Set ATLAS_CODER_MODEL for the selected provider.");
  const spec = (environment.ATLAS_CODER_FALLBACKS ?? "").trim();
  const fallbacks = spec.toLowerCase() === "none" ? [] : spec.split(",").map((route) => route.trim()).filter(Boolean);
  for (const route of fallbacks) {
    const [id, name, key, extra] = route.split(":");
    if (!Object.hasOwn(KEYS, id ?? "") || !name || !/^[A-Za-z0-9@._/-]+$/u.test(name) || key !== KEYS[id] || extra !== undefined) throw new Error("Invalid coder fallback; use provider:model:its_provider_key_environment.");
  }
  // A custom/private server never acquires public fallbacks implicitly.
  if (spec.toLowerCase() !== "none" && !environment.ATLAS_CODER_BASE_URL) {
    for (const id of ["workers-ai", "openai", "groq"]) if (id !== provider && configured(id) && !fallbacks.some((route) => route.startsWith(id + ":"))) fallbacks.push(id + ":" + (id === "workers-ai" ? environment.ATLAS_WORKERS_AI_MODEL || MODELS[id] : MODELS[id]) + ":" + KEYS[id]);
  }
  return { provider, model, apiKeyVariable: KEYS[provider], fallbacks };
}
