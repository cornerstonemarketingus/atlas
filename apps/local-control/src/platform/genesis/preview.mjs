import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { safeEnvironment } from "../../agent/tools/process.mjs";
import { resolveCheck } from "../self-improve/runtime.mjs";
import { getTemplate } from "./templates/index.mjs";
import { startDesignPreview } from "./visual.mjs";

/**
 * Runs Genesis projects so they can be seen and inspected.
 *
 * - One preview per project, bound to 127.0.0.1 on a free port the manager
 *   allocates; starting again restarts it.
 * - Startup is judged by the template's health URL answering 200, not by the
 *   process merely existing; an early exit or a timeout is a failed start
 *   with the captured logs as evidence (which the repair loop receives).
 * - Output is kept in a bounded ring buffer per preview.
 * - Running previews are recorded in a small registry file, so after Atlas
 *   crashes the next start can stop the orphans it left behind. A recorded
 *   process is only killed when the operating system confirms it is still
 *   the same preview (its command line names the project folder); otherwise
 *   the record is just dropped, because process ids get reused.
 * - Commands run without a shell and with the minimal environment the rest
 *   of Atlas uses, plus HOST and PORT.
 */

const LOG_LINES = 300;

export async function freePort(host = "127.0.0.1") {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function processCommandLine(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" "); } catch { return null; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class PreviewManager {
  /**
   * @param {{ registryPath: string, runPrepare: (argv: string[], cwd: string, options?: object) => Promise<{ exitCode: number, stdout: string, stderr: string }>,
   *   spawnImpl?: typeof spawn, fetchImpl?: typeof fetch, log?: (line: string) => void, pollMs?: number }} options
   */
  constructor({ registryPath, runPrepare, spawnImpl = spawn, fetchImpl = fetch, log = () => {}, pollMs = 250 }) {
    this.registryPath = registryPath;
    this.runPrepare = runPrepare;
    this.spawn = spawnImpl;
    this.fetch = fetchImpl;
    this.log = log;
    this.pollMs = pollMs;
    this.previews = new Map();
    this.designs = new Map();
  }

  #readRegistry() {
    try { return JSON.parse(readFileSync(this.registryPath, "utf8")); } catch { return {}; }
  }

  #writeRegistry() {
    const value = Object.fromEntries([...this.previews.entries()].filter(([, p]) => p.state === "running").map(([id, p]) => [id, { pid: p.pid, port: p.port, folder: p.folder, startedAt: p.startedAt }]));
    mkdirSync(dirname(this.registryPath), { recursive: true });
    writeFileSync(`${this.registryPath}.tmp`, JSON.stringify(value, null, 2));
    renameSync(`${this.registryPath}.tmp`, this.registryPath);
  }

  /** Stops previews a previous Atlas process left running. Returns what it did for each record. */
  cleanupOrphans() {
    const results = [];
    for (const [projectId, record] of Object.entries(this.#readRegistry())) {
      if (!Number.isInteger(record?.pid) || !alive(record.pid)) { results.push({ projectId, action: "gone" }); continue; }
      const commandLine = processCommandLine(record.pid);
      if (commandLine && record.folder && commandLine.includes(record.folder)) {
        try { process.kill(record.pid, "SIGTERM"); results.push({ projectId, action: "stopped", pid: record.pid }); } catch { results.push({ projectId, action: "gone" }); }
      } else {
        results.push({ projectId, action: "left", pid: record.pid, reason: "could not confirm the process is the preview" });
      }
    }
    this.#writeRegistry();
    return results;
  }

  #append(preview, chunk) {
    for (const line of String(chunk).split(/\r?\n/u)) if (line.trim()) preview.logs.push(line.slice(0, 500));
    if (preview.logs.length > LOG_LINES) preview.logs.splice(0, preview.logs.length - LOG_LINES);
  }

  status(projectId) {
    const preview = this.previews.get(projectId);
    if (!preview) return null;
    const { child, ...rest } = preview;
    return { ...rest, logs: rest.logs.slice(-80) };
  }

  list() { return [...this.previews.keys()].map((id) => this.status(id)); }

  async design(project, parentOrigin) {
    const previous = this.designs.get(project.id);
    const pending = (async () => {
      const old = await previous?.catch(() => null);
      await old?.close();
      return startDesignPreview(project, parentOrigin);
    })();
    this.designs.set(project.id, pending);
    try {
      const view = await pending;
      return { url: view.url, session: view.session };
    } catch (error) {
      if (this.designs.get(project.id) === pending) this.designs.delete(project.id);
      throw error;
    }
  }

  /** Starts (or restarts) the project's preview; resolves once its health URL answers, or with the failure and logs. */
  async start(project, { timeoutMs = null } = {}) {
    await this.stop(project.id);
    const template = getTemplate(project.plan.template);
    const folder = resolve(project.workspace);
    if (!existsSync(folder)) return { ok: false, reason: "The project folder does not exist.", logs: "" };
    if (template.preview.prepare) {
      const prepared = await this.runPrepare(template.preview.prepare, folder, { timeoutMs: 300_000 });
      if (prepared.exitCode !== 0) return { ok: false, reason: `Preparing the preview failed (${template.preview.prepare.join(" ")}).`, logs: `${prepared.stdout}\n${prepared.stderr}`.trim().slice(-4000) };
    }
    const port = await freePort();
    const env = Object.fromEntries(Object.entries(template.preview.env).map(([key, value]) => [key, String(value).replace("{port}", String(port))]));
    const [command, args] = resolveCheck(template.preview.command);
    const preview = { projectId: project.id, folder, port, url: `http://127.0.0.1:${port}`, state: "starting", startedAt: new Date().toISOString(), pid: null, logs: [], exitCode: null };
    const child = this.spawn(command, args, { cwd: folder, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: safeEnvironment(env) });
    preview.child = child;
    preview.pid = child.pid ?? null;
    this.previews.set(project.id, preview);
    child.stdout?.on("data", (chunk) => this.#append(preview, chunk));
    child.stderr?.on("data", (chunk) => this.#append(preview, chunk));
    child.on("error", (error) => { this.#append(preview, `could not start: ${error.message}`); preview.state = "exited"; });
    child.on("exit", (code) => { preview.exitCode = code; if (preview.state !== "stopped") preview.state = "exited"; this.#writeRegistry(); });

    const deadline = Date.now() + (timeoutMs ?? template.preview.startupTimeoutMs);
    while (Date.now() < deadline) {
      if (preview.state === "exited") break;
      try {
        const response = await this.fetch(`${preview.url}${template.preview.health}`, { signal: AbortSignal.timeout(2_000) });
        if (response.ok) {
          preview.state = "running";
          this.#writeRegistry();
          this.log(`Preview for ${project.id} running at ${preview.url}`);
          return { ok: true, url: preview.url, port, pid: preview.pid };
        }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    const exited = preview.state === "exited";
    await this.stop(project.id);
    return { ok: false, reason: exited ? `The app exited during startup (code ${preview.exitCode ?? "unknown"}).` : `The app did not answer ${template.preview.health} within ${Math.round((timeoutMs ?? template.preview.startupTimeoutMs) / 1000)} s.`, logs: preview.logs.join("\n").slice(-4000) };
  }

  async stop(projectId) {
    const design = await this.designs.get(projectId)?.catch(() => null);
    await design?.close();
    this.designs.delete(projectId);
    const preview = this.previews.get(projectId);
    if (!preview) return false;
    const wasRunning = preview.state === "running" || preview.state === "starting";
    preview.state = "stopped";
    if (preview.child && preview.child.exitCode === null && !preview.child.killed) {
      await new Promise((done) => {
        const timer = setTimeout(() => { try { preview.child.kill("SIGKILL"); } catch { /* gone */ } done(); }, 3_000);
        preview.child.once("exit", () => { clearTimeout(timer); done(); });
        try { preview.child.kill("SIGTERM"); } catch { clearTimeout(timer); done(); }
      });
    }
    this.#writeRegistry();
    return wasRunning;
  }

  async stopAll() {
    for (const id of [...this.designs.keys()]) await this.stop(id);
    for (const id of [...this.previews.keys()]) await this.stop(id);
  }
}
