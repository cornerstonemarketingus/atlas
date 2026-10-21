import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LOCAL_UI_JS } from "../src/ui.mjs";
import { LocalTaskStore } from "../src/store.mjs";
import { createLocalControlServer } from "../src/server.mjs";

test("Windows launcher passes an explicit model to the daemon and all local workers", { skip: process.platform !== "win32" }, () => {
  const launcher = fileURLToPath(new URL("../../../scripts/windows/Start-AtlasLocal.ps1", import.meta.url));
  const script = `function Invoke-RestMethod { throw 'not running' }; function node { @{ model=$env:ATLAS_MODEL; team=$env:ATLAS_TEAM_MODEL; workforce=$env:ATLAS_WORKFORCE_MODEL } | ConvertTo-Json -Compress }; & '${launcher.replaceAll("'", "''")}' -Model 'qwen3:1.7b' -SkipModelCheck`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  const selected = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
  assert.deepEqual(selected, { model: "qwen3:1.7b", team: "qwen3:1.7b", workforce: "qwen3:1.7b" });
});

test("Windows automatic launch avoids installed 7B weights on an 8 GiB PC", { skip: process.platform !== "win32" }, () => {
  const launcher = fileURLToPath(new URL("../../../scripts/windows/Start-AtlasLocal.ps1", import.meta.url));
  const script = `function Invoke-RestMethod { throw 'not running' }; function Get-CimInstance { @{TotalPhysicalMemory=8GB} }; function Get-Command { param($Name); if($Name -eq 'ollama') { @{Source='ollama'} } else { Microsoft.PowerShell.Core\\Get-Command $Name } }; function ollama { 'NAME ID SIZE MODIFIED'; 'qwen2.5-coder:7b abc 4.7GB today'; 'qwen3:1.7b def 1.4GB today' }; function node { Write-Output $env:ATLAS_MODEL }; & '${launcher.replaceAll("'", "''")}'`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split(/\r?\n/u).at(-1), "qwen3:1.7b");
});

test("Windows launcher reopens a healthy daemon instead of starting another", { skip: process.platform !== "win32" }, () => {
  const launcher = fileURLToPath(new URL("../../../scripts/windows/Start-AtlasLocal.ps1", import.meta.url));
  const script = `function Invoke-RestMethod { @{status='ok';mode='sovereign';model='qwen3:1.7b'} }; function node { param($target); Write-Output $target }; & '${launcher.replaceAll("'", "''")}' -SkipModelCheck`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim().split(/\r?\n/u).at(-1), /scripts[\\/]local[\\/]open-atlas\.mjs$/u);
});

test("model discovery exposes only an installed default, preserving owner selection", async t => {
  const store = new LocalTaskStore(":memory:");
  const token = "local-launch-test-token-32-characters";
  const server = createLocalControlServer({ store, token, model: "qwen3:1.7b", runTask: async () => ({}), discoverModels: async () => ({ models: ["qwen2.5-coder:7b", "qwen3:1.7b"] }) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => { store.close(); resolve(); }); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).defaultModel, "qwen3:1.7b");
});

test("conversation picker loads the installed default and keeps a later user choice", async () => {
  const body = LOCAL_UI_JS.slice(LOCAL_UI_JS.indexOf("async function loadSessions(){"), LOCAL_UI_JS.indexOf("q('#session-picker').onchange"));
  const picker = { value: "qwen2.5-coder:7b", dataset: {} };
  const executor = { value: "local", dataset: {} };
  const elements = { "#session-model": picker, "#session-picker": {}, "#session-executor": executor };
  const load = new Function("api", "q", "esc", "sessionId", body + "return loadSessions;")(
    async url => Response.json(url === "/v1/models" ? { models: ["qwen3:1.7b", "qwen3:0.6b"], defaultModel: "qwen3:1.7b" } : url === "/v1/sessions" ? { sessions: [] } : { executors: ["local", "conversation"] }),
    selector => elements[selector], value => value, "",
  );
  await load();
  assert.equal(picker.value, "qwen3:1.7b");
  assert.match(picker.innerHTML, /qwen3:0.6b/u);
  assert.equal(executor.value, "conversation", "chat must use streaming conversation rather than an isolated coding job");
  picker.value = "qwen3:0.6b";
  executor.value = "local";
  await load();
  assert.equal(picker.value, "qwen3:0.6b");
  assert.equal(executor.value, "local");
});
