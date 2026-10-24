import { randomUUID } from "node:crypto";
import type {
  ModelCompletionOptions,
  ModelProvider,
  ModelProviderMetadata,
  ModelRequest,
  ModelResponse,
} from "../model/model-provider.js";
import { ModelProviderError } from "../model/model-provider.js";
import type { InferenceGovernor } from "./inference-governor-client.js";

export interface GovernedModelProviderOptions {
  /** Longest this wrapper waits for capacity before raising a retryable rate-limit error. Defaults to 30 s. */
  readonly maximumWaitMs?: number;
  readonly latencyClass?: "INTERACTIVE" | "TASK_CRITICAL" | "BACKGROUND" | "BATCH";
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly newRequestId?: () => string;
}

/**
 * Reserves provider capacity from the shared governor before each physical
 * model request, and reports the outcome afterwards, so a coder run on a
 * runner and hosted chat draw down one allowance instead of racing each other.
 *
 * - Waiting is bounded. Past `maximumWaitMs` the reservation is withdrawn and a
 *   retryable rate-limit error carries the wait; the retrying layer outside
 *   this one then retries, or (wait longer than its cap) hands over to the
 *   next fallback route. Nothing queues without limit.
 * - A request larger than the model's whole allowance is refused as
 *   unavailable so the fallback route takes it, rather than waiting forever.
 * - A rate-limit failure is reported with its retry-after, so every other
 *   caller in the same scope stops sending until it passes.
 * - Governor unavailable or malformed: refuse dispatch; bounded retry/fallback
 *   may recover, but configured shared admission must never be bypassed.
 * - Cancellation withdraws the reservation and never calls the provider.
 *
 * Place it directly around the raw provider and inside RetryingModelProvider,
 * so every retry attempt reserves again.
 */
export class GovernedModelProvider implements ModelProvider {
  public readonly metadata: ModelProviderMetadata;
  readonly #provider: ModelProvider;
  readonly #governor: InferenceGovernor;
  readonly #maximumWaitMs: number;
  readonly #latencyClass: NonNullable<GovernedModelProviderOptions["latencyClass"]>;
  readonly #sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly #newRequestId: () => string;

  public constructor(provider: ModelProvider, governor: InferenceGovernor, options: GovernedModelProviderOptions = {}) {
    this.#provider = provider;
    this.#governor = governor;
    this.metadata = provider.metadata;
    this.#maximumWaitMs = options.maximumWaitMs ?? 30_000;
    this.#latencyClass = options.latencyClass ?? "TASK_CRITICAL";
    this.#sleep = options.sleep ?? defaultSleep;
    this.#newRequestId = options.newRequestId ?? randomUUID;
  }

  public async complete(request: ModelRequest, options: ModelCompletionOptions = {}): Promise<ModelResponse> {
    const providerId = this.metadata.id;
    this.#throwIfCancelled(options.signal);
    const requestId = this.#newRequestId();
    const estimatedTokens = estimateTokens(request);
    let waited = 0;
    for (;;) {
      let grant;
      try {
        grant = await this.#governor.reserve({ requestId, models: [request.model], estimatedTokens, latencyClass: this.#latencyClass, priority: 0 }, options.signal);
      } catch (error: unknown) {
        await this.#withdraw(requestId);
        this.#throwIfCancelled(options.signal);
        if (error instanceof ModelProviderError && error.code === "authentication") throw error;
        throw unavailable(providerId);
      }
      if (options.signal?.aborted) { await this.#withdraw(requestId); this.#throwIfCancelled(options.signal); }
      if (!grant || typeof grant.granted !== "boolean" || (grant.model !== undefined && grant.model !== request.model)) {
        await this.#withdraw(requestId);
        throw unavailable(providerId);
      }
      if (grant.granted) break;
      if (grant.permanent) {
        await this.#withdraw(requestId);
        if (grant.reason === "account_disabled") throw accountDisabled(providerId, request.model, grant);
        throw new ModelProviderError({ message: `The shared capacity ledger refuses this request for ${request.model} (${grant.reason ?? "unavailable"}).`, code: "model-unavailable", providerId, retryable: false });
      }
      const waitMs = Number.isFinite(grant.waitMs) && (grant.waitMs ?? 0) > 0 ? Math.ceil(grant.waitMs as number) : 1_000;
      if (waited + waitMs > this.#maximumWaitMs) {
        await this.#withdraw(requestId);
        throw new ModelProviderError({ message: `Provider capacity for ${request.model} is reserved by other work; retry in about ${Math.ceil(waitMs / 1000)}s.`, code: "rate-limit", providerId, retryable: true, retryAfterMs: waitMs });
      }
      try {
        await this.#sleep(waitMs, options.signal);
      } catch {
        await this.#withdraw(requestId);
        throw cancelled(providerId);
      }
      waited += waitMs;
    }

    let response: ModelResponse;
    try {
      response = await this.#provider.complete(request, options);
    } catch (error: unknown) {
      await this.#release(outcomeFor(requestId, request.model, error));
      throw error;
    }
    await this.#release({ requestId, model: request.model, status: 200, kind: null });
    return response;
  }

  async #withdraw(requestId: string): Promise<void> {
    try { await this.#governor.withdraw(requestId); } catch { /* uncertain reservations expire; cleanup never authorizes dispatch */ }
  }

  async #release(outcome: Parameters<InferenceGovernor["release"]>[0]): Promise<void> {
    try { await this.#governor.release(outcome); } catch { /* retain the original provider outcome; never replay completed work */ }
  }

  #throwIfCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw cancelled(this.metadata.id);
  }
}

const ACCOUNT_PROBLEM: Readonly<Record<string, string>> = {
  AUTHENTICATION: "the API key was rejected",
  BILLING: "there is no credit or a billing problem",
  PERMISSION: "the key has no permission for this model or project",
};

/**
 * The provider's account, not its capacity, is the problem. The wording avoids
 * "capacity" on purpose: a fallback chain must not wait for an account that
 * only the owner can fix, and the person reading the report should be told what to fix.
 */
function accountDisabled(providerId: string, model: string, grant: { readonly kind?: string; readonly waitMs?: number }): ModelProviderError {
  const problem = ACCOUNT_PROBLEM[grant.kind ?? ""] ?? "its account was reported unusable";
  const minutes = Math.max(1, Math.ceil((grant.waitMs ?? 0) / 60_000));
  return new ModelProviderError({
    message: `No request was sent: the ${providerId} account is marked unusable for ${model} because ${problem}. Fix the key or billing; Atlas tries it again automatically in about ${minutes} min.`,
    // "authentication" covers every account-level refusal (key, billing, permission); the message says which.
    code: "authentication",
    providerId, retryable: false,
  });
}

function unavailable(providerId: string): ModelProviderError {
  return new ModelProviderError({ message: "Shared inference capacity could not be confirmed. No model request was sent.",
    code: "provider-failure", providerId, retryable: true, retryAfterMs: 1_000 });
}

function outcomeFor(requestId: string, model: string, error: unknown) {
  if (error instanceof ModelProviderError) {
    if (error.code === "rate-limit") {
      const retryAfterMs = error.retryAfterMs;
      return { requestId, model, status: 429, kind: "RATE_LIMIT", ...(retryAfterMs === undefined ? {} : { retryAfterMs }), ...(retryAfterMs !== undefined && retryAfterMs > 60_000 ? { scope: "daily" as const } : {}) };
    }
    if (error.code === "authentication") return { requestId, model, kind: "AUTHENTICATION" };
    if (error.code === "model-unavailable") return { requestId, model, kind: "MODEL_NOT_FOUND" };
    if (error.code === "cancelled") return { requestId, model, kind: "CANCELLED" };
    if (error.code === "invalid-request") return { requestId, model, kind: "INVALID_RESPONSE" };
    return { requestId, model, kind: "SERVER_ERROR" };
  }
  return { requestId, model, kind: "NETWORK" };
}

/** About four characters per token over the whole request, plus the output allowance the caller asked for. */
export function estimateTokens(request: ModelRequest): number {
  const input = Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools ?? [] }).length / 4);
  return input + (request.maxOutputTokens ?? 4_096);
}

function cancelled(providerId: string): ModelProviderError {
  return new ModelProviderError({ message: "Request cancelled", code: "cancelled", providerId, retryable: false });
}

function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("aborted")); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, delayMs);
    const onAbort = (): void => { clearTimeout(timer); reject(new Error("aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
