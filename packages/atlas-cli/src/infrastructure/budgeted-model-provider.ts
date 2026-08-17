import type { UsageBudgetLedger } from "../domain/usage-budget.js";
import type {
  ModelCompletionOptions,
  ModelProvider,
  ModelProviderMetadata,
  ModelRequest,
  ModelResponse,
} from "../model/model-provider.js";

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
    this.metadata = provider.metadata;
  }

  public async complete(
    request: ModelRequest,
    options: ModelCompletionOptions = {},
  ): Promise<ModelResponse> {
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
    this.ledger.record({
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: response.usage.estimatedCostUsd ?? 0,
    });
    return response;
  }
}
