#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { safeEnvironment } from "../../apps/local-control/src/agent/tools/process.mjs";
import { resolveOllamaBaseUrl } from "../../apps/local-control/src/agent/models/egress.mjs";

const atlasRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

if (process.argv.includes("--help")) {
  console.log(`Usage:
  node scripts/local/run-coder.mjs --repository <path> --objective <text> [options]

Options:
  --provider <id>           ollama (default, native API), local (credential-free OpenAI-compatible, loopback only) or groq
  --model <name>            Model (default: $ATLAS_LOCAL_CODER_MODEL, else qwen3:0.6b)
  --base-url <url>          Model server base URL (default: $ATLAS_OLLAMA_URL or $OLLAMA_HOST, else http://127.0.0.1:11434/v1)
  --context-window <n>      Served context window (default: 16384)
  --max-output-tokens <n>   Output limit per turn (default: 2048)
  --verify-dir <path>       Package directory containing build/test scripts
  --audit-log <path>        Local audit log destination

This path uses local Git, local tools, and a self-hosted OpenAI-compatible model.
It does not need a GitHub, Cloudflare, Groq, or Anthropic credential. With a
loopback --base-url the coder runs with --local-only: no route may leave this
machine, and if the model server is down the run fails instead of switching.`);
  process.exit(0);
}

const repository = option("--repository");
const objective = option("--objective");
if (!repository || !objective) throw new Error("--repository and --objective are required. Run with --help for usage.");

const provider = option("--provider", "ollama");
if (!["ollama", "local", "groq"].includes(provider)) throw new Error("--provider must be ollama, local or groq for a local run.");
const model = option("--model", process.env.ATLAS_LOCAL_CODER_MODEL || "qwen3:0.6b");
const baseUrl = option("--base-url", `${resolveOllamaBaseUrl(process.env)}/v1`);
const contextWindow = option("--context-window", "16384");
const maxOutputTokens = option("--max-output-tokens", "2048");
const verifyDir = option("--verify-dir", "");
const defaultAudit = join(homedir(), ".atlas", "runs", `${new Date().toISOString().replaceAll(":", "-")}.jsonl`);
const auditLog = resolve(option("--audit-log", defaultAudit));

const endpoint = new URL(baseUrl);
const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);
if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
  throw new Error("Self-hosted endpoints must use HTTPS unless they are loopback URLs.");
}

// Ollama's native API lists installed models at /api/tags; other servers at {base}/models.
const modelsUrl = provider === "ollama"
  ? new URL("/api/tags", endpoint.origin)
  : new URL(`${endpoint.pathname.replace(/\/$/u, "")}/models`, endpoint.origin);
let response;
try {
  response = await fetch(modelsUrl, { signal: AbortSignal.timeout(5_000) });
} catch {
  throw new Error(`No self-hosted model server answered at ${modelsUrl}. Start Ollama before running Atlas.`);
}
if (!response.ok) throw new Error(`The self-hosted model server returned HTTP ${response.status} from ${modelsUrl}.`);
if (provider === "ollama") {
  const installed = ((await response.json().catch(() => ({}))).models ?? []).map((entry) => String(entry.name ?? entry.model ?? ""));
  const present = installed.some((name) => name === model || name === `${model}:latest`);
  if (installed.length > 0 && !present) throw new Error(`Model '${model}' is not installed in Ollama (installed: ${installed.join(", ")}). Run: ollama pull ${model}`);
}

const cliDirectory = join(atlasRoot, "packages", "atlas-cli");
const cli = join(cliDirectory, "dist", "src", "cli.js");
const build = spawnSync("npm", ["run", "build"], { cwd: cliDirectory, stdio: "inherit", shell: process.platform === "win32" });
if (build.error || build.status !== 0) process.exit(build.status ?? 1);

mkdirSync(dirname(auditLog), { recursive: true });
const args = [
  cli, "code", resolve(repository), objective,
  "--provider", provider,
  ...(provider === "groq" ? ["--api-key-env", "ATLAS_LOCAL_MODEL_KEY"] : []),
  "--model", model,
  "--base-url", baseUrl,
  "--context-window", contextWindow,
  "--max-output-tokens", maxOutputTokens,
  "--audit-log", auditLog,
  "--format", "text",
  // A loopback server means a local run: the CLI refuses any route off this machine.
  ...(loopback ? ["--local-only"] : []),
];
if (verifyDir) args.push("--verify-dir", verifyDir);

console.log(`Atlas local-only run\nProvider: ${provider}\nModel: ${model}\nContext window: ${contextWindow}\nRepository: ${resolve(repository)}\nAudit: ${auditLog}`);
const run = spawnSync(process.execPath, args, {
  cwd: atlasRoot,
  stdio: "inherit",
  env: safeEnvironment({ ATLAS_LOCAL_MODEL_KEY: "local-only-no-credential" }),
  timeout: 18_000_000,
});
if (run.error) throw run.error;
process.exit(run.status ?? 1);
