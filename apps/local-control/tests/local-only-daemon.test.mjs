import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { startFakeOllama } from "./helpers/fake-ollama-server.mjs";

/**
 * The local-only guarantee at the real boundary: the actual daemon
 * (src/main.mjs) in its own process, with every outbound TCP, TLS, fetch and
 * DNS attempt routed through tests/helpers/network-guard.mjs, which fails and
 * records anything that is not loopback. Provider keys for every hosted
 * vendor are in the environment, as they would be on a developer's machine.
 *
 * The model is tests/helpers/fake-ollama-server.mjs, a protocol-accurate fake:
 * this proves where requests go and what they carry, not model quality.
 */
const here = dirname(fileURLToPath(import.meta.url));
const main = resolve(here, "..", "src", "main.mjs");
const guard = pathToFileURL(resolve(here, "helpers", "network-guard.mjs")).href;
const TOKEN = "0123456789abcdef0123456789abcdef";
const PROVIDER_KEYS = {
  GROQ_API_KEY: "gsk_" + "a".repeat(40), OPENAI_API_KEY: "sk-" + "b".repeat(40), ANTHROPIC_API_KEY: "sk-ant-" + "c".repeat(30),
  GEMINI_API_KEY: "d".repeat(20), OPENROUTER_API_KEY: "sk-or-" + "e".repeat(20), MISTRAL_API_KEY: "f".repeat(20), CEREBRAS_API_KEY: "csk-" + "g".repeat(20),
  ATLAS_WORKERS_AI_TOKEN: "h".repeat(20), CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
};
const freePort = () => new Promise((done) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => done(port)); }); });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function startDaemon(t, extra) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-local-only-"));
  const port = await freePort();
  const log = join(directory, "network.jsonl");
  const env = { ...process.env };
  // Nothing inherited from the developer's shell may configure a model endpoint.
  for (const key of Object.keys(env)) if (/^(ATLAS_|OLLAMA_)/u.test(key)) delete env[key];
  Object.assign(env, PROVIDER_KEYS, {
    ATLAS_LOCAL_DATA_DIR: directory, ATLAS_LOCAL_TOKEN: TOKEN, ATLAS_LOCAL_PORT: String(port), ATLAS_LOCAL_HOST: "127.0.0.1",
    ATLAS_VAULT_PASSPHRASE: "a long enough passphrase", ATLAS_NETWORK_GUARD: "1", ATLAS_NETWORK_GUARD_LOG: log,
  }, extra);
  const child = spawn(process.execPath, ["--import", guard, main], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise((done) => child.once("exit", done)); }
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`The daemon exited:\n${output}`);
    try { if ((await fetch(`${origin}/health`)).ok) break; } catch { /* not yet */ }
    if (attempt > 200) throw new Error(`The daemon never became healthy:\n${output}`);
    await sleep(100);
  }
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const call = async (path, method = "GET", body) => {
    const response = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const attempts = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { call, attempts, output: () => output };
}

async function chat(daemon, model, text) {
  const created = await daemon.call("/v1/sessions", "POST", { title: "Local only", model, executor: "conversation" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.session.id;
  assert.equal((await daemon.call(`/v1/sessions/${id}/turns`, "POST", { text })).status, 202);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const { body } = await daemon.call(`/v1/sessions/${id}`);
    if (["completed", "failed", "cancelled"].includes(body.session.status)) return body.session;
    await sleep(100);
  }
  throw new Error("The turn never finished.");
}

test("only Ollama configured and every vendor key present: chat, planning and health stay on 127.0.0.1", async (t) => {
  const fake = await startFakeOllama({ models: ["qwen2.5-coder:7b", "qwen3:0.6b", "nomic-embed-text:latest"] });
  t.after(() => fake.close());
  const daemon = await startDaemon(t, { ATLAS_OLLAMA_URL: fake.origin });
  assert.match(daemon.output(), /Model egress: local-only/u);

  const health = await daemon.call("/v1/models/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.egress.mode, "local-only");
  assert.deepEqual(health.body.egress.remote, []);
  assert.ok(health.body.servers.some((server) => server.kind === "ollama" && server.location === "this machine" && server.models.some((m) => m.name === "qwen2.5-coder:7b")));

  const session = await chat(daemon, "qwen2.5-coder:7b", "Say hello from this machine.");
  assert.equal(session.status, "completed", session.summary ?? "");
  const turn = fake.chats().find((request) => request.path === "/api/chat");
  assert.ok(turn, "the chat turn reached Ollama's native API");
  assert.equal(turn.body.model, "qwen2.5-coder:7b");
  assert.equal(turn.body.options.num_ctx, 16_384, "the window chat was fitted to is the window Ollama was told");
  assert.ok(Array.isArray(turn.body.tools) && turn.body.tools.length > 0, "tools are offered in Ollama's tools field");

  // Planning a team mission uses the same client.
  const before = fake.chats().length;
  const mission = await daemon.call("/v1/team/missions", "POST", { goal: "Summarise what this workspace is for." });
  // The fake's plain-text reply is not a plan, so planning may refuse; what matters here is where the request went.
  assert.notEqual(mission.status, 500, JSON.stringify(mission.body));
  assert.ok(fake.chats().length > before, "the planner asked the local model");

  const attempts = daemon.attempts();
  assert.ok(attempts.length > 0, "the guard saw the daemon's connections");
  assert.deepEqual(attempts.filter((entry) => !entry.allowed), [], "no connection left this machine");
});

test("ATLAS_LOCAL_ONLY=1 with a hosted endpoint configured: the turn fails clearly and nothing is sent", async (t) => {
  const fake = await startFakeOllama();
  t.after(() => fake.close());
  const daemon = await startDaemon(t, { ATLAS_OLLAMA_URL: fake.origin, ATLAS_LOCAL_ONLY: "1", ATLAS_MODEL_ENDPOINT: "https://api.groq.com/openai/v1" });
  assert.match(daemon.output(), /ATLAS_LOCAL_ONLY overrides the configured api\.groq\.com \(ATLAS_MODEL_ENDPOINT\)/u);
  const health = await daemon.call("/v1/models/health");
  assert.equal(health.body.egress.forced, true);
  assert.deepEqual(health.body.egress.refused, [{ host: "api.groq.com", variable: "ATLAS_MODEL_ENDPOINT" }]);

  const session = await chat(daemon, "openai/gpt-oss-120b", "hello");
  assert.equal(session.status, "failed");
  assert.match(session.summary ?? "", /Refused to send a model request to api\.groq\.com/u);
  assert.deepEqual(daemon.attempts().filter((entry) => !entry.allowed), [], "the refusal happened before any connection");
});

test("a remote endpoint the owner configured is used, and every request to it is audited", async (t) => {
  const daemon = await startDaemon(t, { ATLAS_MODEL_ENDPOINT: "https://models.example.test/v1" });
  assert.match(daemon.output(), /remote model endpoints explicitly configured: models\.example\.test \(ATLAS_MODEL_ENDPOINT\)/u);
  const session = await chat(daemon, "big-model", "hello");
  // The guard stands in for the network here, so the request is attempted and then blocked.
  assert.equal(session.status, "failed");
  assert.ok(daemon.attempts().some((entry) => entry.host === "models.example.test" && !entry.allowed), "the opted-in endpoint was the one contacted");
  assert.ok(daemon.attempts().every((entry) => entry.allowed || entry.host === "models.example.test"), "and no other remote host");
  const audit = await daemon.call("/v1/audit");
  assert.ok(audit.body.events.some((event) => event.category === "model.remote" && /models\.example\.test/u.test(event.summary)), "the remote request is in the audit log");
  assert.ok(audit.body.events.some((event) => event.category === "model.egress"));
});
