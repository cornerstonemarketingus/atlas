import type { ReadOnlyToolAgentResult } from "../agent/read-only-tool-agent.js";

export interface CodeEditSummary {
  readonly path: string;
  readonly operation: "create" | "update";
}

export interface CodeOutput {
  readonly sessionId: string;
  readonly status: ReadOnlyToolAgentResult["status"];
  readonly summary?: string;
  readonly message?: string;
  readonly edits: readonly CodeEditSummary[];
  readonly turns: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export function toCodeOutput(
  sessionId: string,
  result: ReadOnlyToolAgentResult,
  edits: readonly CodeEditSummary[],
): CodeOutput {
  return {
    sessionId,
    status: result.status,
    ...(result.status === "completed" ? { summary: result.response } : {}),
    ...(result.status === "approval-required" || result.status === "blocked" || result.status === "cancelled" || result.status === "failed"
      ? { message: "message" in result ? result.message : `Stopped waiting on approval for ${result.toolName}.` }
      : {}),
    edits,
    turns: result.trace.turns,
    toolCalls: result.trace.toolCalls,
    inputTokens: result.trace.usage.inputTokens,
    outputTokens: result.trace.usage.outputTokens,
  };
}

export function renderCodeJson(output: CodeOutput): string {
  return JSON.stringify(output, null, 2);
}

export function renderCodeText(output: CodeOutput): string {
  const body = output.summary ?? output.message ?? "No summary.";
  return [
    body,
    "",
    `Status: ${output.status}`,
    `Session: ${output.sessionId}`,
    `Files changed: ${output.edits.length}`,
    ...output.edits.map((edit) => `  ${edit.operation} ${edit.path}`),
    `Turns: ${output.turns}`,
    `Tool calls: ${output.toolCalls}`,
    `Tokens: ${output.inputTokens} input / ${output.outputTokens} output`,
  ].join("\n");
}
