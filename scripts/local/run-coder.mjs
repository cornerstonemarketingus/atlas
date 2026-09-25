#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { safeEnvironment } from "../../apps/local-control/src/agent/tools/process.mjs";

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
  --model <name>            Ollama model (default: qwen2.5-coder:7b)
  --base-url <url>          OpenAI-compatible base URL (default: http://127.0.0.1:11434/v1)
  --context-window <n>      Served context window (default: 16384)
  --max-output-tokens <n>   Output limit per turn (default: 2048)
  --verify-dir <path>       Package directory containing build/test scripts
  --audit-log <path>        Local audit log destination

This path uses local Git, local tools, and a self-hosted OpenAI-compatible model.
It does not need a GitHub, Cloudflare, Groq, or Anthropic credential.`);
  process.exit(0);
}

const repository = option("--repository");
const objective = option("--objective");
if (!repository || !objective) throw new Error("--repository and --objective are required. Run with --help for usage.");

const model = option("--model", "qwen2.5-coder:7b");
const baseUrl = option("--base-url", "http://127.0.0.1:11434/v1");
const contextWindow = option("--context-window", "16384");
const maxOutputTokens = option("--max-output-tokens", "2048");
const verifyDir = option("--verify-dir", "");
const defaultAudit = join(homedir(), ".atlas", "runs", `${new Date().toISOString().replaceAll(":", "-")}.jsonl`);
const auditLog = resolve(option("--audit-log", defaultAudit));

const endpoint = new URL(baseUrl);
if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname))) {
  throw new Error("Self-hosted endpoints must use HTTPS unless they are loopback URLs.");
}

const modelsUrl = new URL(`${endpoint.pathname.replace(/\/$/u, "")}/models`, endpoint.origin);
let response;
try {
  response = await fetch(modelsUrl, { signal: AbortSignal.timeout(5_000) });
} catch {
  throw new Error(`No self-hosted model server answered at ${modelsUrl}. Start Ollama before running Atlas.`);
}
if (!response.ok) throw new Error(`The self-hosted model server returned HTTP ${response.status} from ${modelsUrl}.`);

const cliDirectory = join(atlasRoot, "packages", "atlas-cli");
const cli = join(cliDirectory, "dist", "src", "cli.js");
const build = spawnSync("npm", ["run", "build"], { cwd: cliDirectory, stdio: "inherit", shell: process.platform === "win32" });
if (build.error || build.status !== 0) process.exit(build.status ?? 1);

mkdirSync(dirname(auditLog), { recursive: true });
const args = [
  cli, "code", resolve(repository), objective,
  "--provider", "groq",
  "--api-key-env", "ATLAS_LOCAL_MODEL_KEY",
  "--model", model,
  "--base-url", baseUrl,
  "--context-window", contextWindow,
  "--max-output-tokens", maxOutputTokens,
  "--audit-log", auditLog,
  "--format", "text",
];
if (verifyDir) args.push("--verify-dir", verifyDir);

console.log(`Atlas local-only run\nModel: ${model}\nRepository: ${resolve(repository)}\nAudit: ${auditLog}`);
const run = spawnSync(process.execPath, args, {
  cwd: atlasRoot,
  stdio: "inherit",
  env: safeEnvironment({ ATLAS_LOCAL_MODEL_KEY: "local-only-no-credential" }),
  timeout: 18_000_000,
});
if (run.error) throw run.error;
process.exit(run.status ?? 1);
