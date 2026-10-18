/**
 * Renders a run's verdict into the GitHub Actions job summary.
 *
 * Every failure so far has needed log archaeology: fetching a 500-line job log
 * and hunting for the one line that says what actually happened. The run page
 * showed a red X and nothing else. This puts the verdict, the counters and the
 * failing checks on the front page of the run.
 *
 * It matters most for the slow paths. A self-hosted model takes one to two
 * hours, and "how far did it get before it died" — turns, tool calls, tokens —
 * is the difference between "the machinery is broken" and "the model is weak".
 * Those are different problems with different fixes.
 *
 * Two rules this file follows:
 *
 * 1. NEVER throws, and never exits non-zero. A run that produced a correct
 *    change has not failed because its summary could not be rendered, and a
 *    summary step that can turn a green run red is worse than no summary.
 * 2. The output is REDACTED before it is written. A job summary is visible to
 *    everyone with read access to the repository, and the text rendered here
 *    includes model output and raw failure messages. That makes this an output
 *    boundary like any other, so it goes through `atlas redact` — the same
 *    rules the agent uses, not a second detector that would drift.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MAX_MESSAGE_CHARACTERS = 1_200;
const MAX_LISTED_EDITS = 40;

/** Table cells are pipe-delimited, so an unescaped pipe silently breaks the row. */
function cell(value) {
  return String(value ?? "").replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

function truncate(value, limit = MAX_MESSAGE_CHARACTERS) {
  const text = String(value ?? "").trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}… (truncated)`;
}

function count(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : "—";
}

const VERDICTS = {
  completed: "✅ completed",
  failed: "❌ failed",
  blocked: "⏸️ blocked",
  cancelled: "⚠️ cancelled",
  unsupported: "⚠️ unsupported",
};

/**
 * Pure: takes the three artifacts a run writes and returns markdown.
 *
 * Every input is optional. A run that dies early writes some of these and not
 * others, and that is exactly when a summary is most wanted — so a missing
 * file produces a thinner summary, never an error.
 */
export function renderRunSummary({ task = null, status = null, code = null, budget = null } = {}) {
  const mode = task?.mode ?? "task";
  const verdict = VERDICTS[status?.status] ?? `❔ ${status?.status ?? "unknown"}`;
  const lines = [`## Atlas ${mode} — ${verdict}`, ""];

  const message = truncate(status?.message ?? code?.message ?? "");
  if (message) lines.push(`> ${message.replace(/\r?\n/gu, "\n> ")}`, "");

  if (budget) lines.push(`Actions budget: **${cell(budget.decision).toUpperCase()}** — ${cell(budget.action)}. ${truncate(budget.reason, 400)}`, "");

  const rows = [];
  if (task?.task_id) rows.push(["Task", `\`${cell(task.task_id)}\``]);
  if (task?.repository) {
    rows.push(["Repository", `\`${cell(task.repository)}\`${task.branch ? ` @ \`${cell(task.branch)}\`` : ""}`]);
  }
  if (task?.commit) rows.push(["Commit", `\`${cell(String(task.commit).slice(0, 12))}\``]);
  if (code && typeof code.turns === "number") {
    rows.push(["Model turns", count(code.turns)]);
    rows.push(["Tool calls", count(code.toolCalls)]);
    rows.push(["Tokens", `${count(code.inputTokens)} in / ${count(code.outputTokens)} out`]);
  }
  if (rows.length > 0) {
    lines.push("| | |", "| --- | --- |", ...rows.map(([label, value]) => `| ${label} | ${value} |`), "");
  }

  const verification = code?.verification ?? status?.verification ?? null;
  if (verification) {
    lines.push("### Verification", "");
    lines.push(`**${cell(verification.status)}** — ${truncate(verification.message, 400)}`, "");
    if (typeof verification.attempts === "number") {
      lines.push(`Repair attempts: ${count(verification.attempts)}`, "");
    }
    const checks = Array.isArray(verification.checks) ? verification.checks : [];
    if (checks.length > 0) {
      lines.push(`Checks run: ${checks.map((check) => `\`${cell(check)}\``).join(", ")}`, "");
    }
    const newFailures = Array.isArray(verification.newFailures) ? verification.newFailures : [];
    if (newFailures.length > 0) {
      // The whole product claim is this distinction: failures the change
      // introduced, separated from failures that were already there.
      lines.push(`**New failures introduced by this change:** ${newFailures.length}`, "");
      for (const failure of newFailures.slice(0, MAX_LISTED_EDITS)) {
        lines.push(`- ${truncate(typeof failure === "string" ? failure : JSON.stringify(failure), 200)}`);
      }
      lines.push("");
    }
  }

  const edits = Array.isArray(code?.edits) ? code.edits : [];
  if (edits.length > 0) {
    lines.push(`### Files changed (${edits.length})`, "");
    for (const edit of edits.slice(0, MAX_LISTED_EDITS)) {
      lines.push(`- \`${cell(edit?.path)}\` — ${cell(edit?.operation ?? "changed")}`);
    }
    if (edits.length > MAX_LISTED_EDITS) {
      lines.push(`- …and ${edits.length - MAX_LISTED_EDITS} more`);
    }
    lines.push("");
  } else if (status?.status === "completed") {
    lines.push("No file changes were proposed.", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function readJson(directory, filename) {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, filename), "utf8"));
  } catch {
    // Absent or unparseable is normal for a run that died early, and is the
    // case a summary is most useful in. Render what exists.
    return null;
  }
}

/**
 * Scrubs credentials out of the summary, failing CLOSED.
 *
 * If redaction cannot run, the rendered text is discarded and replaced with a
 * status-only line. The status words come from a fixed set and carry nothing
 * from the model or the repository, so the reader still learns the outcome
 * without anything unscanned reaching a page other people can read.
 */
function redact(markdown, fallbackStatus) {
  const cli = path.resolve("packages/atlas-cli/dist/src/cli.js");
  const result = spawnSync(process.execPath, [cli, "redact"], {
    input: markdown,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    const reason = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
    console.error(`Run summary withheld: redaction failed (${reason}).`);
    return `## Atlas run — ${VERDICTS[fallbackStatus] ?? fallbackStatus ?? "unknown"}\n\n`
      + "Details were withheld because they could not be scanned for credentials. "
      + "The run log and the uploaded artifact still have the full record.\n";
  }
  return result.stdout;
}

function main() {
  const directory = process.env.ATLAS_OUTPUT_DIR;
  if (!directory) {
    console.error("Run summary skipped: ATLAS_OUTPUT_DIR is not set.");
    return;
  }
  const status = readJson(directory, "status.json");
  const markdown = redact(
    renderRunSummary({
      task: readJson(directory, "task.json"),
      status,
      code: readJson(directory, "code.json"),
      budget: readJson(directory, "budget.json"),
    }),
    status?.status,
  );

  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) {
    // Running outside Actions. Print it so the script is usable by hand.
    process.stdout.write(markdown);
    return;
  }
  try {
    fs.appendFileSync(target, markdown, "utf8");
  } catch (error) {
    console.error(`Run summary could not be written: ${error.message}`);
  }
}

// Only run when invoked directly, so the renderer can be imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    main();
  } catch (error) {
    // Belt and braces. Nothing in a summary is worth failing a run over.
    console.error(`Run summary failed: ${error?.message ?? error}`);
  }
}
