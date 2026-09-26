import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CATALOG, assessCatalog, catalogEntry, fittingContext, memoryRequiredGiB, planModels } from "../src/agent/models/catalog.mjs";
import { classifyDifficulty, modelForDifficulty } from "../src/agent/models/difficulty.mjs";
import { detectHardware, parseRocm } from "../src/agent/models/hardware.mjs";
import { ModelPlanStore, createModelHostingRoutes } from "../src/agent/models/hosting.mjs";
import { ModelManager, ModelManagerError, assertModelTag, ollamaCandidates, pullProgress } from "../src/agent/models/manager.mjs";

const cpu16 = { cpuCount: 8, totalMemoryGiB: 16, gpus: [], unifiedMemory: false, usableModelMemoryGiB: 16 };
const cpu8 = { cpuCount: 4, totalMemoryGiB: 8, gpus: [], unifiedMemory: false, usableModelMemoryGiB: 8 };
const gpu24 = { cpuCount: 16, totalMemoryGiB: 64, gpus: [{ vendor: "nvidia", name: "RTX 4090", memoryGiB: 24 }], unifiedMemory: false, usableModelMemoryGiB: 24 };
const mac64 = { cpuCount: 12, totalMemoryGiB: 64, gpus: [], unifiedMemory: true, usableModelMemoryGiB: 48 };

test("memory estimates grow with parameters and context", () => {
  const seven = catalogEntry("qwen2.5-coder:7b");
  assert.ok(memoryRequiredGiB(seven, 8_192) > 4 && memoryRequiredGiB(seven, 8_192) < 6);
  assert.ok(memoryRequiredGiB(seven, 32_768) > memoryRequiredGiB(seven, 8_192));
  assert.ok(memoryRequiredGiB(catalogEntry("qwen2.5-coder:32b"), 8_192) > 18);
  // Context never exceeds what the model itself supports, and shrinks to fit.
  assert.equal(fittingContext(seven, gpu24), 32_768);
  assert.equal(fittingContext(catalogEntry("qwen2.5-coder:32b"), cpu16), null);
  assert.equal(new Set(CATALOG.map((entry) => entry.tag)).size, CATALOG.length);
});

test("the planner picks stronger models as the machine grows", () => {
  const small = planModels(cpu8);
  const medium = planModels(cpu16);
  const large = planModels(gpu24);
  const score = (plan) => catalogEntry(plan.coder.tag).coding;
  assert.ok(small.coder && medium.coder && large.coder);
  assert.ok(score(small) <= score(medium) && score(medium) <= score(large));
  assert.ok(catalogEntry(large.coder.tag).coding >= 8);
  for (const plan of [small, medium, large, planModels(mac64)]) {
    assert.ok(catalogEntry(plan.coder.tag).tools, "the coder must drive tools");
    assert.ok(!catalogEntry(plan.coder.tag).vision);
  }
  // The reviewer prefers another family, so it does not share the coder's blind spots.
  assert.notEqual(catalogEntry(large.reviewer.tag).family, catalogEntry(large.coder.tag).family);
  assert.deepEqual(large.missing.sort(), [...new Set([large.coder.tag, large.reviewer.tag, large.fast.tag])].sort());
});

test("preferInstalled keeps the plan to downloaded models, and tiny machines get an honest answer", () => {
  const plan = planModels(gpu24, ["qwen2.5-coder:7b"], { preferInstalled: true });
  assert.equal(plan.coder.tag, "qwen2.5-coder:7b");
  assert.deepEqual(plan.missing, []);
  const none = planModels({ ...cpu8, usableModelMemoryGiB: 1 });
  assert.equal(none.coder, null);
  assert.match(none.summary, /remote OpenAI-compatible endpoint/u);
  const assessed = assessCatalog(cpu16, ["qwen3:8b"]);
  assert.equal(assessed.find((entry) => entry.tag === "qwen3:8b").installed, true);
  assert.equal(assessed.find((entry) => entry.tag === "qwen2.5-coder:32b").fits, false);
});

test("difficulty routes simple work to the fast model and escalates retries", () => {
  assert.equal(classifyDifficulty({ objective: "Fix a typo in the README", kind: "todo-comment" }).level, "simple");
  assert.equal(classifyDifficulty({ objective: "Make the failing test pass", kind: "failing-check" }).level, "standard");
  assert.equal(classifyDifficulty({ objective: "Refactor the session store for concurrency" }).level, "hard");
  assert.equal(classifyDifficulty({ objective: "Touch src/a.mjs, src/b.mjs and src/c.mjs" }).level, "hard");
  const retry = classifyDifficulty({ objective: "Fix a typo", kind: "todo-comment", attempt: 2 });
  assert.equal(retry.level, "hard");
  assert.match(retry.reasons.join(" "), /escalating/u);

  const plan = { coder: { tag: "qwen3-coder:30b", context: 32_768 }, fast: { tag: "qwen2.5-coder:3b", context: 16_384 }, reviewer: { tag: "gpt-oss:20b" } };
  assert.equal(modelForDifficulty(plan, "simple").tag, "qwen2.5-coder:3b");
  assert.equal(modelForDifficulty(plan, "hard").tag, "qwen3-coder:30b");
  assert.equal(modelForDifficulty(null, "hard", { tag: "fallback" }).tag, "fallback");
  // A plan entry that is not installed is skipped rather than failing the run.
  assert.equal(modelForDifficulty({ ...plan, fast: { ...plan.fast, installed: false } }, "simple").tag, "qwen3-coder:30b");
});

test("hardware: AMD cards, Apple unified memory and free memory are reported", async () => {
  assert.deepEqual(parseRocm(JSON.stringify({ card0: { "VRAM Total Memory (B)": String(16 * 1024 ** 3), "Card series": "Radeon RX 7800" }, system: {} })), [{ vendor: "amd", name: "Radeon RX 7800", memoryGiB: 16 }]);
  assert.deepEqual(parseRocm("not json"), []);
  const amd = await detectHardware({
    runCommandImpl: async (command) => (command === "rocm-smi" ? { ok: true, stdout: JSON.stringify({ card0: { "VRAM Total Memory (B)": String(24 * 1024 ** 3), "Card series": "RX 7900" } }) } : { ok: false, stdout: "" }),
    os: { platform: "linux", arch: "x64", totalmem: 32 * 1024 ** 3, freemem: 20 * 1024 ** 3 },
  });
  assert.equal(amd.accelerator, "amd");
  assert.equal(amd.usableModelMemoryGiB, 24);
  assert.equal(amd.freeMemoryGiB, 20);
  const calls = [];
  const mac = await detectHardware({ runCommandImpl: async (command) => { calls.push(command); return { ok: false, stdout: "" }; }, os: { platform: "darwin", arch: "arm64", totalmem: 64 * 1024 ** 3, freemem: 30 * 1024 ** 3 } });
  assert.equal(mac.accelerator, "apple");
  assert.equal(mac.unifiedMemory, true);
  assert.equal(mac.usableModelMemoryGiB, 48);
  assert.deepEqual(calls, []);
});

function fakeOllama({ up = true } = {}) {
  const state = { up, pulled: [], deleted: [], generated: [], models: [{ name: "qwen2.5-coder:7b", size: 4.7e9, details: { quantization_level: "Q4_K_M" } }] };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  state.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (!state.up) throw new TypeError("fetch failed");
    if (path === "/api/version") return json({ version: "0.12.0" });
    if (path === "/api/tags") return json({ models: state.models });
    if (path === "/api/ps") return json({ models: [{ name: "qwen2.5-coder:7b", size: 6e9, size_vram: 0, context_length: 16_384 }] });
    if (path === "/api/pull") {
      const { model } = JSON.parse(init.body);
      state.pulled.push(model);
      if (model === "broken:1b") return new Response(`${JSON.stringify({ error: "pull model manifest: file does not exist" })}\n`);
      const lines = [{ status: "pulling manifest" }, { status: "downloading", total: 100, completed: 40 }, { status: "downloading", total: 100, completed: 100 }, { status: "success" }];
      return new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    }
    if (path === "/api/delete") { const { model } = JSON.parse(init.body); state.deleted.push(model); return new Response(null, { status: state.models.some((entry) => entry.name === model) ? 200 : 404 }); }
    if (path === "/api/generate") { state.generated.push(JSON.parse(init.body)); return json({ done: true }); }
    return json({}, 404);
  };
  return state;
}

test("the manager reports status, installs with progress, removes and warms models", async () => {
  const ollama = fakeOllama();
  const manager = new ModelManager({ fetchImpl: ollama.fetch, findBinary: () => "/usr/bin/ollama", spawnImpl: () => assert.fail("must not start a second server") });
  const status = await manager.status();
  assert.equal(status.reachable, true);
  assert.equal(status.version, "0.12.0");
  assert.deepEqual(status.installed, [{ tag: "qwen2.5-coder:7b", sizeGB: 4.7, quantization: "Q4_K_M" }]);
  assert.equal(status.loaded[0].context, 16_384);

  const job = manager.install("qwen3:8b");
  assert.equal(manager.install("qwen3:8b"), job, "a second install of the same model joins the running one");
  await job.promise;
  assert.equal(job.state, "done");
  assert.equal(job.percent, 100);
  assert.deepEqual(ollama.pulled, ["qwen3:8b"]);

  const failed = manager.install("broken:1b");
  await failed.promise;
  assert.equal(failed.state, "failed");
  assert.match(failed.status, /does not exist/u);

  assert.deepEqual(await manager.remove("qwen2.5-coder:7b"), { removed: "qwen2.5-coder:7b" });
  await assert.rejects(manager.remove("missing:1b"), /not installed/u);
  assert.deepEqual(await manager.warm("qwen2.5-coder:7b", 999_999), { loaded: "qwen2.5-coder:7b", context: 131_072 });
  assert.equal(ollama.generated[0].options.num_ctx, 131_072);
  assert.equal(ollama.generated[0].keep_alive, "30m");
});

test("the manager starts and stops only its own loopback server, and rejects odd model names", async () => {
  assert.throws(() => new ModelManager({ baseUrl: "http://10.0.0.5:11434" }), ModelManagerError);
  for (const bad of ["", "../etc", "qwen 7b", "a:b:c", "UPPER:1b", 5]) assert.throws(() => assertModelTag(bad), /Model names/u);
  assert.equal(assertModelTag("hf.co-user_model:q4_k_m"), "hf.co-user_model:q4_k_m");

  const missing = new ModelManager({ fetchImpl: fakeOllama({ up: false }).fetch, findBinary: () => null });
  await assert.rejects(missing.ensureServer(), (error) => error.code === "NO_RUNTIME");
  assert.equal((await missing.status()).installGuide, "https://ollama.com/download");

  const ollama = fakeOllama({ up: false });
  const spawned = [];
  let killed = false;
  const manager = new ModelManager({
    fetchImpl: ollama.fetch,
    findBinary: () => "/opt/ollama",
    spawnImpl: (command, args, options) => { spawned.push({ command, args, options }); ollama.up = true; return { on() {}, kill() { killed = true; } }; },
  });
  assert.deepEqual(manager.stopServer(), { stopped: false });
  assert.deepEqual(await manager.ensureServer({ contextLength: 8_192 }), { started: true });
  assert.equal(spawned[0].command, "/opt/ollama");
  assert.deepEqual(spawned[0].args, ["serve"]);
  assert.equal(spawned[0].options.shell, false);
  assert.equal(spawned[0].options.env.OLLAMA_HOST, "127.0.0.1:11434");
  assert.equal(spawned[0].options.env.OLLAMA_CONTEXT_LENGTH, "8192");
  assert.equal((await manager.status()).managed, true);
  assert.deepEqual(manager.stopServer(), { stopped: true });
  assert.equal(killed, true);

  assert.deepEqual(pullProgress('{"status":"downloading","total":200,"completed":50}'), { status: "downloading", percent: 25 });
  assert.equal(pullProgress("garbage"), null);
  assert.ok(ollamaCandidates({ platform: "win32", env: { Path: "C:\\bin", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" } }).some((candidate) => candidate.endsWith("ollama.exe")));
});

test("hosting routes: read for anyone signed in, act for the owner, plan stored for routing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-models-"));
  try {
    const planStore = new ModelPlanStore(join(directory, "model-plan.json"));
    const manager = new ModelManager({ fetchImpl: fakeOllama().fetch, findBinary: () => "/usr/bin/ollama" });
    const handle = createModelHostingRoutes({
      manager, planStore, detectHardware: async () => gpu24,
      parseBody: async (request) => request.body ?? {},
      send: (response, status, value) => { response.status = status; response.body = value; return true; },
    });
    const call = async (method, url, role, body) => { const response = {}; await handle({ method, url, body }, response, { role }); return response; };

    const overview = await call("GET", "/v1/models/hosting", "device");
    assert.equal(overview.status, 200);
    assert.equal(overview.body.runtime.reachable, true);
    assert.equal(overview.body.catalog.length, CATALOG.length);
    assert.ok(overview.body.recommended.coder);
    assert.equal(overview.body.recommendedInstalled.coder.tag, "qwen2.5-coder:7b");
    assert.equal(overview.body.applied, null);

    assert.equal((await call("POST", "/v1/models/hosting/install", "device", { tag: "qwen3:8b" })).status, 403);
    assert.equal((await call("POST", "/v1/models/hosting/install", "admin", { tag: "bad tag" })).status, 400);
    const install = await call("POST", "/v1/models/hosting/install", "admin", { tag: "qwen3:8b" });
    assert.equal(install.status, 202);
    assert.equal(install.body.job.tag, "qwen3:8b");
    assert.equal(install.body.job.promise, undefined);

    const applied = await call("POST", "/v1/models/hosting/plan", "admin", {});
    assert.equal(applied.status, 200);
    assert.equal(applied.body.applied.coder.tag, overview.body.recommended.coder.tag);
    assert.equal(planStore.read().coder.tag, overview.body.recommended.coder.tag);

    const custom = await call("POST", "/v1/models/hosting/plan", "admin", { coder: "qwen2.5-coder:7b", fast: { tag: "qwen2.5-coder:1.5b", context: 8_192 } });
    assert.deepEqual({ coder: custom.body.applied.coder, fast: custom.body.applied.fast }, { coder: { tag: "qwen2.5-coder:7b", context: 32_768 }, fast: { tag: "qwen2.5-coder:1.5b", context: 8_192 } });
    assert.equal((await call("POST", "/v1/models/hosting/plan", "admin", { reviewer: "qwen3:8b" })).status, 400);
    assert.equal((await call("POST", "/v1/models/hosting/server", "admin", { action: "stop" })).body.stopped, false);
    assert.equal((await call("POST", "/v1/models/hosting/nope", "admin", {})).status, 404);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
