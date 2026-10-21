import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

/** Bounded subprocess with metadata-only progress; stdout stays parseable JSON. */
export function runCoderProcess(command, args, cwd, timeoutMs, { intervalMs = 30_000, maxBytes = 2 * 1024 * 1024, cleanupMs = 1000, onProgress = console.log, env = process.env } = {}) {
  for (const [name, value, maximum] of [["timeoutMs", timeoutMs, 2_147_483_647], ["intervalMs", intervalMs, 2_147_483_647], ["maxBytes", maxBytes, Number.MAX_SAFE_INTEGER], ["cleanupMs", cleanupMs, 5000]]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new RangeError(`Invalid coder ${name}`);
  }
  return new Promise((resolve) => {
    const started = Date.now(); let stdout = "", stderr = "", bytes = 0, timedOut = false, overflow = false, spawnError = false;
    let counters = { modelRequests: 0, toolCalls: 0, failedTools: 0 };
    let cleanup, stopping = false, settled = false, exitCode = null;
    const child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const kill = (signal) => {
      if (!child.pid) return;
      if (process.platform === "win32") spawnSync(join(process.env.SystemRoot || "C:/Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
      else { try { process.kill(-child.pid, signal); } catch { /* already exited */ } }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat); clearTimeout(timeout); clearTimeout(cleanup);
      // Descendants outside the group may retain inherited pipes. Their lifetime
      // cannot extend the trusted runner's cleanup deadline.
      child.stdout.destroy(); child.stderr.destroy();
      resolve({ label: "code", exitCode, timedOut, outputExceeded: overflow, ok: !spawnError && !timedOut && !overflow && exitCode === 0, stdout,
        stderr: overflow ? "Coder output exceeded its capture bound." : spawnError ? "Coder subprocess could not start." : stderr });
    };
    const stop = () => {
      if (stopping || settled) return;
      stopping = true;
      clearInterval(heartbeat);
      kill("SIGTERM");
      // Keep escalation alive even if the group leader exits before its children.
      cleanup = setTimeout(() => { kill("SIGKILL"); finish(); }, cleanupMs);
    };
    const collect = (type, chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) { if (!overflow) { overflow = true; stop(); } return; }
      if (type === "stdout") stdout += chunk;
      else {
        stderr += chunk;
        const matches = [...stderr.slice(-4096).matchAll(/Atlas progress: (\{"modelRequests":\d+,"toolCalls":\d+,"failedTools":\d+\})/gu)];
        if (matches.length) counters = JSON.parse(matches.at(-1)[1]);
      }
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.on("error", () => { spawnError = true; });
    const heartbeat = setInterval(() => {
      try { Promise.resolve(onProgress("Atlas coder active: " + JSON.stringify({ elapsedSeconds: Math.floor((Date.now() - started) / 1000), ...counters }))).catch(() => {}); }
      catch { /* An observer failure must not abandon a running coder. */ }
    }, intervalMs);
    heartbeat.unref();
    const timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs); timeout.unref();
    child.on("exit", (code) => { exitCode = code; });
    child.on("close", (code) => {
      exitCode = code;
      if (!stopping) finish();
    });
  });
}
