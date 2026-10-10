import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { renderRunSummary } from "./run-summary.mjs";
import { correlationIdFromEnv, correlationLogSuffix, withCorrelationId } from "./correlation.mjs";

const limit = 16000;
function read(directory, name) {
  try {
    const filename = path.join(directory, name);
    if (fs.statSync(filename).size > 2 * 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch { return null; }
}

export function renderResult({ task, status, code, inspection, debug, conclusion, budget }) {
  const lines = [`Runner job: ${conclusion || "unknown"}.`, renderRunSummary({ task, status, code, budget })];
  if (inspection) {
    lines.push("Repository inspection (no implementation plan or edits were generated):",
      `Files scanned: ${inspection.fileCount ?? "unknown"}.`,
      `Languages: ${(inspection.languages ?? []).slice(0, 20).map(x => `${x.name} (${x.fileCount})`).join(", ") || "none detected"}.`,
      `Frameworks: ${(inspection.frameworks ?? []).slice(0, 20).map(x => x.name).join(", ") || "none detected"}.`,
      `Manifests: ${(inspection.manifests ?? []).slice(0, 25).map(x => x.path).join(", ") || "none detected"}.`);
    for (const warning of (inspection.warnings ?? []).slice(0, 10)) lines.push(`Warning: ${warning.message}`);
  }
  if (debug) {
    lines.push("Build/test results:");
    for (const step of (debug.steps ?? []).slice(0, 10)) {
      lines.push(`${step.label}: ${step.ok ? "passed" : "failed"}; exit ${step.exitCode ?? "unknown"}${step.timedOut ? "; timed out" : ""}.`);
      if (!step.ok) lines.push(String(step.stderr || step.stdout || "No output captured.").slice(-3000));
    }
  }
  if (status?.pull_request_url) lines.push(`Pull request: ${status.pull_request_url}`);
  if (!status) lines.push("The runner did not produce a final result. Open the run log for the failure.");
  return lines.join("\n\n").slice(0, limit - 100);
}

/** The callback body; `correlationId` is included only when well-formed. */
export function buildResultPayload({ taskId, summary, correlationId }) {
  return withCorrelationId({ taskId, summary }, correlationId);
}

// Retry only recognized transport failures. Redirect refusal, invalid URLs,
// TLS/certificate errors and other configuration failures remain terminal.
const TRANSIENT_TRANSPORT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND",
  "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);

function transientTransportFailure(error) {
  if (error?.name === "TimeoutError") return true;
  const cause = error?.cause ?? error;
  if (TRANSIENT_TRANSPORT_CODES.has(cause?.code)) return true;
  // Node may report several failed address attempts in one AggregateError.
  return Array.isArray(cause?.errors) && cause.errors.length > 0
    && cause.errors.every((failure) => TRANSIENT_TRANSPORT_CODES.has(failure?.code));
}

export async function deliverResult({ endpoint, token, payload }, fetcher = fetch) {
  // The receiver's task/run/attempt IDs make an acknowledgement lost after
  // commit safe to retry. Snapshot the evidence so every attempt is identical.
  const body = JSON.stringify(payload);
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetcher(endpoint, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(20000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
      });
    } catch (error) {
      if (!transientTransportFailure(error)) {
        throw new Error("Result delivery failed: request could not be sent.");
      }
      if (attempt === 2) {
        throw new Error("Result delivery failed: transport unavailable after 3 attempts.");
      }
    }
    if (response) {
      // Only response metadata is needed; release a retry's unused body.
      try { await response.body?.cancel(); } catch { /* no response text is surfaced */ }
      if (response.ok) return { delivered: true };
      // Manually dispatched maintenance jobs have no hosted conversation.
      if (response.status === 404) return { delivered: false, reason: 'task-not-found' };
      if (response.status < 500 || attempt === 2) throw new Error(`Result delivery failed: HTTP ${response.status}`);
    }
    // Two bounded waits (250ms, 500ms) prevent a tight outage retry loop.
    await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
  }
}

export function deliveryMessage(delivery, taskId, correlationId) {
  return delivery.delivered ? `Delivered result for task ${taskId}.${correlationLogSuffix(correlationId)}` : `Result was not delivered: no hosted task exists for ${taskId}.${correlationLogSuffix(correlationId)}`;
}

async function main() {
  const taskId = process.env.ATLAS_TASK_ID;
  if (!/^[0-9a-f-]{36}$/i.test(taskId ?? "")) { console.log("This run is not a hosted task; callback skipped."); return; }
  const directory = process.env.ATLAS_OUTPUT_DIR;
  let text;
  try {
    text = renderResult({ task: read(directory, "task.json"), status: read(directory, "status.json"), code: read(directory, "code.json"), inspection: read(directory, "inspect.json"), debug: read(directory, "debug.json"), conclusion: process.env.ATLAS_JOB_RESULT, budget: read(directory, "budget.json") });
  } catch { text = "The runner returned malformed result data. Open the run log; no successful outcome is inferred."; }
  const redacted = spawnSync(process.execPath, [path.resolve("packages/atlas-cli/dist/src/cli.js"), "redact"], {
    input: text, encoding: "utf8", timeout: 60000, maxBuffer: 128000, windowsHide: true,
  });
  // Never publish unscanned artifacts, including on parser/redactor failures.
  const summary = !redacted.error && redacted.status === 0 && redacted.stdout.trim()
    ? redacted.stdout.slice(0, limit)
    : "Runner finished. Result details were withheld because credential scanning failed. Open the run log.";
  const identityUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  identityUrl.searchParams.set("audience", "atlas-runner-results");
  const identity = await fetch(identityUrl, { headers: { authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, signal: AbortSignal.timeout(10000) });
  if (!identity.ok) throw new Error("Runner identity unavailable");
  const { value: token } = await identity.json();
  const endpoint = process.env.ATLAS_RESULT_URL || "https://atlas-web.cornerstonemarketingus.workers.dev/api/tasks/result";
  if (new URL(endpoint).protocol !== "https:") throw new Error("Result endpoint must use HTTPS");
  const correlationId = correlationIdFromEnv();
  const delivery = await deliverResult({ endpoint, token, payload: buildResultPayload({ taskId, summary, correlationId }) });
  console.log(deliveryMessage(delivery, taskId, correlationId));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Atlas result delivery failed. Check the reporting job and retry it."); process.exitCode = 1; });
}
