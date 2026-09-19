import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { confineRealPath } from "./path-confinement.mjs";

/**
 * Read-only repository tools.
 *
 * Every path argument is confined to the session's repository root before it
 * is touched. The model supplies these paths, and model output is untrusted
 * input like any other, so "../../.ssh/id_rsa" has to be impossible rather
 * than merely unlikely.
 */
const IGNORED = new Set([".git", "node_modules", ".next", "dist", "build", ".venv", "__pycache__", ".cache"]);

export class RepositoryToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RepositoryToolError";
    this.code = code;
  }
}

export function confineToRepository(root, candidate) {
  if (!root) throw new RepositoryToolError("NO_REPOSITORY", "This session has no repository attached.");
  // Symlink-aware: a lexical resolve would let a link inside the repository
  // read or write outside it.
  return confineRealPath(root, candidate, (code, message) => new RepositoryToolError(
    code === "PATH_ESCAPES_ROOT" ? "PATH_ESCAPES_REPOSITORY" : code,
    code === "PATH_ESCAPES_ROOT" ? `'${candidate}' is outside the repository.` : message,
  ));
}

export function registerRepositoryTools(registry, { readFileImpl = readFile, readdirImpl = readdir, statImpl = stat } = {}) {
  const io = { readdirImpl, statImpl };

  registry.register({
    name: "repository.list",
    description: "List files and directories at a path inside the repository.",
    capability: "repository.read",
    risk: "low",
    timeoutMs: 10_000,
    maxOutputCharacters: 20_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: [],
      properties: {
        path: { type: "string", maxLength: 1024, default: "." },
        depth: { type: "integer", minimum: 1, maximum: 4, default: 1 },
      },
    },
    async execute({ input, context }) {
      const root = context.repository;
      const target = confineToRepository(root, input.path);
      const lines = await walk(target, input.depth, root, io);
      return lines.length > 0 ? lines.join("\n") : "(empty)";
    },
  });

  registry.register({
    name: "repository.read",
    description: "Read a UTF-8 text file from the repository, optionally a line range.",
    capability: "repository.read",
    risk: "low",
    timeoutMs: 10_000,
    maxOutputCharacters: 60_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", maxLength: 1024, minLength: 1 },
        startLine: { type: "integer", minimum: 1, default: 1 },
        lineCount: { type: "integer", minimum: 1, maximum: 2000, default: 400 },
      },
    },
    async execute({ input, context }) {
      const target = confineToRepository(context.repository, input.path);
      const info = await statImpl(target).catch(() => null);
      if (!info || !info.isFile()) throw new RepositoryToolError("NOT_A_FILE", `'${input.path}' is not a readable file.`);
      if (info.size > 4 * 1024 * 1024) throw new RepositoryToolError("TOO_LARGE", `'${input.path}' is too large to read in one call.`);
      const text = await readFileImpl(target, "utf8");
      const lines = text.split("\n");
      const from = Math.min(input.startLine - 1, Math.max(0, lines.length - 1));
      const slice = lines.slice(from, from + input.lineCount);
      return slice.map((line, index) => `${from + index + 1}\t${line}`).join("\n");
    },
  });

  registry.register({
    name: "repository.search",
    description: "Search the repository text files for a literal string or regular expression.",
    capability: "repository.read",
    risk: "low",
    timeoutMs: 20_000,
    maxOutputCharacters: 30_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 400 },
        path: { type: "string", maxLength: 1024, default: "." },
        regex: { type: "boolean", default: false },
        maxResults: { type: "integer", minimum: 1, maximum: 200, default: 60 },
      },
    },
    async execute({ input, context }) {
      const root = context.repository;
      const target = confineToRepository(root, input.path);
      let matcher = null;
      if (input.regex) {
        try {
          matcher = new RegExp(input.query, "u");
        } catch (error) {
          throw new RepositoryToolError("INVALID_INPUT", `That is not a valid regular expression: ${error.message}`);
        }
      }
      const results = [];
      for await (const file of eachFile(target, io)) {
        if (results.length >= input.maxResults) break;
        let text;
        try {
          text = await readFileImpl(file, "utf8");
        } catch {
          continue;
        }
        // A NUL byte means this is a binary file that happened to decode.
        if (text.includes(NUL)) continue;
        const lines = text.split("\n");
        for (let index = 0; index < lines.length && results.length < input.maxResults; index += 1) {
          const hit = matcher ? matcher.test(lines[index]) : lines[index].includes(input.query);
          if (hit) results.push(`${relative(root, file)}:${index + 1}: ${lines[index].trim().slice(0, 240)}`);
        }
      }
      return results.length > 0 ? results.join("\n") : "No matches.";
    },
  });

  return registry;
}

const NUL = String.fromCharCode(0);

async function walk(directory, depth, root, io) {
  const entries = await io.readdirImpl(directory, { withFileTypes: true }).catch(() => []);
  const lines = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (IGNORED.has(entry.name) || entry.name.startsWith(".")) continue;
    const child = join(directory, entry.name);
    lines.push(`${relative(root, child)}${entry.isDirectory() ? "/" : ""}`);
    if (entry.isDirectory() && depth > 1) lines.push(...(await walk(child, depth - 1, root, io)));
    if (lines.length > 2000) break;
  }
  return lines;
}

async function* eachFile(directory, io, budget = { count: 0 }) {
  if (budget.count > 5000) return;
  const entries = await io.readdirImpl(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const child = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* eachFile(child, io, budget);
    } else if (entry.isFile()) {
      budget.count += 1;
      yield child;
    }
  }
}
