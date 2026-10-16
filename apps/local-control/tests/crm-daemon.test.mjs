import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("real authenticated daemon exposes denied CRM tools without leaking configuration", { timeout: 30000 }, async t => {
  const data = await mkdtemp(join(tmpdir(), "atlas-crm-discovery-"));
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const token = "crm-discovery-0123456789abcdef0123456789abcdef";
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/main.mjs", import.meta.url))], { stdio: ["ignore", "ignore", "pipe"], env: {
    ...process.env, ATLAS_LOCAL_DATA_DIR: data, ATLAS_LOCAL_TOKEN: token, ATLAS_LOCAL_HOST: "127.0.0.1", ATLAS_LOCAL_PORT: String(port),
    HUBSPOT_PRIVATE_APP_TOKEN: "", ATLAS_VAULT_PASSPHRASE: "crm discovery fixture passphrase", ATLAS_GITHUB_TOKEN: "", ATLAS_CLOUDFLARE_TOKEN: "", ATLAS_VERCEL_TOKEN: "",
  } });
  let errors = ""; child.stderr.on("data", chunk => { errors += chunk; });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; } await rm(data, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`; let healthy = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) assert.fail(`Daemon exited before discovery: ${errors}`);
    try { if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok) { healthy = true; break; } } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(healthy, true, "daemon must boot before the CRM acceptance check");
  assert.equal((await fetch(`${origin}/v1/tools`)).status, 401);
  const response = await fetch(`${origin}/v1/tools`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const { tools } = await response.json();
  const lookup = tools.find(tool => tool.name === "crm.find_contact");
  const create = tools.find(tool => tool.name === "crm.create_contact");
  assert.equal(lookup?.decision, "deny"); assert.equal(create?.decision, "deny");
  assert.equal(create.requiresApproval, true); assert.equal(create.capability, "crm.write");
  assert.equal(JSON.stringify([lookup, create]).includes(token), false);
  assert.equal("credentials" in create, false);
});
