import type { UsageBudgetLedger } from "../domain/usage-budget.js";
import type {
  ModelCompletionOptions,
  ModelProvider,
  ModelProviderMetadata,
  ModelRequest,
  ModelResponse,
} from "../model/model-provider.js";
import { ModelProviderError } from "../model/model-provider.js";

// Coordinate all wrappers sharing a ledger, including repair/escalation routes.
// Unbounded output and unrelated ledgers keep their existing parallel behavior.
const admissions = new WeakMap<UsageBudgetLedger, Promise<void>>();
const accountingFailures = new WeakMap<UsageBudgetLedger, { error: unknown }>();

/**
 * Applies available output-token limits before a request and records actual
 * usage afterward. Provider-reported input tokens and cost are necessarily
 * accounted after completion because the neutral contract has no estimator.
 */
export class BudgetedModelProvider implements ModelProvider {
  public readonly metadata: ModelProviderMetadata;

  public constructor(
    private readonly provider: ModelProvider,
    private readonly ledger: UsageBudgetLedger,
  ) {
    if (provider instanceof BudgetedModelProvider && provider.ledger === ledger) {
      throw new TypeError("A model provider cannot be budgeted twice with the same ledger.");
    }
    this.metadata = provider.metadata;
  }

  public async complete(
    request: ModelRequest,
    options: ModelCompletionOptions = {},
  ): Promise<ModelResponse> {
    if (options.signal?.aborted) throw cancellation(this.metadata.id);
    if (this.ledger.snapshot().remaining.outputTokens === undefined) {
      return this.#complete(request, options);
    }
    const previous = admissions.get(this.ledger) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => slot);
    admissions.set(this.ledger, tail);
    // A cancelled queued slot must still wait for its predecessor before the
    // ledger can be removed, otherwise a later caller could bypass active work.
    void tail.then(() => {
      if (admissions.get(this.ledger) === tail) admissions.delete(this.ledger);
    });
    try {
      await waitForAdmission(previous, options.signal, this.metadata.id);
      return await this.#complete(request, options);
    } finally {
      release();
    }
  }

  async #complete(request: ModelRequest, options: ModelCompletionOptions): Promise<ModelResponse> {
    if (options.signal?.aborted) throw cancellation(this.metadata.id);
    const failure = accountingFailures.get(this.ledger);
    if (failure) throw failure.error;
    const remaining = this.ledger.snapshot().remaining;
    if (remaining.outputTokens !== undefined && remaining.outputTokens < 1) {
      this.ledger.record({ outputTokens: 1 });
    }
    const maximum = remaining.outputTokens === undefined
      ? request.maxOutputTokens
      : Math.min(request.maxOutputTokens ?? remaining.outputTokens, remaining.outputTokens);
    const response = await this.provider.complete({
      ...request,
      ...(maximum === undefined ? {} : { maxOutputTokens: maximum }),
    }, options);
    try {
      this.ledger.record({
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        costUsd: response.usage.estimatedCostUsd ?? 0,
      });
    } catch (error: unknown) {
      // Atomic accounting can reject all dimensions after work already spent
      // tokens. Do not admit more work using that now-incomplete snapshot.
      accountingFailures.set(this.ledger, { error });
      throw error;
    }
    return response;
  }
}

function cancellation(providerId: string): ModelProviderError {
  return new ModelProviderError({ message: "Model request cancelled", code: "cancelled", providerId, retryable: false });
}

function waitForAdmission(previous: Promise<void>, signal: AbortSignal | undefined, providerId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(cancellation(providerId));
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    void previous.then(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}
