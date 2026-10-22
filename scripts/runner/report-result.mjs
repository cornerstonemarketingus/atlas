import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { renderRunSummary } from "./run-summary.mjs";
import { correlationIdFromEnv, correlationLogSuffix, withCorrelationId } from "./correlation.mjs";

const limit = 16000;
const DEFAULT_RESULT_ENDPOINT = "https://atlas-web.cornerstonemarketingus.workers.dev/api/tasks/result";

// Only fixed diagnostics cross this boundary: upstream bodies, URLs and thrown
// messages can contain credentials. The Worker advertises a bounded error code.
const RESULT_ERRORS = {
  RUNNER_AUTHENTICATION_REQUIRED: "GitHub OIDC authentication was rejected; verify the report job has id-token: write and uses the atlas-runner-results audience.",
  INVALID_RESULT_PAYLOAD: "The Worker rejected the callback payload; verify runner and Worker versions are compatible.",
  DISPATCH_NOT_FOUND: "No hosted conversation exists for this task.",
  EXECUTOR_IDENTITY_MISMATCH: "The signed executor repository does not match the saved dispatch.",
  RESULT_CORRELATION_MISMATCH: "The result correlation id does not match the saved dispatch.",
  GITHUB_VERIFICATION_CREDENTIAL_MISSING: "The Worker has no GitHub run-verification credential; deploy ATLAS_GITHUB_TOKEN or the configured GitHub App to the Worker.",
  GITHUB_RUN_VERIFICATION_UNAVAILABLE: "The Worker could not verify this GitHub run; check its GitHub credential permissions and GitHub API availability.",
  RESULT_DISPATCH_MISMATCH: "The signed run does not match the saved task and trusted workflow.",
  RESULT_OWNERSHIP_MISMATCH: "The saved execution claim does not authorize this result; inspect the exact task, run and attempt.",
  RESULT_STORAGE_UNAVAILABLE: "The Worker could not persist the report; check D1 availability and applied task migrations.",
};

export class ResultDeliveryError extends Error {
  constructor(message, { stage = "callback", code = "DELIVERY_FAILED", status = null } = {}) {
    super(message);
    this.name = "ResultDeliveryError";
    this.stage = stage;
    this.code = code;
    this.status = status;
  }
}

export function deliveryFailure(error) {
  if (error instanceof ResultDeliveryError) return {
    delivered: false, stage: error.stage, code: error.code,
    ...(error.status === null ? {} : { httpStatus: error.status }), message: error.message,
  };
  return { delivered: false, stage: "report", code: "REPORT_FAILED", message: "Atlas result reporting failed before delivery. Inspect the report job's setup and retained task artifacts." };
}

export function resultEndpoint(value) {
  try {
    const endpoint = new URL(value || DEFAULT_RESULT_ENDPOINT);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) throw new Error();
    return endpoint.href;
  } catch {
    throw new ResultDeliveryError("Result endpoint is invalid; set ATLAS_RESULT_URL to the HTTPS Worker /api/tasks/result endpoint without embedded credentials.", { stage: "configuration", code: "INVALID_RESULT_ENDPOINT" });
  }
}

export async function requestRunnerIdentity(env, fetcher = fetch) {
  let identityUrl;
  try {
    identityUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    if (identityUrl.protocol !== "https:" || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error();
  } catch {
    throw new ResultDeliveryError("GitHub OIDC is unavailable; the report job must have id-token: write permission.", { stage: "identity", code: "OIDC_UNAVAILABLE" });
  }
  identityUrl.searchParams.set("audience", "atlas-runner-results");
  let identity;
  try {
    identity = await fetcher(identityUrl, {
      headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      redirect: "error", signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new ResultDeliveryError("GitHub OIDC token request failed; check GitHub Actions identity service availability.", { stage: "identity", code: "OIDC_REQUEST_FAILED" });
  }
  if (!identity.ok) {
    try { await identity.body?.cancel(); } catch { /* ignore upstream response body */ }
    throw new ResultDeliveryError(`GitHub OIDC token request failed: HTTP ${identity.status}. Check report job identity permissions.`, { stage: "identity", code: "OIDC_REJECTED", status: identity.status });
  }
  let token;
  try { ({ value: token } = await identity.json()); } catch { /* fixed diagnostic below */ }
  if (typeof token !== "string" || !token || token.length > 16000) {
    throw new ResultDeliveryError("GitHub OIDC returned no usable identity token.", { stage: "identity", code: "OIDC_INVALID_RESPONSE" });
  }
  return token;
}
function read(directory, name) {
  try {
    const filename = path.join(directory, name);
    if (fs.statSync(filename).size > 2 * 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch { return null; }
}

export function renderResult({ task, status, code, inspection, debug, conclusion, budget, progress, recovery }) {
  const lines = [`Runner job: ${conclusion || "unknown"}.`, renderRunSummary({ task, status, code: code ?? progress, budget })];
  if (progress && !code) {
    lines.push(`Progress checkpoint saved at phase '${String(progress.phase ?? "unknown").slice(0, 80)}'. This checkpoint does not confirm task completion.`);
  }
  if (recovery) {
    lines.push("Repository recovery data is retained in recovery.json. Review it against the recorded base commit before restoring work; no continuation or completion is inferred.");
  }
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
        throw new ResultDeliveryError("Result delivery failed: request could not be sent.", { code: "CALLBACK_REQUEST_FAILED" });
      }
      if (attempt === 2) {
        throw new ResultDeliveryError("Result delivery failed: transport unavailable after 3 attempts.", { code: "CALLBACK_TRANSPORT_UNAVAILABLE" });
      }
    }
    if (response) {
      // Only response metadata is needed; release a retry's unused body.
      try { await response.body?.cancel(); } catch { /* no response text is surfaced */ }
      if (response.ok) return { delivered: true };
      // Manually dispatched maintenance jobs have no hosted conversation.
      if (response.status === 404) return { delivered: false, reason: 'task-not-found' };
      if (response.status < 500 || attempt === 2) {
        const advertised = response.headers?.get("x-atlas-result-error");
        const code = Object.hasOwn(RESULT_ERRORS, advertised) ? advertised : `CALLBACK_HTTP_${response.status}`;
        const hint = RESULT_ERRORS[code] ?? ({
          401: RESULT_ERRORS.RUNNER_AUTHENTICATION_REQUIRED,
          403: "The Worker refused this signed run; check the saved task, workflow identity and repository.",
          409: "The callback conflicts with the saved task or execution claim; inspect the task/run/attempt without replaying execution.",
          429: "The callback endpoint is rate limited; retry the reporting job after capacity is restored.",
          503: "The Worker could not verify or persist this result; check its GitHub credential, D1 migrations and service availability.",
        })[response.status] ?? "Check ATLAS_RESULT_URL and the Worker's result endpoint.";
        throw new ResultDeliveryError(`Result delivery failed: HTTP ${response.status}. ${hint}`, { code, status: response.status });
      }
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
    text = renderResult({ task: read(directory, "task.json"), status: read(directory, "status.json"), code: read(directory, "code.json"), inspection: read(directory, "inspect.json"), debug: read(directory, "debug.json"), conclusion: process.env.ATLAS_JOB_RESULT, budget: read(directory, "budget.json"), progress: read(directory, "progress.json"), recovery: read(directory, "recovery.json") });
  } catch { text = "The runner returned malformed result data. Open the run log; no successful outcome is inferred."; }
  const redacted = spawnSync(process.execPath, [path.resolve("packages/atlas-cli/dist/src/cli.js"), "redact"], {
    input: text, encoding: "utf8", timeout: 60000, maxBuffer: 128000, windowsHide: true,
  });
  // Never publish unscanned artifacts, including on parser/redactor failures.
  const summary = !redacted.error && redacted.status === 0 && redacted.stdout.trim()
    ? redacted.stdout.slice(0, limit)
    : "Runner finished. Result details were withheld because credential scanning failed. Open the run log.";
  const endpoint = resultEndpoint(process.env.ATLAS_RESULT_URL);
  const token = await requestRunnerIdentity(process.env);
  const correlationId = correlationIdFromEnv();
  const delivery = await deliverResult({ endpoint, token, payload: buildResultPayload({ taskId, summary, correlationId }) });
  writeDeliveryReceipt({ ...delivery, stage: "callback", ...(delivery.delivered ? { code: "DELIVERED" } : { code: "DISPATCH_NOT_FOUND" }), message: deliveryMessage(delivery, taskId, correlationId) });
  console.log(deliveryMessage(delivery, taskId, correlationId));
  // Manual maintenance callbacks remain compatible, but a granted hosted task
  // cannot turn a missing dispatch into a green reporting job.
  if (!delivery.delivered && process.env.ATLAS_CLAIM_GRANTED === "true") process.exitCode = 1;
}

function writeDeliveryReceipt(receipt) {
  // Receipts contain only fixed diagnostics and validated task ids, never tokens,
  // response bodies, endpoint URLs, or the model's unscanned summary.
  try {
    if (process.env.ATLAS_OUTPUT_DIR) {
      fs.mkdirSync(process.env.ATLAS_OUTPUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.ATLAS_OUTPUT_DIR, "delivery.json"), `${JSON.stringify({ schema_version: 1, ...receipt }, null, 2)}\n`, { mode: 0o600 });
    }
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Atlas result delivery\n\n${receipt.message}\n`, "utf8");
  } catch { console.error("Result delivery receipt could not be retained; inspect this reporting job's logs."); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const failure = deliveryFailure(error);
    writeDeliveryReceipt(failure);
    console.error(failure.message);
    process.exitCode = 1;
  });
}
