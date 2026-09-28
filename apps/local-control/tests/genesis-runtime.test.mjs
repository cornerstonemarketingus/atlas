import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobStore } from "../src/platform/genesis/templates/shared/src/jobs.mjs";
import { createAtlas } from "../src/platform/genesis/templates/shared/src/atlas.mjs";
import { createWorkspace } from "../src/platform/genesis/workspace.mjs";
import { inferSpecification } from "../src/platform/genesis/requirements.mjs";
import { execFileSync } from "node:child_process";

function folder(t) {
  const root = mkdtempSync(join(tmpdir(), "atlas-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("jobs survive restart, deduplicate and stop after bounded retries without storing exception secrets", async (t) => {
  const file = join(folder(t), "jobs.sqlite");
  let now = 100;
  let jobs = new JobStore(file, { now: () => now });
  const job = jobs.enqueue("report", { x: 1 }, { key: "daily", maxAttempts: 2 });
  assert.equal(jobs.enqueue("report", { x: 1 }, { key: "daily" }).id, job.id);
  assert.throws(() => jobs.enqueue("report", { x: 2 }, { key: "daily" }), /different work/u);
  jobs.close();
  jobs = new JobStore(file, { now: () => now });
  try {
    const fail = { report: () => { throw new Error("secret-token"); } };
    assert.equal((await jobs.runNext(fail)).state, "queued");
    assert.equal(await jobs.runNext(fail), null);
    now += 1000;
    assert.equal((await jobs.runNext(fail)).state, "failed");
    now += 100000;
    assert.equal(await jobs.runNext(fail), null);
    assert.equal(jobs.get(job.id).attempts, 2);
    assert.doesNotMatch(JSON.stringify(jobs.get(job.id)), /secret-token/u);
  } finally { jobs.close(); }
});

test("two workers respect the lease and a stale worker cannot overwrite recovered work", async (t) => {
  const file = join(folder(t), "jobs.sqlite");
  let now = 0;
  const a = new JobStore(file, { now: () => now });
  const b = new JobStore(file, { now: () => now });
  const job = a.enqueue("report");
  let finish;
  const pending = a.runNext({ report: () => new Promise((resolve) => { finish = resolve; }) }, { leaseMs: 100 });
  try {
    assert.equal(await b.runNext({ report: () => "premature" }), null);
    now = 101;
    assert.equal((await b.runNext({ report: () => "recovered" })).result, "recovered");
    finish("stale");
    await pending;
    assert.equal(a.get(job.id).result, "recovered");
    assert.equal(a.get(job.id).attempts, 2);
  } finally { a.close(); b.close(); }
});

test("runtime keeps application databases and jobs separate and persists records", (t) => {
  const root = folder(t);
  const entities = [{ slug: "items", fields: [{ key: "name", label: "Name", type: "text", required: true }] }];
  const file = join(root, "a.sqlite");
  const a = createAtlas({ entities, dataFile: file });
  const b = createAtlas({ entities, dataFile: join(root, "b.sqlite") });
  const record = a.database.create("items", { name: "First" });
  const job = a.jobs.enqueue("report");
  assert.deepEqual(b.database.list("items"), []);
  assert.equal(b.jobs.get(job.id), null);
  a.close(); b.close();
  const reopened = createAtlas({ entities, dataFile: file });
  try { assert.equal(reopened.database.get("items", record.id).name, "First"); }
  finally { reopened.close(); }
});

test("expired final attempts fail without replay, and unsupported handlers leave jobs queued", async (t) => {
  let now = 0;
  const jobs = new JobStore(join(folder(t), "jobs.sqlite"), { now: () => now });
  const job = jobs.enqueue("report", {}, { maxAttempts: 1 });
  assert.equal(await jobs.runNext({ different: () => null }), null);
  let finish;
  const running = jobs.runNext({ report: () => new Promise((resolve) => { finish = resolve; }) }, { leaseMs: 1 });
  now = 2;
  assert.equal(await jobs.runNext({ report: () => assert.fail("must not replay") }), null);
  finish("late");
  await running;
  assert.equal(jobs.get(job.id).state, "failed");
  assert.equal(jobs.get(job.id).result, null);
  assert.throws(() => jobs.enqueue("bad", {}, { maxAttempts: 11 }), /attempt limit/u);
  assert.throws(() => jobs.enqueue("bad", "x".repeat(65537)), /64 KiB/u);
  jobs.close();
});

test("generated app ships a runnable durable summary job with no dependencies", async (t) => {
  const root = folder(t);
  const spec = inferSpecification("Build a REST API for managing inventory items");
  const workspace = await createWorkspace({ root, projectId: "gen_11111111-0000", spec, templateId: "api-service" });
  const run = () => JSON.parse(execFileSync(process.execPath, ["src/run-jobs.mjs"], { cwd: workspace.folder, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const first = run();
  assert.equal(first.state, "completed");
  assert.ok(Object.keys(first.result).length > 0);
  assert.equal(run().id, first.id);
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: workspace.folder, stdio: "pipe" });
  const built = JSON.parse(execFileSync(process.execPath, ["src/run-jobs.mjs"], { cwd: join(workspace.folder, "dist"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(built.state, "completed");
});
