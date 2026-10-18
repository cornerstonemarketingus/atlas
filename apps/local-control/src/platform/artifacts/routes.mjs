import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { ARTIFACT_KINDS } from "../../../../../packages/atlas-contracts/src/index.mjs";

/**
 * /v1/artifacts — authenticated (the daemon checks the bearer token before
 * this handler runs). Any authenticated caller can read its own tenant's
 * artifacts; nothing here writes.
 *
 * GET  /v1/artifacts?kind=&runId=&limit=   records, newest first
 * GET  /v1/artifacts/:sha256               one record
 * GET  /v1/artifacts/:sha256/content       the bytes (HEAD too; single Range requests answered with 206)
 *
 * Bytes are reachable only by digest. The digest must be 64 lowercase hex
 * characters and the caller's tenant must own a record for it; any other
 * path under /v1/artifacts is a 404, so there is nothing to traverse.
 *
 * Every byte response carries the stored media type, `X-Content-Type-Options:
 * nosniff`, a sandboxing Content-Security-Policy that loads nothing except
 * (for media) itself, and `Content-Disposition: attachment` for everything
 * that is not a video or an image, so a browser never renders stored bytes
 * as a page of this origin.
 */

const DIGEST = "[0-9a-f]{64}";
const ROUTE = new RegExp(`^/v1/artifacts/(${DIGEST})(/content)?$`, "u");
const EXTENSIONS = {
  "video/mp4": "mp4", "video/webm": "webm", "model/gltf-binary": "glb", "model/gltf+json": "gltf", "application/pdf": "pdf",
  "text/markdown": "md", "text/plain": "txt", "text/csv": "csv", "application/json": "json", "application/zip": "zip",
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "application/vnd.atlas.site-manifest+json": "json",
};

/** The Content-Security-Policy for serving one artifact's bytes. */
export function contentSecurityPolicy(artifact) {
  const base = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox";
  if (artifact.mediaType.startsWith("video/")) return `${base}; media-src 'self'`;
  if (artifact.mediaType.startsWith("image/")) return `${base}; img-src 'self'`;
  return base;
}

function inline(artifact) {
  return artifact.mediaType.startsWith("video/") || artifact.mediaType.startsWith("image/");
}

function fileName(artifact) {
  const fallback = `${artifact.kind}-${artifact.sha256.slice(0, 12)}.${EXTENSIONS[artifact.mediaType] ?? "bin"}`;
  // ASCII-only quoted name; the contract already refuses separators and control characters.
  const name = (artifact.name ?? fallback).replace(/[^A-Za-z0-9._ -]/gu, "_").slice(0, 200);
  return name || fallback;
}

/**
 * Parses a Range header against a size. Returns null to serve the whole body
 * (no header, a syntax this server does not answer such as several ranges, or
 * a non-bytes unit), "unsatisfiable" for a 416, or { start, end } inclusive.
 */
export function parseRange(header, size) {
  if (typeof header !== "string") return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (!Number.isSafeInteger(start) || start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/**
 * @param {{ artifacts: import("./store.mjs").ArtifactStore, tenantFor?: (identity: object) => string,
 *   send: (response: import("node:http").ServerResponse, status: number, value: unknown) => boolean }} options
 */
export function createArtifactRoutes({ artifacts, tenantFor = () => "local", send }) {
  return async function handle(request, response, identity) {
    const url = new URL(request.url ?? "/", "http://local.atlas");
    if (url.pathname !== "/v1/artifacts" && !url.pathname.startsWith("/v1/artifacts/")) return false;
    const tenantId = tenantFor(identity);
    if (!["GET", "HEAD"].includes(request.method)) {
      response.setHeader("allow", "GET, HEAD");
      return send(response, 405, { message: "Artifacts are read-only over HTTP." });
    }
    if (url.pathname === "/v1/artifacts") {
      const kind = url.searchParams.get("kind");
      if (kind && !ARTIFACT_KINDS.includes(kind)) return send(response, 400, { message: `kind must be one of ${ARTIFACT_KINDS.join(", ")}.` });
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return send(response, 200, { artifacts: artifacts.list(tenantId, { kind, runId: url.searchParams.get("runId"), limit: Number.isInteger(limit) ? limit : 100 }) });
    }
    const match = ROUTE.exec(url.pathname);
    if (!match) return send(response, 404, { message: "Artifacts are addressed by their sha256 digest." });
    const located = artifacts.locate(tenantId, match[1]);
    // Another tenant's artifact is indistinguishable from a missing one.
    if (!located) return send(response, 404, { message: "Artifact not found." });
    if (!match[2]) return send(response, 200, { artifact: located.artifact });
    return serveBytes(request, response, located, send);
  };
}

async function serveBytes(request, response, { artifact, path }, send) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size !== artifact.size) return send(response, 410, { message: "The artifact's bytes are missing from this computer." });
  const textual = artifact.mediaType.startsWith("text/") || artifact.mediaType.endsWith("json");
  response.setHeader("content-type", textual ? `${artifact.mediaType}; charset=utf-8` : artifact.mediaType);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-security-policy", contentSecurityPolicy(artifact));
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.setHeader("content-disposition", `${inline(artifact) ? "inline" : "attachment"}; filename="${fileName(artifact)}"`);
  response.setHeader("accept-ranges", "bytes");
  response.setHeader("etag", `"${artifact.sha256}"`);
  // Bytes at a digest never change.
  response.setHeader("cache-control", "private, max-age=31536000, immutable");

  const range = parseRange(request.headers.range, artifact.size);
  if (range === "unsatisfiable") {
    response.setHeader("content-range", `bytes */${artifact.size}`);
    response.setHeader("content-length", "0");
    response.writeHead(416);
    response.end();
    return true;
  }
  const { start, end } = range ?? { start: 0, end: artifact.size - 1 };
  const length = artifact.size === 0 ? 0 : end - start + 1;
  if (range) response.setHeader("content-range", `bytes ${start}-${end}/${artifact.size}`);
  response.setHeader("content-length", String(length));
  response.writeHead(range ? 206 : 200);
  if (request.method === "HEAD" || length === 0) { response.end(); return true; }
  await new Promise((resolve) => {
    const stream = createReadStream(path, { start, end });
    stream.on("error", () => { response.destroy(); resolve(); });
    response.on("close", () => { stream.destroy(); resolve(); });
    stream.pipe(response);
  });
  return true;
}
