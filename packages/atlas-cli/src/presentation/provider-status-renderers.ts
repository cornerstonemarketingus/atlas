import type { ProviderStatusResult } from "../infrastructure/provider-health-check.js";

export function renderProviderStatusJson(result: ProviderStatusResult): string {
  return JSON.stringify(result, null, 2);
}

export function renderProviderStatusText(result: ProviderStatusResult): string {
  const lines = [
    `Provider: ${result.providerId}`,
    `Status: ${result.ready ? "ready" : "not ready"}`,
  ];
  if (result.endpoint !== undefined) lines.push(`Endpoint: ${result.endpoint}`);
  if (result.latencyMs !== undefined) lines.push(`Latency: ${result.latencyMs}ms`);
  lines.push(result.message);
  return lines.join("\n");
}
