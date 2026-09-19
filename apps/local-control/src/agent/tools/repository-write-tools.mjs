import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";

import { confineToRepository, RepositoryToolError } from "./repository-tools.mjs";
import { git, runCommand } from "./process.mjs";

/**
 * Repository tools that change things.
 *
 * Everything here is confined to the repository, and the destructive members
 * of the family — delete, and running a test command — require approval bound
 * to the exact action. Writing and renaming do not: they happen inside an
 * isolated worktree whose whole purpose is to be reviewable before it becomes
 * a commit, and an approval prompt per file edit would train the operator to
 * approve without reading.
 */

/** Test commands are chosen from a fixed list, not composed by the model. */
export const APPROVED_TEST_COMMANDS = new Map([
  ["npm-test", ["npm", ["test", "--silent"]]],
  ["npm-lint", ["npm", ["run", "lint", "--silent"]]],
  ["npm-build", ["npm", ["run", "build", "--silent"]]],
  ["node-test", [process.execPath, ["--test"]]],
  ["pytest", ["python3", ["-m", "pytest", "-q"]]],
]);

export function registerRepositoryWriteTools(registry, { writeFileImpl = writeFile, gitImpl = git, runCommandImpl = runCommand } = {}) {
  registry.register({
    name: "repository.write",
    description: "Create or overwrite a UTF-8 text file in the repository.",
    capability: "repository.write",
    risk: "moderate",
    timeoutMs: 15_000,
    maxOutputCharacters: 2_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: ["path", "content"],
      properties: {
        path: { type: "string", minLength: 1, maxLength: 1024 },
        content: { type: "string", maxLength: 1_000_000 },
      },
    },
    async execute({ input, context }) {
      const target = confineToRepository(context.repository, input.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFileImpl(target, input.content, "utf8");
      return `Wrote ${input.content.length} characters to ${input.path}.`;
    },
  });

  registry.register({
    name: "repository.rename",
    description: "Rename or move a file inside the repository.",
    capability: "repository.write",
    risk: "moderate",
    timeoutMs: 15_000,
    maxOutputCharacters: 2_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: ["from", "to"],
      properties: {
        from: { type: "string", minLength: 1, maxLength: 1024 },
        to: { type: "string", minLength: 1, maxLength: 1024 },
      },
    },
    async execute({ input, context }) {
      const from = confineToRepository(context.repository, input.from);
      const to = confineToRepository(context.repository, input.to);
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
      return `Renamed ${input.from} to ${input.to}.`;
    },
  });

  registry.register({
    name: "repository.delete",
    description: "Delete a file from the repository. This is destructive and needs approval.",
    capability: "repository.write",
    risk: "high",
    timeoutMs: 15_000,
    maxOutputCharacters: 2_000,
    requiresApproval: true,
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string", minLength: 1, maxLength: 1024 } },
    },
    async execute({ input, context }) {
      const target = confineToRepository(context.repository, input.path);
      if (relative(context.repository, target) === "") throw new RepositoryToolError("REFUSED", "The repository root cannot be deleted.");
      // No recursive delete: a single mistaken argument must not be able to
      // remove a directory tree.
      await rm(target, { recursive: false, force: false });
      return `Deleted ${input.path}.`;
    },
  });

  registry.register({
    name: "repository.diff",
    description: "Show the uncommitted changes in the repository, including new files.",
    capability: "repository.read",
    risk: "low",
    timeoutMs: 20_000,
    maxOutputCharacters: 60_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: [],
      properties: { path: { type: "string", maxLength: 1024, default: "." } },
    },
    async execute({ input, context, signal }) {
      const root = context.repository;
      confineToRepository(root, input.path);
      // Staged into the worktree's own index first, so files the agent
      // created appear in the diff rather than silently missing from it.
      await gitImpl(root, ["add", "-A", "--", input.path], { signal });
      const diff = await gitImpl(root, ["diff", "--cached", "--no-ext-diff", "--", input.path], { signal });
      return diff.trim() || "No uncommitted changes.";
    },
  });

  registry.register({
    name: "repository.branch",
    description: "Create and switch to a Git branch in the repository.",
    capability: "repository.git",
    risk: "moderate",
    timeoutMs: 20_000,
    maxOutputCharacters: 2_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        // Anchored, and no leading dash: a branch name is about to become a
        // command-line argument.
        name: { type: "string", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]*$" },
      },
    },
    async execute({ input, context, signal }) {
      await gitImpl(context.repository, ["checkout", "-B", input.name], { signal });
      return `On branch ${input.name}.`;
    },
  });

  registry.register({
    name: "repository.commit",
    description: "Stage everything and record a Git commit in the repository.",
    capability: "repository.git",
    risk: "moderate",
    timeoutMs: 30_000,
    maxOutputCharacters: 4_000,
    requiresApproval: false,
    inputSchema: {
      type: "object",
      required: ["message"],
      properties: { message: { type: "string", minLength: 1, maxLength: 4_000 } },
    },
    async execute({ input, context, signal }) {
      const root = context.repository;
      await gitImpl(root, ["add", "-A"], { signal });
      const staged = await gitImpl(root, ["diff", "--cached", "--name-only"], { signal });
      if (!staged.trim()) return "Nothing to commit; the working tree is clean.";
      // `--` ends option parsing so a message beginning with a dash is a
      // message rather than a flag.
      await gitImpl(root, ["commit", "-m", input.message, "--"], { signal });
      const head = await gitImpl(root, ["rev-parse", "--short", "HEAD"], { signal });
      return `Committed ${head.trim()} with ${staged.trim().split("\n").length} file(s).`;
    },
  });

  registry.register({
    name: "repository.run_tests",
    description: `Run one approved verification command. Choose from: ${[...APPROVED_TEST_COMMANDS.keys()].join(", ")}.`,
    capability: "repository.execute",
    risk: "high",
    timeoutMs: 15 * 60_000,
    maxOutputCharacters: 30_000,
    requiresApproval: true,
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", enum: [...APPROVED_TEST_COMMANDS.keys()] },
        directory: { type: "string", maxLength: 1024, default: "." },
      },
    },
    async execute({ input, context, signal }) {
      const cwd = confineToRepository(context.repository, input.directory);
      const [command, args] = APPROVED_TEST_COMMANDS.get(input.command);
      const result = await runCommandImpl(command, args, { cwd, signal, timeoutMs: 14 * 60_000, maxBytes: 200_000 });
      const output = `${result.stdout}\n${result.stderr}`.trim();
      if (result.timedOut) return `${input.command} timed out.\n${output}`;
      return `${input.command} ${result.ok ? "passed" : `failed (exit ${result.status})`}.\n${output}`;
    },
  });

  return registry;
}
