#!/usr/bin/env node
/**
 * The Phase 8 journey against a real Atlas daemon, end to end.
 *
 *   node scripts/e2e/journey.mjs
 *
 * Starts a scripted OpenAI-compatible model and a small MCP server, then the
 * daemon itself (temporary data directory, loopback ports), and walks the
 * owner journey over the daemon's HTTP API: configure a model, plan a goal
 * over the agent organization, delegate, run an authorized tool, verify the
 * artifacts, remember the result, enforce deny/ask policies, approve and deny
 * actions, pause/resume/cancel, kill the daemon mid-step and recover, and
 * read the history back. Every line printed is PASS or FAIL with the
 * evidence; the exit code is non-zero on any FAIL.
 *
 * The model is scripted, so this proves the runtime around it, not model
 * quality.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const TOKEN = "e2e-" + "0123456789abcdef0123456789abcdef";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const data = mkdtempSync(join(tmpdir(), "atlas-e2e-"));
mkdirSync(join(data, "workspace"), { recursive: true });
writeFileSync(join(data, "workspace", "brief.md"), "Launch page due Friday. Price: $29/month. Audience: small agencies.\n");
const [daemonPort, modelPort] = [await freePort(), await freePort()];
const base = `http://127.0.0.1:${daemonPort}`;
const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

let modelProcess = null;
let daemonProcess = null;
async function model(delay) {
  if (modelProcess) { modelProcess.kill(); await sleep(300); }
  modelProcess = spawn(process.execPath, [join(here, "scripted-model.mjs"), String(modelPort)], { env: { ...process.env, FAKE_STEP_DELAY_MS: String(delay) }, stdio: "ignore" });
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${modelPort}/v1/models`)).ok) return; } catch {} await sleep(100); }
}
async function daemon(action = "start") {
  if (daemonProcess) { daemonProcess.kill("SIGKILL"); await new Promise((r) => daemonProcess.once("exit", r)); daemonProcess = null; }
  if (action !== "start") return;
  daemonProcess = spawn(process.execPath, [join(root, "src", "main.mjs")], {
    cwd: root,
    env: {
      ...process.env, ATLAS_LOCAL_DATA_DIR: data, ATLAS_LOCAL_PORT: String(daemonPort), ATLAS_LOCAL_TOKEN: TOKEN,
      ATLAS_MODEL_ENDPOINT: `http://127.0.0.1:${modelPort}/v1`, ATLAS_TEAM_MODEL: "fake-team",
      ATLAS_MCP_SERVERS: JSON.stringify([{ id: "echo", argv: [process.execPath, join(here, "echo-mcp-server.mjs")], allowedTools: ["echo"] }]),
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/health")).ok) return; } catch {} await sleep(125); }
  throw new Error("The daemon did not start.");
}
const call = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const until = async (id, pred, ms = 20000) => { const end = Date.now() + ms; for (;;) { const d = (await call(`/v1/team/missions/${id}`)).body?.mission; if (d && pred(d)) return d; if (Date.now() > end) return d; await sleep(250); } };
let failures = 0;
const log = (step, ok, detail) => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"} | ${step} | ${detail}`); };
const setPolicy = (capability, decision) => call("/v1/policies", "PUT", { capability, decision });

try {
await model(0);
await daemon("start");
// 1. Access control and model configuration
log("unauthenticated request refused", (await fetch(base + "/v1/team/missions")).status === 401, "401 without token");
const health = await call("/v1/models/health");
log("model configured and discovered", health.body.servers.some((s) => s.models.some((m) => m.name === "fake-team")), JSON.stringify(health.body.servers.map((s) => [s.kind, s.location, s.models.map((m) => m.name)])));

// 2. Mission: plan → delegate → authorized tool → artifact → verify
await setPolicy("filesystem.read", "allow");
let started = await call("/v1/team/missions", "POST", { goal: "Read our project brief and give me a short summary of it." });
const id1 = started.body.mission.id;
log("goal planned into steps over real agents", started.status === 202, started.body.plan.steps.map((s) => `${s.title} → ${s.agentName ?? s.agent}`).join("; "));
let m = await until(id1, (d) => ["completed", "failed"].includes(d.taskStatus));
log("mission completed and platform task completed", m.status === "completed" && m.taskStatus === "completed", `mission=${m.status} task=${m.taskStatus} transitions=${m.transitions.map((t) => t.to).join(">")}`);
log("delegation recorded on the family graph", m.messages.some((x) => x.type === "TASK_ASSIGNMENT") && m.messages.some((x) => x.type === "RESULT"), m.messages.map((x) => `${x.type}:${x.from}->${x.to}`).join(", "));
log("authorized tool ran and was traced", m.toolCalls.some((c) => c.tool === "filesystem.read" && c.status === "succeeded"), JSON.stringify(m.toolCalls.map((c) => [c.agent, c.tool, c.status])));
log("artifacts verified with evidence", m.artifacts.length === 2 && m.artifacts.every((a) => a.verification === "verified" && a.evidence?.[0]?.kind === "step_check"), m.artifacts.map((a) => `${a.step}:${a.verification}`).join(", "));
log("output grounded in the tool result", /\$29\/month/u.test(m.steps[0].summary ?? ""), (m.steps[0].summary ?? "").slice(0, 90));
const mem = await call("/v1/knowledge?q=brief");
log("verified work remembered with provenance", mem.body.entries.some((e) => e.provenance.sourceRefs.includes(id1)), `${mem.body.entries.length} entries; source=${mem.body.entries[0]?.provenance.source}`);

// 3. Denied tool: policy deny is enforced and reported, mission fails honestly
await setPolicy("filesystem.read", "deny");
started = await call("/v1/team/missions", "POST", { goal: "Read our project brief and give me a short summary of it." });
m = await until(started.body.mission.id, (d) => ["completed", "failed"].includes(d.taskStatus));
log("denied capability blocks the tool and fails the step honestly", m.toolCalls.some((c) => c.tool === "filesystem.read" && c.status === "denied") && m.taskStatus === "failed", `task=${m.taskStatus}; first step: ${m.steps[0].state} — ${(m.steps[0].summary ?? "").slice(0, 80)}`);

// 4. Approval: ask → the step waits; the owner approves that exact action; it runs once
await setPolicy("filesystem.read", "ask");
started = await call("/v1/team/missions", "POST", { goal: "Read our project brief and give me a short summary of it." });
const id4 = started.body.mission.id;
let pending = null;
for (let i = 0; i < 80 && !pending; i++) { await sleep(250); pending = (await call("/v1/approvals")).body.approvals.find((a) => a.status === "pending" && a.capability === "filesystem.read"); }
m = (await call(`/v1/team/missions/${id4}`)).body.mission;
log("ask policy pauses the step for an approval of the exact action", Boolean(pending) && m.toolCalls.some((c) => c.status === "awaiting_approval") && m.taskStatus === "running", `approval: "${pending?.summary}"; task=${m.taskStatus}`);
const decided = await call(`/v1/approvals/${pending.id}/decision`, "POST", { decision: "approved" });
m = await until(id4, (d) => ["completed", "failed"].includes(d.taskStatus));
log("approved action runs and the mission completes", decided.status === 200 && m.taskStatus === "completed" && m.toolCalls.filter((c) => c.tool === "filesystem.read").map((c) => c.status).join() === "succeeded", `decision=${decided.status}; tools=${JSON.stringify(m.toolCalls.map((c) => c.status))}; task=${m.taskStatus}`);
const spent = (await call("/v1/audit")).body.events.filter((e) => e.category === "approval.consumed").length;
log("the approval was spent exactly once", spent === 1, `approval.consumed events: ${spent}`);
started = await call("/v1/team/missions", "POST", { goal: "Read our project brief and give me a short summary of it." });
pending = null;
for (let i = 0; i < 80 && !pending; i++) { await sleep(250); pending = (await call("/v1/approvals")).body.approvals.find((a) => a.status === "pending"); }
await call(`/v1/approvals/${pending.id}/decision`, "POST", { decision: "denied" });
for (let i = 0; i < 40; i++) { await sleep(250); const again = (await call("/v1/approvals")).body.approvals.find((a) => a.status === "pending"); if (again) { await call(`/v1/approvals/${again.id}/decision`, "POST", { decision: "denied" }); break; } }
m = await until(started.body.mission.id, (d) => ["completed", "failed"].includes(d.taskStatus));
log("a denied action never runs and the mission fails honestly", m.taskStatus === "failed" && !m.toolCalls.some((c) => c.status === "succeeded"), `tools=${JSON.stringify(m.toolCalls.map((c) => c.status))}; task=${m.taskStatus}`);
await setPolicy("filesystem.read", "allow");

// 5. Pause / resume / cancel (slow model)
await model(2500);
await sleep(800);
started = await call("/v1/team/missions", "POST", { goal: "Read our project brief and give me a short summary of it." });
const id5 = started.body.mission.id;
await sleep(500);
const paused = await call(`/v1/team/missions/${id5}/pause`, "POST", {});
m = await until(id5, (d) => ["paused", "interrupted"].includes(d.status), 8000);
log("pause stops the mission at a checkpoint", paused.status === 200 && ["paused", "interrupted"].includes(m.status), `status=${m.status}`);
const resumed = await call(`/v1/team/missions/${id5}/resume`, "POST", {});
m = await until(id5, (d) => ["completed", "failed"].includes(d.taskStatus), 30000);
log("resume carries it to completion", resumed.status === 200 && m.taskStatus === "completed", `resume=${resumed.status}; mission=${m.status} task=${m.taskStatus}`);
started = await call("/v1/team/missions", "POST", { goal: "Read our project brief and give me a short summary of it." });
await sleep(600);
const cancelled = await call(`/v1/team/missions/${started.body.mission.id}/cancel`, "POST", {});
m = await until(started.body.mission.id, (d) => ["completed", "failed", "cancelled"].includes(d.taskStatus), 15000);
log("cancel stops it and the task says so", cancelled.status === 200 && m.taskStatus === "cancelled", `mission=${m.status} task=${m.taskStatus}`);

// 6. Worker restart mid-step, then recovery
started = await call("/v1/team/missions", "POST", { goal: "Read our project brief and give me a short summary of it." });
const id6 = started.body.mission.id;
await sleep(1200);
await daemon("stop");
await daemon("start");
m = (await call(`/v1/team/missions/${id6}`)).body.mission;
log("after a restart the interrupted mission is visible, not lost", Boolean(m) && m.status === "interrupted", `status=${m?.status}; task=${m?.taskStatus}; steps=${m?.steps.map((s) => s.state).join(",")}`);
const res6 = await call(`/v1/team/missions/${id6}/resume`, "POST", {});
m = await until(id6, (d) => ["completed", "failed"].includes(d.taskStatus), 30000);
log("the owner resumes it and it completes after the restart", res6.status === 200 && m.taskStatus === "completed", `resume=${res6.status}; mission=${m.status}; task=${m.taskStatus}; transitions=${m.transitions.map((t) => t.to).join(">")}`);

// 7. History survives restarts
const all = (await call("/v1/team/missions")).body.missions;
log("history lists every mission after restarts", all.length === 7 && all.some((x) => x.id === id1), `${all.length} missions: ${[...new Set(all.map((x) => x.taskStatus))].join(", ")}`);
const audit = (await call("/v1/audit")).body.events;
log("audit log records policy changes and decisions", audit.some((e) => e.category === "policy.changed") && audit.some((e) => /approv/iu.test(e.category)), `${audit.length} events; categories: ${[...new Set(audit.map((e) => e.category))].slice(0, 8).join(", ")}`);
} catch (error) {
  failures += 1;
  console.log(`FAIL | journey aborted | ${error.stack ?? error}`);
} finally {
  await daemon("stop");
  modelProcess?.kill();
  rmSync(data, { recursive: true, force: true });
}
console.log(failures ? `${failures} step(s) failed.` : "Every step passed.");
process.exit(failures ? 1 : 0);
