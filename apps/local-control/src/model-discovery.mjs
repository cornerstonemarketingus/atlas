import { defaultModelEndpoint } from "./agent/models/daemon-client.mjs";

/** The models the configured endpoint serves; with nothing configured, the local Ollama (OLLAMA_HOST honoured). */
export async function discoverLocalModels({ endpoint = defaultModelEndpoint(process.env), fetchImpl = fetch } = {}) {
  const url = new URL("models", endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("Model discovery requires HTTPS unless the server is loopback.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_500);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Model server returned HTTP ${response.status}.`);
    const body = await response.json();
    const models = [...new Set((Array.isArray(body.data) ? body.data : []).map((entry) => entry?.id).filter((id) => typeof id === "string" && id.length <= 200))].sort();
    return { endpoint: url.origin, models };
  } finally {
    clearTimeout(timeout);
  }
}
