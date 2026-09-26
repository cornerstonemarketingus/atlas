import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { runCommand, safeEnvironment } from "../../agent/tools/process.mjs";
import { reviewChange } from "./reviewer.mjs";

/**
 * The real builder, check runner and reviewer for a self-improvement loop,
 * shared by the terminal command (scripts/local/self-improve.mjs) and the
 * daemon's service, so both run exactly the same thing.
 *
 * - Builder: Atlas's own coder (packages/atlas-cli `atlas code`), editing the
 *   worktree and verifying/repairing its change, against an OpenAI-compatible
 *   endpoint (a local Ollama by default). Its output streams to `onOutput`.
 * - Checks: argv arrays run with no shell and a minimal environment. On
 *   Windows `node` and `npm` go through this Node binary (npm via its own
 *   npm-cli.js), because the shell-free runner cannot start npm's .cmd shim.
 * - Reviewer: a separate chat call (reviewer.mjs), optionally another model.
 */

export const DEFAULT_MODEL_ENDPOINT = Object.freeze({ baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5-coder:7b" });
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Throws for an endpoint that would send repository content in clear text over a network. */
export function assertSafeEndpoint(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Error("Model endpoints must use HTTPS unless they are loopback URLs.");
  }
  if (url.username || url.password) throw new Error("Put model credentials in an environment variable, not in the URL.");
  return url;
}

export function isLoopback(baseUrl) {
  return LOOPBACK.has(new URL(baseUrl).hostname);
}

/** Builds packages/atlas-cli once; returns the CLI entry point. */
export function buildCoderCli(atlasRoot, { stdio = "inherit" } = {}) {
  const cliDirectory = join(atlasRoot, "packages", "atlas-cli");
  const build = spawnSync("npm", ["run", "build"], { cwd: cliDirectory, stdio, shell: process.platform === "win32" });
  if (build.error || build.status !== 0) throw new Error("Building the Atlas coder failed.");
  return join(cliDirectory, "dist", "src", "cli.js");
}

/**
 * @param {{ atlasRoot: string, cli: string, runsDirectory: string, endpoint: { baseUrl: string, model: string, apiKey?: string|null },
 *   contextWindow?: string, maxOutputTokens?: string, onOutput?: (text: string) => void, timeoutMs?: number }} options
 */
export function createCoderBuilder({ atlasRoot, cli, runsDirectory, endpoint, contextWindow = "16384", maxOutputTokens = "2048", onOutput = null, timeoutMs = 18_000_000 }) {
  assertSafeEndpoint(endpoint.baseUrl);
  mkdirSync(runsDirectory, { recursive: true });
  return ({ worktree, objective, verifyDirectory }) => new Promise((resolve) => {
    const auditLog = join(runsDirectory, `${new Date().toISOString().replaceAll(":", "-")}.jsonl`);
    const args = [
      cli, "code", worktree, objective,
      "--provider", "groq",
      "--api-key-env", "ATLAS_SELF_IMPROVE_KEY",
      "--model", endpoint.model,
      "--base-url", endpoint.baseUrl,
      ...(isLoopback(endpoint.baseUrl) ? ["--context-window", contextWindow, "--max-output-tokens", maxOutputTokens] : []),
      "--audit-log", auditLog,
      "--verify-dir", verifyDirectory,
      "--format", "text",
    ];
    const child = spawn(process.execPath, args, {
      cwd: atlasRoot, shell: false, windowsHide: true,
      stdio: ["ignore", onOutput ? "pipe" : "inherit", onOutput ? "pipe" : "inherit"],
      env: safeEnvironment({ ATLAS_SELF_IMPROVE_KEY: endpoint.apiKey || "local-only-no-credential" }),
    });
    if (onOutput) {
      child.stdout.on("data", (chunk) => onOutput(String(chunk)));
      child.stderr.on("data", (chunk) => onOutput(String(chunk)));
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", () => { clearTimeout(timer); resolve({ ok: false, summary: `the coder could not start; audit ${auditLog}` }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, summary: `coder exited ${code ?? "abnormally"}; audit ${auditLog}` }); });
  });
}

/** `node`/`npm` through this Node binary where the shell-free runner needs it. */
export function resolveCheck([command, ...args], { platform = process.platform, execPath = process.execPath } = {}) {
  if (command === "node") return [execPath, args];
  if (command === "npm" && platform === "win32") {
    const npmCli = join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(npmCli)) return [execPath, [npmCli, ...args]];
  }
  return [command, args];
}

export async function runCheck(argv, cwd, { timeoutMs = 900_000 } = {}) {
  const [command, args] = resolveCheck(argv);
  const result = await runCommand(command, args, { cwd, timeoutMs, maxBytes: 2_000_000, env: safeEnvironment() });
  return { exitCode: result.status ?? (result.ok ? 0 : 1), stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut };
}

export function createReviewer(endpoint) {
  assertSafeEndpoint(endpoint.baseUrl);
  return ({ objective, diff, checks }) => reviewChange({ endpoint, objective, diff, checks });
}
