/**
 * The cloud-environment broker: the hosted side of
 * `CloudflareSandboxEnvironment` (apps/local-control/src/platform/environments/cloudflare.mjs).
 *
 *   GET    /api/sandbox/:id                describe
 *   POST   /api/sandbox/:id                create (idempotent) { internet?, fresh? }
 *   DELETE /api/sandbox/:id                destroy (snapshots in R2 are kept)
 *   POST   /api/sandbox/:id/exec           { argv, timeoutMs?, maxOutputBytes? }
 *   GET    /api/sandbox/:id/files?path=    read one file (base64)
 *   PUT    /api/sandbox/:id/files          { path, contentBase64, executable? }
 *   GET    /api/sandbox/:id/tree           tree entries (mode, path, sha256)
 *   POST   /api/sandbox/:id/snapshot       { name? } → { backup, entries }
 *   POST   /api/sandbox/:id/restore        { backup } into a fresh :id → { entries }
 *   POST   /api/sandbox/:id/preview        { port } → { url }
 *
 * - Auth: the deployment owner only (the operator token or an operator
 *   session), the same gate as the Genesis node routes. Sandboxes run code.
 * - Tenancy: the sandbox is `t<tenantId>-<id>`; the tenant comes from the
 *   caller's resolved workspace, never from the body. Snapshots live under the
 *   tenant's R2 prefix, so a record from another tenant does not restore.
 * - Off unless deployed: without the ATLAS_SANDBOX binding every call answers
 *   503 UNAVAILABLE with the reason (Workers Paid plan, sandbox build, deploy).
 * - Inputs are validated here before the Durable Object sees them; the object
 *   validates paths again inside the container.
 */
import {
  DEFAULT_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, MAX_FILE_BYTES, MAX_OUTPUT_BYTES, MAX_TIMEOUT_MS, PREVIEW_REGISTRY, workspacePath,
} from "../../../worker/sandbox-core.mjs";

export const SANDBOX_BINDING = "ATLAS_SANDBOX";
export const ENVIRONMENT_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
export const UNAVAILABLE_REASON = "Cloud environments are off on this deployment. They need the Cloudflare Workers Paid plan, the sandbox build enabled in apps/web/sandbox.config.json, the R2 bucket for snapshots, and a deploy of the Worker. See docs/atlas-os/GENESIS.md (Cloud environments).";

const MAX_BODY_BYTES = Math.ceil(MAX_FILE_BYTES * 4 / 3) + 64 * 1024;
const MAX_ARGS = 256;
const MAX_ARG_LENGTH = 8192;

const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const refuse = (code, message, status = 400) => json({ code, message }, status);

export function sandboxName(tenantId, id) {
  return `t${tenantId}-${id}`;
}

/** Whether this deployment can run cloud environments, as a flag and a reason (for setup status). */
export function sandboxReadiness(environment) {
  const bound = typeof environment?.[SANDBOX_BINDING]?.idFromName === "function";
  return bound ? { available: true, previews: Boolean(environment.ATLAS_SANDBOX_PREVIEW_DOMAIN) } : { available: false, reason: UNAVAILABLE_REASON };
}

async function readJson(request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw Object.assign(new Error("too large"), { status: 413 });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw Object.assign(new Error("too large"), { status: 413 });
  if (!text) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError("not an object");
  return parsed;
}

function boundedInteger(value, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function validArgv(argv) {
  return Array.isArray(argv) && argv.length > 0 && argv.length <= MAX_ARGS
    && argv.every((part) => typeof part === "string" && part.length <= MAX_ARG_LENGTH && !part.includes("\0"))
    && argv[0].length > 0;
}

function validPath(path) {
  try { workspacePath(path); return true; } catch { return false; }
}

/** The shape of a DirectoryBackupRecord; anything else is refused before it reaches R2. */
export function validBackupRecord(backup) {
  return Boolean(backup) && typeof backup === "object"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(String(backup.id))
    && typeof backup.dir === "string" && backup.dir.startsWith("/") && backup.dir.length <= 1024
    && Number.isSafeInteger(backup.size) && backup.size >= 0
    && /^[0-9a-f]{64}$/u.test(String(backup.sha256))
    && backup.format === "tar+zstd/1"
    && (backup.name === undefined || (typeof backup.name === "string" && backup.name.length <= 200));
}

async function call(stub, operation, argument) {
  const response = await stub.fetch(new Request(`https://atlas-sandbox/${operation}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(argument ?? {}),
  }));
  let body;
  try { body = await response.json(); } catch { body = { code: "SANDBOX_FAILED", message: "The sandbox answered without a result." }; }
  return { status: response.status, body };
}

/** Maps an HTTP request onto one sandbox operation and its validated argument, or a refusal. */
async function plan(request, operation, url) {
  const method = request.method.toUpperCase();
  if (!operation) {
    if (method === "GET") return { operation: "describe", argument: {} };
    if (method === "DELETE") return { operation: "destroy", argument: {} };
    if (method === "POST") {
      const body = await readJson(request);
      if (body.internet !== undefined && typeof body.internet !== "boolean") return { refusal: refuse("BAD_REQUEST", "internet is true or false.") };
      if (body.fresh !== undefined && typeof body.fresh !== "boolean") return { refusal: refuse("BAD_REQUEST", "fresh is true or false.") };
      return { operation: "create", argument: { internet: body.internet === true, fresh: body.fresh === true } };
    }
  } else if (operation === "exec" && method === "POST") {
    const body = await readJson(request);
    if (!validArgv(body.argv)) return { refusal: refuse("BAD_COMMAND", `exec takes argv: 1-${MAX_ARGS} strings, never a shell line.`) };
    const timeoutMs = boundedInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    const maxOutputBytes = boundedInteger(body.maxOutputBytes, DEFAULT_OUTPUT_BYTES, 1, MAX_OUTPUT_BYTES);
    if (timeoutMs === null) return { refusal: refuse("BAD_REQUEST", `timeoutMs is 1000-${MAX_TIMEOUT_MS}.`) };
    if (maxOutputBytes === null) return { refusal: refuse("BAD_REQUEST", `maxOutputBytes is 1-${MAX_OUTPUT_BYTES}.`) };
    return { operation: "exec", argument: { argv: body.argv, timeoutMs, maxOutputBytes } };
  } else if (operation === "files" && method === "GET") {
    const path = url.searchParams.get("path");
    if (!validPath(path)) return { refusal: refuse("UNSAFE_PATH", "The path must be relative and inside the workspace.") };
    return { operation: "readFile", argument: { path } };
  } else if (operation === "files" && method === "PUT") {
    const body = await readJson(request);
    if (!validPath(body.path)) return { refusal: refuse("UNSAFE_PATH", "The path must be relative and inside the workspace.") };
    if (typeof body.contentBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/u.test(body.contentBase64)) return { refusal: refuse("BAD_REQUEST", "contentBase64 is base64 text.") };
    if (body.executable !== undefined && typeof body.executable !== "boolean") return { refusal: refuse("BAD_REQUEST", "executable is true or false.") };
    return { operation: "writeFile", argument: { path: body.path, contentBase64: body.contentBase64, executable: body.executable } };
  } else if (operation === "tree" && method === "GET") {
    return { operation: "tree", argument: {} };
  } else if (operation === "snapshot" && method === "POST") {
    const body = await readJson(request);
    if (body.name !== undefined && (typeof body.name !== "string" || body.name.length > 100)) return { refusal: refuse("BAD_REQUEST", "name is at most 100 characters.") };
    return { operation: "snapshot", argument: { name: body.name } };
  } else if (operation === "restore" && method === "POST") {
    const body = await readJson(request);
    if (!validBackupRecord(body.backup)) return { refusal: refuse("BAD_SNAPSHOT", "backup must be the record a snapshot returned.") };
    return { operation: "restore", argument: { backup: body.backup } };
  } else if (operation === "preview" && method === "POST") {
    const body = await readJson(request);
    if (!Number.isInteger(body.port) || body.port < 1024 || body.port > 65535) return { refusal: refuse("BAD_PORT", "A preview port is 1024-65535.") };
    return { operation: "preview", argument: { port: body.port } };
  }
  return { refusal: refuse("NOT_FOUND", "There is no such sandbox operation.", 404) };
}

/**
 * @param {Request} request
 * @param {{ id: string, operation?: string | null }} route
 * @param {{ authenticate: (request: Request) => Promise<any>, isOwner: (account: any) => boolean,
 *   resolveTenant: (request: Request, account: any) => Promise<{ tenantId: number } | null>, environment: any }} dependencies
 */
export async function handleSandboxRequest(request, { id, operation = null }, { authenticate, isOwner, resolveTenant, environment }) {
  const account = await authenticate(request);
  if (!account) return refuse("UNAUTHORIZED", "Sign in is required.", 401);
  if (!isOwner(account)) return refuse("FORBIDDEN", "Cloud environments are for the deployment owner.", 403);
  const namespace = environment?.[SANDBOX_BINDING];
  if (typeof namespace?.idFromName !== "function") return refuse("UNAVAILABLE", UNAVAILABLE_REASON, 503);
  if (!ENVIRONMENT_ID.test(String(id ?? ""))) return refuse("BAD_ID", "An environment id is 1-40 lowercase letters, digits and hyphens.");
  const tenant = await resolveTenant(request, account);
  if (!tenant || !Number.isSafeInteger(tenant.tenantId)) return refuse("FORBIDDEN", "You are not a member of that workspace.", 403);

  let planned;
  try {
    planned = await plan(request, operation, new URL(request.url));
  } catch (error) {
    if (error?.status === 413) return refuse("TOO_LARGE", "The request body is too large.", 413);
    return refuse("BAD_REQUEST", "The request body must be a JSON object.");
  }
  if (planned.refusal) return planned.refusal;

  const name = sandboxName(tenant.tenantId, id);
  const stub = namespace.get(namespace.idFromName(name));
  const argument = { ...planned.argument, name, tenant: String(tenant.tenantId) };
  try {
    const { status, body } = await call(stub, planned.operation, argument);
    if (planned.operation === "preview" && status === 200) {
      const registry = namespace.get(namespace.idFromName(PREVIEW_REGISTRY));
      const registered = await call(registry, "registry/register", { token: body.token, name, port: body.port });
      if (registered.status !== 200) return refuse("PREVIEW_FAILED", "The preview could not be registered.", 502);
      return json({ port: body.port, url: body.url });
    }
    return json(body, status);
  } catch {
    return refuse("SANDBOX_UNREACHABLE", "The sandbox could not be reached.", 502);
  }
}
