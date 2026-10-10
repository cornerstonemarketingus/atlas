import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createMemoryJournal, createOperatorControl } from "../../windows-companion/src/operator/control.mjs";
import { actorOf, createOperatorRoutes } from "../src/agent/operator-routes.mjs";
import { buildCommandCenter } from "../src/platform/command-center.mjs";
import { PlatformTaskStore } from "../src/platform/index.mjs";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";
import { LOCAL_UI_HTML, LOCAL_UI_JS } from "../src/ui.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";
const DEVICE_TOKEN = "device-token-device-token-device-token";
const main = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "main.mjs");

async function serve(t, { control = createOperatorControl({ journal: createMemoryJournal() }), platform = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-operator-http-"));
  const store = new LocalTaskStore(join(directory, "atlas.sqlite"));
  store.addDevice("Phone", createHash("sha256").update(DEVICE_TOKEN).digest("hex"));
  const platformStore = platform ? new PlatformTaskStore(join(directory, "platform.sqlite")) : null;
  const server = createLocalControlServer({
    store, token: TOKEN, runTask: async () => ({ ok: true, message: "ok" }), operator: control,
    ...(platform ? { platformStore, platformServices: { onEmergencyStop: ({ actor }) => ({ operator: control.cancel({ actor, reason: "emergency stop" }).status.state }) } } : {}),
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => { await new Promise((done) => server.close(done)); store.close(); platformStore?.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token = TOKEN, body } = {}) => {
    const response = await fetch(`${origin}${path}`, { method, headers: { ...(token && { authorization: `Bearer ${token}` }), ...(body !== undefined && { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  return { control, call, origin, store };
}

test("the operator API needs a token; the owner and a paired phone can both watch and control, and each change names who made it", async (t) => {
  const { control, call } = await serve(t);
  assert.equal((await call("GET", "/v1/operator", { token: null })).status, 401);
  assert.equal((await call("POST", "/v1/operator/pause", { token: null, body: {} })).status, 401);
  assert.equal((await call("GET", "/v1/operator")).data.status.state, "idle");

  assert.equal((await call("POST", "/v1/operator/begin", { body: {} })).data.status.state, "running");
  const paused = await call("POST", "/v1/operator/pause", { token: DEVICE_TOKEN, body: { reason: "stepping away" } });
  assert.deepEqual([paused.status, paused.data.changed, paused.data.status.state, paused.data.status.lastActor], [200, true, "paused", "device:Phone"]);
  assert.equal((await call("GET", "/v1/operator", { token: DEVICE_TOKEN })).data.status.lastReason, "stepping away");
  assert.equal((await call("POST", "/v1/operator/pause", { token: DEVICE_TOKEN, body: {} })).data.changed, false, "a repeat is harmless");
  assert.equal((await call("POST", "/v1/operator/resume", { body: {} })).data.status.lastActor, "owner");
  assert.equal((await call("POST", "/v1/operator/takeover", { token: DEVICE_TOKEN, body: {} })).data.status.state, "taken_over");
  assert.equal((await call("POST", "/v1/operator/handback", { body: {} })).data.status.state, "running");

  assert.equal((await call("POST", "/v1/operator/resume", { body: {} })).data.changed, false, "resuming what is already running is harmless");
  await call("POST", "/v1/operator/takeover", { body: {} });
  const illegal = await call("POST", "/v1/operator/resume", { body: {} });
  await call("POST", "/v1/operator/handback", { body: {} });
  assert.equal(illegal.status, 409);
  assert.equal(illegal.data.code, "INVALID_TRANSITION");
  assert.match(illegal.data.message, /can: /u, "the refusal says what is possible");
  assert.equal((await call("POST", "/v1/operator/cancel", { token: DEVICE_TOKEN, body: {} })).data.status.state, "cancelled");
  assert.equal((await call("POST", "/v1/operator/explode", { body: {} })).status, 404);
  assert.equal((await call("PUT", "/v1/operator/pause", { body: {} })).status, 405, "a control is a POST and nothing else");
  assert.equal((await call("GET", "/v1/operator/pause")).status, 405);

  const receipts = (await call("GET", "/v1/operator/receipts", { token: DEVICE_TOKEN })).data.receipts;
  assert.deepEqual(receipts.map((entry) => `${entry.actor}:${entry.from}>${entry.to}`), ["owner:idle>running", "device:Phone:running>paused", "owner:paused>running", "device:Phone:running>taken_over", "owner:taken_over>running", "owner:running>taken_over", "owner:taken_over>running", "device:Phone:running>cancelled"]);
  assert.equal((await call("GET", "/v1/operator/receipts?after=2&limit=2")).data.receipts.length, 2);
  assert.equal((await call("GET", "/v1/operator/receipts?limit=0")).status, 400);
  assert.equal((await call("GET", "/v1/operator/receipts?after=-1")).status, 400);
  assert.equal(actorOf({ role: "device", device: { name: "Ann's <b>phone</b>" } }), "device:Anns bphoneb");
  assert.equal(control.status().receipts, receipts.length);
});

test("an uncertain action is confirmed through the API, by the owner or a paired device", async (t) => {
  const { control, call } = await serve(t);
  control.guard({ kind: "act" });
  control.intent({ digest: "d1", summary: "submit: Place order on shop.example.invalid", actionClass: "submit" });
  control.outcome({ intentId: control.status().uncertain[0]?.id ?? "intent-1-2", ok: false, uncertain: true });
  const [open] = (await call("GET", "/v1/operator")).data.status.uncertain;
  assert.match(open.summary, /Place order/u);
  assert.equal((await call("POST", `/v1/operator/intents/${open.id}/acknowledge`, { body: { verdict: "maybe" } })).status, 400);
  assert.equal((await call("POST", "/v1/operator/intents/intent-9-9/acknowledge", { body: { verdict: "happened" } })).status, 404);
  assert.equal((await call("POST", "/v1/operator/intents/not-an-id/acknowledge", { body: { verdict: "happened" } })).status, 404);
  const done = await call("POST", `/v1/operator/intents/${open.id}/acknowledge`, { token: DEVICE_TOKEN, body: { verdict: "did_not_happen" } });
  assert.deepEqual(done.data.status.uncertain, []);
  assert.equal((await call("POST", `/v1/operator/intents/${open.id}/acknowledge`, { body: { verdict: "happened" } })).status, 409, "already settled");
  assert.equal(control.receipts().at(-1).actor, "device:Phone");
});

test("the live stream sends the current status first, then every change, and stops listening when the client leaves", async () => {
  const control = createOperatorControl({});
  const written = [];
  const listeners = {};
  const response = { writeHead: (status, headers) => written.push({ status, type: headers["content-type"] }), write: (chunk) => written.push(chunk), on: (event, fn) => { listeners[event] = fn; } };
  const request = { method: "GET", url: "/v1/operator/stream", on: (event, fn) => { listeners[`request:${event}`] = fn; } };
  const handle = createOperatorRoutes({ control, parseBody: async () => ({}), send: () => true, heartbeatMs: 1_000_000 });
  assert.equal(await handle(request, response, { role: "admin" }), true);
  assert.deepEqual(written[0], { status: 200, type: "text/event-stream" });
  assert.match(written[1], /^event: status\ndata: \{"runId":0,"state":"idle"/u);
  control.begin({ actor: "owner" });
  control.pause({ actor: "owner" });
  const frames = written.filter((entry) => typeof entry === "string");
  assert.ok(frames.some((frame) => frame.startsWith("event: state") && frame.includes('"state":"paused"')));
  listeners.close();
  const before = written.length;
  control.resume({ actor: "owner" });
  assert.equal(written.length, before, "nothing is written after the client closed");
});

test("an emergency stop also cancels the operator, and a cancelled operator stays stopped until the owner lets it operate again", async (t) => {
  const { control, call } = await serve(t, { platform: true });
  control.begin({ actor: "owner" });
  const stop = await call("POST", "/v1/platform/emergency-stop", { body: { confirm: true } });
  assert.equal(stop.status, 200, JSON.stringify(stop.data));
  assert.equal(stop.data.hook.operator, "cancelled");
  assert.equal(control.state, "cancelled");
  assert.throws(() => control.guard({ kind: "act" }), (error) => error.code === "OPERATOR_CANCELLED");
  assert.equal((await call("POST", "/v1/operator/begin", { body: {} })).data.status.state, "running");
});

test("the Command Center shows the operator in each state with only the controls that state allows; needs-you states are attention", () => {
  const item = (status) => buildCommandCenter({ operator: status }).items.find((entry) => entry.kind === "operator");
  const base = { runId: 1, since: "2026-10-07T00:00:00.000Z", lastActor: "owner", lastReason: null, site: "shop.example.invalid", currentAction: null, approvalPending: false, uncertain: [] };
  assert.equal(item({ ...base, state: "idle" }), undefined, "nothing to show while idle");
  const cases = {
    running: ["running", ["pause", "takeover", "cancel"]],
    paused: ["waiting", ["resume", "takeover", "cancel"]],
    taken_over: ["waiting", ["handBack", "cancel"]],
    blocked: ["attention", ["takeover", "cancel"]],
    interrupted: ["attention", ["takeover", "cancel"]],
    cancelled: ["done", ["begin"]],
  };
  for (const [state, [bucket, actions]] of Object.entries(cases)) {
    const shown = item({ ...base, state, lastReason: state === "blocked" ? "a CAPTCHA" : null });
    assert.equal(shown.bucket, bucket, state);
    assert.deepEqual(shown.actions.map((action) => action.name), actions, state);
    for (const action of shown.actions) assert.deepEqual([action.method, action.path.startsWith("/v1/operator/")], ["POST", true]);
  }
  assert.equal(item({ ...base, state: "taken_over" }).actions[0].path, "/v1/operator/handback", "the route name, not the method name");
  assert.match(item({ ...base, state: "blocked", lastReason: "a CAPTCHA" }).detail, /CAPTCHA/u);
  assert.match(item({ ...base, state: "running", currentAction: { type: "click" }, approvalPending: true }).detail, /click on shop\.example\.invalid, waiting for your approval/u);
  const unsure = item({ ...base, state: "running", uncertain: [{ id: "intent-1-2", summary: "submit: Place order", actionClass: "submit", at: "x" }] });
  assert.equal(unsure.bucket, "attention", "an action that may have happened needs the owner even while running");
  assert.match(unsure.detail, /may or may not have happened/u);
  const idleButUnsure = item({ ...base, state: "idle", uncertain: [{ id: "intent-1-2", summary: "x", actionClass: "submit", at: "x" }] });
  assert.equal(idleButUnsure.bucket, "attention");
});

test("the Command Center endpoint and the console expose the operator", async (t) => {
  const { control, call } = await serve(t);
  control.begin({ actor: "owner" });
  const center = (await call("GET", "/v1/command-center", { token: DEVICE_TOKEN })).data;
  assert.equal(center.items.find((entry) => entry.kind === "operator").state, "running");
  assert.match(LOCAL_UI_HTML, /id="operator-panel"/u);
  assert.match(LOCAL_UI_HTML, /Take over when you want to use the computer yourself/u);
  assert.doesNotThrow(() => new Function(LOCAL_UI_JS));
  for (const part of ["/v1/operator", "/acknowledge", "data-op", "takeover", "handback", "loadOperator"]) assert.ok(LOCAL_UI_JS.includes(part), part);
});

// -- the real daemon, killed mid-run ---------------------------------------------------------------------------------

function startDaemon(directory, port) {
  const child = spawn(process.execPath, [main], {
    env: { ...process.env, ATLAS_LOCAL_DATA_DIR: directory, ATLAS_LOCAL_TOKEN: TOKEN, ATLAS_LOCAL_PORT: String(port), ATLAS_LOCAL_HOST: "127.0.0.1", ATLAS_VAULT_PASSPHRASE: "a long enough passphrase", ATLAS_GITHUB_TOKEN: "", ATLAS_CLOUDFLARE_TOKEN: "", ATLAS_VERCEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  return { child, output: () => output };
}

async function healthy(origin, daemon) {
  for (let waited = 0; waited < 15_000; waited += 100) {
    if (daemon.child.exitCode !== null) throw new Error(`The daemon exited:\n${daemon.output()}`);
    if (await fetch(`${origin}/health`).then((response) => response.ok, () => false)) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`The daemon never became healthy:\n${daemon.output()}`);
}

test("a real daemon killed mid-run comes back interrupted, with its journal on disk, and the owner takes over and hands back", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-operator-daemon-"));
  const port = 4300 + Math.floor(Math.random() * 600);
  const origin = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const post = (path) => fetch(`${origin}/v1/operator/${path}`, { method: "POST", headers, body: "{}" }).then(async (response) => ({ status: response.status, data: await response.json() }));
  const first = startDaemon(directory, port);
  t.after(async () => { first.child.kill("SIGKILL"); await rm(directory, { recursive: true, force: true }); });
  await healthy(origin, first);
  assert.equal((await (await fetch(`${origin}/v1/operator`, { headers })).json()).status.state, "idle");
  assert.equal((await post("begin")).data.status.state, "running");
  assert.equal((await post("pause")).data.status.state, "paused");
  assert.equal((await post("resume")).data.status.state, "running");
  const journal = join(directory, "operator", "journal.jsonl");
  assert.ok(existsSync(journal), "the journal is in the data directory");
  assert.equal(readFileSync(journal, "utf8").trim().split("\n").length, 3);

  first.child.kill("SIGKILL"); // a crash, not a clean shutdown
  await new Promise((done) => first.child.once("exit", done));
  const second = startDaemon(directory, port);
  t.after(async () => { second.child.kill("SIGKILL"); });
  await healthy(origin, second);
  const back = (await (await fetch(`${origin}/v1/operator`, { headers })).json()).status;
  assert.equal(back.state, "interrupted");
  assert.equal(back.lastActor, "system");
  const refused = await post("resume");
  assert.equal(refused.status, 409, "an interrupted run is not resumed blindly");
  assert.equal((await post("takeover")).data.status.state, "taken_over");
  assert.equal((await post("handback")).data.status.state, "running");
  const receipts = (await (await fetch(`${origin}/v1/operator/receipts`, { headers })).json()).receipts;
  assert.deepEqual(receipts.map((entry) => `${entry.from}>${entry.to}`), ["idle>running", "running>paused", "paused>running", "running>interrupted", "interrupted>taken_over", "taken_over>running"]);
  const audit = (await (await fetch(`${origin}/v1/audit`, { headers })).json()).events;
  assert.ok(audit.some((event) => event.category === "operator.transition"), "control changes are mirrored into the audit log");
});
