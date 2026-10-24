import { spawn as nodeSpawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  CONTAINER_WORKDIR, ContainerSandboxError, containerRunArguments, killContainer as killContainerByName, minimalRuntimeEnvironment, resolveContainerSandbox,
} from "../terminal/container-sandbox.mjs";
import { createRedactor, hostSecretValues } from "../terminal/redaction.mjs";
import { RENDER_TOOLS, RenderPolicyError, isValidImageReference, validateRenderJob } from "./render-policy.mjs";

/**
 * Render execution (issue #352): ffmpeg and headless Blender as a controlled
 * capability that runs only inside the container sandbox.
 *
 * - **Container or nothing.** A runner without a working container sandbox
 *   refuses every job with REQUIRES_CONTAINER_SANDBOX. There is no host
 *   path: the only process this module ever starts is the container runtime
 *   itself with `run`, and that invocation is re-checked (network none, one
 *   mount, the configured image) right before spawning.
 * - **Staging, not the workspace.** The container does not see the
 *   workspace. It sees a fresh staging directory at /workspace that holds a
 *   copy of the declared inputs and nothing else. After the run, only
 *   declared outputs that are regular files (never symlinks) are hashed and
 *   copied back into the workspace; any other file the tool wrote fails the
 *   job and is discarded with the staging directory.
 * - **Bounds.** A wall-clock timeout removes the container; written bytes are
 *   polled during the run and checked again at the end against
 *   maxOutputBytes; stdout/stderr keep only a bounded, redacted tail.
 * - **Network off**, always: render jobs never get the bridge network.
 *
 * Results list each produced file with its workspace path, size and sha256,
 * the shape a content-addressed artifact store can ingest directly.
 */

export class RenderError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "RenderError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Capability names, as declared to the worker registry (`capabilities.render`). */
export const RENDER_CAPABILITIES = Object.freeze({ ffmpeg: "render.ffmpeg", blender: "render.blender" });

/** Scheduling requirements for a render job: the tool, and a container sandbox or stronger. */
export function renderRequirements(tool) {
  if (!RENDER_TOOLS.includes(tool)) throw new RenderError("INVALID_TOOL", `Unknown render tool '${tool}'.`);
  return { terminal: "container", render: [tool] };
}

/**
 * Render outputs that go to the artifact store, by extension: videos (ffmpeg),
 * glTF models (Blender exports) and still images (frames, thumbnails). Images
 * are stored as kind "file", the kind that carries image media types. The
 * store sniffs the bytes against the declared type and refuses a mismatch;
 * any other extension stays in the workspace only. See platform/artifacts/.
 */
export const RENDER_ARTIFACT_TYPES = Object.freeze({
  ".mp4": Object.freeze({ kind: "video", mediaType: "video/mp4" }),
  ".webm": Object.freeze({ kind: "video", mediaType: "video/webm" }),
  ".glb": Object.freeze({ kind: "model3d", mediaType: "model/gltf-binary" }),
  ".gltf": Object.freeze({ kind: "model3d", mediaType: "model/gltf+json" }),
  ".png": Object.freeze({ kind: "file", mediaType: "image/png" }),
  ".jpg": Object.freeze({ kind: "file", mediaType: "image/jpeg" }),
  ".jpeg": Object.freeze({ kind: "file", mediaType: "image/jpeg" }),
  ".webp": Object.freeze({ kind: "file", mediaType: "image/webp" }),
});

const STAGING_PREFIX = "atlas-render-";
const STAGING_TMP = ".tmp";
const DEFAULTS = Object.freeze({ maxLogBytes: 64 * 1024, pollIntervalMs: 500, killGraceMs: 5_000 });

function normalizeImages(images) {
  const out = {};
  for (const tool of RENDER_TOOLS) {
    const entry = images?.[tool];
    if (entry === undefined || entry === null) continue;
    const config = typeof entry === "string" ? { image: entry } : entry;
    if (!config || typeof config !== "object" || !isValidImageReference(config.image)) {
      throw new RenderError("INVALID_CONFIG", `images.${tool} must be an image reference or { image, entrypointRunsTool }.`);
    }
    const allowed = [config.image, ...(Array.isArray(config.alternates) ? config.alternates : [])];
    if (!allowed.every(isValidImageReference)) throw new RenderError("INVALID_CONFIG", `images.${tool}.alternates must be image references.`);
    out[tool] = Object.freeze({ image: config.image, allowed: Object.freeze(allowed), entrypointRunsTool: config.entrypointRunsTool === true });
  }
  return Object.freeze(out);
}

/**
 * The last line of defence against a host fallback: the process about to be
 * started must be the sandbox's runtime running a networkless container with
 * exactly one mount (the staging directory) and the expected image.
 */
export function assertContainerInvocation({ file, args, sandbox, stagingRoot, image }) {
  const fail = (why) => { throw new RenderError("REQUIRES_CONTAINER_SANDBOX", `Refusing to start a render outside the container sandbox: ${why}.`); };
  if (!sandbox || typeof sandbox.runtime !== "string" || !isAbsolute(sandbox.runtime)) fail("no container runtime");
  if (file !== sandbox.runtime) fail(`'${file}' is not the container runtime`);
  if (!Array.isArray(args) || args[0] !== "run") fail("not a container run");
  const flag = (name) => args[args.indexOf(name) + 1];
  if (flag("--network") !== "none") fail("network is not 'none'");
  if (args.filter((a) => a === "--mount" || a === "--volume" || a === "-v").length !== 1) fail("expected exactly one mount");
  if (flag("--mount") !== `type=bind,source=${stagingRoot},target=${CONTAINER_WORKDIR}`) fail("the only mount must be the staging directory");
  if (!args.includes("--rm") || !args.includes("--read-only") || flag("--cap-drop") !== "ALL") fail("isolation flags missing");
  if (!args.includes(image)) fail("image missing");
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Every entry under `dir` (lstat: symlinks are reported, never followed). */
async function walk(dir, base = dir, out = []) {
  for (const name of await readdir(dir)) {
    const full = join(dir, name);
    const stat = await lstat(full);
    out.push({ rel: relative(base, full).split(sep).join("/"), stat });
    if (stat.isDirectory()) await walk(full, base, out);
  }
  return out;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Keeps the last `limit` bytes of a stream; ffmpeg reports errors at the end. */
class TailBuffer {
  constructor(limit) { this.limit = limit; this.chunks = []; this.size = 0; this.dropped = 0; }
  push(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.chunks.push(buf);
    this.size += buf.length;
    while (this.size > this.limit && this.chunks.length) {
      const excess = this.size - this.limit;
      const first = this.chunks[0];
      if (first.length <= excess) { this.chunks.shift(); this.size -= first.length; this.dropped += first.length; } else {
        this.chunks[0] = first.subarray(excess); this.size -= excess; this.dropped += excess;
      }
    }
  }
  text() { return Buffer.concat(this.chunks).toString("utf8"); }
}

export class RenderRunner {
  #containerOption;
  #resolveSandbox;
  #sandbox = null;
  #images;
  #stagingRoot;
  #spawn;
  #killContainer;
  #options;
  #redact;
  #artifactStore;
  #active = new Map();

  /**
   * @param options.container   the container sandbox option ({ runtime, cpus, memoryBytes, ... }); required to run anything
   * @param options.images      { ffmpeg?: image | { image, entrypointRunsTool?, alternates? }, blender?: ... }
   * @param options.stagingRoot host directory for per-job staging copies (default: OS temp dir)
   * @param options.spawn       injected for tests; called only with the container runtime
   */
  constructor({
    container = undefined,
    images = {},
    stagingRoot = tmpdir(),
    resolveSandbox = resolveContainerSandbox,
    spawn = nodeSpawn,
    killContainer = killContainerByName,
    maxLogBytes = DEFAULTS.maxLogBytes,
    pollIntervalMs = DEFAULTS.pollIntervalMs,
    killGraceMs = DEFAULTS.killGraceMs,
    knownSecrets = hostSecretValues(),
    artifactStore = null,
  } = {}) {
    if (artifactStore !== null && typeof artifactStore?.put !== "function") throw new RenderError("INVALID_CONFIG", "artifactStore must have a put() method.");
    this.#artifactStore = artifactStore;
    this.#containerOption = container;
    this.#resolveSandbox = resolveSandbox;
    this.#images = normalizeImages(images);
    if (typeof stagingRoot !== "string" || !isAbsolute(stagingRoot)) throw new RenderError("INVALID_CONFIG", "stagingRoot must be an absolute path.");
    this.#stagingRoot = stagingRoot;
    this.#spawn = spawn;
    this.#killContainer = killContainer;
    this.#options = { maxLogBytes, pollIntervalMs, killGraceMs };
    this.#redact = createRedactor({ knownSecrets });
  }

  /**
   * Resolves the container sandbox, or throws. Never returns a "no sandbox"
   * value that a caller could mistake for permission to run on the host.
   */
  #requireSandbox() {
    if (this.#sandbox) return this.#sandbox;
    const option = this.#containerOption;
    if (option === undefined || option === null || option === false) {
      throw new RenderError("REQUIRES_CONTAINER_SANDBOX", "Rendering requires the container sandbox (configure container: { runtime }); it never runs on the host.");
    }
    let sandbox;
    try {
      sandbox = this.#resolveSandbox(option);
    } catch (error) {
      const reason = error instanceof ContainerSandboxError ? error.message : String(error?.message ?? error);
      throw new RenderError("REQUIRES_CONTAINER_SANDBOX", `Rendering requires the container sandbox, which is not available: ${reason} It never runs on the host.`);
    }
    if (!sandbox || typeof sandbox.runtime !== "string" || !isAbsolute(sandbox.runtime)) {
      throw new RenderError("REQUIRES_CONTAINER_SANDBOX", "Rendering requires the container sandbox; none was resolved. It never runs on the host.");
    }
    this.#sandbox = sandbox;
    return sandbox;
  }

  /** `{ available, reason, capabilities }` — which render capabilities this machine can honestly declare. */
  status() {
    try {
      this.#requireSandbox();
    } catch (error) {
      return { available: false, reason: error.message, capabilities: [] };
    }
    const capabilities = RENDER_TOOLS.filter((tool) => this.#images[tool]).map((tool) => RENDER_CAPABILITIES[tool]);
    return { available: capabilities.length > 0, reason: capabilities.length ? "container sandbox ready" : "no render image configured", capabilities };
  }

  /** Jobs whose container is running now. */
  activeJobs() { return [...this.#active.keys()]; }

  /**
   * Emergency stop: removes the container of every job in flight; each ends
   * with status "cancelled" and its outputs discarded. Returns the job ids.
   */
  cancelAll(reason = "emergency stop") {
    const cancelled = [];
    for (const [jobId, stop] of this.#active) {
      stop(`cancelled: ${reason}`);
      cancelled.push(jobId);
    }
    return { cancelled };
  }

  /** The `render` list for a worker registry capability declaration. */
  registryCapabilities() {
    return this.status().capabilities.map((name) => name.slice("render.".length));
  }

  /**
   * Runs one job. Throws RenderPolicyError/RenderError before anything runs
   * (invalid job, no sandbox, no image); returns a result for anything that
   * happened after the container started.
   *
   * @param context.tenantId  required when an artifactStore is configured
   * @param context.runId     provenance run id for stored artifacts (default: the job id)
   */
  async run(workspaceRoot, jobInput, context = {}) {
    const job = validateRenderJob(jobInput);
    if (this.#artifactStore && (typeof context.tenantId !== "string" || !context.tenantId)) {
      throw new RenderError("TENANT_REQUIRED", "A tenantId is required to store render outputs as artifacts.");
    }
    const toolImage = this.#images[job.tool];
    if (!toolImage) throw new RenderError("IMAGE_NOT_CONFIGURED", `${RENDER_CAPABILITIES[job.tool]} needs a configured image (images.${job.tool}).`);
    const image = job.image ?? toolImage.image;
    if (!toolImage.allowed.includes(image)) throw new RenderError("IMAGE_NOT_ALLOWED", `Image '${image}' is not configured for ${job.tool}.`);
    const sandbox = this.#requireSandbox();

    if (typeof workspaceRoot !== "string" || !isAbsolute(workspaceRoot)) throw new RenderError("INVALID_WORKSPACE", "workspaceRoot must be an absolute path.");
    const workspace = await realpath(workspaceRoot).catch(() => { throw new RenderError("INVALID_WORKSPACE", "workspaceRoot does not exist."); });

    // Resolve inputs before creating anything: each must be a regular file inside the workspace.
    const inputSources = [];
    for (const rel of job.inputs) {
      const candidate = join(workspace, ...rel.split("/"));
      const real = await realpath(candidate).catch(() => null);
      if (!real) throw new RenderError("INPUT_MISSING", `Input '${rel}' does not exist.`);
      if (!inside(workspace, real)) throw new RenderError("INPUT_OUTSIDE_WORKSPACE", `Input '${rel}' resolves outside the workspace.`);
      if (!(await lstat(real)).isFile()) throw new RenderError("INPUT_NOT_FILE", `Input '${rel}' is not a regular file.`);
      inputSources.push({ rel, real });
    }

    const jobId = `rnd_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const staging = await mkdtemp(join(this.#stagingRoot, STAGING_PREFIX));
    try {
      if (staging.includes(",")) throw new RenderError("INVALID_CONFIG", "The staging path cannot contain a comma.");
      await mkdir(join(staging, STAGING_TMP));
      for (const { rel, real } of inputSources) {
        const target = join(staging, ...rel.split("/"));
        await mkdir(dirname(target), { recursive: true });
        await copyFile(real, target, fsConstants.COPYFILE_FICLONE);
      }
      for (const rel of job.outputs) await mkdir(dirname(join(staging, ...rel.split("/"))), { recursive: true });
      return await this.#execute({ job, jobId, image, toolImage, sandbox, staging, workspace, context });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async #execute({ job, jobId, image, toolImage, sandbox, staging, workspace, context }) {
    const argv = toolImage.entrypointRunsTool ? [...job.args] : [job.tool, ...job.args];
    const name = `atlas-render-${jobId.slice(4, 20)}`;
    const args = containerRunArguments({ sandbox: { ...sandbox, image }, name, workspaceRoot: staging, cwd: staging, argv, env: {}, network: false });
    assertContainerInvocation({ file: sandbox.runtime, args, sandbox, stagingRoot: staging, image });

    const inputSet = new Set(job.inputs);
    const stagedBytes = async () => {
      let total = 0;
      for (const entry of await walk(staging).catch(() => [])) if (entry.stat.isFile() && !inputSet.has(entry.rel)) total += entry.stat.size;
      return total;
    };

    const started = Date.now();
    const stdout = new TailBuffer(this.#options.maxLogBytes);
    const stderr = new TailBuffer(this.#options.maxLogBytes);
    const outcome = await new Promise((resolve) => {
      let stopReason = null;
      let settled = false;
      let child;
      const timers = [];
      const finish = (value) => {
        if (settled) return;
        settled = true;
        this.#active.delete(jobId);
        for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
        resolve({ ...value, stopReason });
      };
      const stop = (reason) => {
        if (stopReason) return;
        stopReason = reason;
        try { this.#killContainer(sandbox, name); } catch { /* the client signal below still runs */ }
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        timers.push(setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, this.#options.killGraceMs));
        // A client that ignores every signal must not hold the job open forever.
        timers.push(setTimeout(() => finish({ exitCode: null, signal: "SIGKILL", abandoned: true }), this.#options.killGraceMs * 2));
      };
      try {
        child = this.#spawn(sandbox.runtime, args, { shell: false, windowsHide: true, env: minimalRuntimeEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        finish({ exitCode: null, signal: null, spawnError: error.message });
        return;
      }
      this.#active.set(jobId, stop);
      child.stdout?.on("data", (chunk) => stdout.push(chunk));
      child.stderr?.on("data", (chunk) => stderr.push(chunk));
      child.on("error", (error) => finish({ exitCode: null, signal: null, spawnError: error.message }));
      child.on("close", (code, signal) => finish({ exitCode: code, signal }));
      timers.push(setTimeout(() => stop("timeout"), job.timeoutMs));
      let polling = false;
      timers.push(setInterval(async () => {
        if (polling || stopReason) return;
        polling = true;
        try { if ((await stagedBytes()) > job.maxOutputBytes) stop("output_limit"); } finally { polling = false; }
      }, this.#options.pollIntervalMs));
    });

    const durationMs = Date.now() - started;
    const result = {
      ok: false,
      status: "failed",
      jobId,
      tool: job.tool,
      capability: RENDER_CAPABILITIES[job.tool],
      image,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      durationMs,
      files: [],
      missing: [],
      undeclared: [],
      violations: [],
      logs: this.#logs(stdout, stderr),
      isolation: {
        level: "container", runtime: sandbox.runtime, image, network: "none",
        mount: `staging copy of declared inputs at ${CONTAINER_WORKDIR}`, timeoutMs: job.timeoutMs, maxOutputBytes: job.maxOutputBytes,
      },
    };
    if (outcome.spawnError) result.error = `container runtime failed to start: ${outcome.spawnError}`;

    // Inspect what the container left behind.
    const outputSet = new Set(job.outputs);
    const declaredDirs = new Set(job.outputs.flatMap((o) => o.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))));
    for (const rel of job.inputs) for (const dir of rel.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))) declaredDirs.add(dir);
    const present = new Map();
    let writtenBytes = 0;
    for (const entry of await walk(staging)) {
      if (entry.rel === STAGING_TMP || entry.rel.startsWith(`${STAGING_TMP}/`)) { if (entry.stat.isFile()) writtenBytes += entry.stat.size; continue; }
      if (inputSet.has(entry.rel)) continue;
      if (entry.stat.isFile()) writtenBytes += entry.stat.size;
      if (outputSet.has(entry.rel)) {
        if (!entry.stat.isFile()) result.violations.push(`${entry.rel} is not a regular file`);
        else present.set(entry.rel, entry.stat.size);
      } else if (!(entry.stat.isDirectory() && declaredDirs.has(entry.rel))) {
        result.undeclared.push(entry.rel);
      }
    }
    result.missing = job.outputs.filter((o) => !present.has(o));
    const outputBytes = [...present.values()].reduce((a, b) => a + b, 0);

    if (outcome.stopReason?.startsWith("cancelled")) {
      result.status = "cancelled";
      result.error = `render ${outcome.stopReason}; container removed, outputs discarded`;
    } else if (outcome.stopReason === "timeout") {
      result.status = "timed_out";
      result.error = `render exceeded ${job.timeoutMs} ms; container removed`;
    } else if (outcome.stopReason === "output_limit" || writtenBytes > job.maxOutputBytes || outputBytes > job.maxOutputBytes) {
      result.status = "output_limit";
      result.error = `render wrote more than ${job.maxOutputBytes} bytes; outputs discarded`;
    } else if (result.violations.length || result.undeclared.length) {
      result.status = "policy_violation";
      result.error = `render wrote files it did not declare or non-regular outputs; outputs discarded (${[...result.violations, ...result.undeclared.map((u) => `undeclared: ${u}`)].slice(0, 10).join("; ")})`;
    } else if (outcome.exitCode !== 0) {
      result.error ??= `${job.tool} exited with ${outcome.exitCode ?? outcome.signal}`;
    } else if (result.missing.length) {
      result.error = `declared outputs were not produced: ${result.missing.join(", ")}`;
    } else {
      result.files = await this.#publish({ job, staging, workspace });
      result.ok = true;
      result.status = "succeeded";
      if (this.#artifactStore) await this.#storeArtifacts({ result, workspace, runId: context.runId ?? jobId, tenantId: context.tenantId });
    }
    return result;
  }

  /**
   * Puts published video, 3D model and image outputs into the artifact
   * store (RENDER_ARTIFACT_TYPES). The store sniffs content itself; a refusal
   * is recorded on the file, not thrown, because the render already succeeded
   * and its outputs are in the workspace.
   */
  async #storeArtifacts({ result, workspace, runId, tenantId }) {
    for (const file of result.files) {
      const name = file.path.slice(file.path.lastIndexOf("/") + 1);
      const dot = name.lastIndexOf(".");
      const type = dot > 0 ? RENDER_ARTIFACT_TYPES[name.slice(dot).toLowerCase()] : undefined;
      if (!type) continue;
      const { kind, mediaType } = type;
      try {
        const { artifact, created } = await this.#artifactStore.put({
          tenantId, kind, mediaType, provenance: { runId, step: "render", source: result.capability },
          path: join(workspace, ...file.path.split("/")), name,
        });
        file.artifact = { id: artifact.id, sha256: artifact.sha256, created };
      } catch (error) {
        file.artifactError = { code: error.code ?? "ARTIFACT_STORE_FAILED", message: error.message };
      }
    }
  }

  #logs(stdout, stderr) {
    const out = this.#redact(stdout.text());
    const err = this.#redact(stderr.text());
    return {
      stdout: out.text, stderr: err.text,
      stdoutTruncatedBytes: stdout.dropped, stderrTruncatedBytes: stderr.dropped,
      redactions: out.count + err.count,
    };
  }

  /** Hashes declared outputs in staging and copies them into the workspace. */
  async #publish({ job, staging, workspace }) {
    const files = [];
    for (const rel of job.outputs) {
      const source = join(staging, ...rel.split("/"));
      const stat = await lstat(source);
      if (!stat.isFile()) throw new RenderError("OUTPUT_NOT_FILE", `Output '${rel}' is not a regular file.`);
      const sha256 = await sha256File(source);
      const target = join(workspace, ...rel.split("/"));
      await mkdir(dirname(target), { recursive: true });
      const parentReal = await realpath(dirname(target));
      if (!inside(workspace, parentReal)) throw new RenderError("OUTPUT_OUTSIDE_WORKSPACE", `Output '${rel}' would be written outside the workspace.`);
      const existing = await lstat(target).catch(() => null);
      if (existing && !existing.isFile()) throw new RenderError("OUTPUT_NOT_FILE", `Workspace path '${rel}' exists and is not a regular file.`);
      await rm(target, { force: true });
      await copyFile(source, target, fsConstants.COPYFILE_EXCL);
      files.push({ path: rel, bytes: stat.size, sha256 });
    }
    return files;
  }
}

export { RenderPolicyError };
