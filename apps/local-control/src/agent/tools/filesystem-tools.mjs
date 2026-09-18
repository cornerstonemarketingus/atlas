import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { createZipArchive } from "./archive.mjs";

/**
 * Filesystem access outside the repository, confined to roots the operator
 * named.
 *
 * The agent does not get the filesystem; it gets a workspace. Every path is
 * resolved and checked against an allow-list of roots, so the difference
 * between "write a report to the workspace" and "write to ~/.ssh/authorized_keys"
 * is enforced rather than merely discouraged.
 */
export class FilesystemToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FilesystemToolError";
    this.code = code;
  }
}

export function confineToRoots(roots, candidate) {
  if (!roots || roots.length === 0) throw new FilesystemToolError("NO_WORKSPACE", "No filesystem workspace is configured.");
  const target = resolve(roots[0], candidate ?? ".");
  const allowed = roots.some((root) => {
    const base = resolve(root);
    return target === base || target.startsWith(base + sep);
  });
  if (!allowed) throw new FilesystemToolError("PATH_OUTSIDE_WORKSPACE", `'${candidate}' is outside the configured workspace.`);
  return target;
}

export function registerFilesystemTools(registry, { roots, maxFileBytes = 4 * 1024 * 1024, maxArchiveBytes = 64 * 1024 * 1024 } = {}) {
  const workspace = (roots ?? []).map((root) => resolve(root));

  registry.register({
    name: "filesystem.read",
    description: "Read a UTF-8 text file from the Atlas workspace.",
    capability: "filesystem.read",
    risk: "low",
    timeoutMs: 10_000,
    maxOutputCharacters: 60_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string", minLength: 1, maxLength: 1024 } },
    },
    async execute({ input }) {
      const target = confineToRoots(workspace, input.path);
      const info = await stat(target).catch(() => null);
      if (!info?.isFile()) throw new FilesystemToolError("NOT_A_FILE", `'${input.path}' is not a readable file.`);
      if (info.size > maxFileBytes) throw new FilesystemToolError("TOO_LARGE", `'${input.path}' exceeds the ${maxFileBytes}-byte read limit.`);
      return readFile(target, "utf8");
    },
  });

  registry.register({
    name: "filesystem.write",
    description: "Write a UTF-8 text file into the Atlas workspace.",
    capability: "filesystem.write",
    risk: "moderate",
    timeoutMs: 15_000,
    maxOutputCharacters: 2_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: ["path", "content"],
      properties: {
        path: { type: "string", minLength: 1, maxLength: 1024 },
        content: { type: "string", maxLength: 2_000_000 },
      },
    },
    async execute({ input }) {
      const target = confineToRoots(workspace, input.path);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, input.content, { encoding: "utf8", mode: 0o600 });
      return `Wrote ${input.content.length} characters to ${input.path}.`;
    },
  });

  registry.register({
    name: "filesystem.archive",
    description: "Package files from the workspace into a single .zip archive.",
    capability: "filesystem.write",
    risk: "moderate",
    timeoutMs: 60_000,
    maxOutputCharacters: 4_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: ["source", "archivePath"],
      properties: {
        source: { type: "string", minLength: 1, maxLength: 1024 },
        archivePath: { type: "string", minLength: 1, maxLength: 1024 },
      },
    },
    async execute({ input }) {
      const source = confineToRoots(workspace, input.source);
      const destination = confineToRoots(workspace, input.archivePath);
      const entries = [];
      let total = 0;
      for await (const file of walkFiles(source)) {
        const content = await readFile(file);
        total += content.length;
        if (total > maxArchiveBytes) throw new FilesystemToolError("TOO_LARGE", `The archive would exceed ${maxArchiveBytes} bytes.`);
        entries.push({ name: relative(source, file) || file.split(sep).pop(), content });
      }
      if (entries.length === 0) throw new FilesystemToolError("EMPTY", `'${input.source}' contains no files to archive.`);
      const archive = createZipArchive(entries);
      await mkdir(resolve(destination, ".."), { recursive: true });
      await writeFile(destination, archive, { mode: 0o600 });
      return `Archived ${entries.length} file(s) (${archive.length} bytes) to ${input.archivePath}.`;
    },
  });

  registry.register({
    name: "filesystem.export_artifact",
    description: "Record a workspace file as a durable artifact receipt for this session.",
    capability: "filesystem.read",
    risk: "low",
    timeoutMs: 10_000,
    maxOutputCharacters: 2_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: ["path", "name"],
      properties: {
        path: { type: "string", minLength: 1, maxLength: 1024 },
        name: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
    async execute({ input, context }) {
      const target = confineToRoots(workspace, input.path);
      const info = await stat(target).catch(() => null);
      if (!info?.isFile()) throw new FilesystemToolError("NOT_A_FILE", `'${input.path}' is not a file.`);
      // The receipt records where the artifact is and how big it is. It never
      // copies the contents anywhere, so exporting cannot leak a file off the
      // machine by itself.
      context.recordArtifact?.({ name: input.name, path: target, bytes: info.size });
      return `Recorded artifact '${input.name}' (${info.size} bytes) at ${input.path}.`;
    },
  });

  return registry;
}

async function* walkFiles(target) {
  const info = await stat(target).catch(() => null);
  if (!info) return;
  if (info.isFile()) { yield target; return; }
  const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const child = join(target, entry.name);
    if (entry.isDirectory()) yield* walkFiles(child);
    else if (entry.isFile()) yield child;
  }
}
