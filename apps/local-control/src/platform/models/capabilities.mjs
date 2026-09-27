/**
 * Model capability registry (blueprint §9).
 *
 * A model profile records what a model can do and what it costs. Every
 * capability exists in two forms: *declared* (what the vendor or the operator
 * says) and *measured* (what Atlas observed running the capability suite in
 * ./capability-suite.mjs). Routing reads `effective()`, which prefers the
 * measured value field by field and says which source each value came from,
 * so a model that claims tool calling but fails the probe is not routed tool
 * work.
 *
 * Relationship to src/agent/models/: that directory is the operator-facing
 * local setup (discover servers, recommend a model for the hardware, run the
 * quick evaluations, and a static task→endpoint route table with ordered
 * fallback). This registry is the platform-level view over *all* providers,
 * cloud and local. `profilesFromRoutes()` below lifts the existing route table
 * into profiles, and `inferContextWindow` from agent/models/discovery.mjs is
 * reused for declared context sizes, so the two stay in agreement instead of
 * becoming parallel truths.
 */
import { inferContextWindow } from "../../agent/models/discovery.mjs";

export const PROVIDERS = Object.freeze(["anthropic", "openai", "openai-compatible", "ollama", "groq", "llama.cpp", "vllm"]);
/** Providers that are, by construction, someone else's computer. */
export const CLOUD_ONLY_PROVIDERS = Object.freeze(["anthropic", "openai", "groq"]);
export const CAPABILITY_KEYS = Object.freeze(["vision", "toolCalls", "structuredOutput", "contextTokens"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class CapabilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CapabilityError";
    this.code = code;
  }
}

export function isLoopbackUrl(value) {
  try { return LOOPBACK.has(new URL(value).hostname); } catch { return false; }
}

export class ModelCapabilityRegistry {
  #profiles = new Map();

  constructor(profiles = []) {
    for (const profile of profiles) this.register(profile);
  }

  /**
   * @param profile { id, provider, local, endpoint?, model?, capabilities, costPerMTokIn,
   *   costPerMTokOut, p50LatencyMs?, reliability?, measured? } — top-level
   *   capabilities/latency/reliability are the *declared* values.
   *   Costs are micro-USD per million tokens.
   */
  register(profile) {
    const normalized = normalizeProfile(profile);
    if (this.#profiles.has(normalized.id)) throw new CapabilityError("DUPLICATE_PROFILE", `Model profile '${normalized.id}' is already registered.`);
    this.#profiles.set(normalized.id, normalized);
    return this.effective(normalized.id);
  }

  upsert(profile) {
    const normalized = normalizeProfile(profile);
    const existing = this.#profiles.get(normalized.id);
    if (existing && !profile.measured && existing.provider === normalized.provider
      && existing.model === normalized.model && existing.endpoint === normalized.endpoint
      && existing.local === normalized.local) normalized.measured = structuredClone(existing.measured);
    this.#profiles.set(normalized.id, normalized);
    return this.effective(normalized.id);
  }

  has(id) {
    return this.#profiles.has(id);
  }

  /** Raw profile with declared and measured kept apart. */
  get(id) {
    const profile = this.#profiles.get(id);
    return profile ? structuredClone(profile) : null;
  }

  list() {
    return [...this.#profiles.keys()].map((id) => this.effective(id));
  }

  /**
   * Records a capability-suite result. Only the fields given are replaced;
   * `measuredAt` is required so a stale measurement is visible as stale.
   */
  recordMeasurement(id, measurement = {}) {
    const { measuredAt } = measurement;
    const profile = this.#profiles.get(id);
    if (!profile) throw new CapabilityError("UNKNOWN_PROFILE", `No model profile '${id}'.`);
    if (!measuredAt || Number.isNaN(Date.parse(measuredAt))) throw new CapabilityError("INVALID_MEASUREMENT", "A measurement needs a measuredAt timestamp.");
    const next = normalizeMeasured({ ...profile.measured, ...measurement,
      capabilities: { ...profile.measured?.capabilities, ...measurement.capabilities } });
    profile.measured = next;
    return this.effective(id);
  }

  /**
   * The routing view: measured values override declared ones per field, and
   * `sources` records which one won.
   */
  effective(id) {
    const profile = this.#profiles.get(id);
    if (!profile) throw new CapabilityError("UNKNOWN_PROFILE", `No model profile '${id}'.`);
    const capabilities = {};
    const sources = {};
    for (const key of CAPABILITY_KEYS) {
      const measured = profile.measured?.capabilities?.[key];
      if (measured !== undefined) { capabilities[key] = measured; sources[key] = "measured"; }
      else if (profile.declared.capabilities[key] !== undefined) { capabilities[key] = profile.declared.capabilities[key]; sources[key] = "declared"; }
      else { capabilities[key] = key === "contextTokens" ? 0 : false; sources[key] = "unknown"; }
    }
    const pick = (key, fallback) => {
      if (profile.measured?.[key] !== undefined) { sources[key] = "measured"; return profile.measured[key]; }
      if (profile.declared[key] !== undefined) { sources[key] = "declared"; return profile.declared[key]; }
      sources[key] = "unknown";
      return fallback;
    };
    return {
      id: profile.id,
      provider: profile.provider,
      model: profile.model,
      endpoint: profile.endpoint,
      local: profile.local,
      capabilities,
      costPerMTokIn: profile.costPerMTokIn,
      costPerMTokOut: profile.costPerMTokOut,
      p50LatencyMs: pick("p50LatencyMs", null),
      reliability: pick("reliability", 0),
      measuredAt: profile.measured?.measuredAt ?? null,
      contextVerifiedTokens: profile.measured?.probes?.contextVerifiedTokens ?? null,
      structuredOutputReliability: profile.measured?.structuredOutputReliability ?? null,
      toolCallReliability: profile.measured?.toolCallReliability ?? null,
      // These describe the latest probe batch, not lifetime production traffic.
      recentFailureRate: profile.measured?.recentFailureRate ?? null,
      health: structuredClone(profile.measured?.health ?? { status: "unknown", checkedAt: null }),
      sources,
    };
  }

  snapshot() {
    return [...this.#profiles.values()].map((profile) => structuredClone(profile));
  }
}

function normalizeProfile(profile) {
  if (!profile || typeof profile !== "object") throw new CapabilityError("INVALID_PROFILE", "A model profile must be an object.");
  const { id, provider } = profile;
  if (typeof id !== "string" || id.trim() === "") throw new CapabilityError("INVALID_PROFILE", "A model profile needs an id.");
  if (!PROVIDERS.includes(provider)) throw new CapabilityError("INVALID_PROFILE", `Model '${id}' has unknown provider '${provider}'. Known: ${PROVIDERS.join(", ")}.`);
  const local = profile.local ?? (provider === "ollama");
  if (typeof local !== "boolean") throw new CapabilityError("INVALID_PROFILE", `Model '${id}' must say whether it is local.`);
  // "local" is a privacy claim; it must be true, not asserted.
  if (local && CLOUD_ONLY_PROVIDERS.includes(provider)) throw new CapabilityError("INVALID_PROFILE", `Model '${id}' cannot be local: ${provider} is a hosted provider.`);
  if (local && profile.endpoint && !isLoopbackUrl(profile.endpoint)) throw new CapabilityError("INVALID_PROFILE", `Model '${id}' is marked local but its endpoint is not loopback.`);
  const declared = { capabilities: {} };
  for (const [key, value] of Object.entries(profile.capabilities ?? profile.declared?.capabilities ?? {})) {
    if (!CAPABILITY_KEYS.includes(key)) continue;
    validateCapability(key, value);
    declared.capabilities[key] = value;
  }
  for (const key of ["reliability", "p50LatencyMs"]) {
    const value = profile[key] ?? profile.declared?.[key];
    if (value !== undefined) declared[key] = key === "reliability" ? unit(value, key) : nonNegative(value, key);
  }
  const normalized = {
    id,
    provider,
    model: profile.model ?? id,
    endpoint: profile.endpoint ?? null,
    local,
    costPerMTokIn: nonNegative(profile.costPerMTokIn ?? 0, "costPerMTokIn"),
    costPerMTokOut: nonNegative(profile.costPerMTokOut ?? 0, "costPerMTokOut"),
    declared,
    measured: null,
  };
  if (profile.measured) normalized.measured = normalizeMeasured(profile.measured);
  return normalized;
}

function normalizeMeasured(measured) {
  if (!measured.measuredAt || Number.isNaN(Date.parse(measured.measuredAt))) throw new CapabilityError("INVALID_MEASUREMENT", "A measurement needs a measuredAt timestamp.");
  const out = { capabilities: {}, measuredAt: new Date(measured.measuredAt).toISOString() };
  for (const [key, value] of Object.entries(measured.capabilities ?? {})) {
    if (!CAPABILITY_KEYS.includes(key)) continue;
    validateCapability(key, value);
    out.capabilities[key] = value;
  }
  if (measured.reliability !== undefined) out.reliability = unit(measured.reliability, "reliability");
  if (measured.p50LatencyMs !== undefined) out.p50LatencyMs = nonNegative(measured.p50LatencyMs, "p50LatencyMs");
  for (const key of ["structuredOutputReliability", "toolCallReliability", "recentFailureRate"]) {
    if (measured[key] !== undefined) out[key] = unit(measured[key], key);
  }
  if (measured.health !== undefined) {
    if (!["available", "unavailable", "degraded"].includes(measured.health?.status)
      || !measured.health.checkedAt || Number.isNaN(Date.parse(measured.health.checkedAt))) {
      throw new CapabilityError("INVALID_MEASUREMENT", "Health needs a status and checkedAt timestamp.");
    }
    out.health = { status: measured.health.status, checkedAt: new Date(measured.health.checkedAt).toISOString() };
  }
  if (measured.probes !== undefined) {
    const { results, contextVerifiedTokens } = measured.probes;
    if (!Array.isArray(results) || results.length > 232) throw new CapabilityError("INVALID_MEASUREMENT", "Probe results must be a bounded array.");
    out.probes = { results: results.map((probe) => {
      if (typeof probe?.id !== "string" || typeof probe.passed !== "boolean" || typeof probe.detail !== "string") throw new CapabilityError("INVALID_MEASUREMENT", "Invalid probe result.");
      return { id: probe.id.slice(0, 100), passed: probe.passed, detail: probe.detail.slice(0, 1000) };
    }), contextVerifiedTokens: contextVerifiedTokens == null ? null : nonNegative(contextVerifiedTokens, "contextVerifiedTokens") };
  }
  return out;
}

function validateCapability(key, value) {
  if (key === "contextTokens") nonNegative(value, key);
  else if (typeof value !== "boolean") throw new CapabilityError("INVALID_PROFILE", `Capability '${key}' must be a boolean.`);
}

function unit(value, name) {
  if (typeof value !== "number" || !(value >= 0 && value <= 1)) throw new CapabilityError("INVALID_PROFILE", `${name} must be a number between 0 and 1.`);
  return value;
}

function nonNegative(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new CapabilityError("INVALID_PROFILE", `${name} must be a non-negative number.`);
  return value;
}

/**
 * Lifts the existing agent route table (agent/models/router.mjs parseRoutes)
 * into capability profiles. Loopback endpoints are local and free; the
 * "vision" route task is taken as a declared vision capability.
 */
export function profilesFromRoutes(routes = []) {
  const byId = new Map();
  for (const route of routes) {
    const local = isLoopbackUrl(route.endpoint);
    const id = `${local ? "local" : "remote"}:${route.model}@${new URL(route.endpoint).host}`;
    const existing = byId.get(id);
    const contextTokens = Number.isFinite(route.contextWindow) ? route.contextWindow : inferContextWindow(route.model).contextWindow;
    const capabilities = { ...(existing?.capabilities ?? {}), contextTokens, ...(route.task === "vision" ? { vision: true } : {}) };
    byId.set(id, { id, provider: local ? "ollama" : "openai-compatible", model: route.model, endpoint: route.endpoint, local, capabilities, costPerMTokIn: 0, costPerMTokOut: 0 });
  }
  return [...byId.values()];
}
