import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { extname, resolve } from "node:path";

import { confineRealPath } from "./tools/path-confinement.mjs";

/**
 * Attachments an operator can put in front of the model: images, text files,
 * PDFs, files from the repository under discussion, and screenshots from the
 * computer operator.
 *
 * Everything here is treated as untrusted input. A file is bounded before it
 * is read, its type is decided by us rather than by the caller's claim, and a
 * path is confined to a root the caller names.
 */
export const ATTACHMENT_KINDS = ["image", "text", "pdf", "repository_file", "screenshot"];

const MAX_BYTES = {
  image: 8 * 1024 * 1024,
  screenshot: 8 * 1024 * 1024,
  pdf: 16 * 1024 * 1024,
  text: 1 * 1024 * 1024,
  repository_file: 1 * 1024 * 1024,
};

const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

export class AttachmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AttachmentError";
    this.code = code;
  }
}

export function normalizeAttachment(raw, { root = null } = {}) {
  const kind = ATTACHMENT_KINDS.includes(raw?.kind) ? raw.kind : null;
  if (!kind) throw new AttachmentError("UNKNOWN_KIND", `Attachment kind must be one of: ${ATTACHMENT_KINDS.join(", ")}.`);
  const name = String(raw.name ?? "attachment").slice(0, 200);

  if (typeof raw.text === "string") {
    if (kind !== "text" && kind !== "repository_file") {
      throw new AttachmentError("INLINE_NOT_ALLOWED", `Inline text is only accepted for text attachments, not ${kind}.`);
    }
    if (Buffer.byteLength(raw.text, "utf8") > MAX_BYTES.text) throw new AttachmentError("TOO_LARGE", `${name} exceeds the inline text limit.`);
    return { kind, name, text: raw.text, path: null, mediaType: "text/plain" };
  }

  if (typeof raw.path !== "string" || raw.path.length === 0) {
    throw new AttachmentError("MISSING_SOURCE", `${name} must carry either inline text or a path.`);
  }
  return { kind, name, text: null, path: confinePath(raw.path, root), mediaType: null };
}

/**
 * Confines a path to `root` when one is given. Resolving first and comparing
 * the resolved prefix is what stops `../` and a symlinked parent from walking
 * out of the repository the operator attached.
 */
function confinePath(candidate, root) {
  if (!root) return resolve(candidate);
  // Symlink-aware, for the same reason the repository tools are: an
  // attachment path comes from the model or from a client request.
  return confineRealPath(root, candidate, () => new AttachmentError(
    "PATH_ESCAPES_ROOT",
    "An attachment path must stay inside the attached repository.",
  ));
}

/** Reads an attachment, refusing anything past its kind's byte limit. */
export async function loadAttachment(attachment, { readFileImpl = readFile, statImpl = stat } = {}) {
  if (attachment.text !== null) {
    return { ...attachment, bytes: Buffer.from(attachment.text, "utf8"), digest: digestOf(Buffer.from(attachment.text, "utf8")) };
  }
  const limit = MAX_BYTES[attachment.kind];
  const info = await statImpl(attachment.path).catch(() => null);
  if (!info) throw new AttachmentError("NOT_FOUND", `${attachment.name} could not be read.`);
  // Checked before the read, so an oversized file is never loaded into memory.
  if (info.size > limit) throw new AttachmentError("TOO_LARGE", `${attachment.name} is ${info.size} bytes, over the ${limit}-byte limit for ${attachment.kind}.`);
  const bytes = await readFileImpl(attachment.path);
  const mediaType = attachment.kind === "image" || attachment.kind === "screenshot"
    ? IMAGE_TYPES.get(extname(attachment.path).toLowerCase()) ?? null
    : attachment.kind === "pdf"
      ? "application/pdf"
      : "text/plain";
  if ((attachment.kind === "image" || attachment.kind === "screenshot") && !mediaType) {
    throw new AttachmentError("UNSUPPORTED_IMAGE", `${attachment.name} is not a supported image type.`);
  }
  return { ...attachment, mediaType, bytes, digest: digestOf(bytes) };
}

/**
 * Turns a loaded attachment into OpenAI-compatible content parts.
 *
 * Images go as data URLs so a vision-capable local model can see them without
 * anything leaving the machine — no upload, no signed URL, no third party.
 */
export function toModelContent(loaded) {
  if (loaded.kind === "image" || loaded.kind === "screenshot") {
    return [{
      type: "image_url",
      image_url: { url: `data:${loaded.mediaType};base64,${loaded.bytes.toString("base64")}` },
    }];
  }
  if (loaded.kind === "pdf") {
    const extracted = extractPdfText(loaded.bytes);
    return [{
      type: "text",
      text: extracted
        ? `Attached PDF ${loaded.name} (extracted text):\n${extracted}`
        : `Attached PDF ${loaded.name}: the text could not be extracted from this file, so its contents are unavailable. Do not guess at them.`,
    }];
  }
  return [{ type: "text", text: `Attached file ${loaded.name}:\n${bounded(loaded.bytes.toString("utf8"))}` }];
}

/**
 * Best-effort, dependency-free PDF text extraction.
 *
 * This package deliberately carries no third-party dependencies, so it reads
 * the Flate-compressed content streams directly. It handles ordinary
 * text-bearing PDFs and gives up cleanly on scanned or encrypted ones —
 * returning null so the caller can say "unavailable" rather than inventing
 * content that is not there.
 */
export function extractPdfText(bytes, { maxCharacters = 200_000 } = {}) {
  if (!bytes.subarray(0, 5).toString("latin1").startsWith("%PDF-")) return null;
  const pieces = [];
  let index = 0;
  while (index < bytes.length && pieces.join("").length < maxCharacters) {
    const start = bytes.indexOf("stream", index, "latin1");
    if (start === -1) break;
    const end = bytes.indexOf("endstream", start, "latin1");
    if (end === -1) break;
    let from = start + "stream".length;
    if (bytes[from] === 0x0d) from += 1;
    if (bytes[from] === 0x0a) from += 1;
    const chunk = bytes.subarray(from, end);
    index = end + "endstream".length;
    let text;
    try {
      text = inflateSync(chunk).toString("latin1");
    } catch {
      text = chunk.toString("latin1");
    }
    const drawn = readPdfTextOperators(text);
    if (drawn) pieces.push(drawn);
  }
  const joined = pieces.join("\n").replace(/[ \t]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim();
  return joined.length > 0 ? joined.slice(0, maxCharacters) : null;
}

/** Pulls the literal strings out of Tj/TJ text-showing operators. */
function readPdfTextOperators(content) {
  const out = [];
  const pattern = /\((?:\\.|[^\\()])*\)\s*Tj|\[((?:\((?:\\.|[^\\()])*\)|[^\][])*)\]\s*TJ/gu;
  for (const match of content.matchAll(pattern)) {
    const source = match[1] ?? match[0];
    for (const literal of source.matchAll(/\((?:\\.|[^\\()])*\)/gu)) {
      out.push(literal[0].slice(1, -1).replace(/\\([()\\])/gu, "$1").replace(/\\n/gu, "\n"));
    }
    out.push(" ");
  }
  return out.join("").trim();
}

function bounded(text, limit = 60_000) {
  return text.length > limit ? `${text.slice(0, limit)}\n…[truncated at ${limit} characters]` : text;
}

function digestOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
