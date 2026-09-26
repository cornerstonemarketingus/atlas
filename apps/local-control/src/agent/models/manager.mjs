import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { catalogEntry } from "./catalog.mjs";

/**
 * Atlas-managed local model hosting: Models → Install → Run, without the
 * owner configuring an inference server by hand.
 *
 * Today the engine is Ollama (the most widely installed local runtime); Atlas
 * drives it through its HTTP API on loopback only:
 * - finds the `ollama` binary (PATH and the usual install locations) and, if
 *   no server answers, starts `ollama serve` itself, bound to 127.0.0.1, with
 *   the context length it wants, and stops it again on shutdown — only a
 *   server Atlas started, never one the owner runs;
 * - installs models with live progress (POST /api/pull, streamed), removes
 *   them, warms one with a chosen context length, and reports what is
 *   loaded and how much memory it holds (/api/ps).
 * Model names are checked against a strict pattern (catalog or custom), so a
 * request can never smuggle anything else into the API call.
 *
 * Not done here: downloading the runtime itself. When no binary exists the
 * status says so and links the official installer; an Atlas-bundled engine
 * (llama.cpp) is the next step.
 */

export const OLLAMA_URL = "http://127.0.0.1:11434";
const TAG = /^[a-z0-9][a-z0-9._-]{0,63}(?::[a-z0-9][a-z0-9._-]{0,63})?$/u;
export const INSTALL_GUIDE = "https://ollama.com/download";

export class ModelManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ModelManagerError";
    this.code = code;
  }
}

export function assertModelTag(tag) {
  if (typeof tag !== "string" || !TAG.test(tag)) throw new ModelManagerError("INVALID_MODEL", "Model names look like 'qwen2.5-coder:7b'.");
  return tag;
}

/** Where an `ollama` executable might be, in order. */
export function ollamaCandidates({ platform = process.platform, env = process.env } = {}) {
  const exe = platform === "win32" ? "ollama.exe" : "ollama";
  const fromPath = String(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, exe));
  const known = platform === "win32"
    ? [env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Ollama", exe), env.ProgramFiles && join(env.ProgramFiles, "Ollama", exe)]
    : platform === "darwin"
      ? ["/Applications/Ollama.app/Contents/Resources/ollama", "/opt/homebrew/bin/ollama", "/usr/local/bin/ollama"]
      : ["/usr/local/bin/ollama", "/usr/bin/ollama"];
  return [...fromPath, ...known.filter(Boolean)];
}

function findExecutable(candidates) {
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* next */ }
  }
  return null;
}

/** Parses Ollama's streamed pull progress (NDJSON) into { status, percent }. */
export function pullProgress(line) {
  let event;
  try { event = JSON.parse(line); } catch { return null; }
  if (event?.error) return { error: String(event.error) };
  const percent = Number.isFinite(event?.total) && event.total > 0 && Number.isFinite(event?.completed) ? Math.floor((event.completed / event.total) * 100) : null;
  return { status: String(event?.status ?? ""), percent };
}

export class ModelManager {
  /**
   * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, spawnImpl?: typeof spawn, findBinary?: () => string|null, log?: (line: string) => void, now?: () => Date }} [options]
   */
  constructor({ baseUrl = OLLAMA_URL, fetchImpl = fetch, spawnImpl = spawn, findBinary = () => findExecutable(ollamaCandidates()), log = () => {}, now = () => new Date() } = {}) {
    const url = new URL(baseUrl);
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) throw new ModelManagerError("NOT_LOOPBACK", "Atlas only manages a model server on this machine.");
    this.baseUrl = url.origin;
    this.fetch = fetchImpl;
    this.spawn = spawnImpl;
    this.findBinary = findBinary;
    this.log = log;
    this.now = now;
    this.child = null;
    this.jobs = new Map();
  }

  async #api(path, init = {}, timeoutMs = 5_000) {
    const response = await this.fetch(`${this.baseUrl}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs), headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
    return response;
  }

  async reachable() {
    try { return (await this.#api("/api/version", {}, 1_500)).ok; } catch { return false; }
  }

  async status() {
    const binary = this.findBinary();
    let version = null;
    let installed = [];
    let loaded = [];
    const up = await this.reachable();
    if (up) {
      try { version = (await (await this.#api("/api/version")).json()).version ?? null; } catch { /* keep null */ }
      try { installed = ((await (await this.#api("/api/tags")).json()).models ?? []).map((entry) => ({ tag: entry.name, sizeGB: entry.size ? Math.round(entry.size / 1e8) / 10 : null, quantization: entry.details?.quantization_level ?? null })); } catch { /* keep empty */ }
      try { loaded = ((await (await this.#api("/api/ps")).json()).models ?? []).map((entry) => ({ tag: entry.name, memoryGB: entry.size ? Math.round(entry.size / 1e8) / 10 : null, gpuGB: entry.size_vram ? Math.round(entry.size_vram / 1e8) / 10 : 0, context: entry.context_length ?? null })); } catch { /* keep empty */ }
    }
    return {
      engine: "ollama",
      reachable: up,
      version,
      binary: binary ? "installed" : "missing",
      managed: Boolean(this.child),
      installGuide: binary ? null : INSTALL_GUIDE,
      installed,
      loaded,
      jobs: [...this.jobs.values()].slice(-10),
    };
  }

  /** Makes sure a server answers on loopback, starting one if Atlas can. */
  async ensureServer({ contextLength = 16_384, waitMs = 20_000 } = {}) {
    if (await this.reachable()) return { started: false };
    const binary = this.findBinary();
    if (!binary) throw new ModelManagerError("NO_RUNTIME", `No local model runtime is installed. Install Ollama from ${INSTALL_GUIDE}, then press Start again.`);
    const host = new URL(this.baseUrl).host;
    this.child = this.spawn(binary, ["serve"], {
      shell: false, windowsHide: true, stdio: "ignore", detached: false,
      env: { ...process.env, OLLAMA_HOST: host, OLLAMA_CONTEXT_LENGTH: String(contextLength) },
    });
    this.child.on?.("exit", () => { this.child = null; });
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (await this.reachable()) { this.log(`Started the local model server (${host}, context ${contextLength}).`); return { started: true }; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    this.stopServer();
    throw new ModelManagerError("START_FAILED", "The local model server did not start. Try running `ollama serve` yourself to see why.");
  }

  /** Stops only a server Atlas started. */
  stopServer() {
    if (!this.child) return { stopped: false };
    try { this.child.kill(); } catch { /* already gone */ }
    this.child = null;
    return { stopped: true };
  }

  /** Starts a download in the background; returns the job to poll. */
  install(tag) {
    assertModelTag(tag);
    const running = [...this.jobs.values()].find((job) => job.tag === tag && job.state === "running");
    if (running) return running;
    const job = { id: `pull-${tag}-${this.now().getTime()}`, tag, state: "running", status: "starting", percent: 0, startedAt: this.now().toISOString(), known: Boolean(catalogEntry(tag)) };
    this.jobs.set(job.id, job);
    job.promise = (async () => {
      try {
        await this.ensureServer();
        const response = await this.#api("/api/pull", { method: "POST", body: JSON.stringify({ model: tag, stream: true }) }, 6 * 60 * 60 * 1000);
        if (!response.ok || !response.body) throw new ModelManagerError("PULL_FAILED", `The model server answered ${response.status}.`);
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let newline;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const progress = pullProgress(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            if (!progress) continue;
            if (progress.error) throw new ModelManagerError("PULL_FAILED", progress.error);
            job.status = progress.status;
            if (progress.percent !== null) job.percent = progress.percent;
          }
        }
        job.state = "done";
        job.percent = 100;
        job.status = "installed";
        this.log(`Installed ${tag}.`);
      } catch (error) {
        job.state = "failed";
        job.status = error instanceof Error ? error.message : "The download failed.";
      }
      job.finishedAt = this.now().toISOString();
    })();
    return job;
  }

  async remove(tag) {
    assertModelTag(tag);
    const response = await this.#api("/api/delete", { method: "DELETE", body: JSON.stringify({ model: tag }) });
    if (!response.ok) throw new ModelManagerError("REMOVE_FAILED", response.status === 404 ? `${tag} is not installed.` : `The model server answered ${response.status}.`);
    this.log(`Removed ${tag}.`);
    return { removed: tag };
  }

  /** Loads a model with a context length and keeps it warm for 30 minutes. */
  async warm(tag, contextLength = 16_384) {
    assertModelTag(tag);
    const context = Math.max(2_048, Math.min(131_072, Number(contextLength) || 16_384));
    await this.ensureServer({ contextLength: context });
    const response = await this.#api("/api/generate", { method: "POST", body: JSON.stringify({ model: tag, prompt: "", keep_alive: "30m", options: { num_ctx: context } }) }, 300_000);
    if (!response.ok) throw new ModelManagerError("WARM_FAILED", `Could not load ${tag} (${response.status}).`);
    return { loaded: tag, context };
  }
}
