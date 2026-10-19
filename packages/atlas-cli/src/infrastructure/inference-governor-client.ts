import { createHash } from "node:crypto";
import { ModelProviderError } from "../model/model-provider.js";

/** One governor decision for a reservation request (the wire shape of packages/atlas-inference's ledger). */
export interface GovernorGrant {
  readonly granted: boolean;
  readonly model?: string;
  readonly permanent?: boolean;
  readonly waitMs?: number;
  readonly reason?: string;
}

export interface GovernorReservation {
  readonly requestId: string;
  readonly models: readonly string[];
  readonly estimatedTokens: number;
  readonly latencyClass: "INTERACTIVE" | "TASK_CRITICAL" | "BACKGROUND" | "BATCH";
  readonly priority: number;
}

export interface GovernorOutcome {
  readonly requestId: string;
  readonly model: string;
  readonly status?: number;
  readonly kind: string | null;
  readonly retryAfterMs?: number;
  readonly scope?: "daily";
}

/** Null from reserve means unavailable; it never authorizes a provider call. */
export interface InferenceGovernor {
  reserve(reservation: GovernorReservation, signal?: AbortSignal): Promise<GovernorGrant | null>;
  release(outcome: GovernorOutcome): Promise<void>;
  withdraw(requestId: string): Promise<void>;
}

/**
 * The provider quota scope, computed exactly as the Worker computes it
 * (apps/web/app/api/inference/governor-client.mjs quotaScopeFor): origin plus
 * a short one-way digest of the key, so a runner and hosted chat that use the
 * same key share one ledger and two keys never do. The key is never sent.
 */
export function quotaScopeFor(origin: string, apiKey: string | undefined): string {
  const base = new URL(origin).origin;
  if (!apiKey) return base;
  return `${base}#${createHash("sha256").update(apiKey).digest().subarray(0, 8).toString("hex")}`;
}

export interface HttpGovernorOptions {
  /** Gateway URL, e.g. https://<worker>/api/inference/governor. */
  readonly url: string;
  readonly token: string;
  readonly scope: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly warn?: (message: string) => void;
}

/**
 * Calls the Worker's governor gateway. Any
 * transport or server failure answers "unavailable" (null / no-op) and warns
 * once. Reservation authentication failures are terminal; callers must not bypass admission.
 * The URL must be https (loopback excepted) because it carries a bearer token.
 */
export function createHttpGovernor(options: HttpGovernorOptions): InferenceGovernor {
  const url = new URL(options.url);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("The governor URL must use https (loopback may use http).");
  }
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  let warned = false;
  const warn = (message: string): void => {
    if (warned) return;
    warned = true;
    try { (options.warn ?? ((text: string) => { process.stderr.write(`${text}\n`); }))(message); } catch { /* logging cannot alter admission or error classification */ }
  };

  async function call(method: string, argument: unknown, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const response = await send(url, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
        body: JSON.stringify({ method, scope: options.scope, argument }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        warn(`Inference governor answered ${response.status}; shared capacity was not confirmed.`);
        if (method === "reserve" && (response.status === 401 || response.status === 403)) {
          throw new ModelProviderError({ message: "Shared inference governor authorization was rejected.", code: "authentication", providerId: "inference-governor", retryable: false });
        }
        return null;
      }
      return await response.json();
    } catch (error: unknown) {
      if (error instanceof ModelProviderError) throw error;
      if (signal?.aborted) return null;
      warn("Inference governor is unreachable; shared capacity was not confirmed.");
      return null;
    }
  }

  return {
    reserve: async (reservation, signal) => (await call("reserve", reservation, signal)) as GovernorGrant | null,
    release: async (outcome) => { await call("release", outcome); },
    withdraw: async (requestId) => { await call("withdraw", { requestId }); },
  };
}

const PROVIDER_ORIGINS: Readonly<Record<string, string>> = {
  groq: "https://api.groq.com",
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  "workers-ai": "https://api.cloudflare.com",
};

/** The origin whose quota a route draws on: its self-hosted endpoint when it has one, otherwise the provider's own API. */
export function quotaOriginFor(providerId: string, endpoint?: URL): string | undefined {
  return endpoint?.origin ?? PROVIDER_ORIGINS[providerId];
}

/**
 * The shared governor for a route when the owner configured one
 * (ATLAS_GOVERNOR_URL and ATLAS_GOVERNOR_TOKEN); undefined otherwise, which
 * leaves model calls exactly as they were.
 */
export function governorFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  route: { readonly providerId: string; readonly apiKey: string; readonly endpoint?: URL },
): InferenceGovernor | undefined {
  const url = environment["ATLAS_GOVERNOR_URL"]?.trim();
  const token = environment["ATLAS_GOVERNOR_TOKEN"]?.trim();
  if (!url && !token) return undefined;
  if (!url || !token) throw new Error("Shared inference governor URL and token must both be configured.");
  const origin = quotaOriginFor(route.providerId, route.endpoint);
  if (origin === undefined) throw new Error("The configured shared governor has no quota scope for this provider.");
  return createHttpGovernor({ url, token, scope: quotaScopeFor(origin, route.apiKey) });
}
