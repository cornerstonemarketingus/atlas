import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PolicyEnforcedReadOnlyToolRegistry } from "../src/infrastructure/policy-enforced-read-only-tool-registry.js";
import { SafeRepositoryFileEditor } from "../src/infrastructure/safe-repository-file-editor.js";
import { createRepositoryWriteTools, registerRepositoryWriteTools } from "../src/infrastructure/repository-write-tools.js";
import { RepositoryToolInputError } from "../src/infrastructure/repository-read-only-tools.js";

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), "atlas-write-tools-"));
}

function allowAllRegistry(): PolicyEnforcedReadOnlyToolRegistry {
  return new PolicyEnforcedReadOnlyToolRegistry({ policy: { defaultDecision: "allow", rules: [] } });
}

test("creates a new file and reports a create-shaped diff", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = allowAllRegistry();
  const tools = createRepositoryWriteTools({ repositoryId: "atlas", repositoryRoot: root }, { editor: new SafeRepositoryFileEditor() });
  registerRepositoryWriteTools(registry, tools);

  const result = await registry.execute({
    name: "repository.propose_file_edit",
    input: { path: "new.ts", content: "export const x = 1;\n" },
    scope: { kind: "repository", repositoryId: "atlas" },
    context: { repositoryId: "atlas" },
  });

  assert.equal(result.status, "completed");
  const output = result.status === "completed" ? result.output as { operation: string; path: string; diff: string } : null;
  assert.equal(output?.operation, "create");
  assert.equal(output?.path, "new.ts");
  assert.match(output?.diff ?? "", /\+export const x = 1;/);
  assert.equal(await readFile(join(root, "new.ts"), "utf8"), "export const x = 1;\n");
});

test("updates an existing file using a freshly computed hash, not a model-supplied one", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "existing.txt"), "old content\n", "utf8");
  const registry = allowAllRegistry();
  const tools = createRepositoryWriteTools({ repositoryId: "atlas", repositoryRoot: root }, { editor: new SafeRepositoryFileEditor() });
  registerRepositoryWriteTools(registry, tools);

  const result = await registry.execute({
    name: "repository.propose_file_edit",
    input: { path: "existing.txt", content: "new content\n" },
    scope: { kind: "repository", repositoryId: "atlas" },
    context: { repositoryId: "atlas" },
  });

  assert.equal(result.status, "completed");
  const output = result.status === "completed" ? result.output as { operation: string } : null;
  assert.equal(output?.operation, "update");
  assert.equal(await readFile(join(root, "existing.txt"), "utf8"), "new content\n");
});

test("rejects a path that resolves outside the repository before reading anything", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "workspace"));
  await writeFile(join(root, "secret.txt"), "top secret", "utf8");

  const registry = allowAllRegistry();
  const tools = createRepositoryWriteTools({ repositoryId: "atlas", repositoryRoot: join(root, "workspace") }, { editor: new SafeRepositoryFileEditor() });
  registerRepositoryWriteTools(registry, tools);

  await assert.rejects(
    registry.execute({
      name: "repository.propose_file_edit",
      input: { path: "../secret.txt", content: "overwritten" },
      scope: { kind: "repository", repositoryId: "atlas" },
      context: { repositoryId: "atlas" },
    }),
    (error: unknown) => error instanceof RepositoryToolInputError,
  );
  assert.equal(await readFile(join(root, "secret.txt"), "utf8"), "top secret");
});

test("policy can deny the write capability independently of read tools", async () => {
  const registry = new PolicyEnforcedReadOnlyToolRegistry({
    policy: { defaultDecision: "allow", rules: [{ id: "deny-writes", capabilities: ["write"], scope: { kind: "global" }, decision: "deny" }] },
  });
  const root = await fixture();
  const tools = createRepositoryWriteTools({ repositoryId: "atlas", repositoryRoot: root }, { editor: new SafeRepositoryFileEditor() });
  registerRepositoryWriteTools(registry, tools);

  await assert.rejects(
    registry.execute({
      name: "repository.propose_file_edit",
      input: { path: "file.ts", content: "x" },
      scope: { kind: "repository", repositoryId: "atlas" },
      context: { repositoryId: "atlas" },
    }),
    /Policy denied tool/,
  );
  await rm(root, { recursive: true, force: true });
});

test("rejects symlinked targets via the underlying editor's own validation", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "target.txt"), "content", "utf8");
  try {
    await symlink(join(root, "target.txt"), join(root, "link.txt"), "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    return;
  }
  const registry = allowAllRegistry();
  const tools = createRepositoryWriteTools({ repositoryId: "atlas", repositoryRoot: root }, { editor: new SafeRepositoryFileEditor() });
  registerRepositoryWriteTools(registry, tools);

  await assert.rejects(registry.execute({
    name: "repository.propose_file_edit",
    input: { path: "link.txt", content: "new" },
    scope: { kind: "repository", repositoryId: "atlas" },
    context: { repositoryId: "atlas" },
  }));
});
