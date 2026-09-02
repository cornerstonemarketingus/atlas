import type { ReadOnlyToolAgentResult } from "../agent/read-only-tool-agent.js";
import type {
  ProposedEditOperation,
  VerificationReport,
  VerifiedCoderResult,
} from "../agent/verified-coder-session.js";

export interface CodeEditSummary {
  readonly path: string;
  readonly operation: ProposedEditOperation;
}

export interface CodeVerificationSummary {
  readonly status: VerificationReport["status"];
  readonly attempts: number;
  readonly checks: readonly string[];
  readonly newFailures: readonly string[];
  readonly message: string;
}

export interface CodeOutput {
  readonly sessionId: string;
  readonly status: ReadOnlyToolAgentResult["status"];
  readonly summary?: string;
  readonly message?: string;
  readonly edits: readonly CodeEditSummary[];
  readonly verification?: CodeVerificationSummary;
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

/**
 * Renders a verified run, where the agent's edits were checked against the
 * repository's own build/test commands. `usage` comes from the final agent
 * pass; a repair loop's earlier passes are counted in `verification.attempts`.
 */
export function toVerifiedCodeOutput(
  sessionId: string,
  result: VerifiedCoderResult,
  usage: { readonly turns: number; readonly toolCalls: number; readonly inputTokens: number; readonly outputTokens: number },
): CodeOutput {
  return {
    sessionId,
    status: result.status,
    ...(result.status === "completed" ? { summary: result.response } : {}),
    ...(result.message === null ? {} : { message: result.message }),
    edits: result.edits.map((edit) => ({ path: edit.path, operation: edit.operation })),
    verification: {
      status: result.verification.status,
      attempts: result.verification.attempts,
      checks: result.verification.profileIds,
      newFailures: result.verification.newFailures,
      message: result.verification.message,
    },
    ...usage,
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
    ...(output.verification === undefined ? [] : [
      `Verification: ${output.verification.status}`,
      `  ${output.verification.message}`,
      ...(output.verification.checks.length === 0 ? [] : [`  Checks: ${output.verification.checks.join(", ")}`]),
      ...output.verification.newFailures.map((failure) => `  ! ${failure}`),
    ]),
    `Turns: ${output.turns}`,
    `Tool calls: ${output.toolCalls}`,
    `Tokens: ${output.inputTokens} input / ${output.outputTokens} output`,
  ].join("\n");
}
