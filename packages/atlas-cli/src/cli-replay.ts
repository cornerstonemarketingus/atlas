import { reconstructSessions } from "./agent/session-replay.js";
import { renderReplayJson, renderReplayText } from "./presentation/replay-renderers.js";
import type { SessionEvent } from "./domain/session-audit.js";

export interface ReplayCommandDependencies {
  readonly readTrace: (path: string) => Promise<string>;
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
}

/**
 * `atlas replay <audit.jsonl>` — reconstructs what a session did.
 *
 * Traces have been written since the audit log landed and nothing has ever
 * read one back, which is fine while one agent works alone and stops being
 * fine the moment several do: interleaved traces cannot be debugged by
 * scrolling.
 *
 * Parsing is lenient by design. A trace is most worth reading when the run
 * that produced it died badly, and a run killed mid-write leaves a half-
 * written final line. Refusing the whole file over that would withhold the
 * record exactly when it is wanted, so unreadable lines are counted and
 * reported rather than thrown, and everything legible is still reconstructed.
 */
export async function executeReplayCommand(
  args: readonly string[],
  dependencies: ReplayCommandDependencies,
): Promise<number> {
  const path = args[1];
  if (path === undefined || path.trim().length === 0) {
    dependencies.writeError("Usage: atlas replay <audit-log.jsonl> [--format text|json] [--session <id>]\n");
    return 2;
  }

  const formatIndex = args.indexOf("--format");
  const format = formatIndex === -1 ? "text" : args[formatIndex + 1];
  if (format !== "text" && format !== "json") {
    dependencies.writeError("--format must be 'text' or 'json'.\n");
    return 2;
  }

  const sessionIndex = args.indexOf("--session");
  const wantedSession = sessionIndex === -1 ? undefined : args[sessionIndex + 1];
  if (sessionIndex !== -1 && (wantedSession === undefined || wantedSession.startsWith("--"))) {
    dependencies.writeError("--session requires a session id.\n");
    return 2;
  }

  let raw: string;
  try {
    raw = await dependencies.readTrace(path);
  } catch (error) {
    dependencies.writeError(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const events: SessionEvent[] = [];
  let unreadableLines = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as SessionEvent;
      if (typeof parsed?.type === "string" && typeof parsed?.occurredAt === "string") {
        events.push(parsed);
      } else {
        unreadableLines += 1;
      }
    } catch {
      unreadableLines += 1;
    }
  }

  if (unreadableLines > 0) {
    // Reported, never silent: a reader has to know the account is partial.
    dependencies.writeError(`${unreadableLines} unreadable line(s) skipped; the rest was reconstructed.\n`);
  }

  const all = reconstructSessions(events);
  const sessions = wantedSession === undefined
    ? all
    : all.filter((session) => session.sessionId === wantedSession);

  if (wantedSession !== undefined && sessions.length === 0) {
    dependencies.writeError(`No session '${wantedSession}' in this trace.\n`);
    return 1;
  }

  dependencies.write(format === "json" ? renderReplayJson(sessions) : renderReplayText(sessions));
  return 0;
}
