import type { ReplaySession, ReplayTurn } from "../agent/session-replay.js";

/**
 * Renders a reconstructed session as something a person reads top to bottom.
 *
 * The ordering is deliberate: verdict first, then the turn-by-turn account,
 * then totals. Someone opening a trace has one question — where did this go
 * wrong — and the answer should not be at the bottom.
 */

function duration(milliseconds: number | undefined): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

function tokens(value: number): string {
  return value.toLocaleString("en-US");
}

function renderTurn(turn: ReplayTurn): string[] {
  const head = turn.unfinished
    ? `Turn ${turn.index} — NO RESPONSE (${turn.modelId})`
    : `Turn ${turn.index} — ${turn.finishReason ?? "?"} (${turn.modelId})`;
  const lines = [head];
  lines.push(
    `  sent ${turn.messageCount} message(s), ${tokens(turn.inputCharacters)} characters, ${turn.toolsOffered} tool(s) offered`,
  );
  if (!turn.unfinished) {
    lines.push(`  tokens ${tokens(turn.inputTokens ?? 0)} in / ${tokens(turn.outputTokens ?? 0)} out`);
  }
  for (const call of turn.toolCalls) {
    // An unfinished call is the most diagnostic line a truncated trace has,
    // so it is marked rather than left looking like any other row.
    const outcome = call.unfinished ? "NO RESULT" : call.outcome ?? "?";
    const denied = call.decision === "deny" || call.decision === "ask";
    const parts = [`  → ${call.toolId} — ${outcome}`];
    if (!call.unfinished && call.durationMs !== undefined) parts.push(`(${duration(call.durationMs)})`);
    if (denied) parts.push(`[policy: ${call.decision}${call.policyReason ? ` — ${call.policyReason}` : ""}]`);
    if (call.errorCode) parts.push(`[${call.errorCode}]`);
    lines.push(parts.join(" "));
  }
  return lines;
}

export function renderReplayText(sessions: readonly ReplaySession[]): string {
  if (sessions.length === 0) return "No sessions found in this trace.\n";

  const blocks = sessions.map((session) => {
    const lines: string[] = [];
    const unfinished = session.outcome === "unfinished" ? " (trace ends mid-session)" : "";
    lines.push(`Session ${session.sessionId} — ${session.outcome}${unfinished}`);
    if (session.repositoryId) lines.push(`Repository: ${session.repositoryId}`);
    if (session.summary) lines.push(`Summary: ${session.summary}`);
    if (session.durationMs !== undefined) lines.push(`Duration: ${duration(session.durationMs)}`);
    lines.push("");

    if (session.turns.length === 0) {
      lines.push("No model turns were recorded.");
    } else {
      for (const turn of session.turns) lines.push(...renderTurn(turn), "");
    }

    if (session.errors.length > 0) {
      lines.push("Errors:");
      for (const error of session.errors) {
        lines.push(`  ${error.code}${error.recoverable ? " (recoverable)" : ""}: ${error.summary}`);
      }
      lines.push("");
    }

    const { totals } = session;
    lines.push(
      `Totals: ${totals.turns} turn(s), ${totals.toolCalls} tool call(s)`
      + (totals.unfinishedToolCalls > 0 ? ` (${totals.unfinishedToolCalls} with no result)` : "")
      + `, ${tokens(totals.inputTokens)} in / ${tokens(totals.outputTokens)} out`,
    );
    return lines.join("\n").trimEnd();
  });

  return `${blocks.join("\n\n---\n\n")}\n`;
}

export function renderReplayJson(sessions: readonly ReplaySession[]): string {
  return `${JSON.stringify({ schemaVersion: 1, sessions }, null, 2)}\n`;
}
