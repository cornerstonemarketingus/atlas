import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GenesisService, GenesisStore } from "../src/platform/genesis/index.mjs";
import { GenesisExecutor, outputTail, testSummary } from "../src/platform/genesis/executor.mjs";
import { PreviewManager } from "../src/platform/genesis/preview.mjs";
import { createInspector, inspectOverHttp } from "../src/platform/genesis/inspector.mjs";
import { runCheck } from "../src/platform/self-improve/runtime.mjs";
import { createKernel } from "../src/agent/kernel/kernel.mjs";
import { WorldState } from "../src/agent/kernel/world-state.mjs";
import { ToolRegistry } from "../src/agent/tool-registry.mjs";

const LEAD_TRACKER = "Build a simple customer lead tracker with: add customer, name/email/phone, status, notes, dashboard, search";

async function harness(run, { coder = null, inspector = undefined, kernel = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atlas-genesis-run-"));
  const store = new GenesisStore(join(root, "genesis.sqlite"));
  const genesis = new GenesisService({ store, policy: () => ({ decision: "allow" }) });
  const preview = new PreviewManager({ registryPath: join(root, "previews.json"), runPrepare: runCheck });
  const executor = new GenesisExecutor({
    genesis, projectsRoot: join(root, "projects"), runCheck, coder, preview, kernel,
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
  if (process.env.GENESIS_REQUIRE_FULL === "1") assert.equal(inspection.mode, "browser", "the Genesis CI job must inspect in a real browser");
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

/** A scripted coder: writes a broken module for the email task, then repairs it when asked. */
function scriptedCoder({ breakTests = false } = {}) {
  const calls = [];
  const coder = async ({ workspace, task, kind, objective }) => {
    calls.push({ kind, task: task.id, objective });
    if (kind === "task") {
      writeFileSync(join(workspace, "src", "notify.mjs"), "export function notify( {\n");
      return { ok: true, summary: "Added email notifications", model: "scripted" };
    }
    if (kind === "repair") {
      if (breakTests) {
        for (const file of ["tests/app.test.mjs"]) if (existsSync(join(workspace, file))) unlinkSync(join(workspace, file));
        return { ok: true, summary: "Deleted the failing tests", model: "scripted" };
      }
      writeFileSync(join(workspace, "src", "notify.mjs"), "export function notify() {\n  return false;\n}\n");
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
    const project = await genesis.create("Build a small app where my team can log in and track tasks, and email me reminders");
    const done = await executor.run(project.id);
    assert.equal(done.state, "ready", JSON.stringify(done.transitions.at(-1), null, 1));
    const path = done.transitions.map((t) => t.to);
    assert.ok(path.indexOf("repairing") > path.indexOf("verifying"), "the check failed and went to repair");
    assert.equal(path.filter((s) => s === "verifying").length >= 2, true, "verified again after the repair");
    const failure = done.transitions.find((t) => t.to === "repairing" && t.evidence.kind === "failure").evidence.failure;
    assert.equal(failure.check, "check");
    assert.match(failure.output, /notify\.mjs/u, "the repair receives the real failure output");
    const repairCall = coder.calls.find((c) => c.kind === "repair");
    assert.match(repairCall.objective, /notify\.mjs/u);
    assert.equal(done.repairsUsed, 1);
    assert.equal(done.tasks.find((t) => /email notifications/iu.test(t.title)).status, "passed");
    assert.equal(done.tasks.find((t) => /sign-in/u.test(t.title)).executor, "template", "sign-in comes from the template");
    assert.equal(done.tasks.find((t) => t.kind === "polish").status, "passed", "one polish pass ran");
  }, { coder, inspector: async (project, preview) => inspectOverHttp(project, preview) });
});

test("a repair that deletes tests is rolled back, and the budget ends the loop", async () => {
  const coder = scriptedCoder({ breakTests: true });
  await harness(async ({ genesis, executor }) => {
    const project = await genesis.create("Build a small app where my team can log in and track tasks, and email me reminders");
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
    const project = await genesis.create("Build a small app where my team can log in and track tasks, and email me reminders");
    const blocked = await executor.run(project.id);
    assert.equal(blocked.state, "blocked");
    assert.match(blocked.transitions.at(-1).reason, /needs a coding model/u);
    assert.equal(blocked.tasks.find((t) => /email notifications/iu.test(t.title)).status, "blocked");
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

test("a Genesis build is a kernel run: each stage is an action and the outcome is recorded", async () => {
  const world = new WorldState();
  try {
    await harness(async ({ genesis, executor }) => {
      const project = await genesis.create("Build a REST API for managing inventory items");
      const done = await executor.run(project.id);
      assert.equal(done.state, "ready", JSON.stringify(done.transitions.at(-1), null, 1));
      const [run] = world.find({ type: "run" });
      assert.equal(run.attrs.status, "verified");
      assert.equal(run.attrs.harness, "genesis");
      assert.ok(world.relations(run.id).some((edge) => edge.relation === "part_of" && edge.to === `task:genesis:${project.id}`));
      const trace = world.traceOf(run.key);
      assert.deepEqual([trace[0].phase, trace.at(-1).phase], ["goal", "finish"]);
      const stages = trace.filter((entry) => entry.phase === "act").map((entry) => entry.data.tool);
      for (const stage of ["genesis.building", "genesis.verifying", "genesis.previewing", "genesis.ready"]) assert.ok(stages.includes(stage), `${stage} in ${stages.join(", ")}`);
    }, { inspector: async (project, preview) => inspectOverHttp(project, preview), kernel: createKernel({ toolRegistry: new ToolRegistry(), world }) });
  } finally {
    world.close();
  }
});

test("a Genesis build that waits on the owner is recorded as waiting, not as failed", async () => {
  const world = new WorldState();
  const coder = scriptedCoder();
  coder.available = async () => false;
  try {
    await harness(async ({ genesis, executor }) => {
      const project = await genesis.create("Build a small app where my team can log in and track tasks, and email me reminders");
      const blocked = await executor.run(project.id);
      assert.equal(blocked.state, "blocked");
      const [run] = world.find({ type: "run" });
      assert.equal(run.attrs.status, "waiting");
      assert.match(run.attrs.reason, /blocked/u);
      assert.equal(world.traceOf(run.key).filter((entry) => entry.phase === "act").at(-1).data.status, "awaiting_approval");
    }, { coder, inspector: async () => ({ ok: true, findings: [], evidence: {} }), kernel: createKernel({ toolRegistry: new ToolRegistry(), world }) });
  } finally {
    world.close();
  }
});

test("test output is summarised from node:test", () => {
  assert.deepEqual(testSummary("ok 1\n# tests 12\n# suites 0\n# pass 11\n# fail 1\n"), { tests: 12, pass: 11, fail: 1 });
  assert.equal(testSummary("no tests here"), null);
});

test("a failing test's name survives even when later tests push it out of the output tail", () => {
  const early = "not ok 3 - Items: create, list, search, update and delete\n  error: expected 201\n";
  const later = Array.from({ length: 400 }, (_, i) => `ok ${i + 10} - later test ${i}`).join("\n");
  const tail = outputTail({ stdout: `${early}${later}\n# tests 410\n# pass 409\n# fail 1\n`, stderr: "" });
  assert.ok(tail.length <= 4000);
  assert.match(tail, /^not ok 3 - Items: create, list, search, update and delete/u, "kept at the top");
  assert.match(tail, /# fail 1/u, "and the summary at the end");
  assert.equal(outputTail({ stdout: "short output", stderr: "" }), "short output");
});

test("an observer that starts runs on every transition still gets exactly one run (the daemon's wiring)", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-genesis-observer-"));
  const store = new GenesisStore(join(root, "genesis.sqlite"));
  let executor = null;
  const runs = [];
  const genesis = new GenesisService({
    store, policy: () => ({ decision: "allow" }),
    onChange: (project) => {
      if (["approved", "scaffolding", "building", "verifying", "previewing", "reviewing"].includes(project.state) && executor && !executor.isRunning(project.id)) runs.push(executor.run(project.id));
    },
  });
  const preview = new PreviewManager({ registryPath: join(root, "previews.json"), runPrepare: runCheck });
  executor = new GenesisExecutor({ genesis, projectsRoot: join(root, "projects"), runCheck, preview, inspector: async (project, running) => inspectOverHttp(project, running) });
  try {
    const project = await genesis.create("Build a REST API for managing inventory items");
    assert.equal(runs.length, 1, "creating an approved project starts one run");
    const done = await runs[0];
    assert.equal(done.state, "ready", JSON.stringify(done.transitions.at(-1)));
    assert.equal(runs.length, 1, "its own transitions never start a second run");
    assert.equal(done.transitions.filter((t) => t.to === "scaffolding").length, 1);
    assert.equal(project.id, done.id);
  } finally {
    await preview.stopAll();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("chat tools build, report, and continue the same project", async () => {
  const { ToolRegistry } = await import("../src/agent/tool-registry.mjs");
  const { registerGenesisTools } = await import("../src/platform/genesis/tools.mjs");
  const store = new GenesisStore(":memory:");
  const genesis = new GenesisService({ store, policy: () => ({ decision: "allow" }) });
  const registry = new ToolRegistry({ policy: () => "allow" });
  registerGenesisTools(registry, () => genesis);
  const tools = Object.fromEntries(["genesis.build", "genesis.status", "genesis.change", "genesis.answer", "genesis.publish"].map((name) => [name, registry.list().find((tool) => tool.name === name)]));
  for (const tool of Object.values(tools)) assert.ok(tool, "registered");
  const run = (name, input) => registry.get(name).execute({ input });
  const started = await run("genesis.build", { prompt: "Atlas, build me a simple CRM for my construction company." });
  assert.match(started, /Construction CRM — Plan approved/u);
  assert.match(started, /Plan: \d+ tasks/u);
  assert.match(started, /#\/build\/gen_/u);
  assert.match(await run("genesis.status", {}), /Construction CRM/u);
  const [project] = genesis.list();
  for (const [to, reason] of [["scaffolding", "s"], ["building", "b"], ["verifying", "v"], ["previewing", "p"], ["reviewing", "r"], ["ready", "done"]]) genesis.advance(project.id, to, { reason });
  const changed = await run("genesis.change", { request: "Add Google login" });
  assert.match(changed, /Change accepted/u);
  assert.equal(genesis.list().length, 1, "the change continued the same project");
  assert.equal(genesis.view(project.id).spec.auth.method, "google");
  const shop = await run("genesis.build", { prompt: "Build an online store that takes payments for my bakery" });
  assert.match(shop, /\[payments\]/u, "open questions are shown with their ids");
  assert.match(await run("genesis.answer", { answers: { payments: "no" } }), /Plan approved/u);
  store.close();
});

test("the vision review reads screenshots, blocks once on real breakage, then only suggests", async () => {
  const { createVisionReviewer, parseVisionAnswer, selectScreenshots, MAX_IMAGES } = await import("../src/platform/genesis/vision.mjs");
  const { startScriptedModelServer } = await import("./helpers/scripted-model-server.mjs");
  assert.deepEqual(parseVisionAnswer('Sure! {"issues":[{"screenshot":1,"problem":"The table overflows on a phone.","severity":"error"}]}'), [{ screenshot: 1, problem: "The table overflows on a phone.", severity: "error" }]);
  assert.equal(parseVisionAnswer("Looks great to me!"), null);
  assert.deepEqual(parseVisionAnswer('{"issues":[{"problem":"tight spacing","severity":"catastrophic"}]}')[0].severity, "warning");

  const root = mkdtempSync(join(tmpdir(), "atlas-genesis-vision-"));
  try {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const shots = ["_dashboard-1280.png", "_dashboard-375.png", "_customers-1280.png", "_customers-375.png", "_a-1280.png", "_b-1280.png", "_c-1280.png", "_d-375.png"].map((name) => { const file = join(root, name); writeFileSync(file, png); return file; });
    const chosen = selectScreenshots(shots);
    assert.equal(chosen.length, MAX_IMAGES);
    assert.ok(chosen.slice(0, 3).every((file) => file.endsWith("-375.png")), "phone widths first");

    let imagesSeen = 0;
    const model = await startScriptedModelServer(({ messages }) => {
      imagesSeen = messages[0].content.filter((part) => part.type === "image_url" && part.image_url.url.startsWith("data:image/png;base64,")).length;
      return { say: '{"issues":[{"screenshot":1,"problem":"The customer table is cut off on a phone.","severity":"error"},{"screenshot":2,"problem":"Buttons sit a little close together.","severity":"warning"}]}' };
    });
    try {
      const review = createVisionReviewer({ environment: { ATLAS_GENESIS_VISION_BASE_URL: model.baseUrl, ATLAS_GENESIS_VISION_MODEL: "qwen2.5vl:7b" } });
      const first = await review({ id: "gen_a" }, shots);
      assert.equal(first.reviewed, true);
      assert.equal(imagesSeen, MAX_IMAGES, "the screenshots were sent as images");
      assert.deepEqual(first.findings.map((f) => [f.check, f.severity]), [["visual", "error"], ["visual", "warning"]]);
      assert.match(first.findings[0].page, /-375\.png$/u);
      const second = await review({ id: "gen_a" }, shots);
      assert.ok(second.findings.every((f) => f.severity === "warning"), "after one visual repair, visual issues only suggest");
      const none = await createVisionReviewer({ environment: { ATLAS_GENESIS_VISION_BASE_URL: "http://127.0.0.1:9/v1" } })({ id: "gen_b" }, shots);
      assert.equal(none.reviewed, false);
      assert.match(none.reason, /No vision model/u);
    } finally {
      await model.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
