import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

/**
 * `atlas code` with only a local Ollama and every hosted vendor's key in the
 * environment, run as the real CLI process with every outbound connection
 * going through tests/support/network-guard.ts, which fails and records any
 * destination that is not loopback.
 *
 * The model is a protocol-accurate fake Ollama (Ollama's /api/version,
 * /api/tags and /api/chat, streamed or not, with tools). It is test
 * infrastructure: it proves where requests go and what they carry, never how
 * a real model behaves.
 */
const PROVIDER_KEYS = {
  GROQ_API_KEY: "gsk_" + "a".repeat(40), OPENAI_API_KEY: "sk-" + "b".repeat(40), ANTHROPIC_API_KEY: "sk-ant-" + "c".repeat(30),
  GEMINI_API_KEY: "d".repeat(20), OPENROUTER_API_KEY: "e".repeat(20), MISTRAL_API_KEY: "f".repeat(20), CEREBRAS_API_KEY: "g".repeat(20),
  ATLAS_WORKERS_AI_TOKEN: "h".repeat(20), CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
};
const guard = pathToFileURL(join(process.cwd(), "dist", "tests", "support", "network-guard.js")).href;

interface Seen { readonly path: string; readonly body: any }

async function fakeOllama(t: test.TestContext, models = ["qwen2.5-coder:7b"]) {
  const seen: Seen[] = [];
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : null;
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    seen.push({ path, body });
    const json = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (path === "/api/version") return json(200, { version: "0.12.6" });
    if (path === "/api/tags") return json(200, { models: models.map((name) => ({ name, model: name, size: 1, digest: "sha256:" + "0".repeat(64), details: { format: "gguf", family: "qwen2", parameter_size: "7.6B", quantization_level: "Q4_K_M" } })) });
    if (path !== "/api/chat") return json(404, { error: "not found" });
    if (!models.includes(body.model)) return json(404, { error: `model "${body.model}" not found, try pulling it first` });
    const final = { model: body.model, created_at: new Date().toISOString(), message: { role: "assistant", content: "Nothing needs to change; this was a local inspection." }, done_reason: "stop", done: true, total_duration: 1, prompt_eval_count: 900, eval_count: 12 };
    if (body.stream === false) return json(200, final);
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write(`${JSON.stringify({ ...final, done: false, done_reason: undefined })}\n`);
    response.end(`${JSON.stringify({ ...final, message: { role: "assistant", content: "" } })}\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  return { origin: `http://127.0.0.1:${address.port}`, port: address.port, seen, chats: () => seen.filter((entry) => entry.path === "/api/chat") };
}

async function closedPort(): Promise<number> {
  return new Promise((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const a = s.address() as { port: number }; s.close(() => resolve(a.port)); }); });
}

async function runCli(t: test.TestContext, args: readonly string[], env: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "atlas-local-only-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "README.md"), "# fixture\n");
  const log = join(root, "..", `${root.split(/[\\/]/u).at(-1)}-network.jsonl`);
  t.after(() => rm(log, { force: true }));
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^(ATLAS_|OLLAMA_)/u.test(key)) childEnv[key] = value;
  Object.assign(childEnv, PROVIDER_KEYS, { ATLAS_NETWORK_GUARD: "1", ATLAS_NETWORK_GUARD_LOG: log }, env);
  let result: { code: number; stdout: string; stderr: string };
  try {
    const { stdout, stderr } = await execute(process.execPath, ["--import", guard, join(process.cwd(), "dist/src/cli.js"), "code", root, "Inspect the README", "--no-verify", "--format", "json",
      "--retry-attempts", "1", "--capacity-wait-ms", "0", ...args], { timeout: 60_000, windowsHide: true, env: childEnv });
    result = { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    result = { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
  const attempts = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { host: string; allowed: boolean }) : [];
  return { ...result, attempts, blocked: attempts.filter((entry) => !entry.allowed) };
}

test("an Ollama model name with no --provider runs on the local Ollama, never on Groq, even with every vendor key set", async (t) => {
  const ollama = await fakeOllama(t);
  const run = await runCli(t, ["--model", "qwen2.5-coder:7b"], { ATLAS_OLLAMA_URL: ollama.origin });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  assert.equal(JSON.parse(run.stdout).status, "completed");
  assert.ok(ollama.chats().length > 0, "the request reached Ollama's native API");
  assert.equal(ollama.chats()[0]!.body.options.num_ctx, 16_384);
  assert.ok(run.attempts.length > 0, "the guard saw the CLI's connections");
  assert.deepEqual(run.blocked, [], "no connection left this machine");
  assert.doesNotMatch(run.stderr, /off this machine/u);
});

test("OLLAMA_HOST is honoured when ATLAS_OLLAMA_URL is not set", async (t) => {
  const ollama = await fakeOllama(t);
  const run = await runCli(t, ["--provider", "ollama", "--model", "qwen2.5-coder:7b"], { OLLAMA_HOST: `127.0.0.1:${ollama.port}` });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  assert.ok(ollama.chats().length > 0);
  assert.deepEqual(run.blocked, []);
});

test("Ollama down: a clear failure, and no hidden switch to a hosted provider", async (t) => {
  const run = await runCli(t, ["--model", "qwen2.5-coder:7b"], { ATLAS_OLLAMA_URL: `http://127.0.0.1:${await closedPort()}` });
  assert.notEqual(run.code, 0);
  assert.match(`${run.stdout}\n${run.stderr}`, /Ollama/u);
  assert.deepEqual(run.blocked, [], "nothing was attempted off this machine");
});

for (const [name, args, env] of [
  ["--local-only refuses an explicit hosted primary", ["--local-only", "--provider", "groq", "--model", "openai/gpt-oss-120b"], {}],
  ["ATLAS_LOCAL_ONLY refuses a hosted model inferred from its name", ["--model", "claude-sonnet-5"], { ATLAS_LOCAL_ONLY: "1" }],
  ["ATLAS_LOCAL_ONLY refuses a hosted fallback behind a local primary", ["--provider", "ollama", "--model", "qwen2.5-coder:7b", "--fallback", "groq:openai/gpt-oss-120b:GROQ_API_KEY"], { ATLAS_LOCAL_ONLY: "1" }],
  ["ATLAS_LOCAL_ONLY refuses a hosted escalation", ["--provider", "ollama", "--model", "qwen2.5-coder:7b", "--escalate", "openai:gpt-5.4-mini:OPENAI_API_KEY"], { ATLAS_LOCAL_ONLY: "1" }],
  ["--local-only refuses a remote --base-url", ["--local-only", "--provider", "groq", "--model", "x", "--base-url", "https://gpu.example.net/v1"], {}],
] as const) {
  test(`${name}, before anything is sent`, async (t) => {
    const ollama = await fakeOllama(t);
    const run = await runCli(t, args, { ATLAS_OLLAMA_URL: ollama.origin, ...env });
    assert.equal(run.code, 2, run.stderr || run.stdout);
    assert.match(run.stderr, /Local-only mode/u);
    assert.deepEqual(run.blocked, []);
    assert.equal(ollama.chats().length, 0);
  });
}

test("a hosted model the operator named is used, and the run says so before sending", async (t) => {
  const run = await runCli(t, ["--model", "llama-3.3-70b-versatile"], {});
  assert.match(run.stderr, /primary model route groq\/llama-3\.3-70b-versatile sends requests off this machine.*chosen from the model name/u);
  // The guard stands in for the network: the opted-in vendor is the only remote host attempted.
  assert.ok(run.blocked.length > 0 && run.blocked.every((entry) => entry.host === "api.groq.com"), JSON.stringify(run.blocked));
});

test("an explicit hosted fallback behind a local Ollama is announced, and the switch is printed when it happens", async (t) => {
  const run = await runCli(t, ["--provider", "ollama", "--model", "qwen2.5-coder:7b", "--fallback", "groq:openai/gpt-oss-120b:GROQ_API_KEY"], { ATLAS_OLLAMA_URL: `http://127.0.0.1:${await closedPort()}` });
  assert.match(run.stderr, /fallback model route groq\/openai\/gpt-oss-120b sends requests off this machine.*explicitly configured/u);
  assert.match(run.stderr, /model route ollama\/qwen2\.5-coder:7b failed \([a-z-]+\); trying groq\/openai\/gpt-oss-120b, which is remote/u);
  assert.ok(run.blocked.every((entry) => entry.host === "api.groq.com"));
});
