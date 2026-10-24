/**
 * The autonomous golden path, end to end, against the REAL daemon.
 *
 * `src/main.mjs` runs as a child process with a temporary data directory, a
 * generated owner token and its model endpoint pointed at a protocol-accurate
 * fake Ollama (tests/helpers/fake-ollama.mjs). Everything is driven over the
 * daemon's HTTP API, exactly as the console drives it:
 *
 *   A  conversation: "Hello" in a plain Home chat, answered through the model
 *   B  repository: a session on a local Git repository discovers and reads it
 *      through the agent's tools; a path outside it is refused; running its
 *      tests goes through policy and the real approvals API
 *   C  coding: the coder fixes a failing test in an isolated worktree after
 *      code.write is approved through the approvals API
 *   D  no fabricated success: the model claims a fix but the test still fails;
 *      the outcome is failed, never completed
 *   E  browser: a browser tool opens and reads a loopback page (when Playwright
 *      and Chromium are installed; otherwise skipped with the reason)
 *   F  verification: Atlas's own verifier re-runs the repository's tests and
 *      the reported evidence (command, exit code, output) is what really ran
 *   G  failure handling: model unavailable, permission denied, missing
 *      repository — each an honest failure naming the cause
 *   H  persistence: stop and restart on the same data directory; tokens,
 *      paired devices, model plan, workspace, policies, interrupted work and
 *      the browser all survive
 *
 * Throughout, the daemon may not open a connection to any non-loopback host
 * (tests/helpers/loopback-only-guard.mjs), provider keys and proxies are
 * removed from its environment, and every model call must reach the fake.
 *
 * The model is scripted. This proves Atlas's wiring around a model; it says
 * nothing about any real model's quality. ATLAS_ACCEPTANCE_REAL_OLLAMA=1 runs
 * the same journey against a real Ollama (docs/atlas-os/AUTONOMOUS-ACCEPTANCE.md),
 * where only the honesty assertions apply to what the model chose to do.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startFakeOllama } from "./helpers/fake-ollama.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const atlasRoot = resolve(appRoot, "..", "..");
const REAL = process.env.ATLAS_ACCEPTANCE_REAL_OLLAMA === "1";
const REAL_URL = (process.env.ATLAS_ACCEPTANCE_OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/u, "");
const MODEL = process.env.ATLAS_ACCEPTANCE_MODEL || "qwen2.5-coder:7b";
const REQUIRE_FULL = process.env.ATLAS_ACCEPTANCE_REQUIRE_FULL === "1";
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// The coder is built from packages/atlas-cli, which needs its dev dependencies (TypeScript).
const coderReason = existsSync(join(atlasRoot, "packages", "atlas-cli", "node_modules", "typescript"))
  ? null
  : "packages/atlas-cli dependencies are not installed (run npm ci --ignore-scripts there)";
// Browser tools need playwright-core (apps/browser-worker's dependency) and a browser: Playwright's
// Chromium build by default, or an installed Edge/Chrome with ATLAS_ACCEPTANCE_BROWSER_CHANNEL=msedge|chrome.
const browserChannel = process.env.ATLAS_ACCEPTANCE_BROWSER_CHANNEL || "chromium";
const defaultBrowsersPath = process.platform === "win32"
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ms-playwright")
  : process.platform === "darwin" ? join(homedir(), "Library", "Caches", "ms-playwright") : join(homedir(), ".cache", "ms-playwright");
const browsersPath = browserChannel !== "chromium" ? "" : [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers", defaultBrowsersPath].find((path) => path && existsSync(path)) ?? "";
const browserReason = !existsSync(join(atlasRoot, "apps", "browser-worker", "node_modules", "playwright-core"))
  ? "playwright-core is not installed (run npm ci --ignore-scripts in apps/browser-worker)"
  : browserChannel === "chromium" && !browsersPath
    ? "no Chromium build: set PLAYWRIGHT_BROWSERS_PATH to an installed Playwright browsers directory, or ATLAS_ACCEPTANCE_BROWSER_CHANNEL=msedge"
    : null;
// A real model on a CPU is far slower than the script.
const SCALE = REAL ? 10 : 1;
const skipCoder = coderReason && !REQUIRE_FULL ? coderReason : false;
const skipBrowser = browserReason && !REQUIRE_FULL ? browserReason : false;

const freePort = () => new Promise((resolvePort) => {
  const server = createNetServer();
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolvePort(port)); });
});
const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};
const scenario = (request) => (/\[scenario:([a-z-]+)\]/u.exec(request.lastUser) ?? /\[scenario:([a-z-]+)\]/u.exec(request.allUser))?.[1] ?? "hello";
const unwrap = (text) => String(text ?? "").replace(/<\/?data[^>]*>/gu, "").trim();

const FIXED_SUM = "export function sum(a, b) {\n  return a + b;\n}\n";
const BUGGY_SUM = "export function sum(a, b) {\n  return a - b;\n}\n";

/**
 * The scripted model. It recognizes the scenario marker in the newest user
 * message and answers the way a cooperative (or, for "fake-claim", a lying)
 * model would, one tool round at a time.
 */
function scriptedModel(request) {
  const done = request.toolResults.length;
  switch (scenario(request)) {
    case "explore":
      if (done === 0) return { toolCalls: [{ name: "repository.list", arguments: { path: ".", depth: 3 } }] };
      if (done === 1) return { toolCalls: [{ name: "repository.read", arguments: { path: "src/sum.mjs" } }] };
      if (done === 2) return { toolCalls: [{ name: "repository.read", arguments: { path: "../outside-secret.txt" } }] };
      return { content: `This repository contains:\n${unwrap(request.toolResults[0])}\n\nsrc/sum.mjs reads:\n${unwrap(request.toolResults[1])}\n\nI could not read ../outside-secret.txt: ${unwrap(request.toolResults[2]).slice(0, 200)}` };
    case "run-tests":
      if (done === 0) return { toolCalls: [{ name: "repository.run_tests", arguments: { command: "npm-test" } }] };
      return { content: `I ran the tests. Result: ${unwrap(request.toolResults[0]).split("\n")[0]}` };
    case "fix":
      if (done === 0) return { toolCalls: [{ name: "repository.read_source", arguments: { path: "src/sum.mjs" } }] };
      if (done === 1) return { toolCalls: [{ name: "repository.propose_change_set", arguments: { edits: [{ operation: "update", path: "src/sum.mjs", content: FIXED_SUM }] } }] };
      return { content: "sum() subtracted its arguments; it now adds them, so the failing test passes." };
    case "fake-claim":
      if (done === 0) return { toolCalls: [{ name: "repository.read_source", arguments: { path: "src/sum.mjs" } }] };
      if (done === 1) return { toolCalls: [{ name: "repository.propose_change_set", arguments: { edits: [{ operation: "update", path: "src/sum.mjs", content: `// Reviewed.\n${BUGGY_SUM}` }] } }] };
      return { content: "Fixed! All tests pass now." };
    case "browse":
      if (done === 0) return { toolCalls: [{ name: "browser.navigate", arguments: { url: /https?:\/\/127\.0\.0\.1:\d+\/[a-z-]*/u.exec(request.lastUser)?.[0] } }] };
      if (done === 1) return { toolCalls: [{ name: "browser.snapshot", arguments: {} }] };
      return { content: `The page says: ${unwrap(request.toolResults[1]).slice(0, 400)}` };
    case "slow":
      return { delayMs: 120_000, content: "This answer arrives far too late." };
    default:
      return { content: "Hello! I am Atlas, answering from your local model." };
  }
}

test("autonomous golden path against the real daemon", { timeout: 900_000 * SCALE }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atlas-acceptance-"));
  const dataDirectory = join(root, "data");
  const home = join(root, "home");
  const repository = join(root, "fixture-repo");
  const netLog = join(root, "non-loopback.jsonl");
  const daemonLog = join(root, "daemon.log");
  mkdirSync(home, { recursive: true });
  // npm in child processes must not reach the registry for update checks.
  writeFileSync(join(home, ".npmrc"), "update-notifier=false\nfund=false\naudit=false\n");
  writeFileSync(join(root, "outside-secret.txt"), "OUTSIDE-THE-REPOSITORY\n");

  // A small repository with a failing test: sum() subtracts.
  mkdirSync(join(repository, "src"), { recursive: true });
  mkdirSync(join(repository, "test"), { recursive: true });
  git(root, "init", "--quiet", "fixture-repo");
  git(repository, "config", "user.email", "acceptance@example.invalid");
  git(repository, "config", "user.name", "Acceptance");
  writeFileSync(join(repository, "package.json"), `${JSON.stringify({ name: "fixture", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
  writeFileSync(join(repository, "src", "sum.mjs"), BUGGY_SUM);
  writeFileSync(join(repository, "test", "sum.test.mjs"), 'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { sum } from "../src/sum.mjs";\n\ntest("sum adds", () => { assert.equal(sum(2, 3), 5); });\n');
  writeFileSync(join(repository, "README.md"), "# Fixture\n\nsum(a, b) should add.\n");
  git(repository, "add", "-A");
  git(repository, "commit", "--quiet", "-m", "Initial commit with a failing test");
  const pristineHead = git(repository, "rev-parse", "HEAD").trim();

  const fake = REAL ? null : await startFakeOllama({ decide: scriptedModel, models: [MODEL] });
  const modelOrigin = REAL ? REAL_URL : fake.origin;
  const page = createHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Acceptance page</title><h1>Atlas acceptance page</h1><p>Verification code ACCEPT-4217</p><a href=\"/next\">Next</a>");
  });
  await new Promise((resolveListen) => page.listen(0, "127.0.0.1", resolveListen));
  const pageUrl = `http://127.0.0.1:${page.address().port}/acceptance`;

  const TOKEN = `acceptance-${randomBytes(24).toString("hex")}`;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const ownerHeaders = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

  // A proxy-free, credential-free environment: only what a process needs.
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    LANG: process.env.LANG ?? "C.UTF-8",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT, COMSPEC: process.env.COMSPEC, PATHEXT: process.env.PATHEXT, TEMP: process.env.TEMP, TMP: process.env.TMP } : {}),
    ATLAS_LOCAL_DATA_DIR: dataDirectory,
    ATLAS_LOCAL_PORT: String(port),
    ATLAS_LOCAL_TOKEN: TOKEN,
    ATLAS_OWNER_TOKEN_STORAGE: "file",
    ATLAS_MODEL_ENDPOINT: `${modelOrigin}/v1`,
    OLLAMA_HOST: modelOrigin.replace(/^https?:\/\//u, ""),
    ATLAS_TEAM_MODEL: MODEL,
    ATLAS_LOOPBACK_GUARD_LOG: netLog,
    npm_config_update_notifier: "false",
    ...(browsersPath ? { PLAYWRIGHT_BROWSERS_PATH: browsersPath } : {}),
    ATLAS_BROWSER_CHANNEL: browserChannel,
    ATLAS_BROWSER_HEADLESS: "1",
    // The acceptance page is on loopback, which both browser guards refuse by default.
    ATLAS_BROWSER_ALLOW_HOSTS: "127.0.0.1",
    ATLAS_BROWSER_ALLOW_PRIVATE_HOSTS: "127.0.0.1",
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  assert.ok(!Object.keys(env).some((key) => /PROXY|API_KEY|GROQ|ANTHROPIC|OPENAI|GITHUB_TOKEN|CLOUDFLARE/iu.test(key)), "no provider key or proxy reaches the daemon");

  let daemon = null;
  const startDaemon = async () => {
    const out = openSync(daemonLog, "a");
    daemon = spawn(process.execPath, ["--import", pathToFileURL(join(here, "helpers", "loopback-only-guard.mjs")).href, join(appRoot, "src", "main.mjs")], { cwd: appRoot, env, stdio: ["ignore", out, out] });
    const exited = new Promise((resolveExit) => daemon.once("exit", resolveExit));
    daemon.exited = exited;
    for (let i = 0; i < 160; i += 1) {
      try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not yet */ }
      if (daemon.exitCode !== null) break;
      await sleep(125);
    }
    throw new Error(`The daemon did not start:\n${readFileSync(daemonLog, "utf8").slice(-4000)}`);
  };
  const stopDaemon = async (signal = "SIGTERM") => {
    if (!daemon || daemon.exitCode !== null) { daemon = null; return; }
    daemon.kill(signal);
    const timer = setTimeout(() => daemon?.kill("SIGKILL"), 15_000);
    await daemon.exited;
    clearTimeout(timer);
    daemon = null;
  };
  t.after(async () => {
    await stopDaemon("SIGTERM").catch(() => {});
    await fake?.close().catch(() => {});
    await new Promise((resolveClose) => page.close(resolveClose));
    spawnSync("git", ["worktree", "prune"], { cwd: repository });
    // A browser the daemon started may still be flushing its profile for a moment after the daemon is gone.
    if (process.platform !== "win32") spawnSync("pkill", ["-KILL", "-f", join(dataDirectory, "browser-profile")]);
    if (process.env.ATLAS_ACCEPTANCE_KEEP !== "1") rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    else console.log(`Kept acceptance files in ${root}`);
  });

  const call = async (path, { method = "GET", body, token = TOKEN } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...ownerHeaders, authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: json, text };
  };
  const setPolicy = async (capability, decision) => {
    const result = await call("/v1/policies", { method: "PUT", body: { capability, decision } });
    assert.equal(result.status, 200, result.text);
  };
  const session = async (id) => (await call(`/v1/sessions/${id}`)).body;
  const waitForSession = async (id, predicate, ms = 120_000) => {
    const end = Date.now() + ms * SCALE;
    let last = null;
    while (Date.now() < end) {
      last = await session(id);
      if (last?.session && predicate(last.session)) return last;
      await sleep(200);
    }
    assert.fail(`session ${id} never reached the expected state; last: ${JSON.stringify(last?.session)}\n${readFileSync(daemonLog, "utf8").slice(-3000)}`);
  };
  const TERMINAL = ["completed", "failed", "cancelled", "awaiting_approval", "interrupted"];
  const events = async (id, ms = 1500) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    const collected = [];
    try {
      const response = await fetch(`${base}/v1/sessions/${id}/events?after=0`, { headers: ownerHeaders, signal: controller.signal });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (data) collected.push(JSON.parse(data));
        }
      }
    } catch { /* the window closed */ } finally { clearTimeout(timer); controller.abort(); }
    return collected;
  };
  const openSession = async (body) => {
    const created = await call("/v1/sessions", { method: "POST", body: { model: MODEL, ...body } });
    assert.equal(created.status, 201, created.text);
    return created.body.session;
  };
  const say = async (id, text) => {
    const sent = await call(`/v1/sessions/${id}/turns`, { method: "POST", body: { text } });
    assert.equal(sent.status, 202, sent.text);
    return sent.body.turn;
  };
  const pendingApproval = async (sessionId, capability, ms = 60_000) => {
    const end = Date.now() + ms * SCALE;
    while (Date.now() < end) {
      const found = (await call("/v1/approvals")).body.approvals.find((a) => a.status === "pending" && a.sessionId === sessionId && (!capability || a.capability === capability));
      if (found) return found;
      await sleep(200);
    }
    assert.fail(`no pending ${capability ?? ""} approval for session ${sessionId}`);
  };
  const decide = async (approval, decision) => {
    const result = await call(`/v1/approvals/${approval.id}/decision`, { method: "POST", body: { decision } });
    assert.equal(result.status, 200, result.text);
    return result.body.approval;
  };
  const independentTestRun = (directory) => spawnSync("npm", ["test"], { cwd: directory, encoding: "utf8", shell: process.platform === "win32", env: { ...env, ATLAS_LOCAL_TOKEN: undefined } });

  await startDaemon();
  const modelCallsBefore = () => fake?.modelCalls().length ?? 0;

  await t.test("A. conversation: Hello in a Home chat is answered through the local model", async () => {
    assert.equal((await fetch(`${base}/v1/sessions`)).status, 401, "no token, no access");
    const health = (await call("/v1/models/health")).body;
    const local = health.servers.find((server) => server.models.some((model) => model.name === MODEL));
    assert.ok(local, `the configured model server is discovered: ${JSON.stringify(health.servers)}`);
    assert.equal(local.location, "this machine");
    const executors = (await call("/v1/executors")).body;
    assert.ok(executors.executors.includes("conversation") && executors.executors.includes("local"), JSON.stringify(executors));
    assert.ok(!executors.executors.includes("github-actions"), "no hosted executor without credentials");

    const before = modelCallsBefore();
    const chat = await openSession({ title: "Hello" });
    assert.equal(chat.executor, "conversation", "a chat with no repository talks; it does not run the coder");
    await say(chat.id, "Hello");
    const { session: done, turns } = await waitForSession(chat.id, (s) => TERMINAL.includes(s.status));
    assert.equal(done.status, "completed", done.summary);
    const answer = (await events(chat.id)).filter((e) => e.kind === "assistant_message" && e.data.final).at(-1)?.data.text ?? "";
    assert.ok(answer.trim().length > 0, "a real reply arrived");
    assert.equal(turns.filter((turn) => turn.role === "user").at(-1).state, "completed");
    if (!REAL) {
      assert.equal(answer, "Hello! I am Atlas, answering from your local model.");
      const calls = fake.modelCalls().slice(before);
      assert.ok(calls.length >= 1 && calls.every((c) => c.protocol === "openai" && c.path === "/v1/chat/completions" && c.model === MODEL && c.stream === true), JSON.stringify(calls));
      assert.equal(calls[0].lastUser, "Hello");
    }
  });

  let repoSession = null;
  await t.test("B. repository: discover and read through the agent's tools; paths outside are refused; tests run only after approval", async () => {
    repoSession = await openSession({ title: "Explore the fixture", repository, executor: "conversation" });
    assert.equal(repoSession.repository, repository);
    await say(repoSession.id, "[scenario:explore] What is in this repository, and what does src/sum.mjs do? Also look at ../outside-secret.txt.");
    const { session: done } = await waitForSession(repoSession.id, (s) => TERMINAL.includes(s.status));
    assert.equal(done.status, "completed", done.summary);
    const seen = await events(repoSession.id);
    const executions = seen.filter((e) => e.kind === "tool_execution");
    if (!REAL) {
      assert.deepEqual(executions.map((e) => [e.data.tool, e.data.outcome]), [["repository.list", "succeeded"], ["repository.read", "succeeded"], ["repository.read", "failed"]]);
      assert.match(executions[0].data.summary, /src[\\/]sum\.mjs/u);
      assert.match(executions[0].data.summary, /test[\\/]sum\.test\.mjs/u);
      assert.match(executions[1].data.summary, /return a - b;/u);
      assert.equal(executions[2].data.errorCode, "PATH_ESCAPES_REPOSITORY", "a path outside the authorized repository is refused");
      assert.doesNotMatch(JSON.stringify(seen), /OUTSIDE-THE-REPOSITORY/u, "nothing outside the repository was read");
      const answer = seen.filter((e) => e.kind === "assistant_message" && e.data.final).at(-1).data.text;
      assert.match(answer, /return a - b;/u, "the answer is grounded in what the tool read");
    } else {
      assert.ok(executions.every((e) => e.data.outcome === "succeeded" || e.data.errorCode), "every tool outcome is reported");
    }

    // Running the repository's tests is a high-risk tool: denied by default policy...
    assert.equal((await call("/v1/policies")).body.policies.find((p) => p.capability === "repository.execute"), undefined, "repository.execute has no saved policy, so it is denied");
    await say(repoSession.id, "[scenario:run-tests] Run this repository's tests and tell me the result.");
    let after = await waitForSession(repoSession.id, (s) => TERMINAL.includes(s.status));
    let runs = (await events(repoSession.id)).filter((e) => e.kind === "tool_execution" && e.data.tool === "repository.run_tests");
    if (!REAL) {
      assert.equal(runs.at(-1).data.errorCode, "POLICY_DENIED", JSON.stringify(runs.at(-1)));
      assert.match(runs.at(-1).data.summary, /repository\.execute/u, "the refusal names the capability");
      assert.match(runs.at(-1).data.summary, /allow/u, "and says where to allow it");
    }
    // ...then allowed with "ask": the session waits for the owner's approval of that exact command.
    await setPolicy("repository.execute", "ask");
    await say(repoSession.id, "[scenario:run-tests] Run this repository's tests and tell me the result.");
    after = await waitForSession(repoSession.id, (s) => TERMINAL.includes(s.status));
    if (REAL && after.session.status !== "awaiting_approval") return;
    assert.equal(after.session.status, "awaiting_approval", after.session.summary);
    const approval = await pendingApproval(repoSession.id, "repository.execute");
    assert.match(approval.summary, /repository\.run_tests/u);
    await decide(approval, "approved");
    after = await waitForSession(repoSession.id, (s) => ["completed", "failed", "cancelled"].includes(s.status));
    assert.equal(after.session.status, "completed", after.session.summary);
    runs = (await events(repoSession.id)).filter((e) => e.kind === "tool_execution" && e.data.tool === "repository.run_tests");
    const ran = runs.at(-1);
    assert.equal(ran.data.outcome, "succeeded", "the approved command ran once");
    assert.match(ran.data.summary, /npm-test failed \(exit 1\)/u, "the real failing result is reported, not a success");
    assert.ok((await call("/v1/audit")).body.events.some((e) => e.category === "approval.consumed" || /consum/u.test(e.category)), "the approval was spent");
    if (!REAL) {
      const answer = (await events(repoSession.id)).filter((e) => e.kind === "assistant_message" && e.data.final).at(-1).data.text;
      assert.match(answer, /failed \(exit 1\)/u);
    }
  });

  const coderRun = async (text, { approve = true } = {}) => {
    const coding = await openSession({ title: text.slice(0, 60), repository, executor: "local" });
    await say(coding.id, text);
    let state = await waitForSession(coding.id, (s) => TERMINAL.includes(s.status), 60_000);
    if (state.session.status === "awaiting_approval") {
      const approval = await pendingApproval(coding.id, "code.write");
      await decide(approval, approve ? "approved" : "denied");
      state = await waitForSession(coding.id, (s) => ["completed", "failed", "cancelled"].includes(s.status), 300_000);
    }
    return { id: coding.id, ...state, events: await events(coding.id) };
  };
  const verificationOf = (run) => run.verification ?? null;

  await t.test("C/F+. coding: the coder fixes the failing test after code.write is approved, and Atlas's verifier confirms it", { skip: skipCoder }, async () => {
    const before = modelCallsBefore();
    const run = await coderRun("[scenario:fix] Fix the failing test in this repository and verify the result.");
    const approvals = (await call("/v1/approvals")).body.approvals.filter((a) => a.sessionId === run.id);
    assert.deepEqual(approvals.map((a) => [a.capability, a.status]), [["code.write", "approved"]], "code.write was asked for and approved through the approvals API");
    const verification = verificationOf(run);
    assert.ok(verification, `the outcome carries Atlas's own verification: ${JSON.stringify(run.session)}`);
    const worktree = run.events.find((e) => e.kind === "artifact" && e.data.name === "worktree")?.data.path;
    if (REAL) {
      // Whatever the model did, the outcome must match what the tests say.
      const truth = independentTestRun(worktree);
      assert.equal(run.session.status === "completed", truth.status === 0, `completed only if the tests pass (exit ${truth.status})`);
      assert.equal(verification.exitCode, truth.status);
      return;
    }
    assert.equal(run.session.status, "completed", run.session.summary);
    assert.equal(run.session.summary, "Verified by Atlas: `npm test` passed (exit 0).", "the outcome says how it was verified");
    assert.equal(verification.status, "verified");
    assert.equal(verification.command, "npm test");
    assert.equal(verification.exitCode, 0);
    assert.match(verification.outputExcerpt, /# pass 1/u);
    assert.match(verification.outputExcerpt, /# fail 0/u);
    // The evidence is what really ran: the same command in the same worktree gives the same answer.
    assert.ok(worktree && existsSync(worktree), "the isolated worktree is reported");
    assert.equal(readFileSync(join(worktree, "src", "sum.mjs"), "utf8"), FIXED_SUM, "the edit tool changed the file in the worktree");
    assert.equal(verification.cwd, worktree, "the verifier ran in the coder's worktree");
    const rerun = independentTestRun(worktree);
    assert.equal(rerun.status, 0);
    assert.match(verification.outputExcerpt, /ok 1 - sum adds/u);
    assert.match(rerun.stdout, /ok 1 - sum adds/u, "the excerpt is the output of that same test run");
    // The owner's checkout is untouched until they apply the patch.
    assert.equal(readFileSync(join(repository, "src", "sum.mjs"), "utf8"), BUGGY_SUM);
    assert.equal(git(repository, "rev-parse", "HEAD").trim(), pristineHead);
    const patch = run.events.find((e) => e.kind === "artifact" && e.data.name === "patch")?.data.path;
    assert.ok(patch && readFileSync(patch, "utf8").includes("+  return a + b;"), "a portable patch is delivered");
    const calls = fake.modelCalls().slice(before);
    assert.ok(calls.length >= 3, `the coder called the model for each tool round: ${calls.length}`);
    assert.ok(calls.every((c) => c.protocol === "ollama" && c.path === "/api/chat" && c.model === MODEL), JSON.stringify(calls.map((c) => [c.protocol, c.model])));
    assert.ok(calls.some((c) => c.tools.includes("repository.propose_change_set")), "the coder offered its edit tool");
    assert.ok(calls.some((c) => c.decision?.toolCalls?.includes("repository.read_source")), "the coder read the file before editing it");
  });

  await t.test("D/F-. no fabricated success: a claimed fix with the test still failing is reported failed, with the real evidence", { skip: skipCoder || (REAL && "a real model cannot be told to lie; see C for the honesty check") }, async () => {
    const run = await coderRun("[scenario:fake-claim] Fix the failing test in this repository and verify the result.");
    const verification = verificationOf(run);
    assert.notEqual(run.session.status, "completed", `a claimed fix whose test still fails is never completed: ${run.session.summary}`);
    assert.equal(run.session.status, "failed");
    assert.ok(verification, "the failure carries the verifier's evidence");
    assert.equal(verification.status, "failed");
    assert.equal(verification.command, "npm test");
    assert.equal(verification.exitCode, 1);
    assert.match(verification.outputExcerpt, /# fail 1/u);
    assert.match(run.session.summary, /npm test/u, "the summary names the command that failed");
    const worktree = run.events.find((e) => e.kind === "artifact" && e.data.name === "worktree")?.data.path;
    assert.equal(verification.cwd, worktree);
    assert.match(verification.outputExcerpt, /not ok 1 - sum adds/u);
    assert.match(verification.outputExcerpt, /Expected values to be strictly equal:[\s\S]*-1 !== 5/u, "the real assertion failure is in the evidence");
    const rerun = independentTestRun(worktree);
    assert.equal(rerun.status, 1, "the evidence matches reality: the test really fails there");
    assert.match(rerun.stdout, /not ok 1 - sum adds/u);
    // The coder process itself exited as though it had succeeded; before Atlas's own
    // verifier, that exit code was the outcome ("Local run verified.").
    assert.ok(run.events.some((e) => e.kind === "tool_execution" && e.data.tool === "repository.coder" && e.data.outcome === "succeeded" && /Status: completed/u.test(e.data.summary)), "the coder claimed completion");
    // The model's prose is still visible, but it is not the outcome.
    assert.ok(run.events.some((e) => e.kind === "assistant_message" && /Fixed! All tests pass now\./u.test(e.data.text)));
    assert.ok(run.events.some((e) => e.kind === "completion" && e.data.status === "failed"));

    // The same holds for an isolated task started from the Tasks page (POST /v1/tasks).
    const queued = await call("/v1/tasks", { method: "POST", body: { repository, objective: "[scenario:fake-claim] Fix the failing test in this repository and verify the result.", model: MODEL } });
    assert.equal(queued.status, 202, queued.text);
    assert.ok(queued.body.approval, "code.write is asked for");
    await decide(queued.body.approval, "approved");
    let task = null;
    for (let i = 0; i < 600 && !["completed", "failed"].includes(task?.status); i += 1) { await sleep(250); task = (await call(`/v1/tasks/${queued.body.task.id}`)).body.task; }
    assert.equal(task.status, "failed", `a task whose tests still fail is not completed: ${task.message?.slice(0, 300)}`);
    assert.match(task.message, /^Verification failed: `npm test` failed \(exit 1\)/u);
  });

  const browseOnce = async (title) => {
    const browse = await openSession({ title });
    await say(browse.id, `[scenario:browse] Open ${pageUrl} and tell me the verification code on it.`);
    const { session: done } = await waitForSession(browse.id, (s) => TERMINAL.includes(s.status), 120_000);
    const executions = (await events(browse.id)).filter((e) => e.kind === "tool_execution");
    if (REAL) { assert.ok(executions.every((e) => e.data.outcome === "succeeded" || e.data.errorCode), "every browser tool outcome is reported"); return; }
    assert.equal(done.status, "completed", `${done.summary} ${JSON.stringify(executions.map((e) => e.data))}`);
    assert.deepEqual(executions.map((e) => [e.data.tool, e.data.outcome]), [["browser.navigate", "succeeded"], ["browser.snapshot", "succeeded"]], JSON.stringify(executions.map((e) => e.data)));
    assert.match(executions[0].data.summary, /Acceptance page/u, "the page title came back from the browser");
    assert.match(executions[1].data.summary, /ACCEPT-4217/u, "the snapshot is the real page");
  };
  const browserProfile = join(dataDirectory, "browser-profile");
  const browserRunning = () => spawnSync("pgrep", ["-f", browserProfile], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);

  await t.test("E. browser: an approved browser tool opens and reads a loopback page, and relaunches after the browser is closed", { skip: skipBrowser }, async () => {
    // Browser tools are denied until the owner allows them.
    const refused = await openSession({ title: "Browse before allowing" });
    await say(refused.id, `[scenario:browse] Open ${pageUrl}.`);
    await waitForSession(refused.id, (s) => TERMINAL.includes(s.status));
    const first = (await events(refused.id)).find((e) => e.kind === "tool_execution");
    if (!REAL) assert.equal(first?.data.errorCode, "POLICY_DENIED", JSON.stringify(first?.data));
    await setPolicy("browser.control", "allow");
    await setPolicy("browser.read", "allow");
    await browseOnce("Browse");
    if (process.platform === "win32") return;
    // Close the browser out from under Atlas (as a crash or the owner closing it would).
    const pids = browserRunning();
    assert.ok(pids.length > 0, "a browser is running on Atlas's own profile");
    spawnSync("pkill", ["-KILL", "-f", browserProfile]);
    for (let i = 0; i < 50 && browserRunning().length; i += 1) await sleep(100);
    assert.equal(browserRunning().length, 0, "the browser is gone");
    await browseOnce("Browse after the browser was closed");
    assert.ok(browserRunning().length > 0, "Atlas launched a new browser");
  });

  await t.test("G1. model unavailable: connection refused and HTTP 500 end in an honest failure naming the model server", { skip: REAL && "needs control of the model server" }, async () => {
    await fake.close();
    const chat = await openSession({ title: "Model down" });
    await say(chat.id, "Hello while the model is down");
    let done = (await waitForSession(chat.id, (s) => TERMINAL.includes(s.status))).session;
    assert.equal(done.status, "failed");
    let error = (await events(chat.id)).find((e) => e.kind === "error");
    assert.equal(error?.data.code, "MODEL_UNREACHABLE", JSON.stringify(error));
    assert.match(error.data.summary, /Start Ollama/u, "the hint says to start the model server");
    assert.match(error.data.summary, new RegExp(fake.origin.replace(/[.]/gu, "\\.")), "and where Atlas looked");

    if (!skipCoder) {
      await setPolicy("code.write", "allow");
      const run = await coderRun("[scenario:fix] Fix the failing test while the model is down.");
      assert.equal(run.session.status, "failed", run.session.summary);
      assert.match(run.session.summary, /Start Ollama/u, run.session.summary);
      await setPolicy("code.write", "ask");
    }

    await fake.listen();
    fake.state.mode = "error500";
    const broken = await openSession({ title: "Model broken" });
    await say(broken.id, "Hello while the model fails");
    done = (await waitForSession(broken.id, (s) => TERMINAL.includes(s.status))).session;
    assert.equal(done.status, "failed");
    error = (await events(broken.id)).find((e) => e.kind === "error");
    assert.match(error?.data.code ?? "", /^MODEL_/u, JSON.stringify(error));
    assert.match(error.data.summary, /HTTP 500/u);
    assert.match(error.data.summary, /llama runner process has terminated/u, "the server's own reason is passed on");
    assert.match(error.data.summary, /installed and fits in memory/u, "with what to check");
    assert.match(error.data.summary, /ollama ps/u);
    fake.state.mode = "ok";
  });

  await t.test("G2. permission denied: a denied capability blocks the work and says where to allow it", async () => {
    await setPolicy("code.write", "deny");
    const before = modelCallsBefore();
    const coding = await openSession({ title: "Denied", repository, executor: "local" });
    await say(coding.id, "[scenario:fix] Fix the failing test.");
    const { session: done } = await waitForSession(coding.id, (s) => TERMINAL.includes(s.status), 60_000);
    assert.equal(done.status, "failed", done.summary);
    assert.match(done.summary, /code\.write/u, "the blocker names the capability");
    assert.match(done.summary, /Policies|policy/u, "and where to allow it");
    assert.equal(modelCallsBefore(), before, "nothing ran: the model was never called");
    assert.equal((await call("/v1/approvals")).body.approvals.filter((a) => a.sessionId === coding.id).length, 0, "a deny is not an approval prompt");

    // Denying an approval is just as final.
    await setPolicy("code.write", "ask");
    const asked = await openSession({ title: "Approval denied", repository, executor: "local" });
    await say(asked.id, "[scenario:fix] Fix the failing test.");
    await waitForSession(asked.id, (s) => s.status === "awaiting_approval", 60_000);
    await decide(await pendingApproval(asked.id, "code.write"), "denied");
    const denied = (await waitForSession(asked.id, (s) => ["completed", "failed", "cancelled"].includes(s.status))).session;
    assert.notEqual(denied.status, "completed");
    assert.match(denied.summary, /Denied/u);
    assert.equal(modelCallsBefore(), before, "the denied work never reached the model");
    await setPolicy("code.write", "deny");
  });

  await t.test("G3. missing repository: refused before anything runs", async () => {
    const missing = join(root, "does-not-exist");
    let created = await call("/v1/sessions", { method: "POST", body: { title: "Missing", model: MODEL, repository: missing, executor: "local" } });
    assert.equal(created.status, 404, created.text);
    assert.equal(created.body.code, "REPOSITORY_NOT_FOUND");
    assert.match(created.body.message, /does-not-exist/u);
    created = await call("/v1/sessions", { method: "POST", body: { title: "Missing chat", model: MODEL, repository: missing, executor: "conversation" } });
    assert.equal(created.status, 404, "a chat cannot be pointed at a folder that does not exist either");
    created = await call("/v1/sessions", { method: "POST", body: { title: "File", model: MODEL, repository: join(repository, "README.md"), executor: "local" } });
    assert.equal(created.status, 404, "a file is not a repository");
    const plain = join(root, "not-a-repo");
    mkdirSync(plain, { recursive: true });
    created = await call("/v1/sessions", { method: "POST", body: { title: "Plain folder", model: MODEL, repository: plain, executor: "local" } });
    assert.equal(created.status, 400, created.text);
    assert.equal(created.body.code, "NOT_A_GIT_REPOSITORY");
    created = await call("/v1/sessions", { method: "POST", body: { title: "None", model: MODEL, executor: "local" } });
    assert.equal(created.status, 400);
    assert.equal(created.body.code, "REPOSITORY_REQUIRED");
    assert.ok(!(await call("/v1/sessions")).body.sessions.some((s) => s.repository === missing || s.repository === plain), "no session was created");
  });

  await t.test("H. persistence: restart on the same data directory keeps identity, configuration, authorization and honest state", async () => {
    // Before the restart: a paired device, a model plan, saved policies and a run in flight.
    const pairing = await call("/v1/pair", { method: "POST", body: {} });
    assert.equal(pairing.status, 201, pairing.text);
    const claimed = await fetch(`${base}/v1/pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pairing.body.code, name: "Acceptance phone" }) });
    assert.equal(claimed.status, 201);
    const { deviceToken } = await claimed.json();
    assert.equal((await call("/v1/identity", { token: deviceToken })).body.role, "device");
    const plan = await call("/v1/models/hosting/plan", { method: "POST", body: { coder: { tag: MODEL, context: 16384 } } });
    assert.equal(plan.status, 200, plan.text);
    const policiesBefore = (await call("/v1/policies")).body.policies;
    assert.equal(policiesBefore.find((p) => p.capability === "code.write").decision, "deny");
    const healthBefore = (await call("/v1/models/health")).body.servers;

    let slow = null;
    if (!REAL) {
      slow = await openSession({ title: "Interrupted" });
      await say(slow.id, "[scenario:slow] Take your time.");
      await waitForSession(slow.id, (s) => s.status === "running", 30_000);
      await sleep(500);
    }
    // A hard stop: nothing gets to clean up.
    await stopDaemon("SIGKILL");
    await startDaemon();

    // Authentication.
    assert.equal((await call("/v1/identity")).body.role, "owner", "the owner token still works");
    const device = await call("/v1/identity", { token: deviceToken });
    assert.equal(device.status, 200, device.text);
    assert.equal(device.body.role, "device", "the paired device token still works");
    assert.equal((await call("/v1/identity", { token: `${TOKEN}x` })).status, 401, "an invalid token is still refused");
    assert.equal((await fetch(`${base}/v1/identity`)).status, 401);

    // Model configuration.
    const hosting = (await call("/v1/models/hosting")).body;
    assert.equal(hosting.applied?.coder?.tag, MODEL, "the selected local model is still applied");
    assert.equal(hosting.applied.coder.context, 16384);
    const healthAfter = (await call("/v1/models/health")).body.servers;
    assert.deepEqual(healthAfter, healthBefore, "the same model endpoint and models are configured");

    // Workspace authorization and policy.
    assert.deepEqual((await call("/v1/policies")).body.policies, policiesBefore, "every saved policy decision, including the deny, persists");
    const reopened = await session(repoSession.id);
    assert.equal(reopened.session.repository, repository, "the authorized repository is still the session's workspace");
    await say(repoSession.id, "[scenario:explore] Look around again after the restart.");
    await waitForSession(repoSession.id, (s) => TERMINAL.includes(s.status));
    if (!REAL) {
      const again = (await events(repoSession.id)).filter((e) => e.kind === "tool_execution").slice(-3);
      assert.deepEqual(again.map((e) => [e.data.tool, e.data.outcome]), [["repository.list", "succeeded"], ["repository.read", "succeeded"], ["repository.read", "failed"]]);
      assert.equal(again[2].data.errorCode, "PATH_ESCAPES_REPOSITORY", "an unauthorized path is still refused");
    }
    const denied = await openSession({ title: "Still denied", repository, executor: "local" });
    await say(denied.id, "[scenario:fix] Fix it.");
    const stillDenied = (await waitForSession(denied.id, (s) => TERMINAL.includes(s.status), 60_000)).session;
    assert.equal(stillDenied.status, "failed");
    assert.match(stillDenied.summary, /code\.write/u, "the saved deny is still enforced");

    // Interrupted work is marked honestly, not left running.
    if (slow) {
      // The killed process held a 30-second lease; once it lapses unrenewed the session is marked interrupted.
      const recovered = (await waitForSession(slow.id, (s) => s.status !== "running" && s.status !== "queued", 45_000)).session;
      assert.equal(recovered.status, "interrupted", JSON.stringify(recovered));
      const turn = (await session(slow.id)).turns.find((x) => x.role === "user");
      assert.notEqual(turn.state, "completed", "the unanswered turn is not marked answered");
    }
  });

  await t.test("H. browser after restart: the browser relaunches on the same profile and a browser tool still works", { skip: skipBrowser }, async () => {
    if (process.platform !== "win32") assert.equal(browserRunning().length, 0, "the killed daemon left no browser holding the profile");
    await browseOnce("Browse after restart");
  });

  await t.test("local only: no connection left this machine and every model call reached the local model", async () => {
    const attempts = existsSync(netLog) ? readFileSync(netLog, "utf8").trim().split("\n").filter(Boolean) : [];
    assert.deepEqual(attempts, [], "the daemon never connected to a non-loopback host");
    if (!REAL) {
      const calls = fake.modelCalls();
      assert.ok(calls.length > 0);
      assert.ok(calls.every((c) => c.model === MODEL), "every model call used the configured local model");
      assert.ok(fake.requests.every((r) => /^127\.0\.0\.1:\d+$/u.test(r.host ?? "")), "and was addressed to the loopback endpoint");
    }
  });
});
