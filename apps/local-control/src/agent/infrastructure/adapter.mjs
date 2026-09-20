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

import { redactSecrets } from "../redaction.mjs";

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
      // The structured fields apply() acts on. Without these in the digest,
      // the approved prose and the executed change could diverge.
      fields: plan.fields ?? null,
      after: plan.after ?? null,
    }))
    .digest("hex");
}

/**
 * Builds a plan. `after` must already be redacted by the caller: a plan is
 * persisted, shown, and audited, so a secret value in it would end up in all
 * three.
 */
export function buildPlan({ provider, operation, resource, target, fields = null, before = null, after = null, reversible = false, notes = [] }) {
  if (!OPERATIONS.includes(operation)) throw new InfrastructureError("BAD_OPERATION", `Unknown operation: ${operation}.`);
  const plan = { provider, operation, resource, target, fields, before, after, reversible, notes };
  return { ...plan, digest: planDigest(plan) };
}

/** Replaces a secret with a shape description, so a preview is still useful. */
export function redactValue(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text.length === 0) return "(empty)";
  return `(${text.length} characters, ending ${text.slice(-2)})`;
}

/**
 * Renders a plan for a human to approve.
 *
 * Every interpolated value is flattened to a single line first. These strings
 * come from the model, and this text is line-oriented: a newline inside a
 * record name let a plan forge its own "Currently:", "After:" and
 * "Reversible:" lines, so the operator read an invented harmless change while
 * the real one trailed below looking like noise.
 */
export function describePlan(plan) {
  const lines = [
    `${oneLine(plan.provider)} ${oneLine(plan.operation)} ${oneLine(plan.resource)}`,
    `Target: ${oneLine(plan.target)}`,
    plan.before === null ? "Currently: not present" : `Currently: ${oneLine(stringify(plan.before))}`,
    plan.after === null ? "After: removed" : `After: ${oneLine(stringify(plan.after))}`,
    plan.reversible ? "Reversible: yes, this provider supports rolling this back." : "Reversible: no — this cannot be undone through Atlas.",
  ];
  for (const note of plan.notes) lines.push(`Note: ${oneLine(note)}`);
  return lines.join("\n");
}

/** Collapses newlines and control characters so one field cannot become many lines. */
export function oneLine(value) {
  return String(value ?? "")
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
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

/**
 * The provider's own prose, redacted.
 *
 * A 400 response frequently echoes the request back, and the request we just
 * sent carried the secret. Without this, that value reached the model, the
 * tool-execution event and the audit log — through the error path, which is
 * exactly where nobody looks for a leak.
 */
function describeError(payload) {
  if (!payload) return null;
  const raw = Array.isArray(payload.errors) && payload.errors.length > 0
    ? payload.errors.map((entry) => entry.message ?? JSON.stringify(entry)).join("; ")
    : payload.error?.message ?? payload.message ?? JSON.stringify(payload);
  return redactSecrets(String(raw)).slice(0, 400);
}
