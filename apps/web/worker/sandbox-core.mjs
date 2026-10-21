/**
 * The logic of one Atlas cloud sandbox (Cloudflare Sandbox SDK 1.0): a
 * Durable Object that owns one container and keeps its record in its own
 * storage. sandbox-object.mjs wires it to `ctx.container`, `Files` and
 * `DirectoryBackup`; everything here takes them injected, so it is tested in
 * plain Node with a fake container (tests/sandbox-broker.test.mjs).
 *
 * - The workspace is /workspace/project. Paths from callers are relative to it
 *   and are refused when they leave it, including through a symlink (the path
 *   is resolved with `realpath -m` inside the container before use).
 * - Commands are argv only, run under GNU `timeout` (which also stops what
 *   they start), with a hard SIGKILL a little later, and their output is
 *   capped. The container starts with Internet access off unless the
 *   environment was created with `internet: true`.
 * - A snapshot is a DirectoryBackup of the workspace in R2, under the
 *   tenant's own key prefix (gitignored files left out, `.git` kept), plus the tree entries the client turns into the
 *   same tree digest a local snapshot uses. A restore only goes into a fresh
 *   sandbox; if it fails, the sandbox is destroyed and nothing is left.
 * - Preview URLs are `https://<port>-<token>.<previewDomain>`; the token is
 *   random, stored here and in the preview registry instance, and checked in
 *   constant time on every request.
 */

import { Buffer } from "node:buffer";

export const WORKSPACE = "/workspace/project";
export const TREE_HELPER = "/opt/atlas/tree-manifest.mjs";
export const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_OUTPUT_BYTES = 256 * 1024;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const PREVIEW_REGISTRY = "preview-registry";

const KILL_GRACE_SECONDS = 5;
const HARD_DEADLINE_SLACK_MS = 15_000;

export class SandboxError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
    this.status = status;
  }
}

/** A caller's relative path → an absolute path under the workspace (lexically). */
export function workspacePath(relativePath) {
  const text = String(relativePath ?? "");
  if (!text || text.length > 1024 || text.includes("\0") || text.startsWith("/") || text.includes("\\")) throw new SandboxError("UNSAFE_PATH", "A path is relative to the workspace.");
  const parts = text.split("/").filter((part) => part !== "" && part !== ".");
  if (!parts.length || parts.includes("..") || parts[0] === ".git") throw new SandboxError("UNSAFE_PATH", "The path is outside the workspace.");
  return `${WORKSPACE}/${parts.join("/")}`;
}

async function readCapped(stream, cap) {
  if (!stream) return { bytes: new Uint8Array(0), truncated: false };
  const reader = stream.getReader();
  const chunks = [];
  let kept = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (kept < cap) {
      const piece = value.subarray(0, cap - kept);
      chunks.push(piece);
      kept += piece.byteLength;
      if (piece.byteLength < value.byteLength) truncated = true;
    } else if (value.byteLength) truncated = true;
  }
  const bytes = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, truncated };
}

const decode = (bytes) => new TextDecoder().decode(bytes);
const toBase64 = (bytes) => Buffer.from(bytes).toString("base64");

function sameText(a, b) {
  const left = new TextEncoder().encode(String(a));
  const right = new TextEncoder().encode(String(b));
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

function randomToken(bytes = 16) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {{ container: any, files: any, backupsFor: (tenant: string) => any, storage: any, image?: any,
 *   previewDomain?: string | null, now?: () => number, token?: () => string }} dependencies
 */
export function createSandboxCore({ container, files, backupsFor, storage, image, previewDomain = null, now = () => Date.now(), token = randomToken }) {
  const meta = () => storage.get("meta");

  async function requireMeta() {
    const record = await meta();
    if (!record) throw new SandboxError("NOT_FOUND", "There is no such sandbox.", 404);
    return record;
  }

  async function ensureRunning(record) {
    if (!container) throw new SandboxError("UNAVAILABLE", "This deployment has no sandbox container configured.", 503);
    if (!container.running) {
      container.start({ image, enableInternet: record.internet === true, entrypoint: ["sleep", "infinity"] });
      await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    }
  }

  async function run(argv, { timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_OUTPUT_BYTES, cwd = WORKSPACE } = {}) {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const controller = new AbortController();
    const child = await container.exec(["timeout", `--kill-after=${KILL_GRACE_SECONDS}`, `${seconds}`, ...argv], { cwd, env: { HOME: WORKSPACE, LANG: "C.UTF-8" }, signal: controller.signal });
    let exited = false;
    // Aborting after the process exits is an error in the runtime, so the hard deadline stands down at exit.
    void Promise.resolve(child.exitCode).then(() => { exited = true; }, () => { exited = true; });
    const timer = setTimeout(() => { if (!exited) controller.abort(); }, seconds * 1000 + KILL_GRACE_SECONDS * 1000 + HARD_DEADLINE_SLACK_MS);
    const started = now();
    try {
      const [stdout, stderr, exitCode] = await Promise.all([readCapped(child.stdout, maxOutputBytes), readCapped(child.stderr, maxOutputBytes), child.exitCode]);
      exited = true;
      const durationMs = now() - started;
      return { exitCode, stdout, stderr, durationMs, timedOut: (exitCode === 124 || exitCode === 137) && durationMs >= seconds * 1000 - 50 };
    } finally {
      exited = true;
      clearTimeout(timer);
    }
  }

  /** Resolves symlinks inside the container; refuses a path that ends up outside the workspace. */
  async function confined(relativePath) {
    const lexical = workspacePath(relativePath);
    const result = await run(["realpath", "-m", "--", lexical], { timeoutMs: 10_000, maxOutputBytes: 8192 });
    const resolved = decode(result.stdout.bytes).trim();
    if (result.exitCode !== 0 || !resolved.startsWith(`${WORKSPACE}/`) || resolved.slice(WORKSPACE.length + 1).split("/")[0] === ".git") {
      throw new SandboxError("UNSAFE_PATH", "The path leads outside the workspace.");
    }
    return resolved;
  }

  async function tree() {
    const result = await run(["node", TREE_HELPER, WORKSPACE], { timeoutMs: 120_000, maxOutputBytes: 64 * 1024 * 1024 });
    if (result.exitCode !== 0 || result.stdout.truncated) throw new SandboxError("TREE_FAILED", "The workspace tree could not be read.", 500);
    const parsed = JSON.parse(decode(result.stdout.bytes));
    if (!Array.isArray(parsed?.entries)) throw new SandboxError("TREE_FAILED", "The workspace tree could not be read.", 500);
    return parsed.entries;
  }

  function describe(record, running) {
    return { exists: true, name: record.name, internet: record.internet === true, running: Boolean(running), createdAt: record.createdAt, workspace: WORKSPACE, previews: Object.keys(record.ports ?? {}).map(Number) };
  }

  async function destroyAll() {
    try { if (container?.running) await container.destroy(); } catch { /* already stopped */ }
    await storage.deleteAll();
  }

  return {
    async describe() {
      const record = await meta();
      return record ? describe(record, container?.running) : { exists: false };
    },

    async create({ name, tenant, internet = false, fresh = false }) {
      const existing = await meta();
      if (existing) {
        if (fresh) throw new SandboxError("EXISTS", "That sandbox already exists; a restore needs a fresh one.", 409);
        await ensureRunning(existing);
        return describe(existing, true);
      }
      const record = { name, tenant: String(tenant), internet: internet === true, createdAt: new Date(now()).toISOString(), ports: {} };
      await ensureRunning(record);
      await files.mkdir(WORKSPACE, { recursive: true });
      await storage.put("meta", record);
      return describe(record, true);
    },

    async exec({ argv, timeoutMs, maxOutputBytes }) {
      const record = await requireMeta();
      await ensureRunning(record);
      const result = await run(argv, { timeoutMs, maxOutputBytes });
      return {
        exitCode: result.exitCode,
        stdout: decode(result.stdout.bytes),
        stderr: decode(result.stderr.bytes),
        timedOut: result.timedOut,
        truncated: { stdout: result.stdout.truncated, stderr: result.stderr.truncated },
        durationMs: result.durationMs,
      };
    },

    async readFile({ path }) {
      const record = await requireMeta();
      await ensureRunning(record);
      const target = await confined(path);
      const stat = await files.stat(target);
      if (stat.type !== "file") throw new SandboxError("NOT_A_FILE", "That path is not a file.", 404);
      if (Number(stat.size) > MAX_FILE_BYTES) throw new SandboxError("TOO_LARGE", `Files over ${MAX_FILE_BYTES} bytes are not transferred.`, 413);
      const bytes = new Uint8Array(await (await files.readFile(target)).arrayBuffer());
      return { path, size: bytes.byteLength, contentBase64: toBase64(bytes) };
    },

    async writeFile({ path, contentBase64, executable }) {
      const record = await requireMeta();
      await ensureRunning(record);
      const bytes = Buffer.from(String(contentBase64 ?? ""), "base64");
      if (bytes.byteLength > MAX_FILE_BYTES) throw new SandboxError("TOO_LARGE", `Files over ${MAX_FILE_BYTES} bytes are not transferred.`, 413);
      const target = await confined(path);
      await files.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      await files.writeFile(target, bytes);
      if (typeof executable === "boolean") {
        const chmod = await run(["chmod", executable ? "755" : "644", "--", target], { timeoutMs: 10_000, maxOutputBytes: 4096 });
        if (chmod.exitCode !== 0) throw new SandboxError("WRITE_FAILED", "The file mode could not be set.", 500);
      }
      return { path, size: bytes.byteLength };
    },

    async tree() {
      const record = await requireMeta();
      await ensureRunning(record);
      return { entries: await tree() };
    },

    async snapshot({ name }) {
      const record = await requireMeta();
      await ensureRunning(record);
      const backup = await backupsFor(record.tenant).backup({ dir: WORKSPACE, name: String(name ?? record.name).slice(0, 100), gitignore: true });
      const entries = await tree();
      await storage.put(`snapshot:${backup.id}`, { backup, at: new Date(now()).toISOString() });
      return { backup, entries };
    },

    async restore({ name, tenant, backup }) {
      if (await meta()) throw new SandboxError("EXISTS", "A restore needs a fresh sandbox.", 409);
      const record = { name, tenant: String(tenant), internet: false, createdAt: new Date(now()).toISOString(), ports: {}, restoredFrom: backup?.id ?? null };
      try {
        await ensureRunning(record);
        await files.mkdir("/workspace", { recursive: true });
        await backupsFor(record.tenant).restore(backup, { dir: WORKSPACE });
        await storage.put("meta", record);
        return { entries: await tree() };
      } catch (error) {
        await destroyAll();
        if (error instanceof SandboxError) throw error;
        const code = typeof error?.code === "string" && /^BACKUP_/u.test(error.code) ? error.code : "RESTORE_FAILED";
        throw new SandboxError(code, "The snapshot could not be restored into a fresh sandbox; nothing was kept.", code === "BACKUP_NOT_FOUND" ? 404 : 409);
      }
    },

    async destroy() {
      const record = await meta();
      await destroyAll();
      return { destroyed: Boolean(record), snapshotsKept: true };
    },

    /** Registers a port for preview; returns the hostname label and token for the registry. */
    async preview({ port }) {
      if (!previewDomain) throw new SandboxError("PREVIEW_NOT_CONFIGURED", "Previews need a preview domain (ATLAS_SANDBOX_PREVIEW_DOMAIN) on this deployment.", 503);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new SandboxError("BAD_PORT", "A preview port is 1024-65535.");
      const record = await requireMeta();
      const ports = { ...(record.ports ?? {}) };
      ports[port] ??= token();
      await storage.put("meta", { ...record, ports });
      return { port, token: ports[port], url: `https://${port}-${ports[port]}.${previewDomain}/` };
    },

    /** A visitor's request on a preview hostname; the token must match the one this sandbox issued. */
    async servePreview(request, { port, token: presented }) {
      const record = await meta();
      const issued = record?.ports?.[port];
      if (!issued || !sameText(issued, presented)) return new Response("Not found", { status: 404 });
      if (!container?.running) return new Response("The sandbox is not running", { status: 503 });
      const url = new URL(request.url);
      url.protocol = "http:";
      try {
        return await container.getTcpPort(port).fetch(new Request(url, request));
      } catch {
        return new Response("Nothing is listening on this port", { status: 502 });
      }
    },
  };
}

/** The registry instance: preview token → sandbox name (so a hostname needs only port and token). */
export function createPreviewRegistry(storage) {
  return {
    async register({ token, name, port }) {
      await storage.put(`preview:${token}`, { name, port });
      return { registered: true };
    },
    async lookup({ token }) {
      return (await storage.get(`preview:${token}`)) ?? null;
    },
  };
}

const OPERATIONS = new Set(["describe", "create", "exec", "readFile", "writeFile", "tree", "snapshot", "restore", "destroy", "preview"]);

/**
 * The object's wire protocol: POST https://atlas-sandbox/<operation> with a
 * JSON body. Fetch rather than RPC, as with the inference governor, so the
 * class needs nothing from `cloudflare:workers` beyond what the SDK brings.
 * Preview traffic arrives as GET/any method on https://atlas-sandbox/~preview/<port>/<token>/<path>.
 */
export async function handleSandboxObjectRequest({ core, registry }, request) {
  const url = new URL(request.url);
  const preview = /^\/~preview\/(\d{4,5})\/([0-9a-f]{32})(\/.*)?$/u.exec(url.pathname);
  if (preview && core) {
    const target = new URL(`http://container${preview[3] ?? "/"}${url.search}`);
    return core.servePreview(new Request(target, request), { port: Number(preview[1]), token: preview[2] });
  }
  if (request.method !== "POST") return new Response("Not found", { status: 404 });
  const operation = url.pathname.slice(1);
  let argument;
  try { argument = await request.json(); } catch { return Response.json({ code: "BAD_REQUEST", message: "Invalid JSON." }, { status: 400 }); }
  try {
    if (operation.startsWith("registry/") && registry) {
      const method = operation.slice("registry/".length);
      if (method !== "register" && method !== "lookup") return new Response("Not found", { status: 404 });
      return Response.json(await registry[method](argument));
    }
    if (!OPERATIONS.has(operation) || !core) return new Response("Not found", { status: 404 });
    return Response.json(await core[operation](argument));
  } catch (error) {
    if (error instanceof SandboxError) return Response.json({ code: error.code, message: error.message }, { status: error.status });
    return Response.json({ code: "SANDBOX_FAILED", message: "The sandbox operation failed." }, { status: 500 });
  }
}

/**
 * A request to a preview hostname (`<port>-<token>.<previewDomain>`), or null
 * when the request is not for one. The registry maps the token to its
 * sandbox, and the sandbox checks the token again before forwarding.
 */
export async function routePreviewRequest(request, environment) {
  const domain = environment?.ATLAS_SANDBOX_PREVIEW_DOMAIN;
  const namespace = environment?.ATLAS_SANDBOX;
  if (!domain || !namespace) return null;
  const url = new URL(request.url);
  const suffix = `.${String(domain).toLowerCase()}`;
  if (!url.hostname.endsWith(suffix)) return null;
  const label = /^(\d{4,5})-([0-9a-f]{32})$/u.exec(url.hostname.slice(0, -suffix.length));
  if (!label) return new Response("Not found", { status: 404 });
  const stub = (name) => namespace.get(namespace.idFromName(name));
  const lookup = await stub(PREVIEW_REGISTRY).fetch(new Request("https://atlas-sandbox/registry/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: label[2] }) }));
  const entry = lookup.ok ? await lookup.json() : null;
  if (!entry || entry.port !== Number(label[1])) return new Response("Not found", { status: 404 });
  return stub(entry.name).fetch(new Request(`https://atlas-sandbox/~preview/${label[1]}/${label[2]}${url.pathname}${url.search}`, request));
}
