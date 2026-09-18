/**
 * Shared shape for infrastructure adapters.
 *
 * Every operation is one of create, update, rotate or delete — the scope
 * distinguishes them because they carry different risk and different
 * reversibility, and an adapter that calls everything "update" hides that
 * from the approval prompt.
 *
 * Every operation also returns a plan first. A plan names the exact target,
 * shows a redacted preview of what would change, and says whether the change
 * is reversible. Nothing is applied until the plan's digest has been
 * approved, and the same plan is verified afterwards by reading the resource
 * back — Atlas does not report a change it has not confirmed.
 */
import { createHash } from "node:crypto";

export const OPERATIONS = ["create", "update", "rotate", "delete"];

export class InfrastructureError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InfrastructureError";
    this.code = code;
  }
}

export function planDigest(plan) {
  return createHash("sha256")
    .update(JSON.stringify({
      provider: plan.provider,
      operation: plan.operation,
      resource: plan.resource,
      target: plan.target,
      after: plan.after ?? null,
    }))
    .digest("hex");
}

/**
 * Builds a plan. `after` must already be redacted by the caller: a plan is
 * persisted, shown, and audited, so a secret value in it would end up in all
 * three.
 */
export function buildPlan({ provider, operation, resource, target, before = null, after = null, reversible = false, notes = [] }) {
  if (!OPERATIONS.includes(operation)) throw new InfrastructureError("BAD_OPERATION", `Unknown operation: ${operation}.`);
  const plan = { provider, operation, resource, target, before, after, reversible, notes };
  return { ...plan, digest: planDigest(plan) };
}

/** Replaces a secret with a shape description, so a preview is still useful. */
export function redactValue(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text.length === 0) return "(empty)";
  return `(${text.length} characters, ending ${text.slice(-2)})`;
}

export function describePlan(plan) {
  const lines = [
    `${plan.provider} ${plan.operation} ${plan.resource}`,
    `Target: ${plan.target}`,
    plan.before === null ? "Currently: not present" : `Currently: ${stringify(plan.before)}`,
    plan.after === null ? "After: removed" : `After: ${stringify(plan.after)}`,
    plan.reversible ? "Reversible: yes, this provider supports rolling this back." : "Reversible: no — this cannot be undone through Atlas.",
  ];
  for (const note of plan.notes) lines.push(`Note: ${note}`);
  return lines.join("\n");
}

function stringify(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A small bounded JSON client shared by the provider adapters. */
export function createApiClient({ root, headers = {}, fetchImpl = fetch, timeoutMs = 30_000 }) {
  return async function call(path, { method = "GET", body = null, signal, query = null } = {}) {
    const url = new URL(`${root}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    if (url.protocol !== "https:") throw new InfrastructureError("INSECURE_ENDPOINT", "Infrastructure APIs must be reached over HTTPS.");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    signal?.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      const response = await fetchImpl(url, {
        method,
        signal: controller.signal,
        headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      const payload = text.length > 0 ? safeJson(text) : null;
      if (!response.ok) {
        // The provider's own message is surfaced; the request headers, which
        // carry the token, never are.
        throw new InfrastructureError(
          response.status === 401 || response.status === 403 ? "NOT_AUTHORIZED" : "REQUEST_FAILED",
          `${method} ${url.pathname} returned HTTP ${response.status}: ${describeError(payload) ?? "no detail"}`,
        );
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 500) }; }
}

function describeError(payload) {
  if (!payload) return null;
  if (Array.isArray(payload.errors) && payload.errors.length > 0) return payload.errors.map((e) => e.message ?? JSON.stringify(e)).join("; ").slice(0, 400);
  if (payload.error?.message) return String(payload.error.message).slice(0, 400);
  if (payload.message) return String(payload.message).slice(0, 400);
  return JSON.stringify(payload).slice(0, 400);
}
