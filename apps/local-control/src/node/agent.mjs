import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

import { detectHardware } from "../agent/models/hardware.mjs";
import { capabilityGaps, normalizeCapabilities } from "../platform/workers/registry.mjs";

/**
 * The Atlas Node program: runs on a machine the owner brings, dials OUT to
 * the owner's daemon, and renders jobs inside its own container sandbox.
 *
 * - Outbound only. It never listens on a port. It talks HTTPS to the daemon;
 *   plain http is accepted only for a loopback daemon on the same machine.
 * - It declares what it can honestly do: CPU cores and memory and any GPU
 *   from hardware detection, and the render tools RenderRunner.status()
 *   reports (none without a working container sandbox).
 * - Every job runs through RenderRunner, which only ever starts the
 *   container runtime (network off, staging copy of the inputs). A job that
 *   needs something this node lacks is handed back for another node.
 * - Inputs are verified against the daemon's sha256 before use; outputs are
 *   uploaded with their sha256 and the daemon re-checks them.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export class NodeAgentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NodeAgentError";
    this.code = code;
  }
}

/** The daemon URL, if it is HTTPS (or http to loopback). Anything else is refused. */
export function validateDaemonUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new NodeAgentError("INVALID_DAEMON_URL", "--daemon must be a URL such as https://atlas.example.com."); }
  if (url.username || url.password) throw new NodeAgentError("INVALID_DAEMON_URL", "Do not put credentials in the daemon URL; use the token environment variable.");
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url;
  throw new NodeAgentError("INSECURE_DAEMON_URL", "The daemon must be reached over https:// (plain http only to 127.0.0.1/localhost on this machine).");
}

/** Registry capabilities for this machine: hardware plus what the render runner can actually do. */
export async function nodeCapabilities({ render, detectHardwareImpl = detectHardware }) {
  const hardware = await detectHardwareImpl();
  const tools = render.registryCapabilities();
  const largestGpu = (hardware.gpus ?? []).reduce((largest, gpu) => Math.max(largest, gpu.memoryGiB ?? 0), 0);
  return normalizeCapabilities({
    terminal: tools.length ? ["container"] : [],
    render: tools,
    gpu: largestGpu > 0 ? { vramGb: largestGpu } : null,
    cpu: { cores: hardware.cpuCount, memoryGiB: hardware.totalMemoryGiB },
  });
}

export class AtlasNodeAgent {
  #daemon;
  #token;
  #render;
  #fetch;
  #workRoot;
  #detectHardware;
  #log;
  #capabilities = null;
  #busy = false;

  /**
   * @param options.daemonUrl  https URL of the owner's daemon (http only for loopback)
   * @param options.token      this node's token (from the environment; never logged)
   * @param options.render     a RenderRunner configured with this machine's container sandbox and images
   */
  constructor({ daemonUrl, token, render, fetchImpl = globalThis.fetch, workRoot = tmpdir(), detectHardwareImpl = detectHardware,
    heartbeatIntervalMs = 15_000, claimWaitMs = 20_000, log = () => {} }) {
    this.#daemon = validateDaemonUrl(daemonUrl);
    if (typeof token !== "string" || token.length < 32) throw new NodeAgentError("TOKEN_REQUIRED", "A node token is required (set it in the token environment variable).");
    if (!render || typeof render.run !== "function" || typeof render.status !== "function") throw new NodeAgentError("INVALID_ARGUMENT", "A RenderRunner is required.");
    if (typeof workRoot !== "string" || !isAbsolute(workRoot)) throw new NodeAgentError("INVALID_ARGUMENT", "workRoot must be an absolute path.");
    this.#token = token;
    this.#render = render;
    this.#fetch = fetchImpl;
    this.#workRoot = workRoot;
    this.#detectHardware = detectHardwareImpl;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.claimWaitMs = claimWaitMs;
    this.#log = log;
  }

  get capabilities() { return this.#capabilities; }

  async #request(method, path, { json = undefined, body = undefined, headers = {}, raw = false, signal = undefined } = {}) {
    signal?.throwIfAborted();
    const url = new URL(path, this.#daemon);
    const init = { method, headers: { authorization: `Bearer ${this.#token}`, ...headers }, redirect: "error", signal };
    if (json !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(json); }
    if (body !== undefined) { init.body = body; init.duplex = "half"; }
    const response = await this.#fetch(url, init);
    if (raw) return response;
    const text = await response.text();
    let value = null;
    try { value = text ? JSON.parse(text) : null; } catch { value = { message: text.slice(0, 200) }; }
    if (!response.ok) {
      const error = new NodeAgentError(value?.code ?? `HTTP_${response.status}`, value?.message ?? `The daemon answered ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return value;
  }

  async refreshCapabilities() {
    this.#capabilities = await nodeCapabilities({ render: this.#render, detectHardwareImpl: this.#detectHardware });
    return this.#capabilities;
  }

  /** Announces this node; until the owner approves it, it receives no jobs. */
  async register({ signal } = {}) {
    if (!this.#capabilities) await this.refreshCapabilities();
    return this.#request("POST", "/v1/node/register", { json: { capabilities: this.#capabilities, load: 0 }, signal });
  }

  async heartbeat({ signal } = {}) {
    return this.#request("POST", "/v1/node/heartbeat", { json: { capabilities: this.#capabilities ?? undefined, load: this.#busy ? 1 : 0 }, signal });
  }

  /** Long-polls for one job and runs it. Returns what happened. */
  async runOnce({ waitMs = this.claimWaitMs, signal } = {}) {
    const { job, reason } = await this.#request("POST", "/v1/node/claim", { json: { waitMs }, signal });
    if (!job) return { claimed: false, reason };
    this.#busy = true;
    try { return { claimed: true, jobId: job.id, ...(await this.execute(job, { signal })) }; } finally { this.#busy = false; }
  }

  async #jobCall(job, action, json, { signal } = {}) {
    return this.#request("POST", `/v1/node/jobs/${encodeURIComponent(job.id)}/${action}`, { json: { claimId: job.claimId, ...json }, signal });
  }

  /** Runs one claimed job end to end. */
  async execute(job, { signal } = {}) {
    signal?.throwIfAborted();
    const caps = this.#capabilities ?? await this.refreshCapabilities();
    const gaps = capabilityGaps(caps, job.requirements ?? {});
    if (gaps.length) {
      // Never attempt what this machine cannot do; another node may.
      await this.#jobCall(job, "fail", { retryable: true, error: `This node lacks: ${gaps.join("; ")}` }, { signal }).catch(() => {});
      return { status: "declined", gaps };
    }
    const workspace = await mkdtemp(join(this.#workRoot, "atlas-node-job-"));
    let lost = false;
    const ticker = setInterval(() => {
      this.#jobCall(job, "status", { message: "rendering" }, { signal }).catch((error) => { if (error.code === "CLAIM_LOST" || error.status === 401) lost = true; });
    }, this.heartbeatIntervalMs);
    ticker.unref?.();
    try {
      for (const [index, input] of job.inputs.entries()) {
        try { await this.#download(job, index, input, workspace, { signal }); } catch (error) {
          if (signal?.aborted) throw error;
          await this.#jobCall(job, "fail", { retryable: true, error: `input ${input.path}: ${error.message}` }, { signal }).catch(() => {});
          return { status: "input_failed", error: error.message };
        }
      }
      await this.#jobCall(job, "status", { progress: 0, message: "inputs verified; rendering in the container sandbox" }, { signal });
      signal?.throwIfAborted();
      let result;
      try {
        result = await this.#render.run(workspace, job.render);
      } catch (error) {
        // Refused before anything ran (no sandbox, image not configured): let another node try.
        await this.#jobCall(job, "fail", { retryable: true, error: `${error.code ?? "RENDER_REFUSED"}: ${error.message}` }, { signal }).catch(() => {});
        return { status: "refused", error: error.message };
      }
      clearInterval(ticker);
      signal?.throwIfAborted();
      if (lost) return { status: "lost" };
      if (!result.ok) {
        await this.#jobCall(job, "fail", { retryable: false, error: result.error ?? result.status }, { signal }).catch(() => {});
        return { status: "failed", error: result.error };
      }
      const files = [];
      for (const file of result.files) {
        const path = join(workspace, ...file.path.split("/"));
        const info = await stat(path);
        await this.#request("PUT", `/v1/node/jobs/${encodeURIComponent(job.id)}/outputs?claim=${encodeURIComponent(job.claimId)}&path=${encodeURIComponent(file.path)}`, {
          body: Readable.toWeb(createReadStream(path)), headers: { "content-type": "application/octet-stream", "x-atlas-sha256": file.sha256, "x-atlas-bytes": String(info.size) }, signal,
        });
        files.push({ path: file.path, sha256: file.sha256 });
      }
      const done = await this.#jobCall(job, "complete", { files }, { signal });
      return { status: "succeeded", job: done.job };
    } catch (error) {
      if (error.code === "CLAIM_LOST" || error.status === 401) return { status: "lost", error: error.message };
      throw error;
    } finally {
      clearInterval(ticker);
      await rm(workspace, { recursive: true, force: true });
    }
  }

  async #download(job, index, input, workspace, { signal } = {}) {
    const response = await this.#request("GET", `/v1/node/jobs/${encodeURIComponent(job.id)}/inputs/${index}?claim=${encodeURIComponent(job.claimId)}`, { raw: true, signal });
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      throw new NodeAgentError(`HTTP_${response.status}`, `the daemon answered ${response.status}`);
    }
    const target = join(workspace, ...input.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    const hash = createHash("sha256");
    let seen = 0;
    await pipeline(Readable.fromWeb(response.body), new Transform({
      transform(chunk, _encoding, done) {
        seen += chunk.length;
        if (seen > input.bytes) return done(new NodeAgentError("INPUT_TOO_LARGE", "more bytes than declared"));
        hash.update(chunk);
        done(null, chunk);
      },
    }), createWriteStream(target, { mode: 0o600 }), { signal });
    if (hash.digest("hex") !== input.sha256) throw new NodeAgentError("INPUT_DIGEST_MISMATCH", "the bytes do not match the declared sha256");
  }

  /**
   * Registers, then heartbeats and pulls jobs until `signal` aborts.
   * Network errors back off; a revoked token stops the node.
   */
  async run({ signal, backoffMs = 5_000 } = {}) {
    let beat;
    try {
      if (signal?.aborted) return { stopped: "signal" };
      await this.register({ signal });
      this.#log("registered; waiting for jobs (the owner must approve this node first)");
      beat = setInterval(() => { this.heartbeat({ signal }).catch((error) => { if (!signal?.aborted) this.#log(`heartbeat failed: ${error.code ?? error.message}`); }); }, this.heartbeatIntervalMs);
      beat.unref?.();
      while (!signal?.aborted) {
        try {
          const outcome = await this.runOnce({ signal });
          if (outcome.claimed) this.#log(`job ${outcome.jobId}: ${outcome.status}`);
        } catch (error) {
          if (signal?.aborted) return { stopped: "signal" };
          if (error.status === 401) { this.#log("the daemon rejected this node's token (revoked?); stopping"); return { stopped: "unauthorized" }; }
          this.#log(`daemon unreachable or refused (${error.code ?? error.message}); retrying`);
          await delay(backoffMs, undefined, { signal });
        }
      }
      return { stopped: "signal" };
    } catch (error) {
      if (signal?.aborted) return { stopped: "signal" };
      throw error;
    } finally {
      clearInterval(beat);
    }
  }
}
