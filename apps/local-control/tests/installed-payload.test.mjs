import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const windows = process.platform === "win32";
const quote = value => "'" + value.replaceAll("'", "''") + "'";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-installed-payload-"));
  const source = join(directory, "source");
  for (const part of ["apps/local-control", "apps/windows-companion", "scripts/windows", "scripts/local", "scripts/runner/merge-decision.mjs", "packages/atlas-contracts", "SOVEREIGN-MODE.md"]) {
    const target = join(source, part);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(root, part), target, { recursive: true, filter: path => !path.split(/[\\/]/).includes("node_modules") });
  }
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, source };
}

async function assertDaemonStarts(t, payload, directory) {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const daemon = spawn(process.execPath, [join(payload, "apps/local-control/src/main.mjs")], {
    cwd: payload, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
      ATLAS_LOCAL_PORT: String(port), ATLAS_LOCAL_HOST: "127.0.0.1", ATLAS_OPEN_BROWSER: "0",
      ATLAS_LOCAL_DATA_DIR: join(directory, "data"), ATLAS_LOCAL_TOKEN: "installed-payload-test-owner-token", ATLAS_OWNER_TOKEN_STORAGE: "file" },
  });
  let output = "";
  try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Installed daemon did not start: " + output)), 20_000);
    const collect = chunk => { output = (output + chunk).slice(-8000); if (output.includes("Atlas sovereign control plane:")) { clearTimeout(timer); resolve(); } };
    daemon.stdout.on("data", collect); daemon.stderr.on("data", collect);
    daemon.once("error", error => { clearTimeout(timer); reject(error); });
    daemon.once("exit", code => { clearTimeout(timer); reject(new Error(`Installed daemon exited ${code}: ${output}`)); });
  });
  const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");
  } finally {
    if (daemon.exitCode === null) { const closed = new Promise(resolve => daemon.once("close", resolve)); daemon.kill(); await closed; }
  }
}

test("source installer payload starts the actual daemon without a repository checkout", { skip: !windows, timeout: 120_000 }, async t => {
  const { directory, source } = await fixture(t);
  const installed = join(directory, "installed");
  // Local model discovery is unrelated to payload integrity and can depend on a
  // machine's running Ollama server. Keep real prerequisite checks, omit that scan.
  const command = `function global:Get-Command { param($Name) if ($Name -ne 'ollama') { Microsoft.PowerShell.Core\\Get-Command $Name } }; & ${quote(join(source, "scripts/windows/Install-AtlasLocal.ps1"))} -InstallDirectory ${quote(installed)} -NoShortcut`;
  const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], { encoding: "utf8", timeout: 60_000, windowsHide: true });
  assert.equal(result.status, 0, String(result.error ?? "") + result.stdout + result.stderr);
  await assertDaemonStarts(t, installed, directory);
});

test("MSI builder stages a payload that starts the actual daemon before WiX/signing", { skip: !windows, timeout: 120_000 }, async t => {
  const { directory, source } = await fixture(t);
  // Stop at the first WiX call, after the real builder's staging and prerequisite
  // reporting. The machine-specific dependency scan is stubbed; payload copying
  // and daemon startup are real. No WiX compilation or signing is exercised.
  const command = `function global:wix { throw 'STAGING_COMPLETE' }; function global:node { param([Parameter(ValueFromRemainingArguments=$true)][string[]]$NodeArgs) if ($NodeArgs[0] -like '*report-requirements.mjs') { return }; & ${quote(process.execPath)} @NodeArgs }; & ${quote(join(source, "scripts/windows/Build-AtlasInstaller.ps1"))} -Version 0.0.1 -OutputDirectory payload-test -SkipSigning`;
  const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], { encoding: "utf8", timeout: 60_000, windowsHide: true });
  assert.match(result.stdout + result.stderr, /STAGING_COMPLETE/);
  await assertDaemonStarts(t, join(source, "payload-test/staging"), directory);
});
