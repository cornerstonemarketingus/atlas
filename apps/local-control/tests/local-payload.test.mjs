import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { stageLocalPayload } from "../../../scripts/release/stage-local.mjs";

test("the install payload contains runtime contracts and a compiled CLI that works without developer dependencies", async (t) => {
  const source = resolve(import.meta.dirname, "../../..");
  try { await access(join(source, "packages/atlas-cli/dist/src/cli.js")); } catch { t.skip("Build the release coding runner before the payload integration test."); return; }
  const directory = await mkdtemp(join(tmpdir(), "atlas-payload-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await stageLocalPayload(directory, source);
  await access(join(directory, "packages/atlas-contracts/src/index.mjs"));
  await access(join(directory, "scripts/windows/Enable-AtlasStartup.ps1"));
  await assert.rejects(access(join(directory, "packages/atlas-cli/node_modules")));
  await assert.rejects(access(join(directory, "apps/web")));
  const child = spawn(process.execPath, [join(directory, "packages/atlas-cli/dist/src/cli.js"), "--help"], { cwd: directory, windowsHide: true, stdio: "ignore" });
  const [code] = await once(child, "close");
  assert.equal(code, 0);
  const imports = spawn(process.execPath, ["--input-type=module", "-e", "await import('./apps/local-control/src/server.mjs'); await import('./apps/local-control/src/agent/models/free-local.mjs');"], { cwd: directory, windowsHide: true, stdio: "ignore" });
  assert.equal((await once(imports, "close"))[0], 0);
});
