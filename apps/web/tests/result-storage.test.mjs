import test from "node:test";
import assert from "node:assert/strict";
import { migratedDatabase } from "./helpers/d1-sqlite.mjs";
import { dispatchSavedTask } from "../app/api/tasks/durable-dispatch.mjs";
import { grantTaskExecution } from "../app/api/tasks/execution-claims.mjs";
import { saveRunnerResult } from "../app/api/tasks/result-storage.mjs";

const taskId = "11111111-1111-4111-8111-111111111111";
const identity = { run_id: "123", run_attempt: "1" };
async function fixture(t) {
  const f = migratedDatabase(); t.after(() => f.sqlite.close());
  const task = { taskId, tenantId: 1, requestedBy: "operator", repository: "cornerstonemarketingus/atlas", branch: "feature", mode: "coder", objective: "Fix tests", mergePolicy: "manual", correlationId: `cor_${"a".repeat(32)}`, conversationId: "conversation", executionProvider: "managed", dispatchState: "dispatched", githubRunId: null };
  await dispatchSavedTask(f.d1, { ...task, account: { userId: "operator", dbUserId: null }, task }, async () => new Response(null, { status: 204 }));
  return { ...f, task };
}
const counts = f => ["run_events", "conversation_messages"].map(table => f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id LIKE 'result:%'`).get().n);

test("claimed owner can deliver late and replay without duplicate results or lease changes", async t => {
  const f = await fixture(t);
  assert.ok(await grantTaskExecution(f.d1, f.task, identity, new Date("2026-01-01T00:00:00Z")));
  const before = f.sqlite.prepare("SELECT * FROM task_execution_claims").get();
  assert.equal(await saveRunnerResult(f.d1, f.task, identity, "Tests failed"), true);
  assert.equal(await saveRunnerResult(f.d1, f.task, identity, "replacement"), true);
  assert.deepEqual(counts(f), [1, 1]);
  assert.equal(f.sqlite.prepare("SELECT content FROM conversation_messages WHERE id LIKE 'result:%'").get().content, "Tests failed");
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM task_execution_claims").get(), before);
});

test("unclaimed dispatch and different run or attempt cannot write a result", async t => {
  const f = await fixture(t);
  assert.equal(await saveRunnerResult(f.d1, f.task, identity, "unclaimed"), false);
  await grantTaskExecution(f.d1, f.task, identity);
  for (const changed of [{ run_id: "124" }, { run_attempt: "2" }]) assert.equal(await saveRunnerResult(f.d1, f.task, { ...identity, ...changed }, "forged"), false);
  assert.deepEqual(counts(f), [0, 0]);
});

test("tenant, principal, conversation and snapshot races fail closed in transaction", async t => {
  const f = await fixture(t); await grantTaskExecution(f.d1, f.task, identity);
  for (const changed of [{ tenantId: 2 }, { requestedBy: "foreign" }, { conversationId: "foreign" }, { correlationId: null }, { mode: "debug" }, { dispatchState: "legacy" }]) assert.equal(await saveRunnerResult(f.d1, { ...f.task, ...changed }, identity, "forged"), false);
  f.sqlite.exec("INSERT INTO tenants (id, slug, name, owner_principal) VALUES (2, 'other', 'Other', 'foreign'); UPDATE conversations SET tenant_id = 2");
  assert.equal(await saveRunnerResult(f.d1, f.task, identity, "foreign conversation"), false);
  assert.deepEqual(counts(f), [0, 0]);
});

test("legacy compatibility never overrides an existing claim", async t => {
  const f = await fixture(t); f.sqlite.exec("UPDATE tasks SET dispatch_state = 'legacy'"); f.task.dispatchState = "legacy";
  assert.equal(await saveRunnerResult(f.d1, f.task, identity, "legacy"), true);
  f.sqlite.prepare("INSERT INTO task_execution_claims VALUES (?, 1, 'operator', 123, 2, 'past', 'past')").run(taskId);
  assert.equal(await saveRunnerResult(f.d1, f.task, identity, "wrong attempt"), false);
  assert.deepEqual(counts(f), [1, 1]);
});

test("storage failure rolls back messages, audit and run linkage; missing migration refuses", async t => {
  const f = await fixture(t); await grantTaskExecution(f.d1, f.task, identity);
  f.sqlite.exec("CREATE TRIGGER fail_result BEFORE INSERT ON conversation_messages BEGIN SELECT RAISE(ABORT, 'private error'); END");
  await assert.rejects(saveRunnerResult(f.d1, f.task, identity, "rollback"));
  assert.deepEqual(counts(f), [0, 0]);
  f.sqlite.exec("DROP TABLE task_execution_claims");
  await assert.rejects(saveRunnerResult(f.d1, f.task, identity, "missing migration"));
  assert.deepEqual(counts(f), [0, 0]);
});

test("built Worker result callback enforces claim ownership after signed run verification", async t => {
  const { register } = await import("node:module");
  const { generateKeyPair, SignJWT, exportJWK } = await import("jose");
  const f = await fixture(t); const pair = await generateKeyPair("RS256"); const jwk = await exportJWK(pair.publicKey); jwk.kid = "result-owner";
  const claims = { ...identity, repository: f.task.repository, repository_id: "1337761549", workflow_ref: `${f.task.repository}/.github/workflows/atlas-coder.yml@refs/heads/main`, ref: "refs/heads/main", event_name: "workflow_dispatch" };
  const sign = (values = claims) => new SignJWT(values).setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setIssuer("https://token.actions.githubusercontent.com").setAudience("atlas-runner-results").setIssuedAt().setExpirationTime("5m").sign(pair.privateKey);
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = globalThis.__resultEnv; export class DurableObject {}", shortCircuit: true };
    return next(specifier, context);
  }`)}`, import.meta.url);
  globalThis.__resultEnv = { DB: f.d1 };
  const originalFetch = globalThis.fetch; const previousToken = process.env.ATLAS_GITHUB_TOKEN; process.env.ATLAS_GITHUB_TOKEN = "fake-result-token";
  let attempt = 1;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/.well-known/jwks")) return Response.json({ keys: [jwk] });
    assert.equal(options.redirect, "error");
    return Response.json({ id: 123, run_attempt: attempt, event: "workflow_dispatch", head_branch: "main", path: ".github/workflows/atlas-coder.yml", display_title: `Atlas Coder · task ${taskId}` });
  };
  t.after(() => { globalThis.fetch = originalFetch; delete globalThis.__resultEnv; if (previousToken === undefined) delete process.env.ATLAS_GITHUB_TOKEN; else process.env.ATLAS_GITHUB_TOKEN = previousToken; });
  const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url));
  const invoke = token => worker.fetch(new Request("https://atlas.test/api/tasks/result", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ taskId, summary: "Reported tests failed", correlationId: f.task.correlationId }) }), globalThis.__resultEnv, { waitUntil() {}, passThroughOnException() {} });
  assert.equal((await invoke("forged")).status, 401);
  assert.equal((await invoke(await sign())).status, 409);
  assert.deepEqual(counts(f), [0, 0]);
  await grantTaskExecution(f.d1, f.task, identity);
  assert.equal((await invoke(await sign({ ...claims, repository_id: "999" }))).status, 403);
  assert.equal((await invoke(await sign())).status, 200);
  assert.equal((await invoke(await sign())).status, 200);
  attempt = 2;
  assert.equal((await invoke(await sign({ ...claims, run_attempt: "2" }))).status, 409);
  assert.deepEqual(counts(f), [1, 1]);
  f.sqlite.exec("DROP TABLE task_execution_claims"); attempt = 1;
  const unavailable = await invoke(await sign());
  assert.equal(unavailable.status, 503); assert.doesNotMatch(await unavailable.text(), /SQL|no such table|fake-result-token/);
});

