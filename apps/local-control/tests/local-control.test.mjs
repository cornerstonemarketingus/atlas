import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createLocalControlServer } from "../src/server.mjs";
import { runIsolatedLocalCoder } from "../src/runner.mjs";
import { LocalTaskStore } from "../src/store.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";

test("local control plane authenticates, persists, and completes tasks", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-local-control-"));
  const store = new LocalTaskStore(join(directory, "test.sqlite"));
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true, message: "verified locally" }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); store.close(); await rm(directory, { recursive: true, force: true }); });
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  assert.equal((await fetch(`${origin}/health`)).status, 200);
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Atlas Local/u);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/u);
  assert.equal((await fetch(`${origin}/v1/tasks`)).status, 401);
  const created = await fetch(`${origin}/v1/tasks`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ repository: directory, objective: "Document sovereign mode." }),
  });
  assert.equal(created.status, 202);
  const { task } = await created.json();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const fetched = await fetch(`${origin}/v1/tasks/${task.id}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(fetched.status, 200);
  assert.equal((await fetched.json()).task.status, "completed");
  assert.equal(store.list()[0].message, "verified locally");
});

test("running tasks are marked interrupted after a restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-local-restart-"));
  const filename = join(directory, "test.sqlite");
  const first = new LocalTaskStore(filename);
  const task = first.create({ repository: directory, objective: "test", model: "local" });
  first.markRunning(task.id); first.close();
  const second = new LocalTaskStore(filename);
  t.after(async () => { second.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(second.get(task.id).status, "interrupted");
});

test("isolated delivery rejects a non-Git directory without mutating it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-local-not-git-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await runIsolatedLocalCoder({ id: "00000000-0000-4000-8000-000000000001", repository: directory, objective: "test", model: "local" }, { dataDirectory: join(directory, "data") });
  assert.equal(result.ok, false);
  assert.match(result.message, /not a Git work tree/u);
});

test("Git worktree command accepts an ordinary repository path", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-local-git-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(spawnSync("git", ["init", directory], { encoding: "utf8" }).status, 0);
  const check = spawnSync("git", ["-C", directory, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  assert.equal(check.stdout.trim(), "true");
});
