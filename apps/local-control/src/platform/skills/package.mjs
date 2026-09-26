import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

import { RISK_LEVELS, canonicalJson, digest } from "../../../../../packages/atlas-contracts/src/index.mjs";

/**
 * Skill package format (blueprint §13 B).
 *
 * A package is `{ manifest, signature, files }`:
 *
 *   manifest  {name, version, publisher, description,
 *              tools: [{name, description, risk, consequential, inputSchema, entry}],
 *              permissions: [glob], tests: [{name, argv}], files: {path: sha256hex}}
 *   signature base64 Ed25519 signature over canonicalJson(manifest)
 *   files     {path: utf8 source text}
 *
 * The signature covers the manifest and the manifest pins every file by
 * SHA-256, so one signature check plus one digest check per file proves the
 * whole package is what the publisher released. The verifying key always
 * comes from the tenant's keyring, never from the package itself — a package
 * that could name its own key could sign itself.
 */
export class SkillError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "SkillError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const SKILL_NAME = /^[a-z][a-z0-9_-]{0,63}$/u;
const PUBLISHER = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const TOOL_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/u;
const PERMISSION = /^(\*\*|\*|[a-z][a-z0-9_]*)(\.(\*\*|\*|[a-z][a-z0-9_]*))*$/u;
const FILE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const MAX_FILES = 64;
const MAX_FILE_BYTES = 512 * 1024;

export function sha256Hex(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** Key id: digest of the public key's SPKI encoding, so ids cannot collide by label. */
export function publicKeyId(publicKeyPem) {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return `ed25519:${createHash("sha256").update(der).digest("hex").slice(0, 32)}`;
}

export function compareSemver(left, right) {
  const parse = (value) => String(value).split("-")[0].split(".").map(Number);
  const [a, b] = [parse(left), parse(right)];
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  const [preLeft, preRight] = [String(left).includes("-"), String(right).includes("-")];
  if (preLeft === preRight) return String(left) === String(right) ? 0 : String(left) < String(right) ? -1 : 1;
  return preLeft ? -1 : 1;
}

/** `entry` is "path/to/file.mjs" or "path/to/file.mjs#exportName" (default export name: execute). */
export function parseEntry(entry) {
  const [path, exportName = "execute", ...rest] = String(entry).split("#");
  if (rest.length > 0 || !EXPORT_NAME.test(exportName)) throw new SkillError("INVALID_PACKAGE", `Tool entry '${entry}' is malformed.`);
  return { path, exportName };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Structural validation of a manifest. Throws SkillError('INVALID_PACKAGE') on the first problem. */
export function validateManifest(manifest) {
  const bad = (message) => { throw new SkillError("INVALID_PACKAGE", message); };
  if (!isPlainObject(manifest)) bad("A skill package needs a manifest object.");
  const allowed = new Set(["name", "version", "publisher", "description", "tools", "permissions", "tests", "files"]);
  for (const key of Object.keys(manifest)) if (!allowed.has(key)) bad(`Manifest field '${key}' is not part of the format.`);
  if (!SKILL_NAME.test(manifest.name ?? "")) bad("Manifest name must be lower-case letters, digits, '-' or '_'.");
  if (!SEMVER.test(manifest.version ?? "")) bad(`Manifest version '${manifest.version}' is not semver.`);
  if (!PUBLISHER.test(manifest.publisher ?? "")) bad("Manifest publisher is missing or malformed.");
  if (typeof manifest.description !== "string" || !manifest.description || manifest.description.length > 2000) bad("Manifest needs a description.");

  if (!isPlainObject(manifest.files) || Object.keys(manifest.files).length === 0) bad("Manifest must pin at least one file.");
  if (Object.keys(manifest.files).length > MAX_FILES) bad(`A skill may ship at most ${MAX_FILES} files.`);
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (!FILE_PATH.test(path)) bad(`File path '${path}' must be relative, without '..' segments.`);
    if (!HEX64.test(hash ?? "")) bad(`File '${path}' needs a SHA-256 hex digest.`);
  }

  if (!Array.isArray(manifest.permissions) || manifest.permissions.length === 0) bad("Manifest must declare its permissions.");
  for (const glob of manifest.permissions) if (typeof glob !== "string" || !PERMISSION.test(glob)) bad(`Permission '${glob}' is malformed.`);

  if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) bad("A skill must expose at least one tool.");
  const names = new Set();
  for (const tool of manifest.tools) {
    if (!isPlainObject(tool)) bad("Every tool must be an object.");
    if (!TOOL_NAME.test(tool.name ?? "")) bad(`Tool name '${tool.name}' must be dotted lower_snake_case.`);
    if (names.has(tool.name)) bad(`Tool '${tool.name}' is declared twice.`);
    names.add(tool.name);
    if (typeof tool.description !== "string" || !tool.description) bad(`Tool '${tool.name}' needs a description.`);
    if (!RISK_LEVELS.includes(tool.risk)) bad(`Tool '${tool.name}' has unknown risk '${tool.risk}'.`);
    if (typeof tool.consequential !== "boolean") bad(`Tool '${tool.name}' must say whether it is consequential.`);
    if (!isPlainObject(tool.inputSchema) || tool.inputSchema.type !== "object") bad(`Tool '${tool.name}' needs an object inputSchema.`);
    const { path } = parseEntry(tool.entry);
    if (!(path in manifest.files)) bad(`Tool '${tool.name}' entry '${path}' is not a pinned file.`);
    if (!/\.m?js$/u.test(path)) bad(`Tool '${tool.name}' entry must be a JavaScript module.`);
  }

  if (!Array.isArray(manifest.tests) || manifest.tests.length === 0) bad("A skill must declare at least one test.");
  for (const entry of manifest.tests) {
    if (!isPlainObject(entry) || typeof entry.name !== "string" || !entry.name) bad("Every test needs a name.");
    if (!Array.isArray(entry.argv) || entry.argv.length === 0 || entry.argv.some((arg) => typeof arg !== "string")) bad(`Test '${entry.name}' needs an argv array.`);
  }
  return manifest;
}

/** Builds and signs a package: digests every file into the manifest, then signs the canonical manifest. */
export function signSkillPackage({ manifest, files, privateKeyPem }) {
  if (!isPlainObject(files)) throw new SkillError("INVALID_PACKAGE", "files must map path to source text.");
  const pinned = Object.fromEntries(Object.entries(files).map(([path, text]) => [path, sha256Hex(String(text))]));
  const full = validateManifest({ ...manifest, files: pinned });
  const signature = sign(null, Buffer.from(canonicalJson(full), "utf8"), createPrivateKey(privateKeyPem)).toString("base64");
  return { manifest: full, signature, files: { ...files } };
}

export function manifestDigest(manifest) {
  return digest(manifest);
}

/** Checks the signature against a list of trusted public keys (PEM). Returns the matching key id or null. */
export function verifyManifestSignature(manifest, signature, trustedKeys) {
  if (typeof signature !== "string" || !signature) return null;
  const bytes = Buffer.from(canonicalJson(manifest), "utf8");
  const sig = Buffer.from(signature, "base64");
  for (const { keyId, publicKeyPem } of trustedKeys) {
    try {
      if (verify(null, bytes, createPublicKey(publicKeyPem), sig)) return keyId;
    } catch { /* malformed key or signature: not a match */ }
  }
  return null;
}

/** Every pinned file present, no unpinned extras, every digest matching. Returns a list of problems. */
export function verifyPackageFiles(manifest, files) {
  const problems = [];
  if (!isPlainObject(files)) return ["package has no files"];
  for (const [path, expected] of Object.entries(manifest.files)) {
    const text = files[path];
    if (typeof text !== "string") problems.push(`'${path}' is missing`);
    else if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) problems.push(`'${path}' exceeds ${MAX_FILE_BYTES} bytes`);
    else if (sha256Hex(text) !== expected) problems.push(`'${path}' does not match its pinned digest`);
  }
  for (const path of Object.keys(files)) if (!(path in manifest.files)) problems.push(`'${path}' is not pinned by the manifest`);
  return problems;
}

/**
 * Glob subsumption over dotted segments (the grammar of policy.matchesPermission):
 * true when every tool name `inner` can match is also matched by `outer`.
 * Conservative: `*` in outer absorbs one literal or `*`; only `**` absorbs `**`.
 */
export function globWithin(inner, outer) {
  const p = inner.split(".");
  const c = outer.split(".");
  const memo = new Map();
  const walk = (i, j) => {
    const key = `${i},${j}`;
    if (memo.has(key)) return memo.get(key);
    let result;
    if (j === c.length) result = i === p.length;
    else if (c[j] === "**") {
      result = false;
      for (let k = i + 1; k <= p.length && !result; k += 1) result = walk(k, j + 1);
    } else if (i === p.length) result = false;
    else if (c[j] === "*") result = p[i] !== "**" && walk(i + 1, j + 1);
    else result = p[i] === c[j] && walk(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return walk(0, 0);
}

/** Permissions in `requested` not covered by any glob in `ceiling`. */
export function permissionsOutside(requested, ceiling) {
  return requested.filter((glob) => !ceiling.some((outer) => globWithin(glob, outer)));
}
