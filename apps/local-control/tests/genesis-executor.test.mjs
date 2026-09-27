import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GenesisService, GenesisStore } from "../src/platform/genesis/index.mjs";
import { GenesisExecutor, testSummary } from "../src/platform/genesis/executor.mjs";
import { PreviewManager } from "../src/platform/genesis/preview.mjs";
import { createInspector, inspectOverHttp } from "../src/platform/genesis/inspector.mjs";
import { runCheck } from "../src/platform/self-improve/runtime.mjs";

const LEAD_TRACKER = "Build a simple customer lead tracker with: add customer, name/email/phone, status, notes, dashboard, search";

async function harness(run, { coder = null, inspector = undefined } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atlas-genesis-run-"));
  const store = new GenesisStore(join(root, "genesis.sqlite"));
  const genesis = new GenesisService({ store, policy: () => ({ decision: "allow" }) });
  const preview = new PreviewManager({ registryPath: join(root, "previews.json"), runPrepare: runCheck });
  const executor = new GenesisExecutor({
    genesis, projectsRoot: join(root, "projects"), runCheck, coder, preview,
    inspector: inspector === undefined ? createInspector({ artifactsRoot: join(root, "inspections") }) : inspector,
  });
  try {
    await run({ root, store, genesis, executor, preview });
  } finally {
    await preview.stopAll();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

test("the lead tracker fixture goes from one sentence to a verified, running application", () => harness(async ({ genesis, executor, preview }) => {
  const project = await genesis.create(LEAD_TRACKER);
  assert.equal(project.state, "approved");
  const done = await executor.run(project.id);
  assert.equal(done.state, "ready", JSON.stringify(done.transitions.at(-1), null, 1));
  assert.deepEqual(done.transitions.map((t) => t.to), ["idea", "requirements", "planned", "approved", "scaffolding", "building", "verifying", "previewing", "reviewing", "ready"]);
  for (const task of done.tasks) assert.ok(["passed", "skipped"].includes(task.status), `${task.title} is ${task.status}`);
  assert.equal(done.tasks.find((t) => t.kind === "polish").status, "skipped", "no model here, so polish is skipped and says so");

  // Real verification evidence: the project's own tests ran and passed.
  const checks = done.transitions.find((t) => t.to === "previewing").evidence.results;
  assert.deepEqual(checks.map((r) => [r.name, r.exitCode]), [["check", 0], ["test", 0], ["build", 0]]);
  assert.ok(checks.find((r) => r.name === "test").summary.pass >= 4);

  // The application is actually running, and it is the lead tracker.
  const config = await (await fetch(`${done.preview.url}/api/config`)).json();
  assert.equal(config.entities[0].name, "Customer");
  assert.deepEqual(config.entities[0].fields.map((f) => f.key), ["name", "email", "phone", "status", "notes"]);
  const added = await fetch(`${done.preview.url}/api/customers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Ada", email: "ada@example.com", status: "Qualified" }) });
  assert.equal(added.status, 201);
  assert.equal((await (await fetch(`${done.preview.url}/api/customers?q=ada`)).json()).records.length, 1);

  // The inspection is recorded, and it says whether a browser was used.
  const inspection = done.tasks.find((t) => t.executor === "browser").evidence.at(-1);
  assert.ok(["browser", "http"].includes(inspection.mode));
  if (inspection.mode === "browser") {
    assert.ok(inspection.checks.some((c) => c.name === "add customer through the form" && c.ok));
    assert.ok(inspection.checks.some((c) => c.name === "find customer by search" && c.ok));
  }
  const summary = done.transitions.at(-1).evidence.summary;
  assert.equal(summary.preview, done.preview.url);
  assert.ok(summary.features.includes("Add a customer"));
  assert.ok(summary.limitations.some((l) => /Polish/u.test(l)));
  assert.ok(existsSync(join(summary.folder, ".git")), "a real git repository, no GitHub needed");
  assert.equal(preview.status(project.id).state, "running");
}));

/** A scripted coder: writes a broken module for the sign-in task, then repairs it when asked. */
function scriptedCoder({ breakTests = false } = {}) {
  const calls = [];
  const coder = async ({ workspace, task, kind, objective }) => {
    calls.push({ kind, task: task.id, objective });
    if (kind === "task") {
      writeFileSync(join(workspace, "src", "auth.mjs"), "export function signIn( {\n");
      return { ok: true, summary: "Added sign-in", model: "scripted" };
    }
    if (kind === "repair") {
      if (breakTests) {
        for (const file of ["tests/app.test.mjs"]) if (existsSync(join(workspace, file))) unlinkSync(join(workspace, file));
        return { ok: true, summary: "Deleted the failing tests", model: "scripted" };
      }
      writeFileSync(join(workspace, "src", "auth.mjs"), "export function signIn() {\n  return false;\n}\n");
      return { ok: true, summary: "Fixed the syntax error", model: "scripted" };
    }
    return { ok: true, summary: "No polish needed", model: "scripted" };
  };
  coder.available = async () => true;
  coder.calls = calls;
  return coder;
}

test("a failed check is repaired with its evidence and verified again", async () => {
  const coder = scriptedCoder();
  await harness(async ({ genesis, executor }) => {
    const project = await genesis.create("Build a small app where my team can log in and track tasks");
    const done = await executor.run(project.id);
    assert.equal(done.state, "ready", JSON.stringify(done.transitions.at(-1), null, 1));
    const path = done.transitions.map((t) => t.to);
    assert.ok(path.indexOf("repairing") > path.indexOf("verifying"), "the check failed and went to repair");
    assert.equal(path.filter((s) => s === "verifying").length >= 2, true, "verified again after the repair");
    const failure = done.transitions.find((t) => t.to === "repairing" && t.evidence.kind === "failure").evidence.failure;
    assert.equal(failure.check, "check");
    assert.match(failure.output, /auth\.mjs/u, "the repair receives the real failure output");
    const repairCall = coder.calls.find((c) => c.kind === "repair");
    assert.match(repairCall.objective, /auth\.mjs/u);
    assert.equal(done.repairsUsed, 1);
    assert.equal(done.tasks.find((t) => /sign-in/u.test(t.title)).status, "passed");
    assert.equal(done.tasks.find((t) => t.kind === "polish").status, "passed", "one polish pass ran");
  }, { coder, inspector: async (project, preview) => inspectOverHttp(project, preview) });
});

test("a repair that deletes tests is rolled back, and the budget ends the loop", async () => {
  const coder = scriptedCoder({ breakTests: true });
  await harness(async ({ genesis, executor }) => {
    const project = await genesis.create("Build a small app where my team can log in and track tasks");
    const done = await executor.run(project.id);
    assert.equal(done.state, "failed");
    assert.match(done.transitions.at(-1).reason, /Still failing after 3 repair attempt/u);
    const rejected = done.transitions.filter((t) => t.evidence.kind === "repair-result");
    assert.equal(rejected.length, 3);
    assert.ok(rejected.every((t) => t.evidence.violations.some((v) => v.rule === "deleted-test")));
    assert.ok(existsSync(join(done.workspace, "tests", "app.test.mjs")), "the tests are still there");
  }, { coder, inspector: async () => ({ ok: true, findings: [], evidence: {} }) });
});

test("a task that needs a model blocks with the reason, then continues when resumed", async () => {
  let available = false;
  const coder = scriptedCoder();
  coder.available = async () => available;
  await harness(async ({ genesis, executor }) => {
    const project = await genesis.create("Build a small app where my team can log in and track tasks");
    const blocked = await executor.run(project.id);
    assert.equal(blocked.state, "blocked");
    assert.match(blocked.transitions.at(-1).reason, /needs a coding model/u);
    assert.equal(blocked.tasks.find((t) => /sign-in/u.test(t.title)).status, "blocked");
    available = true;
    genesis.resume(project.id);
    const done = await executor.run(project.id);
    assert.equal(done.state, "ready", JSON.stringify(done.transitions.at(-1)));
  }, { coder, inspector: async (project, preview) => inspectOverHttp(project, preview) });
});

test("an interrupted build resumes where it stopped after a restart", () => harness(async ({ root, store, genesis, executor }) => {
  const project = await genesis.create(LEAD_TRACKER);
  // Run only as far as the checks, then "crash".
  genesis.advance(project.id, "scaffolding", { reason: "start" });
  await executor.run(project.id).catch(() => {});
  const view = genesis.view(project.id);
  assert.equal(view.state, "ready");
  // A second project interrupted mid-verification: recovery pauses it; resume finishes it.
  const second = await genesis.create("Build a REST API for managing inventory items");
  genesis.advance(second.id, "scaffolding", { reason: "start" });
  const recovered = genesis.recover();
  assert.deepEqual(recovered.map((p) => p.id), [second.id]);
  genesis.resume(second.id);
  const done = await executor.run(second.id);
  assert.equal(done.state, "ready", JSON.stringify(done.transitions.at(-1)));
  assert.equal(done.tasks.find((t) => t.executor === "browser").evidence.at(-1).mode, "http", "an API is inspected over HTTP");
}));

test("the preview manager starts on a free port, reports failed starts with logs, and stops", () => harness(async ({ root, genesis, executor, preview }) => {
  const project = await genesis.create("Build a REST API for managing inventory items");
  const done = await executor.run(project.id);
  assert.equal(done.state, "ready");
  const status = preview.status(project.id);
  assert.equal(status.state, "running");
  assert.equal(JSON.parse(readFileSync(join(root, "previews.json"), "utf8"))[project.id].port, status.port);
  // Break the app: a start now fails with the error in the logs.
  writeFileSync(join(done.workspace, "server.mjs"), "throw new Error('boom at startup');\n");
  const failed = await preview.start(done, { timeoutMs: 5_000 });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /exited during startup/u);
  assert.match(failed.logs, /boom at startup/u);
  assert.equal(await preview.stop(project.id), false);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "previews.json"), "utf8")), {});
  // Orphan cleanup never kills a process it cannot confirm is a preview.
  writeFileSync(join(root, "previews.json"), JSON.stringify({ gen_x: { pid: process.pid, port: 1, folder: "/nowhere/else" } }));
  const cleaned = preview.cleanupOrphans();
  assert.equal(cleaned[0].action, "left");
}));

test("test output is summarised from node:test", () => {
  assert.deepEqual(testSummary("ok 1\n# tests 12\n# suites 0\n# pass 11\n# fail 1\n"), { tests: 12, pass: 11, fail: 1 });
  assert.equal(testSummary("no tests here"), null);
});
