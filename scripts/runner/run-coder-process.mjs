import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

/** Bounded subprocess with metadata-only progress; stdout stays parseable JSON. */
export function runCoderProcess(command, args, cwd, timeoutMs, { intervalMs = 30_000, maxBytes = 2 * 1024 * 1024, onProgress = console.log, env = process.env } = {}) {
  return new Promise((resolve) => {
    const started = Date.now(); let stdout = "", stderr = "", bytes = 0, timedOut = false, overflow = false, spawnError = false;
    let counters = { modelRequests: 0, toolCalls: 0, failedTools: 0 };
    const child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let force;
    const kill = (signal) => {
      if (!child.pid) return;
      if (process.platform === "win32") spawnSync(join(process.env.SystemRoot || "C:/Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
      else { try { process.kill(-child.pid, signal); } catch { /* already exited */ } }
    };
    const stop = () => { kill("SIGTERM"); force = setTimeout(() => kill("SIGKILL"), 1000); force.unref(); };
    const collect = (type, chunk) => {
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
    const heartbeat = setInterval(() => onProgress("Atlas coder active: " + JSON.stringify({ elapsedSeconds: Math.floor((Date.now() - started) / 1000), ...counters })), intervalMs);
    heartbeat.unref();
    const timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs); timeout.unref();
    child.on("close", (code) => {
      clearInterval(heartbeat); clearTimeout(timeout); clearTimeout(force);
      resolve({ label: "code", exitCode: code, timedOut, outputExceeded: overflow, ok: !spawnError && !timedOut && !overflow && code === 0, stdout,
        stderr: overflow ? "Coder output exceeded its capture bound." : spawnError ? "Coder subprocess could not start." : stderr });
    });
  });
}
