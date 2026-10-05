import { listModels } from "./openai-compatible.mjs";

/**
 * The inference targets Atlas may route to, with what each server currently
 * says it serves. Configured names are the only model names in Atlas's
 * runtime; whether each is actually available is probed, not assumed, so a
 * model the provider retires is marked unavailable before the first request
 * fails on it.
 *
 * A probe result is kept for `ttlMs`. A failed probe marks nothing
 * unavailable: an unreachable /models endpoint says nothing about the models
 * (many local servers do not implement it), so those targets stay eligible
 * and the circuit breaker judges them by real requests.
 */
export const MODEL_LIST_TTL_MS = 10 * 60_000;

export function createTargetRegistry({ endpoints, fetcher = fetch, now = Date.now, ttlMs = MODEL_LIST_TTL_MS }) {
  // endpoints: [{ id, baseUrl, apiKey?, provider, models: [{ model, contextWindowTokens?, maxOutputTokens?, capabilities?, local?, paid? }] }]
  const probes = new Map();

  async function probe(endpoint) {
    const cached = probes.get(endpoint.id);
    if (cached && now() - cached.at < ttlMs) return cached.result;
    const result = await listModels({ baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, fetcher });
    probes.set(endpoint.id, { at: now(), result });
    return result;
  }

  /**
   * Every configured target, in configured order, with availability.
   * @returns {Promise<{ id: string, provider: string, origin: string, model: string, available: boolean | null, reason?: string, contextWindowTokens: number|null, maxOutputTokens: number|null, capabilities: object, local: boolean, paid: boolean }[]>}
   */
  async function targets() {
    const out = [];
    for (const endpoint of endpoints) {
      const listed = await probe(endpoint);
      const origin = new URL(endpoint.baseUrl).origin;
      for (const configured of endpoint.models) {
        const served = listed.ok ? listed.models.find((model) => model.id === configured.model) : null;
        const available = !listed.ok ? null : Boolean(served?.active);
        out.push({
          id: `${endpoint.id}/${configured.model}`, provider: endpoint.provider ?? "openai-compatible", origin, model: configured.model,
          available,
          ...(listed.ok && !served ? { reason: "not_served" } : listed.ok && served && !served.active ? { reason: "inactive" } : !listed.ok ? { reason: `probe_${String(listed.kind).toLowerCase()}` } : {}),
          contextWindowTokens: configured.contextWindowTokens ?? served?.contextWindowTokens ?? null,
          maxOutputTokens: configured.maxOutputTokens ?? null,
          capabilities: { tools: true, json: true, streaming: true, reasoning: false, ...(configured.capabilities ?? {}) },
          local: Boolean(configured.local ?? endpoint.local), paid: Boolean(configured.paid ?? endpoint.paid),
        });
      }
    }
    return out;
  }

  /** Targets that may be routed to: available, or unknown because the server does not list models. */
  async function eligibleTargets() {
    return (await targets()).filter((target) => target.available !== false);
  }

  return { targets, eligibleTargets, forget: () => probes.clear() };
}
