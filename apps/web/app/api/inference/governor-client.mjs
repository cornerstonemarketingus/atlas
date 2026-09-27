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
