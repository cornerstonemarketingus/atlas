import type { CoderProviderId } from "../model/coder-provider-selection.js";

/**
 * A simple "is this provider usable right now" check, so an operator (or a
 * workflow, before spending a run's turn budget) can find out that Ollama
 * isn't running yet, rather than discovering it three turns into a coder
 * session via a network-failure error.
 *
 * Cloud providers (Anthropic, Groq) are checked by presence of their API key
 * environment variable only — never by an actual network call. A "status
 * check" that itself spends billed quota, or counts against the same rate
 * limit the run is about to need, would be a strange thing for a health
 * check to do. A local server has no such cost, so it gets a real request.
 */

export interface ProviderStatusCheckInput {
  readonly providerId: CoderProviderId;
  /** Base OpenAI-compatible URL (e.g. `http://127.0.0.1:11434/v1`); only used for `local`. */
  readonly endpoint?: URL;
  readonly apiKeyEnvironmentVariable: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly fetchImplementation?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface ProviderStatusResult {
  readonly providerId: CoderProviderId;
  /** True when the provider looks usable: a key is set, or the server answered. */
  readonly ready: boolean;
  readonly endpoint?: string;
  readonly latencyMs?: number;
  readonly message: string;
}

const DEFAULT_TIMEOUT_MS = 3_000;

/** `base` must already be the `/v1`-style root, not a chat-completions URL. */
function toModelsUrl(base: URL): URL {
  const url = new URL(base.href);
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${path}/models`;
  return url;
}

export async function checkProviderStatus(input: ProviderStatusCheckInput): Promise<ProviderStatusResult> {
  if (input.providerId !== "local") {
    const value = input.environment[input.apiKeyEnvironmentVariable];
    const ready = value !== undefined && value.trim().length > 0;
    return {
      providerId: input.providerId,
      ready,
      message: ready
        ? `${input.apiKeyEnvironmentVariable} is set. (No live call was made, so this does not confirm the key is valid or has remaining quota.)`
        : `${input.apiKeyEnvironmentVariable} is not set.`,
    };
  }

  const base = input.endpoint;
  if (base === undefined) {
    return { providerId: "local", ready: false, message: "No endpoint was provided for the local provider." };
  }
  const modelsUrl = toModelsUrl(base);
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  try {
    const response = await fetchImplementation(modelsUrl, { signal: AbortSignal.timeout(timeoutMs) });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return {
        providerId: "local",
        ready: false,
        endpoint: modelsUrl.href,
        latencyMs,
        message: `Server at ${modelsUrl.href} responded with HTTP ${response.status}.`,
      };
    }
    let modelCount: number | undefined;
    try {
      const body = (await response.json()) as { data?: unknown[] };
      modelCount = Array.isArray(body.data) ? body.data.length : undefined;
    } catch {
      // A server that serves /models but not as JSON is unusual, but still
      // reachable; the model count is a nicety, not the health signal itself.
    }
    return {
      providerId: "local",
      ready: true,
      endpoint: modelsUrl.href,
      latencyMs,
      message: modelCount === undefined
        ? `Server reachable at ${modelsUrl.href}.`
        : `Server reachable at ${modelsUrl.href} with ${modelCount} model${modelCount === 1 ? "" : "s"} available.`,
    };
  } catch (error: unknown) {
    const latencyMs = Date.now() - started;
    const reason = error instanceof Error ? error.message : String(error);
    return {
      providerId: "local",
      ready: false,
      endpoint: modelsUrl.href,
      latencyMs,
      message: `Not reachable at ${modelsUrl.href}: ${reason}. Start Ollama (or another OpenAI-compatible server) there, or pass --endpoint to point elsewhere.`,
    };
  }
}
