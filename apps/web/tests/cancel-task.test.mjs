import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { cancelHostedTask, cancellableRun } from "../app/api/tasks/cancel-task.mjs";
import { migratedDatabase } from "./helpers/d1-sqlite.mjs";
import { authenticatedAccount } from "../app/api/tasks/operator-auth.mjs";
import { resolveTenantContext } from "../app/api/auth/tenant-context.mjs";

const taskId = "11111111-1111-4111-8111-111111111111";
function fixture(t) {
  const { sqlite, d1 } = migratedDatabase();
  t.after(() => sqlite.close());
  sqlite.prepare("INSERT INTO conversations (id, tenant_id, requested_by, title, repository, branch) VALUES ('conversation', 1, 'operator', 'task', 'owner/repo', 'main')").run();
  sqlite.prepare("INSERT INTO tasks (task_id, tenant_id, requested_by, repository, branch, mode, objective, conversation_id, github_run_id) VALUES (?, 1, 'operator', 'owner/repo', 'main', 'coder', 'Fix tests', 'conversation', 123)").run(taskId);
  const run = { id: 123, run_attempt: 1, repository: { full_name: "owner/repo" }, event: "workflow_dispatch", head_branch: "main", path: ".github/workflows/atlas-coder.yml", name: "Atlas coder", display_title: `Atlas coder — task ${taskId}`, status: "in_progress", conclusion: null };
  const calls = [];
  const deps = {
    authenticate: request => authenticatedAccount(request, { ATLAS_OPERATOR_TOKEN: "operator-test" }),
    tenantContext: resolveTenantContext,
    database: () => d1,
    githubToken: async () => "github-test-secret",
    environment: {},
    fetcher: async (url, options) => {
      calls.push({ url, options });
      if (options.redirect !== undefined) assert.equal(options.redirect, "manual");
      assert.equal(options.headers.authorization, "Bearer github-test-secret");
      assert.ok(options.signal);
      if (options.method === "POST") {
        assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM run_events WHERE id LIKE '%:requested'").get().n, 1, "audit precedes cancellation");
        return new Response(null, { status: 202 });
      }
      return Response.json(url.includes("?event=") ? { workflow_runs: [run] } : run);
    },
  };
  const request = (headers = {}) => new Request(`https://atlas.test/api/tasks/${taskId}/cancel`, { method: "POST", headers: { authorization: "Bearer operator-test", ...headers } });
  const invoke = () => cancelHostedTask(request(), taskId, deps);
  return { sqlite, d1, deps, request, invoke, run, calls };
}

test("authenticated cancellation persists intent and acceptance; restart/retry does not resend", async t => {
  const f = fixture(t);
  for (let i = 0; i < 2; i++) {
    const response = await f.invoke(); assert.equal(response.status, 202);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { taskId, runId: 123, status: "cancellation-requested" });
  }
  assert.equal(f.calls.filter(call => call.options.method === "POST").length, 1);
  for (const call of f.calls) assert.equal(call.options.redirect, "manual", "cancellation never follows redirects");
  assert.equal(f.calls.at(-2).url, "https://api.github.com/repos/owner/repo/actions/runs/123/cancel");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM run_events").get().n, 2);
  f.run.run_attempt = 2;
  assert.equal((await f.invoke()).status, 202);
  assert.equal(f.calls.filter(call => call.options.method === "POST").length, 2, "a new attempt has its own receipt");
});

test("unauthenticated, cross-origin, non-member, other-tenant and other-principal calls never touch GitHub", async t => {
  const f = fixture(t);
  assert.equal((await cancelHostedTask(f.request({ authorization: "Bearer wrong" }), taskId, f.deps)).status, 401);
  assert.equal((await cancelHostedTask(f.request({ origin: "https://evil.test" }), taskId, f.deps)).status, 403);
  assert.equal((await cancelHostedTask(f.request({ "sec-fetch-site": "cross-site" }), taskId, f.deps)).status, 403);
  const authenticate = f.deps.authenticate;
  f.sqlite.prepare("INSERT INTO users (id, github_user_id, github_login) VALUES (99, 999, 'other')").run();
  f.sqlite.prepare("INSERT INTO tenant_members (tenant_id, user_id, role) VALUES (1, 99, 'member')").run();
  f.deps.authenticate = async () => ({ userId: "github:other", dbUserId: 99 });
  assert.equal((await cancelHostedTask(f.request({ "x-atlas-tenant": "999" }), taskId, f.deps)).status, 403);
  f.deps.authenticate = authenticate;
  f.sqlite.prepare("INSERT INTO tenants (id, slug, name, kind, owner_principal) VALUES (2, 'other', 'Other', 'personal', 'github:other')").run();
  f.sqlite.prepare("UPDATE tasks SET tenant_id = 2").run();
  assert.equal((await f.invoke()).status, 404);
  f.sqlite.prepare("UPDATE tasks SET tenant_id = 1, requested_by = 'github:other'").run();
  assert.equal((await f.invoke()).status, 404);
  assert.equal(f.calls.length, 0);
});

test("stored heuristic IDs, wrong workflow/repo/branch/event, and manual runs cannot authorize cancellation", async t => {
  const f = fixture(t);
  for (const change of [{ id: 124 }, { display_title: "Manual run" }, { display_title: `task 22222222-2222-4222-8222-222222222222` }, { repository: { full_name: "other/repo" } }, { path: ".github/workflows/other.yml" }, { head_branch: "feature" }, { event: "push" }, { run_attempt: 0 }]) {
    const original = { ...f.run }; Object.assign(f.run, change);
    assert.equal((await f.invoke()).status, 409);
    Object.assign(f.run, original);
  }
  assert.equal(f.calls.filter(call => call.options.method === "POST").length, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM run_events").get().n, 0);
});

test("unresolved task discovers only one exact named run; ambiguous discovery is refused", async t => {
  const f = fixture(t);
  f.sqlite.prepare("UPDATE tasks SET github_run_id = NULL").run();
  assert.equal((await f.invoke()).status, 202);
  assert.match(f.calls[0].url, /workflows\/atlas-coder.yml\/runs\?event=workflow_dispatch&per_page=100$/);
  f.deps.fetcher = async () => Response.json({ workflow_runs: [f.run, { ...f.run, id: 124 }] });
  assert.equal((await f.invoke()).status, 409);
  f.deps.fetcher = async () => Response.json({ workflow_runs: [] });
  assert.equal((await f.invoke()).status, 409);
});

test("completed and private runs do not send cancellation; unavailable credentials fail closed", async t => {
  const f = fixture(t);
  f.run.status = "completed"; f.run.conclusion = "success";
  assert.deepEqual(await (await f.invoke()).json(), { taskId, runId: 123, status: "completed", conclusion: "success" });
  assert.equal(f.calls.filter(call => call.options.method === "POST").length, 0);
  f.sqlite.prepare("UPDATE tasks SET execution_provider = 'private'").run();
  assert.equal((await f.invoke()).status, 409);
  f.sqlite.prepare("UPDATE tasks SET execution_provider = 'managed'").run();
  f.deps.githubToken = async () => undefined;
  assert.equal((await f.invoke()).status, 503);
});

test("audit failure or a conversation outside the tenant prevents the external action", async t => {
  const f = fixture(t);
  f.sqlite.prepare("UPDATE conversations SET requested_by = 'github:other'").run();
  assert.equal((await f.invoke()).status, 503);
  assert.equal(f.calls.filter(call => call.options.method === "POST").length, 0);
  f.sqlite.exec("DROP TABLE run_events");
  assert.equal((await f.invoke()).status, 503);
  assert.equal(f.calls.filter(call => call.options.method === "POST").length, 0);
});

test("lost cancellation acknowledgement is durable, redacted and retryable without claiming stopped", async t => {
  const f = fixture(t); const fetcher = f.deps.fetcher;
  f.deps.fetcher = async (url, options) => { if (options.method === "POST") throw new Error("github-test-secret"); return fetcher(url, options); };
  const response = await f.invoke(); assert.equal(response.status, 202);
  const text = await response.text(); assert.match(text, /cancellation-unknown/); assert.doesNotMatch(text, /github-test-secret|cancelled/);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM run_events").get().n, 1);
  f.deps.fetcher = fetcher;
  assert.equal((await f.invoke()).status, 202);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM run_events").get().n, 2);
});

test("provider refusals and racing completion do not fabricate a successful cancellation", async t => {
  const f = fixture(t); const fetcher = f.deps.fetcher;
  for (const status of [401, 403, 409, 500]) {
    f.deps.fetcher = (url, options) => options.method === "POST" ? Promise.resolve(new Response("github-test-secret", { status })) : fetcher(url, options);
    const response = await f.invoke(); assert.equal(response.status, status === 409 || status === 500 ? 202 : 502);
    const text = await response.text(); assert.match(text, /cancellation-unknown/); assert.doesNotMatch(text, /github-test-secret/);
  }
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM run_events WHERE id LIKE '%:accepted'").get().n, 0);
});

test("acceptance receipt failure reports uncertainty after the action without losing intent", async t => {
  const f = fixture(t);
  const wrap = statement => ({ ...statement, bind: (...values) => {
    const bound = statement.bind(...values);
    return values[0]?.endsWith?.(":accepted") ? { ...bound, run: async () => { throw new Error("private storage diagnostic"); } } : bound;
  } });
  f.deps.database = () => ({ prepare: sql => sql.startsWith("INSERT INTO run_events") ? wrap(f.d1.prepare(sql)) : f.d1.prepare(sql) });
  const response = await f.invoke(); assert.equal(response.status, 202);
  const text = await response.text(); assert.match(text, /cancellation-unknown/); assert.doesNotMatch(text, /private storage diagnostic/);
  assert.equal(f.calls.filter(call => call.options.method === "POST").length, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM run_events").get().n, 1);
});

test("workflow numeric overrides verify the run's workflow id", () => {
  const task = { taskId, repository: "owner/repo" };
  const run = { id: 1, run_attempt: 1, workflow_id: 99, repository: { full_name: "owner/repo" }, event: "workflow_dispatch", head_branch: "main", display_title: `task ${taskId}` };
  assert.equal(cancellableRun(run, task, "99"), true);
  assert.equal(cancellableRun(run, task, "100"), false);
});

test("built HTTP route uses authenticated tenant-scoped D1 and persists retry-safe cancellation", async t => {
  const f = fixture(t);
  register(`data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = globalThis.__cancelRouteEnv; export class DurableObject {}", shortCircuit: true };
      return next(specifier, context);
    }
  `)}`, import.meta.url);
  globalThis.__cancelRouteEnv = { DB: f.d1 };
  const previous = { token: process.env.ATLAS_OPERATOR_TOKEN, github: process.env.ATLAS_GITHUB_TOKEN, fetch: globalThis.fetch };
  process.env.ATLAS_OPERATOR_TOKEN = "operator-test";
  process.env.ATLAS_GITHUB_TOKEN = "github-test-secret";
  globalThis.fetch = f.deps.fetcher;
  t.after(() => {
    globalThis.fetch = previous.fetch; delete globalThis.__cancelRouteEnv;
    for (const [key, value] of [["ATLAS_OPERATOR_TOKEN", previous.token], ["ATLAS_GITHUB_TOKEN", previous.github]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url));
  const invoke = headers => worker.fetch(f.request(headers), globalThis.__cancelRouteEnv, { waitUntil() {}, passThroughOnException() {} });
  assert.equal((await invoke({ authorization: "Bearer wrong" })).status, 401);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await invoke({ origin: "https://atlas.test" });
    assert.equal(response.status, 202); assert.equal((await response.json()).status, "cancellation-requested");
  }
  assert.equal(f.calls.filter(call => call.options.method === "POST").length, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM run_events").get().n, 2);
  f.run.status = "completed"; f.run.conclusion = "cancelled";
  const progress = await worker.fetch(new Request(`https://atlas.test/api/tasks/${taskId}/activity`, { headers: { authorization: "Bearer operator-test" } }), globalThis.__cancelRouteEnv, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(progress.status, 200);
  const activity = await progress.json(); assert.equal(activity.status, "completed"); assert.equal(activity.conclusion, "cancelled");
  f.sqlite.prepare("UPDATE tasks SET requested_by = 'github:other'").run();
  assert.equal((await invoke()).status, 404);
});
