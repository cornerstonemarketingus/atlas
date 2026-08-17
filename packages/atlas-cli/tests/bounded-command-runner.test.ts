import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SafeCommandError } from "../src/domain/safe-command-runner.js";
import { BoundedCommandRunner } from "../src/infrastructure/bounded-command-runner.js";

async function fixture(options: Record<string, unknown> = {}): Promise<{
  root: string;
  runner: BoundedCommandRunner;
}> {
  const root = await mkdtemp(join(tmpdir(), "atlas-command-"));
  return {
    root,
    runner: new BoundedCommandRunner({
      repositoryRoot: root,
      allowedExecutables: [process.execPath],
      timeoutMs: 2_000,
      ...options,
    }),
  };
}

test("passes arguments without shell interpretation and uses a contained cwd", async () => {
  const { root, runner } = await fixture();
  await mkdir(join(root, "nested"));
  const result = await runner.run({
    executable: process.execPath,
    args: ["-e", "console.log(JSON.stringify({arg:process.argv[1],cwd:process.cwd()}))", "a && b"],
    cwd: "nested",
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { arg: "a && b", cwd: join(root, "nested") });
});

test("rejects disallowed executables and working-directory escape attempts", async () => {
  const { runner } = await fixture();
  await assert.rejects(
    runner.run({ executable: "definitely-not-allowed" }),
    (error: unknown) => error instanceof SafeCommandError && error.code === "executable-not-allowed",
  );
  await assert.rejects(
    runner.run({ executable: process.execPath, cwd: ".." }),
    (error: unknown) => error instanceof SafeCommandError && error.code === "cwd-outside-repository",
  );
});

test("rejects a symbolic-link working directory", async (context) => {
  const { root, runner } = await fixture();
  const target = join(root, "target");
  await mkdir(target);
  try {
    await symlink(target, join(root, "linked"), "junction");
  } catch (error) {
    context.skip(`Symlinks unavailable: ${String(error)}`);
    return;
  }
  await assert.rejects(
    runner.run({ executable: process.execPath, cwd: "linked" }),
    (error: unknown) => error instanceof SafeCommandError && error.code === "cwd-is-symlink",
  );
});

test("passes only explicitly inherited or allowlisted environment variables", async () => {
  const previous = process.env["ATLAS_SECRET_TEST"];
  process.env["ATLAS_SECRET_TEST"] = "secret";
  try {
    const { runner } = await fixture({
      allowedEnvironmentVariables: ["ATLAS_SAFE"],
      inheritedEnvironmentVariables: ["PATH"],
    });
    const result = await runner.run({
      executable: process.execPath,
      args: ["-e", "console.log(JSON.stringify({safe:process.env.ATLAS_SAFE,secret:process.env.ATLAS_SECRET_TEST}))"],
      environment: { ATLAS_SAFE: "visible" },
    });
    assert.deepEqual(JSON.parse(result.stdout.trim()), { safe: "visible" });
    await assert.rejects(
      runner.run({ executable: process.execPath, environment: { ATLAS_SECRET_TEST: "no" } }),
      (error: unknown) => error instanceof SafeCommandError && error.code === "environment-not-allowed",
    );
  } finally {
    if (previous === undefined) delete process.env["ATLAS_SECRET_TEST"];
    else process.env["ATLAS_SECRET_TEST"] = previous;
  }
});

test("classifies timeout and cancellation and cleans up the child", async () => {
  const { root } = await fixture();
  const timeoutRunner = new BoundedCommandRunner({
    repositoryRoot: root,
    allowedExecutables: [process.execPath],
    timeoutMs: 50,
  });
  const timedOut = await timeoutRunner.run({ executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] });
  assert.equal(timedOut.timedOut, true);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const cancelled = await new BoundedCommandRunner({
    repositoryRoot: root,
    allowedExecutables: [process.execPath],
    timeoutMs: 2_000,
  }).run({ executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], signal: controller.signal });
  assert.equal(cancelled.cancelled, true);
});

test("bounds stream and combined output and marks truncation", async () => {
  const { runner } = await fixture({ maxStdoutBytes: 16, maxStderrBytes: 16, maxCombinedOutputBytes: 20 });
  const result = await runner.run({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(10000))"],
  });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 16);
});
