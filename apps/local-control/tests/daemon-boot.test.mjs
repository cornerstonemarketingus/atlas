import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const main = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "main.mjs");

/**
 * Boots the real daemon.
 *
 * Every other test in this package imports modules directly, which means a
 * wiring mistake in main.mjs — a store constructed after the thing that uses
 * it, an executor never registered — passes every one of them and still fails
 * on the first real launch. This test is the one that would have caught it,
 * and it did.
 */
function startDaemon(environment) {
  const child = spawn(process.execPath, [main], {
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  return { child, read: () => output };
}

async function waitForHealth(origin, read, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The daemon exited with code ${child.exitCode}:\n${read()}`);
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return response.json();
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The daemon never became healthy:\n${read()}`);
}

test("the daemon starts, registers its executors, and serves the session API", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-boot-"));
  const token = "0123456789abcdef0123456789abcdef";
  const port = 4200 + Math.floor(Math.random() * 500);
  const { child, read } = startDaemon({
    ATLAS_LOCAL_DATA_DIR: directory,
    ATLAS_LOCAL_TOKEN: token,
    ATLAS_LOCAL_PORT: String(port),
    ATLAS_LOCAL_HOST: "127.0.0.1",
    ATLAS_VAULT_PASSPHRASE: "a long enough passphrase",
    // Deliberately no provider credentials: a machine with none must boot.
    ATLAS_GITHUB_TOKEN: "",
    ATLAS_CLOUDFLARE_TOKEN: "",
    ATLAS_VERCEL_TOKEN: "",
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(directory, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(origin, read, child);
  assert.equal(health.status, "ok");
  assert.equal(health.runtime.running, true);
  assert.deepEqual(health.runtime.executors, ["local", "conversation"]);

  const admin = { authorization: `Bearer ${token}` };
  const created = await fetch(`${origin}/v1/sessions`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ title: "Boot check", repository: directory, model: "qwen2.5-coder:7b", executor: "conversation" }),
  });
  assert.equal(created.status, 201);
  const { session } = await created.json();

  const listed = await (await fetch(`${origin}/v1/sessions`, { headers: admin })).json();
  assert.ok(listed.sessions.some((entry) => entry.id === session.id));

  // The whole tool surface has to be constructible, not merely importable.
  const policies = await (await fetch(`${origin}/v1/policies`, { headers: admin })).json();
  assert.ok(policies.policies.length > 0);

  // Model health must answer on a machine with no model server running, and
  // must not leak a credential or a raw endpoint into customer-facing copy.
  const health2 = await fetch(`${origin}/v1/models/health`, { headers: admin });
  assert.equal(health2.status, 200);
  const report = await health2.json();
  assert.ok(report.hardware.totalMemoryGiB > 0);
  assert.ok(Array.isArray(report.servers));
  assert.ok(report.recommendations.coding);
  const serialized = JSON.stringify(report);
  assert.equal(/authorization|bearer|api[_-]?key/iu.test(serialized), false, "no credential appears in the health report");
});

test("the daemon still boots when no credential vault passphrase is set", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-boot-nopass-"));
  const token = "0123456789abcdef0123456789abcdef";
  const port = 4700 + Math.floor(Math.random() * 200);
  const { child, read } = startDaemon({
    ATLAS_LOCAL_DATA_DIR: directory,
    ATLAS_LOCAL_TOKEN: token,
    ATLAS_LOCAL_PORT: String(port),
    ATLAS_LOCAL_HOST: "127.0.0.1",
    ATLAS_VAULT_PASSPHRASE: "",
  });
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(directory, { recursive: true, force: true });
  });

  // A locked vault is a locked vault, not a broken daemon: everything that
  // does not need a credential must keep working.
  const health = await waitForHealth(`http://127.0.0.1:${port}`, read, child);
  assert.equal(health.status, "ok");
});
