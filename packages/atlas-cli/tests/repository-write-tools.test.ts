import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PolicyEnforcedReadOnlyToolRegistry } from "../src/infrastructure/policy-enforced-read-only-tool-registry.js";
import { SafeRepositoryFileEditor } from "../src/infrastructure/safe-repository-file-editor.js";
import {
  createRepositoryWriteTools,
  registerRepositoryWriteTools,
  RepositoryChangeSetToolError,
} from "../src/infrastructure/repository-write-tools.js";
import { TransactionalRepositoryChangeSetEditor } from "../src/infrastructure/transactional-repository-change-set-editor.js";
import { RepositoryFileEditError } from "../src/domain/repository-file-edit.js";
import type {
  RepositoryFileEditApproval,
  RepositoryFileEditPlan,
  RepositoryFileEditRequest,
  RepositoryFileEditor,
} from "../src/domain/repository-file-edit.js";
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

  const result = await registry.execute({
    name: "repository.propose_file_edit",
    input: { path: "../secret.txt", content: "overwritten" },
    scope: { kind: "repository", repositoryId: "atlas" },
    context: { repositoryId: "atlas" },
  });
  assert.equal(result.status, "failed");
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

  const result = await registry.execute({
    name: "repository.propose_file_edit",
    input: { path: "link.txt", content: "new" },
    scope: { kind: "repository", repositoryId: "atlas" },
    context: { repositoryId: "atlas" },
  });
  assert.equal(result.status, "failed");
});

/** Fails the nth apply so the transaction's rollback path can be driven deterministically. */
class FailingApplyFileEditor implements RepositoryFileEditor {
  private applies = 0;
  public constructor(private readonly inner: RepositoryFileEditor, private readonly failAt: number) {}
  public preview(repositoryPath: string, request: RepositoryFileEditRequest) { return this.inner.preview(repositoryPath, request); }
  public async apply(plan: RepositoryFileEditPlan, approval: RepositoryFileEditApproval) {
    this.applies += 1;
    if (this.applies === this.failAt) throw new RepositoryFileEditError("IO_ERROR", "injected apply failure");
    return this.inner.apply(plan, approval);
  }
  public discard(planDigest: string): boolean { return this.inner.discard(planDigest); }
}

function changeSetTools(root: string, services?: { failApplyAt?: number }) {
  const editor = new SafeRepositoryFileEditor();
  const registry = allowAllRegistry();
  const tools = createRepositoryWriteTools({ repositoryId: "atlas", repositoryRoot: root }, {
    editor,
    ...(services?.failApplyAt === undefined
      ? {}
      : { changeSetEditor: new TransactionalRepositoryChangeSetEditor(new FailingApplyFileEditor(editor, services.failApplyAt)) }),
  });
  registerRepositoryWriteTools(registry, tools);
  return registry;
}

function runChangeSet(registry: PolicyEnforcedReadOnlyToolRegistry, edits: readonly unknown[]) {
  return registry.execute({
    name: "repository.propose_change_set",
    input: { edits },
    scope: { kind: "repository", repositoryId: "atlas" },
    context: { repositoryId: "atlas" },
  });
}

/**
 * A change set that is well-formed but cannot be applied against the repository
 * as it actually is — a path that escapes the root, a missing update target, an
 * occupied rename destination, a mid-batch apply failure — comes back as a
 * `failed` RESULT, not a thrown error. That is the registry's deliberate
 * contract: the model should see the reason and adapt, rather than have the
 * session end. Asserting on the returned message is therefore asserting on
 * exactly what the model gets to read.
 */
async function failedChangeSet(
  registry: PolicyEnforcedReadOnlyToolRegistry,
  edits: readonly unknown[],
): Promise<{ message: string; errorCode: string | undefined }> {
  const result = await runChangeSet(registry, edits);
  assert.equal(result.status, "failed", `expected a failed change set, got ${result.status}`);
  if (result.status !== "failed") throw new Error("unreachable");
  return { message: result.message, errorCode: result.errorCode };
}

/**
 * A change set that is MALFORMED — an unknown operation, a delete carrying
 * content, more edits than the schema allows — throws instead. Input validation
 * runs before the tool executes, and a call that does not match the advertised
 * schema is a broken caller rather than a repository state the model can work
 * around.
 */
async function malformedChangeSet(
  registry: PolicyEnforcedReadOnlyToolRegistry,
  edits: readonly unknown[],
): Promise<void> {
  await assert.rejects(runChangeSet(registry, edits), (error: unknown) => error instanceof RepositoryToolInputError);
}

test("applies a multi-file create, update, delete, and rename atomically", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "updated.ts"), "before\n", "utf8");
  await writeFile(join(root, "obsolete.ts"), "obsolete\n", "utf8");
  await writeFile(join(root, "old-name.ts"), "moved\n", "utf8");

  const result = await runChangeSet(changeSetTools(root), [
    { operation: "create", path: "added.ts", content: "added\n" },
    { operation: "update", path: "updated.ts", content: "after\n" },
    { operation: "delete", path: "obsolete.ts" },
    { operation: "rename", path: "old-name.ts", toPath: "new-name.ts" },
  ]);

  assert.equal(result.status, "completed");
  const output = result.status === "completed"
    ? result.output as { changeSetDigest: string; applied: readonly { operation: string; path: string; toPath: string | null }[] }
    : null;
  assert.equal(output?.applied.length, 4);
  assert.deepEqual(output?.applied.map((edit) => edit.operation), ["create", "update", "delete", "rename"]);
  assert.equal(output?.applied[3]?.toPath, "new-name.ts");
  assert.equal(typeof output?.changeSetDigest, "string");
  assert.equal(await readFile(join(root, "added.ts"), "utf8"), "added\n");
  assert.equal(await readFile(join(root, "updated.ts"), "utf8"), "after\n");
  await assert.rejects(readFile(join(root, "obsolete.ts")), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "old-name.ts")), { code: "ENOENT" });
  assert.equal(await readFile(join(root, "new-name.ts"), "utf8"), "moved\n");
});

test("rolls every applied edit back when one edit in the batch fails", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "updated.ts"), "before\n", "utf8");
  await writeFile(join(root, "obsolete.ts"), "obsolete\n", "utf8");
  await writeFile(join(root, "old-name.ts"), "moved\n", "utf8");

  // The fifth edit's apply fails, so the four before it must be undone.
  const registry = changeSetTools(root, { failApplyAt: 5 });
  const failure = await failedChangeSet(registry, [
    { operation: "create", path: "added.ts", content: "added\n" },
    { operation: "update", path: "updated.ts", content: "after\n" },
    { operation: "delete", path: "obsolete.ts" },
    { operation: "rename", path: "old-name.ts", toPath: "new-name.ts" },
    { operation: "create", path: "never.ts", content: "never\n" },
  ]);
  // The message is the model's only view of what happened, so it has to say
  // both what failed and — critically — that the repository was put back. A
  // model told only "the change set failed" would not know whether it is now
  // looking at a half-applied tree.
  assert.equal(failure.errorCode, "CHANGE_SET_FAILED");
  assert.match(failure.message, /IO_ERROR/u);
  assert.match(failure.message, /rolled back/u);

  await assert.rejects(readFile(join(root, "added.ts")), { code: "ENOENT" });
  assert.equal(await readFile(join(root, "updated.ts"), "utf8"), "before\n");
  assert.equal(await readFile(join(root, "obsolete.ts"), "utf8"), "obsolete\n");
  assert.equal(await readFile(join(root, "old-name.ts"), "utf8"), "moved\n");
  await assert.rejects(readFile(join(root, "new-name.ts")), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "never.ts")), { code: "ENOENT" });
});

test("rejects change-set paths that escape the repository, including a rename destination", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "workspace"));
  await writeFile(join(root, "secret.txt"), "top secret", "utf8");
  await writeFile(join(root, "workspace", "inside.txt"), "inside\n", "utf8");
  const registry = changeSetTools(join(root, "workspace"));

  for (const edits of [
    [{ operation: "update", path: "../secret.txt", content: "overwritten" }],
    [{ operation: "delete", path: "../secret.txt" }],
    [{ operation: "rename", path: "inside.txt", toPath: "../secret.txt" }],
    [{ operation: "rename", path: "inside.txt", toPath: join(root, "secret.txt") }],
    [{ operation: "create", path: join(root, "secret.txt"), content: "overwritten" }],
  ]) {
    const failure = await failedChangeSet(registry, edits);
    assert.match(failure.message, /outside the repository|repository-relative/u);
  }
  assert.equal(await readFile(join(root, "secret.txt"), "utf8"), "top secret");
  assert.equal(await readFile(join(root, "workspace", "inside.txt"), "utf8"), "inside\n");
});

test("rejects change-set edits that traverse or target a symlink", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = await fixture();
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.txt"), "top secret", "utf8");
  await writeFile(join(root, "target.txt"), "content\n", "utf8");
  try {
    await symlink(join(root, "target.txt"), join(root, "link.txt"), "file");
    await symlink(outside, join(root, "linked"), "junction");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    return;
  }
  const registry = changeSetTools(root);

  await failedChangeSet(registry, [{ operation: "delete", path: "link.txt" }]);
  await failedChangeSet(registry, [{ operation: "rename", path: "target.txt", toPath: "linked/stolen.txt" }]);
  assert.equal(await readFile(join(root, "target.txt"), "utf8"), "content\n");
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "top secret");
});

test("refuses to clobber an existing rename destination", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "old-name.ts"), "moved\n", "utf8");
  await writeFile(join(root, "taken.ts"), "occupied\n", "utf8");

  await failedChangeSet(changeSetTools(root), [{ operation: "rename", path: "old-name.ts", toPath: "taken.ts" }]);
  assert.equal(await readFile(join(root, "taken.ts"), "utf8"), "occupied\n");
  assert.equal(await readFile(join(root, "old-name.ts"), "utf8"), "moved\n");
});

test("rejects malformed, oversized, and self-conflicting change sets", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "file.ts"), "content\n", "utf8");
  const registry = changeSetTools(root);

  // Schema violations: the call itself is wrong, so it never reaches the editor.
  await malformedChangeSet(registry, []);
  await malformedChangeSet(registry, [{ operation: "rewrite", path: "file.ts", content: "x" }]);
  await malformedChangeSet(registry, [{ operation: "delete", path: "file.ts", content: "x" }]);
  await malformedChangeSet(registry, [{ operation: "create", path: "file.ts", content: "x", toPath: "other.ts" }]);
  await malformedChangeSet(registry, [{ operation: "rename", path: "file.ts" }]);
  await malformedChangeSet(registry, [{ operation: "rename", path: "file.ts", toPath: "file.ts" }]);
  await malformedChangeSet(registry, [{ operation: "update", path: "file.ts", content: "x", extra: 1 }]);
  await malformedChangeSet(registry, [{ operation: "update", path: "file.ts", content: "x" }, { operation: "delete", path: "file.ts" }]);
  await malformedChangeSet(registry, Array.from({ length: 26 }, (_, index) => ({ operation: "create", path: `f${index}.ts`, content: "x" })));

  // Well-formed, but wrong about the repository — the model is told which, so
  // it can retry with the right operation instead of losing the session.
  assert.match((await failedChangeSet(registry, [{ operation: "update", path: "missing.ts", content: "x" }])).message, /does not exist/u);
  assert.match((await failedChangeSet(registry, [{ operation: "create", path: "file.ts", content: "x" }])).message, /already exists/u);
  assert.equal(await readFile(join(root, "file.ts"), "utf8"), "content\n");
});

test("carries the structured rollback outcome on the error the tool itself throws", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "updated.ts"), "before\n", "utf8");

  // The registry flattens this to a message and an errorCode for the model.
  // Below that flattening the structured fields are the source that message is
  // built from, so they are pinned here — a rollback that silently reported
  // "rolled-back" when it had not is the worst failure this tool can have.
  const editor = new SafeRepositoryFileEditor();
  const tools = createRepositoryWriteTools({ repositoryId: "atlas", repositoryRoot: root }, {
    editor,
    changeSetEditor: new TransactionalRepositoryChangeSetEditor(new FailingApplyFileEditor(editor, 2)),
  });
  const input = tools.proposeChangeSet.validateInput({
    edits: [
      { operation: "update", path: "updated.ts", content: "after\n" },
      { operation: "create", path: "never.ts", content: "never\n" },
    ],
  });

  await assert.rejects(
    tools.proposeChangeSet.execute(input, { repositoryId: "atlas" }),
    (error: unknown) => error instanceof RepositoryChangeSetToolError
      && error.code === "CHANGE_SET_FAILED"
      && error.failureCode === "IO_ERROR"
      && error.rollbackStatus === "rolled-back"
      && error.rollbackFailedPaths.length === 0,
  );
  assert.equal(await readFile(join(root, "updated.ts"), "utf8"), "before\n");
});

test("policy can deny the batch write tool alongside the single-file one", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new PolicyEnforcedReadOnlyToolRegistry({
    policy: { defaultDecision: "allow", rules: [{ id: "deny-writes", capabilities: ["write"], scope: { kind: "global" }, decision: "deny" }] },
  });
  registerRepositoryWriteTools(registry, createRepositoryWriteTools(
    { repositoryId: "atlas", repositoryRoot: root },
    { editor: new SafeRepositoryFileEditor() },
  ));

  await assert.rejects(runChangeSet(registry, [{ operation: "create", path: "file.ts", content: "x" }]), /Policy denied tool/);
});
