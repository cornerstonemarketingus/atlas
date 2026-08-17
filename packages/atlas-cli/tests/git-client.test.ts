import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { GitClient } from "../src/infrastructure/git-client.js";

const execFileAsync = promisify(execFile);

async function withTemporaryDirectory(
  prefix: string,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test("distinguishes a non-Git directory from unavailable Git", async () => {
  await withTemporaryDirectory("atlas-not-git-", async (root) => {
    const summary = await new GitClient().inspect(root);

    assert.equal(summary.isAvailable, true);
    assert.equal(summary.isRepository, false);
  });

  await withTemporaryDirectory("atlas-no-git-", async (root) => {
    const summary = await new GitClient("atlas-command-that-does-not-exist").inspect(root);

    assert.equal(summary.isAvailable, false);
    assert.equal(summary.isRepository, false);
  });
});

test("recognizes an unborn Git repository", async () => {
  await withTemporaryDirectory("atlas-unborn-", async (root) => {
    await execFileAsync("git", ["init", "--quiet", root], { windowsHide: true });

    const summary = await new GitClient().inspect(root);

    assert.equal(summary.isAvailable, true);
    assert.equal(summary.isRepository, true);
    assert.equal(summary.headCommit, null);
    assert.equal(summary.isDirty, false);
  });
});

test("reports detached HEAD without losing the commit", async () => {
  await withTemporaryDirectory("atlas-detached-", async (root) => {
    await execFileAsync("git", ["init", "--quiet", root], { windowsHide: true });
    await writeFile(join(root, "tracked.txt"), "fixture\n");
    await execFileAsync("git", ["-C", root, "add", "tracked.txt"], { windowsHide: true });
    await execFileAsync(
      "git",
      [
        "-C", root,
        "-c", "user.name=Atlas Tests",
        "-c", "user.email=atlas-tests@example.invalid",
        "commit", "--quiet", "-m", "fixture",
      ],
      { windowsHide: true },
    );
    await execFileAsync("git", ["-C", root, "checkout", "--quiet", "--detach", "HEAD"], {
      windowsHide: true,
    });

    const summary = await new GitClient().inspect(root);

    assert.equal(summary.isRepository, true);
    assert.equal(summary.branch, null);
    assert.match(summary.headCommit ?? "", /^[0-9a-f]{40}$/u);
    assert.equal(summary.isDirty, false);
  });
});
