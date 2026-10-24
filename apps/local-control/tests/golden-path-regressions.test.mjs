/**
 * Focused regression tests for the Atlas bugs the autonomous golden-path
 * acceptance test (autonomous-golden-path.test.mjs) found. Each test names the
 * bug it pins down.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentSessionStore } from "../src/agent/session-store.mjs";
import { AgentRuntime } from "../src/agent/runtime.mjs";
import { createLocalExecutor } from "../src/agent/executors.mjs";
import { createIndependentVerifier, detectTestCommand, npmInvocation, verifyCoderResult } from "../src/agent/independent-verifier.mjs";
import { checkLocalRepository } from "../src/agent/repository-check.mjs";
import { resolveCoderOllamaUrl } from "../src/agent/models/coder-endpoint.mjs";
import { loadPlaywright } from "../src/agent/browser/load-playwright.mjs";
import { registerBrowserTools } from "../src/agent/tools/browser-tools.mjs";
import { APPROVED_TEST_COMMANDS } from "../src/agent/tools/repository-write-tools.mjs";
import { ToolRegistry } from "../src/agent/tool-registry.mjs";
import { createModelClient } from "../src/agent/model-client.mjs";

async function temporary(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function runtimeWith(t, executors, options = {}) {
  const directory = await temporary(t, "atlas-regression-");
  const sessions = new AgentSessionStore(join(directory, "agent.sqlite"));
  const runtime = new AgentRuntime({ sessions, executors, ...options });
  t.after(async () => { await runtime.stop(); sessions.close(); });
  return { runtime, sessions, directory };
}

const okCoder = (calls = []) => async (task) => { calls.push(task); return { ok: true, message: "Status: completed\nVerification: verified", worktree: "/w", patch: "/w.patch", patchBytes: 10 }; };
const receipt = (status, exitCode) => async () => ({ verifier: "atlas-verifier", status, command: status === "unverified" ? null : "npm test", exitCode, outputExcerpt: exitCode === 0 ? "# pass 1\n# fail 0" : "# pass 0\n# fail 1", cwd: "/w", reason: status === "verified" ? "`npm test` passed (exit 0)." : status === "failed" ? "`npm test` failed (exit 1)." : "The repository declares no test command." });

// Bug: the coder exits 0 whenever its agent finished, even when its own report
// says "Verification: regressed", and the local executor reported that as
// "Local run verified." A claimed fix whose tests still failed was "completed".
test("a coder run is completed only when Atlas's own re-run of the tests passes", async (t) => {
  for (const [status, exitCode, expected, summary] of [
    ["verified", 0, "completed", /Verified by Atlas/u],
    ["failed", 1, "failed", /Verification failed: `npm test` failed \(exit 1\)/u],
    ["unverified", null, "failed", /Unverified/u],
  ]) {
    const { runtime } = await runtimeWith(t, { local: createLocalExecutor({ runCoder: okCoder(), dataDirectory: "/tmp", verify: receipt(status, exitCode) }) });
    const session = runtime.createSession({ title: status, repository: "/tmp/repo", model: "m" });
    runtime.submitTurn(session.id, { text: "Fix the failing test." });
    await runtime.drain();
    const done = runtime.getSession(session.id);
    assert.equal(done.status, expected, `${status}: ${done.summary}`);
    assert.match(done.summary, summary);
    const verification = runtime.getVerification(session.id);
    assert.equal(verification.status, status);
    assert.equal(verification.exitCode, exitCode);
    assert.ok(runtime.getEvents(session.id).some((e) => e.kind === "artifact" && e.data.name === "worktree" && e.data.path === "/w"));
  }
});

test("an isolated task (POST /v1/tasks) is held to the same verifier", async () => {
  const coderSaysDone = { ok: true, message: "Status: completed", worktree: "/w", patch: "/w.patch" };
  const failed = await verifyCoderResult(coderSaysDone, receipt("failed", 1));
  assert.equal(failed.ok, false);
  assert.match(failed.message, /^Verification failed: `npm test` failed \(exit 1\)/u);
  assert.equal(failed.verification.exitCode, 1);
  assert.equal((await verifyCoderResult(coderSaysDone, receipt("unverified", null))).ok, false);
  const passed = await verifyCoderResult(coderSaysDone, receipt("verified", 0));
  assert.equal(passed.ok, true);
  assert.match(passed.message, /Verified by Atlas/u);
  const notRun = { ok: false, message: "No model server." };
  assert.equal(await verifyCoderResult(notRun, async () => assert.fail("nothing to verify")), notRun);
});

test("a coder that failed without changing anything is not re-verified and names its cause", async (t) => {
  let verified = 0;
  const executor = createLocalExecutor({
    dataDirectory: "/tmp",
    runCoder: async () => ({ ok: false, message: "file:///x/run-coder.mjs:66\n  throw new Error(...)\n\nError: No self-hosted model server answered at http://127.0.0.1:1/api/tags. Start Ollama before running Atlas.\n    at file:///x:66:9\n\nNode.js v22\n\nIsolated worktree: /w\nNo patch was produced.", worktree: "/w", patch: null }),
    verify: async () => { verified += 1; return {}; },
  });
  const { runtime } = await runtimeWith(t, { local: executor });
  const session = runtime.createSession({ title: "down", repository: "/tmp/repo", model: "m" });
  runtime.submitTurn(session.id, { text: "Fix it." });
  await runtime.drain();
  const done = runtime.getSession(session.id);
  assert.equal(done.status, "failed");
  assert.equal(done.summary, "The coder failed without changing anything: No self-hosted model server answered at http://127.0.0.1:1/api/tags. Start Ollama before running Atlas.");
  assert.equal(verified, 0);
});

// Bug: sessions on the local executor never consulted the code.write policy, so
// a deny was not enforced and "ask" never produced an approval.
test("the local executor enforces code.write: deny blocks before the coder, ask waits for a one-time approval", async (t) => {
  const calls = [];
  let decision = "deny";
  const granted = new Set();
  const requested = [];
  const approvals = {
    check: async (digest) => granted.delete(digest),
    request: async (request) => { requested.push(request); return { id: `approval-${requested.length}` }; },
  };
  const executor = createLocalExecutor({ runCoder: okCoder(calls), dataDirectory: "/tmp", policy: () => ({ decision }), approvals, verify: receipt("verified", 0) });
  const { runtime } = await runtimeWith(t, { local: executor });

  const denied = runtime.createSession({ title: "deny", repository: "/tmp/repo", model: "m" });
  runtime.submitTurn(denied.id, { text: "Fix it." });
  await runtime.drain();
  assert.equal(runtime.getSession(denied.id).status, "failed");
  assert.match(runtime.getSession(denied.id).summary, /code\.write is set to deny.*Policies/u);
  assert.equal(calls.length, 0, "the coder never started");
  assert.equal(requested.length, 0, "a deny is not a prompt");

  decision = "ask";
  const asked = runtime.createSession({ title: "ask", repository: "/tmp/repo", model: "m" });
  runtime.submitTurn(asked.id, { text: "Fix it." });
  await runtime.drain();
  assert.equal(runtime.getSession(asked.id).status, "awaiting_approval");
  assert.equal(calls.length, 0);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].capability, "code.write");
  assert.equal(requested[0].sessionId, asked.id);
  assert.ok(runtime.getEvents(asked.id).some((e) => e.kind === "approval_request" && e.data.approvalId === "approval-1"));

  // The owner approves: resuming spends the approval and the coder runs once.
  granted.add(requested[0].digest);
  runtime.resume(asked.id);
  await runtime.drain();
  assert.equal(runtime.getSession(asked.id).status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(granted.size, 0, "the approval was spent");
  // An approval for one turn does not cover the next.
  runtime.submitTurn(asked.id, { text: "Now something else." });
  await runtime.drain();
  assert.equal(runtime.getSession(asked.id).status, "awaiting_approval");
  assert.notEqual(requested[1].digest, requested[0].digest);
  assert.equal(calls.length, 1);
});

test("Atlas's verifier reports the command, exit code and output that really ran", async (t) => {
  const directory = await temporary(t, "atlas-verifier-");
  await mkdir(join(directory, "test"));
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  await writeFile(join(directory, "value.mjs"), "export const value = 1;\n");
  await writeFile(join(directory, "test", "value.test.mjs"), 'import assert from "node:assert/strict"; import test from "node:test"; import { value } from "../value.mjs"; test("value", () => assert.equal(value, 2));\n');
  const verify = createIndependentVerifier();
  const failing = await verify({ worktree: directory });
  assert.deepEqual([failing.status, failing.command, failing.exitCode], ["failed", "npm test", 1]);
  assert.match(failing.outputExcerpt, /# fail 1/u);
  assert.equal(failing.cwd, directory);
  await writeFile(join(directory, "value.mjs"), "export const value = 2;\n");
  const passing = await verify({ worktree: directory });
  assert.deepEqual([passing.status, passing.exitCode], ["verified", 0]);
  assert.match(passing.outputExcerpt, /# pass 1/u);

  // No test command is "unverified", never verified.
  await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }));
  assert.equal(await detectTestCommand(directory), null);
  assert.equal((await verify({ worktree: directory })).status, "unverified");
  // npm is run without a shell on Windows through the npm CLI beside node.exe.
  assert.deepEqual(npmInvocation(["test"], { platform: "win32", execPath: "C:\\node\\node.exe", exists: () => true }).args.slice(1), ["test"]);
  assert.match(npmInvocation(["test"], { platform: "win32", execPath: "C:\\node\\node.exe", exists: () => true }).args[0], /npm-cli\.js$/u);
  assert.deepEqual(npmInvocation(["test"], { platform: "linux" }), { program: "npm", args: ["test"] });
  // repository.run_tests uses the same shell-free npm, so it can run on Windows too.
  const { program, args } = npmInvocation(["test", "--silent"]);
  assert.deepEqual(APPROVED_TEST_COMMANDS.get("npm-test"), [program, args]);
});

// Bug: a session could be opened on a folder that does not exist; the failure
// only surfaced after a run had started, as a worktree error.
test("a session on a missing folder, a file or a non-Git folder is refused before it exists", async (t) => {
  const directory = await temporary(t, "atlas-repository-check-");
  const plain = join(directory, "plain");
  const repo = join(directory, "repo");
  await mkdir(plain);
  await mkdir(join(repo, ".git"), { recursive: true });
  await writeFile(join(directory, "file.txt"), "x");
  assert.equal(checkLocalRepository({ executor: "local", repository: join(directory, "missing") }).code, "REPOSITORY_NOT_FOUND");
  assert.equal(checkLocalRepository({ executor: "local", repository: join(directory, "file.txt") }).code, "REPOSITORY_NOT_FOUND");
  assert.equal(checkLocalRepository({ executor: "local", repository: "relative/path" }).code, "REPOSITORY_NOT_ABSOLUTE");
  assert.equal(checkLocalRepository({ executor: "local", repository: plain }).code, "NOT_A_GIT_REPOSITORY");
  assert.equal(checkLocalRepository({ executor: "conversation", repository: plain }), null, "a chat may work in any existing folder");
  assert.equal(checkLocalRepository({ executor: "local", repository: repo }), null);
  assert.equal(checkLocalRepository({ executor: "github-actions", repository: "owner/name" }), null, "a remote repository is not a local path");

  const { runtime } = await runtimeWith(t, { local: createLocalExecutor({ runCoder: async () => assert.fail("must not run"), dataDirectory: "/tmp" }) }, { checkRepository: checkLocalRepository });
  assert.throws(() => runtime.createSession({ title: "missing", repository: join(directory, "missing"), model: "m" }), { code: "REPOSITORY_NOT_FOUND" });
  assert.throws(() => runtime.createSession({ title: "plain", repository: plain, model: "m" }), { code: "NOT_A_GIT_REPOSITORY" });
  assert.equal(runtime.listSessions().length, 0);
  const ok = runtime.createSession({ title: "repo", repository: repo, model: "m" });
  await rm(repo, { recursive: true, force: true });
  assert.throws(() => runtime.submitTurn(ok.id, { text: "x" }), { code: "REPOSITORY_NOT_FOUND" }, "a folder removed since is refused at the next turn");
});

// Bug: a daemon killed outright and restarted within the 30-second lease left
// its sessions "running" forever: boot recovery skipped unexpired leases and
// nothing ever looked again.
test("a session whose runtime died is marked interrupted once its unrenewed lease lapses", async (t) => {
  const directory = await temporary(t, "atlas-lease-");
  const sessions = new AgentSessionStore(join(directory, "agent.sqlite"));
  t.after(() => sessions.close());
  const created = sessions.createSession({ title: "killed", model: "m", executor: "local" });
  sessions.addTurn({ sessionId: created.id, role: "user", text: "work" });
  sessions.setStatus(created.id, "running");
  assert.ok(sessions.acquireLease(created.id, "dead-runtime", new Date(Date.now() + 400).toISOString()));
  for (const turn of sessions.turns(created.id)) sessions.setTurnState(turn.id, "running");

  const runtime = new AgentRuntime({ sessions, executors: { local: { id: "local", run: async () => ({ status: "completed" }) } } });
  t.after(() => runtime.stop());
  assert.deepEqual(runtime.recover(), [], "the lease has not lapsed yet");
  assert.equal(sessions.session(created.id).status, "running");
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const after = sessions.session(created.id);
  assert.equal(after.status, "interrupted", "not left running forever");
  assert.equal(sessions.turns(created.id)[0].state, "pending", "the unanswered turn is queued again for resume");
});

// Bug: with ATLAS_MODEL_ENDPOINT pointed at a model server, chat used it but
// every coding run still went to http://127.0.0.1:11434.
test("the coder talks to the same model server as the rest of Atlas", () => {
  assert.equal(resolveCoderOllamaUrl({}), null);
  assert.equal(resolveCoderOllamaUrl({ ATLAS_MODEL_ENDPOINT: "http://127.0.0.1:5555/v1" }), "http://127.0.0.1:5555");
  assert.equal(resolveCoderOllamaUrl({ ATLAS_MODEL_ENDPOINT: "http://127.0.0.1:5555/v1", OLLAMA_HOST: "127.0.0.1:6666" }), "http://127.0.0.1:6666");
  assert.equal(resolveCoderOllamaUrl({ OLLAMA_HOST: "0.0.0.0" }), "http://127.0.0.1:11434", "a server bound to every interface is reached on loopback");
  assert.equal(resolveCoderOllamaUrl({ OLLAMA_HOST: "http://localhost:7777" }), "http://localhost:7777");
  assert.equal(resolveCoderOllamaUrl({ ATLAS_OLLAMA_URL: "http://127.0.0.1:8888/", OLLAMA_HOST: "127.0.0.1:6666" }), "http://127.0.0.1:8888");
});

// Bug: the agent's browser tools only tried a bare import("playwright-core"),
// which never resolves from apps/local-control, so they said "Playwright is not
// installed" on a machine where the browser worker had it.
test("the browser tools find Playwright where Atlas's browser worker installed it", async (t) => {
  const directory = await temporary(t, "atlas-playwright-");
  const host = join(directory, "host");
  await mkdir(join(host, "node_modules", "playwright-core"), { recursive: true });
  await writeFile(join(host, "package.json"), JSON.stringify({ name: "host" }));
  await writeFile(join(host, "node_modules", "playwright-core", "package.json"), JSON.stringify({ name: "playwright-core", main: "index.js" }));
  await writeFile(join(host, "node_modules", "playwright-core", "index.js"), "module.exports = { chromium: { name: 'fake-chromium' } };\n");
  const missing = () => { throw new Error("Cannot find package 'playwright-core'"); };
  assert.equal((await loadPlaywright({ hosts: [join(directory, "nowhere"), host], importBare: missing })).chromium.name, "fake-chromium");
  assert.equal(await loadPlaywright({ hosts: [join(directory, "nowhere")], importBare: missing }), null);
});

// Bug: a browser that was closed or crashed left a dead session cached for the
// life of the daemon, and a failed launch was remembered forever.
test("the browser tools relaunch a closed browser and retry a failed launch", async () => {
  let builds = 0;
  let failNext = true;
  const sessions = [];
  const factory = async () => {
    builds += 1;
    if (failNext) { failNext = false; throw new Error("profile is locked"); }
    const session = {
      dead: false,
      isClosed() { return this.dead; },
      async navigate({ url }) { if (this.dead) throw new Error("page.goto: Target page, context or browser has been closed"); return { url, title: "T" }; },
      async snapshot() { if (this.dead) throw new Error("The page could not be read: Target closed"); return "page"; },
    };
    sessions.push(session);
    return session;
  };
  const registry = new ToolRegistry({ policy: () => "allow" });
  registerBrowserTools(registry, { session: factory, urlGuard: async () => {} });
  const run = (name, args) => registry.invoke({ name, rawArguments: JSON.stringify(args), sessionId: "s", approvals: { check: async () => false }, context: {} });

  const first = await run("browser.navigate", { url: "https://example.com/" });
  assert.equal(first.code, "NO_BROWSER");
  assert.equal((await run("browser.navigate", { url: "https://example.com/" })).status, "completed", "a failed launch is retried");
  // Dies without anything noticing: navigating opens a new browser and succeeds.
  sessions[0].dead = true;
  sessions[0].isClosed = () => false;
  assert.equal((await run("browser.navigate", { url: "https://example.com/" })).status, "completed");
  assert.equal(sessions.length, 2);
  // Closed and known to be closed: the next call relaunches up front.
  sessions[1].dead = true;
  assert.equal((await run("browser.snapshot", {})).status, "completed");
  assert.equal(sessions.length, 3);
  // A page action on a browser that died under it says so instead of pretending.
  sessions[2].dead = true;
  sessions[2].isClosed = () => false;
  const lost = await run("browser.snapshot", {});
  assert.equal(lost.code, "BROWSER_CLOSED");
  assert.equal(builds, 4);
});

test("an HTTP 500 from the model server says what to check", async () => {
  const client = createModelClient({ baseUrl: "http://127.0.0.1:9/v1", fetchImpl: async () => new Response(JSON.stringify({ error: "llama runner process has terminated" }), { status: 500 }) });
  await assert.rejects(async () => { for await (const chunk of client.stream({ model: "qwen2.5-coder:7b", messages: [] })) void chunk; }, (error) => {
    assert.equal(error.code, "MODEL_REQUEST_FAILED");
    assert.match(error.message, /HTTP 500/u);
    assert.match(error.message, /llama runner process has terminated/u);
    assert.match(error.message, /ollama pull qwen2\.5-coder:7b/u);
    return true;
  });
});
