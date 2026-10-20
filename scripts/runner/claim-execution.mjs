import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLAIM_AUDIENCE = "atlas-task-execution";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function checkExecutionLease(env, now = Date.now()) {
  const minutes = Number(env.ATLAS_JOB_TIMEOUT_MINUTES);
  const expiresAt = env.ATLAS_CLAIM_EXPIRES_AT;
  const deadline = Date.parse(expiresAt);
  if (env.ATLAS_CLAIM_GRANTED !== "true" || !uuid.test(env.ATLAS_TASK_ID ?? "")
    || env.ATLAS_CLAIM_RUN_ID !== env.GITHUB_RUN_ID || env.ATLAS_CLAIM_RUN_ATTEMPT !== env.GITHUB_RUN_ATTEMPT
    || ![env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT].every(value => /^\d+$/u.test(value ?? "") && Number.isSafeInteger(Number(value)) && Number(value) > 0)
    || !timestamp.test(expiresAt ?? "") || !Number.isInteger(minutes) || minutes < 1 || minutes > 330
    || !Number.isFinite(deadline) || !Number.isFinite(now)
    || deadline <= now + minutes * 60000 + 60000) throw new Error("Execution claim does not cover this job's bounded lifetime");
  return true;
}

export function executionClaimPayload(env) {
  if (!uuid.test(env.ATLAS_TASK_ID ?? "") || !/^cor_[0-9a-f]{32}$/u.test(env.ATLAS_CORRELATION_ID ?? "")) throw new Error("A saved Atlas task is required");
  return { taskId: env.ATLAS_TASK_ID, repository: env.ATLAS_REPOSITORY, branch: env.ATLAS_BRANCH, mode: env.ATLAS_MODE,
    objective: env.ATLAS_OBJECTIVE, mergePolicy: env.ATLAS_MODE === "coder" ? env.ATLAS_MERGE_POLICY : "manual", correlationId: env.ATLAS_CORRELATION_ID };
}

export function enforceHostedExecutionLease(env) {
  const hosted = env.GITHUB_ACTIONS === "true" && (["Atlas Coder", "Atlas Runner"].includes(env.GITHUB_WORKFLOW)
    || /\/\.github\/workflows\/atlas-(coder|runner)\.yml@/u.test(env.GITHUB_WORKFLOW_REF ?? ""));
  return hosted ? checkExecutionLease(env) : true;
}

export async function requestExecutionClaim(env, fetcher = fetch) {
  const payload = executionClaimPayload(env);
  const endpoint = new URL(env.ATLAS_CLAIM_URL || new URL("/api/tasks/claim", env.ATLAS_RESULT_URL || "https://atlas-web.cornerstonemarketingus.workers.dev"));
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/api/tasks/claim") throw new Error("Invalid claim endpoint");
  const identityUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (identityUrl.protocol !== "https:" || identityUrl.username || identityUrl.password || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error("Trusted runner identity unavailable");
  identityUrl.searchParams.set("audience", CLAIM_AUDIENCE);
  const identity = await fetcher(identityUrl, { redirect: "error", signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
  if (!identity.ok) throw new Error("Trusted runner identity unavailable");
  const { value: token } = await identity.json();
  if (typeof token !== "string" || !token || token.length > 15993) throw new Error("Trusted runner identity unavailable");
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetcher(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload) });
    } catch { if (attempt === 2) throw new Error("Execution claim transport unavailable"); }
    if (response?.ok) {
      const grant = await response.json();
      if (grant?.granted !== true || grant.taskId !== payload.taskId || String(grant.runId) !== env.GITHUB_RUN_ID
        || String(grant.runAttempt) !== env.GITHUB_RUN_ATTEMPT || !timestamp.test(grant.expiresAt ?? "") || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()) throw new Error("Execution claim acknowledgement invalid");
      return grant;
    }
    if (response) {
      const status = response.status;
      try { await response.body?.cancel(); } catch { /* private response bodies are not logged */ }
      if (status < 500 || attempt === 2) throw new Error("Execution claim refused or unavailable");
    }
    await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
  }
}

async function main() {
  if (process.argv[2] === "check") { checkExecutionLease(process.env); console.log("Execution claim covers the bounded job."); return; }
  const grant = await requestExecutionClaim(process.env);
  if (!process.env.GITHUB_OUTPUT) throw new Error("Claim job output unavailable");
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `granted=true\nexpires_at=${grant.expiresAt}\nrun_id=${grant.runId}\nrun_attempt=${grant.runAttempt}\n`, { encoding: "utf8" });
  console.log("Cloud execution claim confirmed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Atlas execution claim failed. No coding execution is authorized."); process.exitCode = 1; });
}
