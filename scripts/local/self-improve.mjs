#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCommand, safeEnvironment } from "../../apps/local-control/src/agent/tools/process.mjs";
import { SelfImprovementLoop } from "../../apps/local-control/src/platform/self-improve/loop.mjs";
import { reviewChange } from "../../apps/local-control/src/platform/self-improve/reviewer.mjs";

/**
 * "Atlas, improve yourself" from a terminal, with no GitHub, Cloudflare or
 * hosted model required: each iteration picks one small improvement, makes
 * it in an isolated worktree with the local coder, re-verifies, applies the
 * self-modification policy, has a separate reviewer model judge the diff,
 * and leaves an accepted change as a branch + patch for you to approve.
 */

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
  node scripts/local/self-improve.mjs [options]

Options:
  --repository <path>       Repository to improve (default: this Atlas checkout)
  --iterations <n>          Attempts to make, one improvement each (default: 1)
  --verify-dir <path>       Directory whose checks gate acceptance (default: apps/local-control)
  --prepare <command>       Run before checks in each fresh worktree, e.g. "npm ci --ignore-scripts"
  --model <name>            Builder model (default: qwen2.5-coder:7b)
  --review-model <name>     Reviewer model (default: same as --model)
  --base-url <url>          OpenAI-compatible endpoint (default: http://127.0.0.1:11434/v1)
  --api-key-env <NAME>      Environment variable holding a key, for a hosted endpoint
  --context-window <n>      Served context window (default: 16384)
  --max-output-tokens <n>   Output limit per builder turn (default: 2048)
  --home <path>             Where worktrees, patches and the ledger live (default: ~/.atlas/self-improve)

Accepted changes are never merged. Each is left as branch atlas/self-*/builder
and a patch in <home>/patches; the ledger in <home>/ledger.jsonl records every
attempt, why it was chosen, and the streak of consecutive accepted changes.`);
  process.exit(0);
}

const repository = resolve(option("--repository", atlasRoot));
const iterations = Math.max(1, Math.min(50, Number(option("--iterations", "1")) || 1));
const verifyDirectory = option("--verify-dir", "apps/local-control");
const prepare = option("--prepare", "") ? [option("--prepare").split(/\s+/u).filter(Boolean)] : [];
const model = option("--model", "qwen2.5-coder:7b");
const reviewModel = option("--review-model", model);
const baseUrl = option("--base-url", "http://127.0.0.1:11434/v1");
const apiKeyEnv = option("--api-key-env", "");
const contextWindow = option("--context-window", "16384");
const maxOutputTokens = option("--max-output-tokens", "2048");
const home = resolve(option("--home", join(homedir(), ".atlas", "self-improve")));

const endpoint = new URL(baseUrl);
const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(endpoint.hostname);
if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) throw new Error("Model endpoints must use HTTPS unless they are loopback URLs.");
const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : "";
if (apiKeyEnv && !apiKey) throw new Error(`${apiKeyEnv} is not set.`);

const cliDirectory = join(atlasRoot, "packages", "atlas-cli");
const cli = join(cliDirectory, "dist", "src", "cli.js");
console.log("Building the Atlas coder…");
const build = spawnSync("npm", ["run", "build"], { cwd: cliDirectory, stdio: "inherit", shell: process.platform === "win32" });
if (build.error || build.status !== 0) process.exit(build.status ?? 1);
mkdirSync(join(home, "runs"), { recursive: true });

/** The builder: Atlas's own coder, editing the worktree and verifying/repairing its change. */
async function builder({ worktree, objective, verifyDirectory: verifyDir }) {
  const auditLog = join(home, "runs", `${new Date().toISOString().replaceAll(":", "-")}.jsonl`);
  const args = [
    cli, "code", worktree, objective,
    "--provider", "groq",
    "--api-key-env", "ATLAS_SELF_IMPROVE_KEY",
    "--model", model,
    "--base-url", baseUrl,
    ...(loopback ? ["--context-window", contextWindow, "--max-output-tokens", maxOutputTokens] : []),
    "--audit-log", auditLog,
    "--verify-dir", verifyDir,
    "--format", "text",
  ];
  const run = spawnSync(process.execPath, args, {
    cwd: atlasRoot, stdio: "inherit", timeout: 18_000_000,
    env: safeEnvironment({ ATLAS_SELF_IMPROVE_KEY: apiKey || "local-only-no-credential" }),
  });
  return { ok: !run.error && run.status === 0, summary: `coder exited ${run.status ?? "abnormally"}; audit ${auditLog}` };
}

async function runCheck(argv, cwd) {
  const [command, ...args] = argv;
  const result = await runCommand(command, args, { cwd, timeoutMs: 900_000, maxBytes: 2_000_000, env: safeEnvironment() });
  return { exitCode: result.status ?? (result.ok ? 0 : 1), stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut };
}

const reviewer = ({ objective, diff, checks }) => reviewChange({ endpoint: { baseUrl, model: reviewModel, apiKey }, objective, diff, checks });

const loop = new SelfImprovementLoop({
  repository,
  worktreeRoot: join(home, "worktrees"),
  ledgerPath: join(home, "ledger.jsonl"),
  patchesDirectory: join(home, "patches"),
  verifyDirectory,
  prepare,
  builder,
  runCheck,
  reviewer,
  log: (line) => console.log(line),
});

console.log(`Atlas self-improvement · ${iterations} iteration(s) · builder ${model} · reviewer ${reviewModel} · ${baseUrl}`);
const { results, streak } = await loop.run({ iterations });
console.log("");
for (const result of results) {
  const detail = result.outcome === "accepted"
    ? `branch ${result.branch}, patch ${result.patch}`
    : (result.violations ?? []).map((item) => item.detail).join("; ") || result.reason || "";
  console.log(`${result.outcome.toUpperCase().padEnd(9)} ${result.kind ?? ""} ${detail}`);
}
console.log(`\nStreak of consecutive accepted self-improvements: ${streak}. Ledger: ${join(home, "ledger.jsonl")}`);
console.log("To take an accepted change: git merge <branch>   (or: git am <patch>)");
process.exit(results.some((result) => result.outcome === "error") ? 1 : 0);
