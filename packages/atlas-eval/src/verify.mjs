import { spawn } from "node:child_process";

const ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "LANG"];
const OUTPUT_CAP = 16_000;

/** Test environment: an allowlist only, so provider keys never reach verification. */
export function verifyEnvironment(source = process.env) {
  const env = {};
  for (const key of ENV_ALLOWLIST) if (source[key] !== undefined) env[key] = source[key];
  env.CI = "1";
  return env;
}

/**
 * Runs the task's own verification command (argv, no shell) in the workspace.
 * Pass means exit code 0; nothing the agent said is consulted.
 */
export function runVerify({ argv, cwd, timeoutMs, env = verifyEnvironment() }) {
  return new Promise((resolveRun) => {
    const started = Date.now();
    let output = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(argv[0], argv.slice(1), { cwd, env, windowsHide: true, detached: process.platform !== "win32" });
    const collect = (chunk) => { if (output.length < OUTPUT_CAP) output += chunk.toString("utf8").slice(0, OUTPUT_CAP - output.length); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ ...result, output, durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.platform === "win32" ? child.kill("SIGKILL") : process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    child.on("error", (error) => finish({ exitCode: null, timedOut, spawnError: error.code ?? "SPAWN_ERROR" }));
    child.on("close", (exitCode) => finish({ exitCode, timedOut }));
  });
}
