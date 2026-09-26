import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SelfImprovementLoop } from "../src/platform/self-improve/loop.mjs";
import { resolveCheck, runCheck, assertSafeEndpoint } from "../src/platform/self-improve/runtime.mjs";
import { SelfImprovementService, createSelfImproveRoutes } from "../src/platform/self-improve/service.mjs";

function sh(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "atlas-selfsvc-"));
  const repository = join(root, "repo");
  mkdirSync(join(repository, "src"), { recursive: true });
  mkdirSync(join(repository, "tests"), { recursive: true });
  writeFileSync(join(repository, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
  writeFileSync(join(repository, "src", "math.mjs"), "export function add(a, b) { return a - b; }\n");
  writeFileSync(join(repository, "tests", "math.test.mjs"), "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from '../src/math.mjs';\ntest('adds', () => assert.equal(add(2, 3), 5));\n");
  sh(repository, "init", "-q", "-b", "main");
  sh(repository, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
  sh(repository, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const service = new SelfImprovementService({
    repository,
    decisionsPath: join(root, "decisions.jsonl"),
    createLoop: ({ log, onOutput }) => new SelfImprovementLoop({
      repository, worktreeRoot: join(root, "worktrees"), ledgerPath: join(root, "ledger.jsonl"), patchesDirectory: join(root, "patches"),
      runCheck, log,
      builder: async ({ worktree }) => { onOutput("coder: fixing add()\n"); writeFileSync(join(worktree, "src", "math.mjs"), "export function add(a, b) { return a + b; }\n"); return { ok: true }; },
      reviewer: async () => ({ approve: true, summary: "Correct.", concerns: [] }),
    }),
  });
  return { root, repository, service };
}

test("a run happens in the background, streams progress, and leaves the change waiting for approval", async () => {
  const { root, repository, service } = setup();
  const started = service.start({ iterations: 1 });
  assert.equal(started.running, true);
  assert.throws(() => service.start({ iterations: 1 }), /already in progress/u);
  await started.promise;
  const status = service.status();
  assert.equal(status.running, false);
  assert.equal(status.streak, 1);
  assert.equal(status.pending.length, 1);
  assert.ok(status.log.some((line) => line.includes("│ coder: fixing add()")));
  assert.ok(status.log.some((line) => line.includes("accepted")));
  // Nothing reached the checkout yet.
  assert.match(readFileSync(join(repository, "src", "math.mjs"), "utf8"), /a - b/u);
  rmSync(root, { recursive: true, force: true });
});

test("approve merges into the owner's branch with a merge commit and removes the agent branch", async () => {
  const { root, repository, service } = setup();
  await service.start().promise;
  const [change] = service.pending();
  const decision = await service.approve(change.id);
  assert.equal(decision.decision, "approved");
  assert.equal(decision.into, "main");
  assert.match(readFileSync(join(repository, "src", "math.mjs"), "utf8"), /a \+ b/u);
  assert.match(sh(repository, "log", "-1", "--pretty=%s"), /Merge Atlas self-improvement/u);
  assert.equal(sh(repository, "branch", "--list", "atlas/*"), "");
  assert.equal(service.pending().length, 0);
  await assert.rejects(service.approve(change.id), /No accepted change/u);
  rmSync(root, { recursive: true, force: true });
});

test("approve refuses a dirty checkout and changes nothing; reject deletes the branch", async () => {
  const { root, repository, service } = setup();
  await service.start().promise;
  const [change] = service.pending();
  writeFileSync(join(repository, "notes.txt"), "work in progress");
  await assert.rejects(service.approve(change.id), (error) => error.code === "DIRTY_CHECKOUT");
  assert.match(readFileSync(join(repository, "src", "math.mjs"), "utf8"), /a - b/u);
  const decision = await service.reject(change.id, "Not now.");
  assert.equal(decision.decision, "rejected");
  assert.equal(sh(repository, "branch", "--list", "atlas/*"), "");
  assert.equal(service.pending().length, 0);
  assert.equal(service.status().decisions[0].reason, "Not now.");
  rmSync(root, { recursive: true, force: true });
});

test("routes: anyone authenticated can read; only the owner can start, approve or reject", async () => {
  const { root, service } = setup();
  const sent = [];
  const send = (_response, status, value) => { sent.push({ status, value }); return true; };
  const parseBody = async (request) => request.body;
  const handle = createSelfImproveRoutes({ service, parseBody, send });
  const request = (method, url, body = {}) => ({ method, url, body });
  assert.equal(await handle(request("GET", "/v1/other"), {}, { role: "admin" }), false);
  await handle(request("GET", "/v1/self-improve"), {}, { role: "device" });
  assert.equal(sent.at(-1).status, 200);
  await handle(request("POST", "/v1/self-improve/runs", { iterations: 1 }), {}, { role: "device" });
  assert.equal(sent.at(-1).status, 403);
  await handle(request("POST", "/v1/self-improve/runs", { iterations: 1 }), {}, { role: "admin" });
  assert.equal(sent.at(-1).status, 202);
  await handle(request("POST", "/v1/self-improve/runs", { iterations: 1 }), {}, { role: "admin" });
  assert.equal(sent.at(-1).status, 409);
  await service.current?.promise;
  await handle(request("POST", "/v1/self-improve/changes/nope/approve"), {}, { role: "admin" });
  assert.equal(sent.at(-1).status, 404);
  const [change] = service.pending();
  await handle(request("POST", `/v1/self-improve/changes/${change.id}/reject`, { reason: "x" }), {}, { role: "admin" });
  assert.equal(sent.at(-1).status, 200);
  rmSync(root, { recursive: true, force: true });
});

test("runtime: node and npm run without a shell on every platform; endpoints must be safe", () => {
  assert.deepEqual(resolveCheck(["node", "--test"], { platform: "linux", execPath: "/usr/bin/node" }), ["/usr/bin/node", ["--test"]]);
  assert.deepEqual(resolveCheck(["npm", "test"], { platform: "linux", execPath: "/usr/bin/node" }), ["npm", ["test"]]);
  assert.throws(() => assertSafeEndpoint("http://models.example.com/v1"), /HTTPS/u);
  assert.throws(() => assertSafeEndpoint("https://user:pw@models.example.com/v1"), /credentials/u);
  assert.ok(assertSafeEndpoint("http://127.0.0.1:11434/v1"));
});
