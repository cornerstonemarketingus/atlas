import type { ReadOnlyToolAgentResult } from "../agent/read-only-tool-agent.js";

export interface ChatOutput {
  readonly sessionId: string;
  readonly status: ReadOnlyToolAgentResult["status"];
  readonly response?: string;
  readonly message?: string;
  readonly pendingTool?: string;
  readonly turns: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Which provider/model actually answered the last turn, when one did. */
  readonly answeredBy?: string;
}

export function toChatOutput(sessionId: string, result: ReadOnlyToolAgentResult): ChatOutput {
  return {
    sessionId,
    status: result.status,
    ...(result.status === "completed" ? { response: result.response } : {}),
    ...(result.status === "approval-required"
      ? { message: "Source access requires explicit approval. Rerun with --allow-source.", pendingTool: result.toolName }
      : result.status === "blocked" || result.status === "cancelled" || result.status === "failed"
        ? { message: result.message }
        : {}),
    turns: result.trace.turns,
    toolCalls: result.trace.toolCalls,
    inputTokens: result.trace.usage.inputTokens,
    outputTokens: result.trace.usage.outputTokens,
    ...(result.trace.lastProviderId === undefined ? {} : { answeredBy: formatAnsweredBy(result.trace.lastProviderId, result.trace.lastModel) }),
  };
}

function formatAnsweredBy(providerId: string, model: string | undefined): string {
  return model === undefined ? providerId : `${providerId} (${model})`;
}

export function renderChatJson(output: ChatOutput): string {
  return JSON.stringify(output, null, 2);
}

export function renderChatText(output: ChatOutput): string {
  const body = output.response ?? output.message ?? "No response.";
  return [
    body,
    "",
    `Status: ${output.status}`,
    `Session: ${output.sessionId}`,
    `Turns: ${output.turns}`,
    `Tool calls: ${output.toolCalls}`,
    `Tokens: ${output.inputTokens} input / ${output.outputTokens} output`,
    ...(output.answeredBy === undefined ? [] : [`Answered by: ${output.answeredBy}`]),
    ...(output.pendingTool === undefined ? [] : [`Pending tool: ${output.pendingTool}`]),
  ].join("\n");
}
