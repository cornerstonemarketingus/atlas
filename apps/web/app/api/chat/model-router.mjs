import { resolveChatModel } from "./model-endpoint.mjs";

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];
const PURPOSES = ["chat", "reasoning", "vision", "summarize", "coding"];
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1";

const LAST_SERVED = new Map();

function normalizeBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  } catch {
    return { ok: false, reason: "The configured model endpoint is not a valid URL." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "The model endpoint must not carry credentials in its URL. Put the key in an API key environment variable instead." };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))) {
    return { ok: false, reason: "A model endpoint must use HTTPS unless it is loopback." };
  }
  if (url.search || url.hash) return { ok: false, reason: "The model endpoint must not contain a query or fragment." };
  return { ok: true, baseUrl: url.toString() };
}

function parseModelRoutes(environment) {
  const raw = (environment.ATLAS_MODEL_ROUTES || "").trim();
  if (!raw) return { ok: true, routesByPurpose: {} };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "ATLAS_MODEL_ROUTES must be valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "ATLAS_MODEL_ROUTES must be a JSON object keyed by purpose." };
  }
  const routesByPurpose = {};
  for (const purpose of PURPOSES) {
    const value = parsed[purpose];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
      return { ok: false, reason: `ATLAS_MODEL_ROUTES.${purpose} must be an array of non-empty route strings.` };
    }
    routesByPurpose[purpose] = value.map((item) => item.trim());
  }
  return { ok: true, routesByPurpose };
}

function resolveProviderRoute(spec, environment) {
  const split = spec.indexOf(":");
  if (split < 1 || split === spec.length - 1) {
    return { ok: false, reason: `Route '${spec}' must use provider:model.` };
  }
  const provider = spec.slice(0, split).toLowerCase();
  const model = spec.slice(split + 1).trim();
  if (!model) return { ok: false, reason: `Route '${spec}' is missing a model name.` };
  if (provider === "groq") {
    const base = (environment.GROQ_BASE_URL || environment.ATLAS_GROQ_BASE_URL || DEFAULT_GROQ_BASE_URL).trim();
    const normalized = normalizeBaseUrl(base);
    if (!normalized.ok) return normalized;
    return { ok: true, route: { provider, model, label: `${provider}:${model}`, baseUrl: normalized.baseUrl, apiKey: (environment.GROQ_API_KEY || "").trim() || null } };
  }
  if (provider === "openai") {
    const base = (environment.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).trim();
    const normalized = normalizeBaseUrl(base);
    if (!normalized.ok) return normalized;
    return { ok: true, route: { provider, model, label: `${provider}:${model}`, baseUrl: normalized.baseUrl, apiKey: (environment.OPENAI_API_KEY || "").trim() || null } };
  }
  if (provider === "chat" || provider === "ollama") {
    const base = (environment.ATLAS_CHAT_BASE_URL || environment.ATLAS_OLLAMA_BASE_URL || "").trim();
    if (!base) return { ok: false, reason: `Route '${spec}' requires ATLAS_CHAT_BASE_URL (or ATLAS_OLLAMA_BASE_URL).` };
    const normalized = normalizeBaseUrl(base);
    if (!normalized.ok) return normalized;
    let apiKey = (environment.ATLAS_MODEL_API_KEY || "").trim();
    if (!apiKey && new URL(normalized.baseUrl).origin === "https://api.groq.com") apiKey = (environment.GROQ_API_KEY || "").trim();
    return { ok: true, route: { provider, model, label: `${provider}:${model}`, baseUrl: normalized.baseUrl, apiKey: apiKey || null } };
  }
  return { ok: false, reason: `Route '${spec}' names unsupported provider '${provider}'.` };
}

function legacyChatRoute(environment) {
  const endpoint = resolveChatModel(environment);
  if (!endpoint.configured) return endpoint;
  return {
    configured: true,
    routes: [{ provider: "chat", model: endpoint.model, label: `chat:${endpoint.model}`, baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey }],
  };
}

/** @returns {{ configured: boolean, reason?: string, chatRoutes?: { provider: string, model: string, label: string, baseUrl: string, apiKey: string | null }[], routesTable?: { purpose: string, route: string, endpoint: string }[] }} */
export function resolveModelRoutes(environment = process.env) {
  const parsed = parseModelRoutes(environment);
  if (!parsed.ok) return { configured: false, reason: parsed.reason, chatRoutes: [], routesTable: [] };

  const routesTable = [];
  for (const purpose of Object.keys(parsed.routesByPurpose)) {
    for (const route of parsed.routesByPurpose[purpose]) routesTable.push({ purpose, route, endpoint: "" });
  }

  const requestedChat = parsed.routesByPurpose.chat ?? [];
  if (requestedChat.length === 0) {
    const legacy = legacyChatRoute(environment);
    if (!legacy.configured) return { configured: false, reason: legacy.reason, chatRoutes: [], routesTable };
    routesTable.push(...legacy.routes.map((route) => ({ purpose: "chat", route: route.label, endpoint: route.baseUrl })));
    return { configured: true, chatRoutes: legacy.routes, routesTable };
  }

  const chatRoutes = [];
  for (const specification of requestedChat) {
    const resolved = resolveProviderRoute(specification, environment);
    if (!resolved.ok) return { configured: false, reason: resolved.reason, chatRoutes: [], routesTable };
    chatRoutes.push(resolved.route);
    const row = routesTable.find((item) => item.purpose === "chat" && item.route === specification && item.endpoint === "");
    if (row) row.endpoint = resolved.route.baseUrl;
    else routesTable.push({ purpose: "chat", route: resolved.route.label, endpoint: resolved.route.baseUrl });
  }
  return { configured: true, chatRoutes, routesTable };
}

export function rememberServedRoute(purpose, routeLabel) {
  if (typeof routeLabel !== "string" || !routeLabel) return;
  LAST_SERVED.set(purpose, routeLabel);
}

export function lastServedRoute(purpose) {
  return LAST_SERVED.get(purpose) ?? null;
}
