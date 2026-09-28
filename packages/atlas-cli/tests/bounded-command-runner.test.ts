import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SafeCommandError } from "../src/domain/safe-command-runner.js";
import { BoundedCommandRunner } from "../src/infrastructure/bounded-command-runner.js";

/** Running, as opposed to gone or a zombie waiting for a parent to reap it (killed all the same). */
async function running(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); } catch { return false; }
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  return stat === null ? true : stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
}

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

test("keeps the start and end of long output, marks the gap, and lets the command finish", async () => {
  const { runner } = await fixture({ maxStdoutBytes: 16, maxStderrBytes: 16, maxCombinedOutputBytes: 20 });
  const result = await runner.run({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('START' + 'x'.repeat(10000) + 'END'); process.exitCode = 3"],
  });
  assert.equal(result.truncated, true);
  assert.equal(result.exitCode, 3, "the command ran to completion rather than being killed");
  assert.match(result.stdout, /^START/);
  assert.match(result.stdout, /END$/);
  const [head, tail] = result.stdout.split(/\n\[\.\.\. \d+ bytes of output omitted \.\.\.\]\n/);
  assert.ok(tail !== undefined, "the omission is marked");
  assert.ok(Buffer.byteLength(head!) + Buffer.byteLength(tail) <= 10, "stdout keeps its share of the combined limit");
  assert.equal(result.stdout.match(/(\d+) bytes/)?.[1], String(10008 - 10));
});

test("output within the limits is returned whole and unmarked", async () => {
  const { runner } = await fixture({ maxStdoutBytes: 64, maxStderrBytes: 64, maxCombinedOutputBytes: 128 });
  const result = await runner.run({ executable: process.execPath, args: ["-e", "process.stdout.write('ok\\n'); process.stderr.write('warn')"] });
  assert.equal(result.truncated, false);
  assert.equal(result.stdout, "ok\n");
  assert.equal(result.stderr, "warn");
});

test("a timeout stops the processes the command started, not only the command", { skip: process.platform === "win32" }, async () => {
  const { root } = await fixture();
  const marker = join(root, "grandchild.pid");
  const runner = new BoundedCommandRunner({ repositoryRoot: root, allowedExecutables: [process.execPath], timeoutMs: 300 });
  // The command starts a grandchild that shares its output pipe and outlives it by far.
  const script = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'inherit' });",
    `fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));`,
    "setTimeout(()=>{}, 30000);",
  ].join("\n");
  const started = Date.now();
  const result = await runner.run({ executable: process.execPath, args: ["-e", script] });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5_000, `returned after ${Date.now() - started} ms`);
  const grandchild = Number(await readFile(marker, "utf8"));
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(await running(grandchild), false, "the grandchild was stopped too");
});

test("a finished command's leftover background processes are stopped", { skip: process.platform === "win32" }, async () => {
  const { root, runner } = await fixture();
  const marker = join(root, "daemon.pid");
  const script = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));`,
    "child.unref();",
  ].join("\n");
  const result = await runner.run({ executable: process.execPath, args: ["-e", script] });
  assert.equal(result.exitCode, 0);
  const daemon = Number(await readFile(marker, "utf8"));
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(await running(daemon), false);
});
