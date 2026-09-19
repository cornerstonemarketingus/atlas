import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentSessionStore } from "../src/agent/session-store.mjs";
import { AgentRuntime } from "../src/agent/runtime.mjs";
import { createLocalExecutor } from "../src/agent/executors.mjs";
import { runIsolatedLocalCoder } from "../src/runner.mjs";

const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
};

async function repository(t) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-worktree-"));
  const checkout = join(directory, "checkout");
  git(directory, "init", "--quiet", "checkout");
  git(checkout, "config", "user.email", "atlas@example.invalid");
  git(checkout, "config", "user.name", "Atlas");
  await writeFile(join(checkout, "README.md"), "# Project\n", "utf8");
  git(checkout, "add", "README.md");
  git(checkout, "commit", "--quiet", "-m", "Initial commit");
  t.after(async () => {
    // Detach the worktree metadata before the temp directory disappears.
    spawnSync("git", ["worktree", "prune"], { cwd: checkout });
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, checkout };
}

test("a real run happens in an isolated worktree and leaves the checkout untouched", async (t) => {
  const { directory, checkout } = await repository(t);
  const dataDirectory = join(directory, "data");

  const result = await runIsolatedLocalCoder(
    { id: "task-1", repository: checkout, objective: "Add a note.", model: "local" },
    {
      dataDirectory,
      runCoder: async (task) => {
        // The coder only ever sees the worktree, never the operator's checkout.
        assert.notEqual(task.repository, checkout);
        await writeFile(join(task.repository, "NOTES.md"), "Written by Atlas.\n", "utf8");
        return { ok: true, message: "Edited NOTES.md." };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.ok(existsSync(result.worktree), "the isolated worktree exists");
  assert.equal(existsSync(join(checkout, "NOTES.md")), false, "the operator's checkout was not modified");
  assert.equal(git(checkout, "status", "--porcelain").trim(), "", "the operator's checkout is still clean");

  assert.ok(result.patch, "a portable patch was written");
  const patch = await readFile(result.patch, "utf8");
  assert.match(patch, /NOTES\.md/u);
  assert.match(patch, /Written by Atlas\./u);
  assert.ok(result.patchBytes > 0);
});

test("the runtime drives a real worktree run and records the patch as an artifact", async (t) => {
  const { directory, checkout } = await repository(t);
  const dataDirectory = join(directory, "data");
  const sessions = new AgentSessionStore(join(directory, "agent.sqlite"));
  const runtime = new AgentRuntime({
    sessions,
    executors: {
      local: createLocalExecutor({
        dataDirectory,
        runCoder: (task, options) =>
          runIsolatedLocalCoder(task, {
            ...options,
            runCoder: async (inner) => {
              await writeFile(join(inner.repository, "CHANGELOG.md"), "- Added by Atlas\n", "utf8");
              return { ok: true, message: "Added a changelog entry." };
            },
          }),
      }),
    },
  });
  t.after(async () => { await runtime.stop(); sessions.close(); });

  const session = runtime.createSession({ title: "Changelog", repository: checkout, model: "qwen2.5-coder:7b" });
  runtime.submitTurn(session.id, { text: "Add a changelog entry." });
  await runtime.drain();

  assert.equal(runtime.getSession(session.id).status, "completed");
  const events = runtime.getEvents(session.id);
  const artifact = events.find((event) => event.kind === "artifact");
  assert.ok(artifact, "the run produced an artifact receipt");
  assert.match(await readFile(artifact.data.path, "utf8"), /CHANGELOG\.md/u);
  assert.equal(git(checkout, "status", "--porcelain").trim(), "", "the operator's checkout is still clean");
  // The receipt names where the patch is; it never carries the contents.
  assert.equal("content" in artifact.data, false);
});

test("a run against a directory that is not a Git work tree fails without touching it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-not-git-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const result = await runIsolatedLocalCoder(
    { id: "task-2", repository: directory, objective: "x", model: "local" },
    { dataDirectory: join(directory, "data"), runCoder: async () => assert.fail("the coder must not run") },
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /not a Git work tree/u);
});
