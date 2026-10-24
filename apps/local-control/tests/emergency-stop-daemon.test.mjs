import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The command center's emergency stop, against the real daemon.
 *
 * main.mjs is started as a process (temporary data directory, real SQLite
 * stores, a scripted model and a real MCP server), real work is put in
 * flight over HTTP, and POST /v1/platform/emergency-stop must stop it: the
 * running team mission is cancelled, the pending approval in the local inbox
 * is denied, and the folder automation is paused with its watcher closed.
 * Every other test wires services by hand; only this one proves main.mjs
 * passes the stop hook (and the terminal and MCP reports) to the platform API.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const TOKEN = "0123456789abcdef0123456789abcdef";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const freePort = () => new Promise((done) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => done(port)); }); });

function start(argv, env) {
  const child = spawn(process.execPath, argv, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  return { child, read: () => output };
}

async function until(read, predicate, { timeoutMs = 20_000, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(value)?.slice(0, 600)}`);
    await sleep(200);
  }
}

test("emergency stop stops a running mission, a pending inbox approval and an automation in the real daemon", { timeout: 90_000 }, async (t) => {
  const data = await mkdtemp(join(tmpdir(), "atlas-estop-"));
  const watched = join(data, "watched");
  mkdirSync(join(data, "workspace"), { recursive: true });
  mkdirSync(watched, { recursive: true });
  writeFileSync(join(data, "workspace", "brief.md"), "Launch page due Friday. Price: $29/month.\n");
  const [daemonPort, modelPort] = [await freePort(), await freePort()];

  // Planning answers at once; each agent step waits, so the mission is still in flight when stopped.
  const model = start([join(root, "scripts", "e2e", "scripted-model.mjs"), String(modelPort)], { FAKE_STEP_DELAY_MS: "1500" });
  const daemon = start([join(root, "src", "main.mjs")], {
    ATLAS_LOCAL_DATA_DIR: data,
    ATLAS_LOCAL_PORT: String(daemonPort),
    ATLAS_LOCAL_HOST: "127.0.0.1",
    ATLAS_LOCAL_TOKEN: TOKEN,
    ATLAS_VAULT_PASSPHRASE: "a long enough passphrase",
    ATLAS_MODEL_ENDPOINT: `http://127.0.0.1:${modelPort}/v1`,
    ATLAS_TEAM_MODEL: "fake-team",
    ATLAS_MCP_SERVERS: JSON.stringify([{ id: "echo", argv: [process.execPath, join(root, "scripts", "e2e", "echo-mcp-server.mjs")], allowedTools: ["echo"] }]),
    ATLAS_GITHUB_TOKEN: "",
    ATLAS_CLOUDFLARE_TOKEN: "",
    ATLAS_VERCEL_TOKEN: "",
  });
  t.after(async () => {
    for (const { child } of [daemon, model]) {
      if (child.exitCode === null) { child.kill("SIGKILL"); await new Promise((done) => child.once("exit", done)); }
    }
    await rm(data, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${daemonPort}`;
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const call = async (path, method = "GET", body = undefined) => {
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  await until(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, Boolean, { what: `the daemon to start:\n${daemon.read()}` });

  // 1. The worker report tells the truth about the terminal controller and the MCP gateway.
  const workers = await until(() => call("/v1/platform/workers"), (r) => r.body?.mcp?.available === true, { what: "the MCP gateway to connect" });
  assert.equal(workers.body.terminal.available, true, JSON.stringify(workers.body.terminal));
  assert.equal(workers.body.terminal.capabilities.noShell, true);
  assert.deepEqual(workers.body.mcp.servers.map((server) => [server.serverId ?? server.id, server.connected]), [["echo", true]]);

  // 2. Real work in flight: a team mission whose first step waits on an approval in the local inbox.
  assert.equal((await call("/v1/policies", "PUT", { capability: "filesystem.read", decision: "ask" })).status, 200);
  const started = await call("/v1/team/missions", "POST", { goal: "Read our project brief and give me a short summary of it." });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const missionId = started.body.mission.id;
  const approval = (await until(() => call("/v1/approvals"), (r) => r.body?.approvals?.some((a) => a.status === "pending" && a.capability === "filesystem.read"), { what: "the pending approval" }))
    .body.approvals.find((a) => a.status === "pending" && a.capability === "filesystem.read");
  assert.equal((await call(`/v1/team/missions/${missionId}`)).body.mission.status, "running");

  // 3. A folder automation with a live watcher.
  const created = await call("/v1/automations", "POST", { name: "On brief change", trigger: { kind: "file", path: watched, debounceSeconds: 1 }, action: { kind: "team", goal: "Summarize what changed." } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const automationId = created.body.automation.id;
  assert.equal(created.body.automation.enabled, true);

  // 4. Press stop.
  const stop = await call("/v1/platform/emergency-stop", "POST", { confirm: true, reason: "test" });
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  const services = stop.body.hook?.services;
  assert.ok(services, `the daemon-wide stop ran: ${JSON.stringify(stop.body)}`);
  assert.deepEqual(services.missions.stopped, [missionId]);
  assert.deepEqual(services.approvals.stopped, [approval.id]);
  assert.deepEqual(services.automations.stopped, [automationId]);
  assert.equal(services.automations.schedulerStopped, true);
  assert.equal(services.automations.watchersStopped, 1);
  // Nothing else was in flight; each of these is wired and reports idle.
  for (const name of ["sessions", "genesis", "renders", "compute", "nodes", "terminal"]) assert.equal(services[name].status, "idle", `${name}: ${JSON.stringify(services[name])}`);
  assert.equal(stop.body.hook.ok, true, JSON.stringify(stop.body.hook));

  // 5. The work really stopped, as each service itself reports it.
  const mission = await until(() => call(`/v1/team/missions/${missionId}`), (r) => r.body?.mission?.status === "cancelled", { what: "the mission to be cancelled" });
  assert.equal(mission.body.mission.taskStatus, "cancelled");
  assert.equal((await call("/v1/approvals")).body.approvals.find((a) => a.id === approval.id).status, "denied");
  const paused = (await call(`/v1/automations/${automationId}`)).body.automation;
  assert.equal(paused.enabled, false);
  assert.match(paused.pausedReason, /emergency stop: test/u);
  writeFileSync(join(watched, "new.md"), "a change after the stop\n");
  await sleep(2500);
  assert.deepEqual((await call(`/v1/automations/${automationId}`)).body.automation.runs, [], "the closed watcher started nothing");
  assert.equal((await call("/v1/approvals")).body.approvals.filter((a) => a.status === "pending").length, 0);

  // 6. Pressing it again stops nothing new, and both stops are audited.
  const again = await call("/v1/platform/emergency-stop", "POST", { confirm: true });
  assert.equal(again.status, 200);
  assert.equal(again.body.hook.stopped, 0, JSON.stringify(again.body.hook));
  assert.equal(again.body.hook.ok, true);
  const audit = (await call("/v1/audit")).body.events;
  assert.equal(audit.filter((event) => event.category === "emergency_stop.services").length, 2);
  assert.ok(audit.some((event) => event.category === "approval.decided" && event.summary.includes(approval.id) && event.summary.includes("emergency stop: test")));
});
