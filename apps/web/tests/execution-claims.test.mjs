import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { generateKeyPair, SignJWT, exportJWK } from "jose";
import { migratedDatabase } from "./helpers/d1-sqlite.mjs";
import { dispatchSavedTask } from "../app/api/tasks/durable-dispatch.mjs";
import { CLAIM_AUDIENCE, EXECUTOR_REPOSITORY_ID, CLAIM_LEASE_MS, verifyClaimIdentity, validateExecutionClaim, claimMatchesTask, claimRunMatches, grantTaskExecution } from "../app/api/tasks/execution-claims.mjs";
import { verifyRunnerIdentity } from "../app/api/tasks/runner-result.mjs";
import { inspectTaskRequest } from "../app/api/tasks/request-inspection.mjs";

const taskId = "11111111-1111-4111-8111-111111111111";
const correlationId = `cor_${"a".repeat(32)}`;
const body = { taskId, repository: "cornerstonemarketingus/atlas", branch: "feature", mode: "coder", objective: "Fix package.json tests", mergePolicy: "manual", correlationId };
const identity = { repository: body.repository, repository_id: EXECUTOR_REPOSITORY_ID, workflow_ref: `${body.repository}/.github/workflows/atlas-coder.yml@refs/heads/main`, ref: "refs/heads/main", event_name: "workflow_dispatch", run_id: "123", run_attempt: "1" };
const run = { id: 123, run_attempt: 1, repository: { id: Number(EXECUTOR_REPOSITORY_ID), full_name: body.repository }, event: "workflow_dispatch", head_branch: "main", path: ".github/workflows/atlas-coder.yml", display_title: `Atlas Coder · task ${taskId}`, status: "in_progress" };
async function fixture(t) {
  const f = migratedDatabase(); t.after(() => f.sqlite.close());
  await dispatchSavedTask(f.d1, { taskId, tenantId: 1, account: { userId: "operator", dbUserId: null }, task: body, mergePolicy: "manual", conversationId: "conversation", executionProvider: "managed", correlationId }, async () => new Response(null, { status: 204 }));
  const task = { ...body, tenantId: 1, requestedBy: "operator", conversationId: "conversation", executionProvider: "managed", dispatchState: "dispatched", githubRunId: null };
  return { ...f, task };
}

test("claim signatures require dedicated audience, expiry, immutable repository and trusted main workflow", async () => {
  const pair = await generateKeyPair("RS256"); const other = await generateKeyPair("RS256");
  const sign = (claims = identity, audience = CLAIM_AUDIENCE, expires = "5m", privateKey = pair.privateKey) => {
    let jwt = new SignJWT(claims).setProtectedHeader({ alg: "RS256" }).setIssuer("https://token.actions.githubusercontent.com").setAudience(audience).setIssuedAt();
    if (expires) jwt = jwt.setExpirationTime(expires);
    return jwt.sign(privateKey);
  };
  assert.equal((await verifyClaimIdentity(await sign(), pair.publicKey)).run_id, "123");
  await assert.rejects(verifyRunnerIdentity(await sign(), pair.publicKey));
  for (const claims of [{ ...identity, repository_id: "999" }, { ...identity, ref: "refs/heads/feature" }, { ...identity, event_name: "pull_request" }, { ...identity, workflow_ref: identity.workflow_ref.replace("atlas-coder", "ci") }, { ...identity, run_id: "9007199254740992" }]) await assert.rejects(verifyClaimIdentity(await sign(claims), pair.publicKey));
  await assert.rejects(verifyClaimIdentity(await sign(identity, "atlas-runner-results"), pair.publicKey));
  await assert.rejects(verifyClaimIdentity(await sign(identity, CLAIM_AUDIENCE, "-1s"), pair.publicKey));
  await assert.rejects(verifyClaimIdentity(await sign(identity, CLAIM_AUDIENCE, null), pair.publicKey));
  await assert.rejects(verifyClaimIdentity(await sign(identity, CLAIM_AUDIENCE, "5m", other.privateKey), pair.publicKey));
});

test("claim payload and live run must exactly match saved objective, workflow, run and attempt", async t => {
  const f = await fixture(t);
  assert.deepEqual(validateExecutionClaim({ ...body, tenantId: 999, requestedBy: "other" }), body);
  assert.equal(Boolean(claimMatchesTask(body, f.task)), true); assert.equal(claimRunMatches(identity, f.task, run), true);
  for (const changed of [{ branch: "other" }, { objective: "different" }, { mergePolicy: "ci-gated" }, { correlationId: `cor_${"b".repeat(32)}` }, { executionProvider: "private" }, { dispatchState: "recorded" }]) assert.equal(Boolean(claimMatchesTask(body, { ...f.task, ...changed })), false);
  for (const changed of [{ id: 124 }, { run_attempt: 2 }, { repository: { id: 999, full_name: body.repository } }, { head_branch: "feature" }, { path: ".github/workflows/ci.yml" }, { display_title: "Manual job" }, { status: "completed" }]) assert.equal(claimRunMatches(identity, f.task, { ...run, ...changed }), false);
  for (const changed of [{ taskId: "manual-task" }, { objective: "x".repeat(4097) }, { correlationId: null }, { mode: "shell" }]) assert.throws(() => validateExecutionClaim({ ...body, ...changed }));
});

test("one atomic claim pins the run and audit; acknowledgement replay does not extend its lease", async t => {
  const f = await fixture(t); const now = new Date("2026-10-11T00:00:00.000Z");
  const first = await grantTaskExecution(f.d1, f.task, identity, now);
  assert.equal(first.granted, true); assert.equal(first.replayed, false);
  assert.equal(Date.parse(first.expiresAt) - now.getTime(), CLAIM_LEASE_MS);
  const second = await grantTaskExecution(f.d1, f.task, identity, new Date(now.getTime() + 1000));
  assert.equal(second.replayed, true); assert.equal(second.expiresAt, first.expiresAt);
  assert.equal(f.sqlite.prepare("SELECT github_run_id FROM tasks").get().github_run_id, 123);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM run_events WHERE id = ?").get(`execution-claim:${taskId}`).n, 1);
});

test("competing runs and attempts cannot steal ownership, including after expiry", async t => {
  const f = await fixture(t); let pending = Promise.resolve();
  const d1 = { ...f.d1, batch: statements => { const operation = pending.then(() => f.d1.batch(statements)); pending = operation.catch(() => {}); return operation; } };
  const now = new Date("2026-10-11T00:00:00.000Z");
  const grants = await Promise.all([grantTaskExecution(d1, f.task, identity, now), grantTaskExecution(d1, f.task, { ...identity, run_id: "124" }, now)]);
  assert.equal(grants.filter(Boolean).length, 1);
  const before = f.sqlite.prepare("SELECT * FROM task_execution_claims").get();
  assert.equal(await grantTaskExecution(d1, f.task, { ...identity, run_attempt: "2" }, now), null);
  assert.equal(await grantTaskExecution(d1, f.task, identity, new Date(now.getTime() + CLAIM_LEASE_MS + 1)), null);
  assert.equal(await grantTaskExecution(d1, f.task, { ...identity, run_id: "125" }, new Date(now.getTime() + CLAIM_LEASE_MS + 1)), null);
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM task_execution_claims").get(), before);
});

test("claim and audit rollback together; changed tenant, principal or task snapshot cannot grant execution", async t => {
  const f = await fixture(t);
  for (const changes of [{ tenantId: 2 }, { requestedBy: "other" }, { objective: "changed" }]) assert.equal(await grantTaskExecution(f.d1, { ...f.task, ...changes }, identity), null);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM task_execution_claims").get().n, 0);
  f.sqlite.exec("CREATE TRIGGER fail_claim_audit BEFORE INSERT ON run_events WHEN NEW.kind = 'execution' BEGIN SELECT RAISE(ABORT, 'private storage error'); END");
  await assert.rejects(grantTaskExecution(f.d1, f.task, identity));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM task_execution_claims").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT github_run_id FROM tasks").get().github_run_id, null);
});

test("claim replay refuses changed task policy and foreign conversation ownership", async t => {
  const f = await fixture(t);
  assert.ok(await grantTaskExecution(f.d1, f.task, identity));
  const before = f.sqlite.prepare("SELECT * FROM task_execution_claims").get();
  f.sqlite.exec("UPDATE tasks SET merge_policy = 'none'");
  assert.equal(await grantTaskExecution(f.d1, f.task, identity), null);
  f.sqlite.exec("UPDATE tasks SET merge_policy = 'manual'; UPDATE conversations SET requested_by = 'other'");
  assert.equal(await grantTaskExecution(f.d1, f.task, identity), null);
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM task_execution_claims").get(), before);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM run_events WHERE kind = 'execution'").get().n, 1);
});

test("mobile inspection exposes scoped lease evidence without treating expiry as completion", async t => {
  const f = await fixture(t);
  f.sqlite.prepare("INSERT INTO task_requests (tenant_id, requested_by, request_key, fingerprint, correlation_id) VALUES (1, 'operator', ?, ?, ?)").run(taskId, "b".repeat(64), correlationId);
  await grantTaskExecution(f.d1, f.task, identity);
  const detail = await inspectTaskRequest(f.d1, { tenantId: 1, principal: "operator" }, taskId);
  assert.equal(detail.task.execution.runId, 123); assert.equal(detail.task.execution.runAttempt, 1); assert.ok(detail.task.execution.expiresAt);
  f.sqlite.exec("UPDATE task_execution_claims SET requested_by = 'other'");
  assert.equal((await inspectTaskRequest(f.d1, { tenantId: 1, principal: "operator" }, taskId)).task.execution, null);
});

test("built Worker verifies real signed claim identity, exact run metadata and duplicate refusal", async t => {
  const f = await fixture(t); const pair = await generateKeyPair("RS256"); const jwk = await exportJWK(pair.publicKey); jwk.kid = "claim-test";
  const sign = (claims = identity, audience = CLAIM_AUDIENCE) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setIssuer("https://token.actions.githubusercontent.com").setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(pair.privateKey);
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = globalThis.__claimsEnv; export class DurableObject {}", shortCircuit: true };
    return next(specifier, context);
  }`)}`, import.meta.url);
  globalThis.__claimsEnv = { DB: f.d1 };
  const originalFetch = globalThis.fetch; const previousToken = process.env.ATLAS_GITHUB_TOKEN; process.env.ATLAS_GITHUB_TOKEN = "github-test";
  let liveRun = run;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/.well-known/jwks")) return Response.json({ keys: [jwk] });
    assert.equal(options.redirect, "error"); assert.equal(options.headers.authorization, "Bearer github-test");
    return Response.json(liveRun);
  };
  t.after(() => { globalThis.fetch = originalFetch; delete globalThis.__claimsEnv; if (previousToken === undefined) delete process.env.ATLAS_GITHUB_TOKEN; else process.env.ATLAS_GITHUB_TOKEN = previousToken; });
  const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url));
  const invoke = (token, payload = body) => worker.fetch(new Request("https://atlas.test/api/tasks/claim", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload) }), globalThis.__claimsEnv, { waitUntil() {}, passThroughOnException() {} });
  assert.equal((await invoke("forged")).status, 401);
  assert.equal((await invoke(await sign(identity, "atlas-runner-results"))).status, 401);
  assert.equal((await invoke(await sign(), { ...body, objective: "different" })).status, 403);
  liveRun = { ...run, repository: { ...run.repository, id: 999 } };
  assert.equal((await invoke(await sign())).status, 403); liveRun = run;
  const response = await invoke(await sign()); assert.equal(response.status, 200, await response.clone().text()); assert.equal(response.headers.get("cache-control"), "no-store");
  const grant = await response.json(); assert.equal(grant.granted, true); assert.equal(grant.runId, 123); assert.doesNotMatch(JSON.stringify(grant), /github-test|operator/);
  assert.equal((await (await invoke(await sign())).json()).replayed, true);
  liveRun = { ...run, run_attempt: 2 };
  assert.equal((await invoke(await sign({ ...identity, run_attempt: "2" }))).status, 409);
  liveRun = run;
  f.sqlite.exec("DROP TABLE task_execution_claims");
  const missing = await invoke(await sign()); assert.equal(missing.status, 503); assert.doesNotMatch(await missing.text(), /SQL|no such table/);
});
