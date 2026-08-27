import { open } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  RepositorySourceReadError,
  type RepositorySourceReader,
  type RepositorySourceReadOptions,
  type RepositorySourceReadResult,
} from "../domain/repository-source.js";
import {
  nodeRepositoryFileSystem,
  type RepositoryFileSystem,
} from "./repository-file-system.js";

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_LINES = 200;

export class BoundedRepositorySourceReader implements RepositorySourceReader {
  public constructor(
    private readonly fileSystem: RepositoryFileSystem = nodeRepositoryFileSystem,
  ) {}

  public async read(
    repositoryPath: string,
    relativePath: string,
    options: RepositorySourceReadOptions = {},
  ): Promise<RepositorySourceReadResult> {
    const startLine = options.startLine ?? 1;
    const endLine = options.endLine;
    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    validateOptions(startLine, endLine, maxLines, maxBytes);

    if (isAbsolute(relativePath)) {
      throw new RepositorySourceReadError(
        "ABSOLUTE_PATH_NOT_ALLOWED",
        "Source paths must be relative to the repository root.",
      );
    }

    let root: string;
    try {
      root = await this.fileSystem.realPath(repositoryPath);
    } catch (error) {
      throw unreadable(repositoryPath, error);
    }

    const candidate = resolve(root, relativePath);
    if (!isContained(root, candidate)) {
      throw new RepositorySourceReadError(
        "PATH_OUTSIDE_REPOSITORY",
        "Source path resolves outside the repository root.",
      );
    }

    let linkStats;
    try {
      linkStats = await this.fileSystem.getLinkStats(candidate);
    } catch (error) {
      throw unreadable(relativePath, error);
    }
    if (linkStats.isSymbolicLink()) {
      throw new RepositorySourceReadError(
        "SYMLINK_NOT_ALLOWED",
        "Symbolic links cannot be read as repository source.",
      );
    }
    if (!linkStats.isFile()) {
      throw new RepositorySourceReadError(
        "SOURCE_NOT_FILE",
        "The requested source path is not a regular file.",
      );
    }

    let canonicalCandidate: string;
    try {
      canonicalCandidate = await this.fileSystem.realPath(candidate);
    } catch (error) {
      throw unreadable(relativePath, error);
    }
    if (!isContained(root, canonicalCandidate)) {
      throw new RepositorySourceReadError(
        "PATH_OUTSIDE_REPOSITORY",
        "Source path resolves outside the repository root.",
      );
    }

    const bytesToRead = Math.min(linkStats.size, maxBytes);
    let buffer: Buffer;
    try {
      buffer = await readPrefix(canonicalCandidate, bytesToRead);
    } catch (error) {
      throw unreadable(relativePath, error);
    }
    const detectedEncoding = detectUnsupportedEncoding(buffer);
    if (detectedEncoding !== null) {
      throw new RepositorySourceReadError(
        "UNSUPPORTED_ENCODING",
        `Source content appears to be ${detectedEncoding} encoded, which is not supported. Only UTF-8 is supported.`,
      );
    }
    if (buffer.includes(0)) {
      throw new RepositorySourceReadError("BINARY_FILE", "Binary source files are not supported.");
    }

    const contentPrefix = decodeUtf8Prefix(buffer, linkStats.size > buffer.length);
    const normalized = contentPrefix.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    const requestedEnd = endLine ?? Number.POSITIVE_INFINITY;
    const selected = lines.slice(startLine - 1, requestedEnd);
    const returned = selected.slice(0, maxLines);
    const truncatedByBytes = linkStats.size > buffer.length;
    const truncatedByLines = selected.length > returned.length;
    const actualEndLine = returned.length === 0 ? null : startLine + returned.length - 1;

    return {
      schemaVersion: 1,
      root,
      path: relative(root, canonicalCandidate).replaceAll("\\", "/"),
      content: returned.join("\n"),
      startLine,
      endLine: actualEndLine,
      bytesRead: buffer.length,
      truncated: truncatedByBytes || truncatedByLines,
      truncatedByBytes,
      truncatedByLines,
    };
  }
}

function validateOptions(
  startLine: number,
  endLine: number | undefined,
  maxLines: number,
  maxBytes: number,
): void {
  if (!Number.isSafeInteger(startLine) || startLine < 1 ||
      (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < startLine))) {
    throw new RepositorySourceReadError(
      "INVALID_LINE_RANGE",
      "Line ranges must use positive integers and endLine must not precede startLine.",
    );
  }
  if (!Number.isSafeInteger(maxLines) || maxLines < 1 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RepositorySourceReadError(
      "INVALID_LIMIT",
      "Source read limits must be positive safe integers.",
    );
  }
}

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

async function readPrefix(path: string, length: number): Promise<Buffer> {
  if (length === 0) return Buffer.alloc(0);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function detectUnsupportedEncoding(buffer: Buffer): string | null {
  if (startsWith(buffer, [0x00, 0x00, 0xfe, 0xff])) return "UTF-32BE";
  if (startsWith(buffer, [0xff, 0xfe, 0x00, 0x00])) return "UTF-32LE";
  if (startsWith(buffer, [0xfe, 0xff])) return "UTF-16BE";
  if (startsWith(buffer, [0xff, 0xfe])) return "UTF-16LE";
  return null;
}

function startsWith(buffer: Buffer, prefix: readonly number[]): boolean {
  if (buffer.length < prefix.length) return false;
  return prefix.every((byte, index) => buffer[index] === byte);
}

function decodeUtf8Prefix(buffer: Buffer, wasByteTruncated: boolean): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const incompleteSuffixLength = wasByteTruncated ? getIncompleteUtf8SuffixLength(buffer) : 0;
  try {
    return decoder.decode(buffer.subarray(0, buffer.length - incompleteSuffixLength));
  } catch {
    throw new RepositorySourceReadError(
      "UNSUPPORTED_ENCODING",
      "Source content is not valid UTF-8.",
    );
  }
}

function getIncompleteUtf8SuffixLength(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let leadIndex = buffer.length - 1;
  while (leadIndex >= 0 && isContinuationByte(buffer[leadIndex] ?? 0)) leadIndex -= 1;
  if (leadIndex < 0) return 0;

  const lead = buffer[leadIndex] ?? 0;
  const expectedLength = lead >= 0xc2 && lead <= 0xdf ? 2
    : lead >= 0xe0 && lead <= 0xef ? 3
    : lead >= 0xf0 && lead <= 0xf4 ? 4
    : 1;
  const availableLength = buffer.length - leadIndex;
  return expectedLength > availableLength ? availableLength : 0;
}

function isContinuationByte(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf;
}

function unreadable(path: string, cause: unknown): RepositorySourceReadError {
  return new RepositorySourceReadError(
    "PATH_UNREADABLE",
    `Unable to read repository path: ${path}`,
    { cause },
  );
}
