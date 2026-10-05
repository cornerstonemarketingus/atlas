/**
 * How Worker code reaches the inference governor for a provider quota scope.
 *
 * Providers count limits per account, not per request (Groq: per
 * organization, shared by every key and model call in it), so the scope is
 * the endpoint origin plus a short one-way digest of the key: two keys are
 * two scopes, one key is one scope wherever it is used. The digest cannot be
 * turned back into the key and is never logged.
 *
 * The governor protects capacity; it must never become the reason a reply
 * fails. When the binding is missing (local tests, a deployment without the
 * migration yet) or the call errors, callers get `null` and carry on as
 * before, and the gap is logged once per call as metadata.
 */
export async function quotaScopeFor({ baseUrl, apiKey }) {
  const origin = new URL(baseUrl).origin;
  if (!apiKey) return origin;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey)));
  return `${origin}#${[...digest.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** The governor stub for a scope, or null when this deployment has none. */
export function governorFor(scope, environment) {
  const namespace = environment?.INFERENCE_GOVERNOR;
  if (!namespace || typeof namespace.idFromName !== "function") return null;
  return namespace.get(namespace.idFromName(scope));
}

function logUnavailable(fields) {
  try { console.warn(JSON.stringify({ atlas: "inference", event: "inference.governor_unavailable", ...fields })); } catch { /* logging never breaks a reply */ }
}

/** Calls one governor method; null (never a throw) when the governor is unavailable. */
export async function governorCall(stub, method, argument) {
  if (!stub) return null;
  try {
    const response = await stub.fetch(new Request(`https://inference-governor/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(argument ?? {}) }));
    if (!response.ok) throw Object.assign(new Error(`governor answered ${response.status}`), { name: "GovernorHttpError" });
    return await response.json();
  } catch (error) {
    logUnavailable({ method, error: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

/**
 * Setup-status readout: is a governor bound, and does a round trip to the
 * chat endpoint's scope work? Counts only; no scope, key digest or request id.
 */
export async function governorReadiness(endpoint, environment) {
  if (!environment?.INFERENCE_GOVERNOR) return { bound: false };
  if (!endpoint?.configured) return { bound: true, reachable: null };
  const snapshot = await governorCall(governorFor(await quotaScopeFor(endpoint), environment), "snapshot");
  return snapshot
    ? { bound: true, reachable: true, models: Object.keys(snapshot.models).length, reservations: snapshot.reservations, waiting: snapshot.waiting.length }
    : { bound: true, reachable: false };
}

/**
 * The ledger calls the chat loop makes around each model request, bound to
 * one scope's governor. Every call answers null when the governor is
 * unavailable, and the loop then sends as it did before the ledger existed.
 */
export function chatGovernor(stub, { latencyClass = "INTERACTIVE" } = {}) {
  if (!stub) return null;
  return {
    latencyClass,
    reserve: (request) => governorCall(stub, "reserve", request),
    release: (outcome) => governorCall(stub, "release", outcome),
    observe: (observation) => governorCall(stub, "observe", observation),
    withdraw: (requestId) => governorCall(stub, "withdraw", { requestId }),
  };
}

/** chatGovernor for an endpoint's quota scope; null (never a throw) when there is none. */
export async function chatGovernorFor(endpoint, environment, options) {
  try {
    return chatGovernor(governorFor(await quotaScopeFor(endpoint), environment), options);
  } catch (error) {
    logUnavailable({ method: "scope", error: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

/**
 * The endpoint with a governor on every provider in its route (the configured
 * model, then each providerFallback), each bound to its own quota scope: a
 * Groq refusal must not be recorded against the self-hosted model or OpenAI.
 * Same-provider fallback models share the node's scope, as they share the account.
 */
export async function governChain(endpoint, environment, options) {
  if (!endpoint?.configured) return endpoint;
  const governor = await chatGovernorFor(endpoint, environment, options);
  const fallback = endpoint.providerFallback ? await governChain(endpoint.providerFallback, environment, options) : null;
  return { ...endpoint, governor, ...(fallback ? { providerFallback: fallback } : {}) };
}
