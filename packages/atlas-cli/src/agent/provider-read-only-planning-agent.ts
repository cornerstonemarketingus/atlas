import {
  type ReadOnlyPlanningAgent,
  type ReadOnlyPlanningRequest,
  type ReadOnlyPlanningResult,
  type PlanningTrace,
} from "./read-only-planning-agent.js";
import {
  ModelProviderError,
  type AssistantMessage,
  type ModelMessage,
  type ModelProvider,
  type ModelUsage,
} from "../model/model-provider.js";

export interface ProviderReadOnlyPlanningAgentOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly maximumTurns?: number;
  readonly maximumEvidenceItems?: number;
  readonly maximumEvidenceCharacters?: number;
  readonly maxOutputTokens?: number;
}

const EMPTY_USAGE: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

/**
 * A provider-neutral planning loop that can reason only over evidence supplied by
 * its caller. It deliberately exposes no tools and performs no repository I/O.
 */
export class ProviderReadOnlyPlanningAgent implements ReadOnlyPlanningAgent {
  readonly #provider: ModelProvider;
  readonly #model: string;
  readonly #maximumTurns: number;
  readonly #maximumEvidenceItems: number;
  readonly #maximumEvidenceCharacters: number;
  readonly #maxOutputTokens: number | undefined;

  public constructor(options: ProviderReadOnlyPlanningAgentOptions) {
    this.#provider = options.provider;
    this.#model = options.model;
    this.#maximumTurns = options.maximumTurns ?? 2;
    this.#maximumEvidenceItems = options.maximumEvidenceItems ?? 50;
    this.#maximumEvidenceCharacters = options.maximumEvidenceCharacters ?? 100_000;
    this.#maxOutputTokens = options.maxOutputTokens;

    assertPositiveInteger("maximumTurns", this.#maximumTurns, 8);
    assertPositiveInteger("maximumEvidenceItems", this.#maximumEvidenceItems, 1_000);
    assertPositiveInteger(
      "maximumEvidenceCharacters",
      this.#maximumEvidenceCharacters,
      1_000_000,
    );
    if (this.#maxOutputTokens !== undefined) {
      assertPositiveInteger("maxOutputTokens", this.#maxOutputTokens, 1_000_000);
    }
  }

  public async plan(request: ReadOnlyPlanningRequest): Promise<ReadOnlyPlanningResult> {
    const messages = this.#initialMessages(request);
    let turns = 0;
    let usage = EMPTY_USAGE;
    let partialResponse = "";

    const trace = (): PlanningTrace => ({
      turns,
      messages: structuredClone(messages),
      usage,
    });

    const invalidInput = validateInput(
      request,
      this.#maximumEvidenceItems,
      this.#maximumEvidenceCharacters,
    );
    if (invalidInput !== undefined) {
      return {
        status: "blocked",
        blocker: "invalid-input",
        message: invalidInput,
        trace: trace(),
      };
    }

    while (turns < this.#maximumTurns) {
      if (request.signal?.aborted === true) {
        return { status: "cancelled", message: "Planning was cancelled.", trace: trace() };
      }

      try {
        const response = await this.#provider.complete(
          {
            model: this.#model,
            messages,
            responseFormat: "text",
            ...(this.#maxOutputTokens === undefined
              ? {}
              : { maxOutputTokens: this.#maxOutputTokens }),
          },
          request.signal === undefined ? {} : { signal: request.signal },
        );
        turns += 1;
        usage = addUsage(usage, response.usage);
        messages.push(response.message);

        const toolCall = response.message.content.find((content) => content.type === "tool-call");
        if (toolCall !== undefined && toolCall.type === "tool-call") {
          return {
            status: "blocked",
            blocker: "tool-call-unsupported",
            message: `Read-only planning cannot execute requested tool '${toolCall.name}'.`,
            trace: trace(),
          };
        }

        const text = extractText(response.message);
        if (text.length > 0) {
          partialResponse = [partialResponse, text].filter(Boolean).join("\n");
        }

        switch (response.finishReason) {
          case "stop":
            return partialResponse.length === 0
              ? {
                  status: "blocked",
                  blocker: "empty-response",
                  message: "The model completed without a textual planning response.",
                  trace: trace(),
                }
              : { status: "completed", response: partialResponse, trace: trace() };
          case "length":
            if (turns >= this.#maximumTurns) {
              return {
                status: "blocked",
                blocker: "turn-limit",
                message: "Planning reached the configured turn limit while continuing output.",
                ...(partialResponse.length === 0 ? {} : { partialResponse }),
                trace: trace(),
              };
            }
            messages.push({
              role: "user",
              content: [{ type: "text", text: "Continue the same read-only response concisely." }],
            });
            break;
          case "content-filter":
            return {
              status: "blocked",
              blocker: "content-filtered",
              message: "The provider filtered the planning response.",
              ...(partialResponse.length === 0 ? {} : { partialResponse }),
              trace: trace(),
            };
          case "cancelled":
            return { status: "cancelled", message: "Planning was cancelled.", trace: trace() };
          case "tool-calls":
            return {
              status: "blocked",
              blocker: "tool-call-unsupported",
              message: "The provider requested tools, but this planning agent exposes none.",
              trace: trace(),
            };
          case "error":
          case "other":
            return {
              status: "failed",
              message: `Provider ended planning with finish reason '${response.finishReason}'.`,
              retryable: false,
              providerId: response.providerId,
              trace: trace(),
            };
        }
      } catch (error: unknown) {
        if (error instanceof ModelProviderError) {
          if (error.code === "cancelled") {
            return { status: "cancelled", message: error.message, trace: trace() };
          }
          return {
            status: "failed",
            message: error.message,
            retryable: error.retryable,
            providerId: error.providerId,
            trace: trace(),
          };
        }
        return {
          status: "failed",
          message: error instanceof Error ? error.message : "Unknown model provider failure.",
          retryable: false,
          trace: trace(),
        };
      }
    }

    return {
      status: "blocked",
      blocker: "turn-limit",
      message: "Planning reached the configured turn limit.",
      ...(partialResponse.length === 0 ? {} : { partialResponse }),
      trace: trace(),
    };
  }

  #initialMessages(request: ReadOnlyPlanningRequest): ModelMessage[] {
    const evidence = request.evidence
      .map((item, index) => `Evidence ${index + 1}: ${item.label}\n${item.content}`)
      .join("\n\n");
    return [
      {
        role: "system",
        content: [
          {
            type: "text",
            text: "You are Atlas in read-only planning mode. Use only caller-supplied evidence. Do not request tools, claim to inspect files, execute commands, or modify a repository. Clearly distinguish evidence from inference and state blockers.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Objective:\n${request.objective}\n\nRepository evidence:\n${evidence || "(none supplied)"}`,
          },
        ],
      },
    ];
  }
}

function validateInput(
  request: ReadOnlyPlanningRequest,
  maximumItems: number,
  maximumCharacters: number,
): string | undefined {
  if (request.objective.trim().length === 0) return "A non-empty objective is required.";
  if (request.evidence.length > maximumItems) {
    return `Evidence item count ${request.evidence.length} exceeds limit ${maximumItems}.`;
  }
  const characters = request.evidence.reduce(
    (total, item) => total + item.label.length + item.content.length,
    0,
  );
  if (characters > maximumCharacters) {
    return `Evidence size ${characters} characters exceeds limit ${maximumCharacters}.`;
  }
  return undefined;
}

function extractText(message: AssistantMessage): string {
  return message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text.trim())
    .filter(Boolean)
    .join("\n");
}

function addUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  const cachedInputTokens = (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0);
  const estimatedCostUsd = (left.estimatedCostUsd ?? 0) + (right.estimatedCostUsd ?? 0);
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    ...(cachedInputTokens === 0 ? {} : { cachedInputTokens }),
    ...(estimatedCostUsd === 0 ? {} : { estimatedCostUsd }),
  };
}

function assertPositiveInteger(name: string, value: number, maximum: number): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}.`);
  }
}
