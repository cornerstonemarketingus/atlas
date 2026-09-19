import { assertReachableEndpoint } from "../model-client.mjs";

const WINDOWS = [[/llama-?3\.1|llama-?3\.2/iu, 131_072], [/qwen2\.5|mistral/iu, 32_768]];

export function inferContextWindow(name) {
  const match = WINDOWS.find(([pattern]) => pattern.test(name));
  return { contextWindow: match?.[1] ?? 8_192, source: match ? "inferred" : "assumed" };
}

export async function discoverModelServers({ endpoints = ["http://127.0.0.1:11434/v1", "http://127.0.0.1:8080/v1"], fetchImpl = fetch } = {}) {
  const found = await Promise.all(endpoints.map((endpoint) => discover(endpoint, fetchImpl)));
  return found.filter(Boolean);
}

async function discover(endpoint, fetchImpl) {
  let base;
  try { base = assertReachableEndpoint(endpoint); } catch { return null; }
  const ollamaUrl = new URL("/api/tags", base);
  try {
    const response = await fetchImpl(ollamaUrl, { signal: AbortSignal.timeout(2_000) });
    if (response.ok) {
      const body = await response.json();
      return { endpoint: base.origin, kind: "ollama", models: (body.models ?? []).map((model) => ({
        name: model.name,
        size: model.size ?? null,
        parameters: model.details?.parameter_size ?? null,
        quantization: model.details?.quantization_level ?? null,
        ...inferContextWindow(model.name),
      })) };
    }
  } catch {}
  try {
    const response = await fetchImpl(new URL("models", base), { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return null;
    const body = await response.json();
    return { endpoint: base.origin, kind: "openai-compatible", models: (body.data ?? []).map(({ id }) => ({ name: id, ...inferContextWindow(id) })) };
  } catch { return null; }
}
