import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ContainerValidationProfileRunner, snapshotRepository, type ContainerAdapter } from "../src/infrastructure/container-validation-runner.js";
import type { SafeCommandRequest, SafeCommandResult } from "../src/domain/safe-command-runner.js";

const helper = await import(new URL("../../../../apps/local-control/src/platform/terminal/container-sandbox.mjs", import.meta.url).href);
const success: SafeCommandResult = { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: false, truncated: false, durationMs: 1 };
const profile = { id: "test", kind: "test" as const, executable: "npm", args: ["test"] };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "atlas-container-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "repository");
  await mkdir(source);
  await writeFile(join(source, "source.txt"), "before");
  return { root, source };
}

async function fakeRunner(source: string, run: (request: SafeCommandRequest, workspace: string) => Promise<SafeCommandResult> = async () => success, cleanup = true, installDependencies = false) {
  const calls: SafeCommandRequest[] = [];
  const workspaces: string[] = [];
  const removed: string[] = [];
  const adapter: ContainerAdapter = {
    resolveContainerSandbox: ({ runtime, image }) => ({ runtime, image, cpus: 2, memoryBytes: 2 * 1024 ** 3, pidsLimit: 256, tmpfsBytes: 64 * 1024 ** 2 }),
    containerRunArguments: helper.containerRunArguments,
    killContainer: (_sandbox, name) => { removed.push(name); return cleanup; },
  };
  const runner = await ContainerValidationProfileRunner.create({ repositoryRoot: source, runtime: process.execPath, packageManager: "npm", timeoutMs: 1000, installDependencies }, {
    adapter,
    runner: (workspace) => ({ run: async (request) => { calls.push(request); workspaces.push(workspace); return run(request, workspace); } }),
  });
  return { runner, calls, workspaces, removed };
}

test("validation uses existing container policy, offline network, quotas and no caller secrets", async (t) => {
  const { source } = await fixture(t);
  const { runner, calls, removed, workspaces } = await fakeRunner(source);
  const report = await runner.run({ label: "baseline", profiles: [profile] });
  assert.equal(report.observations[0]?.outcome, "passed");
  const args = calls[0]!.args!;
  for (const flag of ["--read-only", "--cap-drop", "--security-opt", "--memory", "--cpus", "--pids-limit", "--rm"]) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args[args.indexOf("--cap-drop") + 1], "ALL");
  assert.equal(args[args.indexOf("--security-opt") + 1], "no-new-privileges");
  assert.equal(args.filter((arg) => arg === "--mount").length, 1);
  assert.match(args[args.indexOf("--mount") + 1]!, /target=\/workspace$/u);
  assert.ok(!args.join(" ").includes(source));
  assert.equal(calls[0]!.environment, undefined);
  assert.deepEqual(args.slice(-3), ["node:22-bookworm-slim", "npm", "test"]);
  assert.equal(removed.length, 1);
  await assert.rejects(access(workspaces[0]!));
});

test("test writes stay in the disposable copy and each phase receives current coder changes", async (t) => {
  const { source } = await fixture(t);
  const contents: string[] = [];
  const { runner } = await fakeRunner(source, async (_request, workspace) => {
    contents.push(await readFile(join(workspace, "source.txt"), "utf8"));
    await writeFile(join(workspace, "source.txt"), "test mutation");
    await writeFile(join(workspace, "injected.txt"), "not a coder edit");
    return success;
  });
  await runner.run({ label: "baseline", profiles: [profile] });
  assert.equal(await readFile(join(source, "source.txt"), "utf8"), "before");
  await assert.rejects(access(join(source, "injected.txt")));
  await writeFile(join(source, "source.txt"), "coder edit");
  await runner.run({ label: "post-change", profiles: [profile] });
  assert.deepEqual(contents, ["before", "coder edit"]);
});

test("snapshot excludes Git metadata, Atlas checkpoints and outside symlinks", async (t) => {
  const { root, source } = await fixture(t);
  await mkdir(join(source, ".git"));
  await writeFile(join(source, ".git", "config"), "credential");
  await mkdir(join(source, ".atlas"));
  const copy = join(root, "copy");
  await snapshotRepository(source, copy);
  await assert.rejects(access(join(copy, ".git")));
  await assert.rejects(access(join(copy, ".atlas")));
  if (process.platform === "win32") return; // Separate symlink test runs on Linux CI.
  await writeFile(join(root, "secret"), "host secret");
  await symlink(join(root, "secret"), join(source, "outside"));
  await symlink("source.txt", join(source, "internal"));
  const copy2 = join(root, "copy2");
  await snapshotRepository(source, copy2);
  await assert.rejects(access(join(copy2, "outside")));
  assert.equal(await readFile(join(copy2, "internal"), "utf8"), "before");
});

test("path traversal, environment injection and unapproved executables never reach Docker", async (t) => {
  const { source } = await fixture(t);
  const { runner, calls } = await fakeRunner(source);
  const report = await runner.run({ label: "baseline", profiles: [
    { ...profile, id: "traversal", cwd: "../" },
    { ...profile, id: "environment", environment: { GROQ_API_KEY: "credential" } },
    { ...profile, id: "executable", executable: "sh" },
  ] });
  assert.deepEqual(report.observations.map((result) => result.outcome), ["execution-failed", "execution-failed", "execution-failed"]);
  assert.equal(calls.length, 0);
});

test("timeout, cancellation and spawn failure clean up both container and snapshot", async (t) => {
  for (const outcome of ["timeout", "cancel", "spawn"] as const) {
    const { source } = await fixture(t);
    const { runner, removed, workspaces } = await fakeRunner(source, async () => {
      if (outcome === "spawn") throw new Error("Docker unavailable");
      return { ...success, exitCode: null, timedOut: outcome === "timeout", cancelled: outcome === "cancel" };
    });
    const report = await runner.run({ label: "baseline", profiles: [profile] });
    assert.equal(report.observations[0]?.outcome, outcome === "cancel" ? "cancelled" : "execution-failed");
    assert.equal(removed.length, 1);
    await assert.rejects(access(workspaces[0]!));
  }
});

test("cleanup failure cannot yield a passing validation receipt", async (t) => {
  const { source } = await fixture(t);
  const { runner } = await fakeRunner(source, async (request) => request.args?.[0] === "container" ? { ...success, stdout: "still-running" } : success, false);
  await assert.rejects(runner.run({ label: "baseline", profiles: [profile] }), /cleanup could not be confirmed/);
  await assert.rejects(runner.run({ label: "baseline", profiles: [profile] }), /cleanup could not be confirmed/);
});

test("dependency installation is sandboxed and enables networking only for fixed script-free npm ci", async (t) => {
  const { source } = await fixture(t);
  const { runner, calls } = await fakeRunner(source, async () => success, true, true);
  await runner.run({ label: "baseline", profiles: [profile] });
  assert.equal(calls.length, 2);
  const installArgs = calls[0]!.args!;
  assert.deepEqual(installArgs.slice(-6), ["node:22-bookworm-slim", "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  assert.equal(installArgs[installArgs.indexOf("--network") + 1], "bridge");
  const testArgs = calls[1]!.args!;
  assert.equal(testArgs[testArgs.indexOf("--network") + 1], "none");
});

test("dependency provisioning failure stops before repository tests and removes scratch state", async (t) => {
  const { source } = await fixture(t);
  const { runner, calls, workspaces } = await fakeRunner(source, async () => ({ ...success, exitCode: 1 }), true, true);
  await assert.rejects(runner.run({ label: "baseline", profiles: [profile] }), /dependency provisioning failed/);
  assert.equal(calls.length, 1);
  await assert.rejects(access(workspaces[0]!));
});

test("missing runtime fails closed before commands can run", async (t) => {
  const { source } = await fixture(t);
  await assert.rejects(ContainerValidationProfileRunner.create({ repositoryRoot: source, runtime: join(source, "missing-docker"), packageManager: "npm", timeoutMs: 1000 }), /not installed|not executable/u);
});

test("Docker startup and resource errors are infrastructure failures, never baseline test failures", async (t) => {
  const { source } = await fixture(t);
  for (const exitCode of [125, 126, 127, 134, 137, 143]) {
    const { runner } = await fakeRunner(source, async () => ({ ...success, exitCode }));
    const report = await runner.run({ label: "baseline", profiles: [profile] });
    assert.equal(report.observations[0]?.outcome, "execution-failed");
  }
});

test("snapshot cancellation stops before execution", async (t) => {
  const { source } = await fixture(t);
  const { runner, calls } = await fakeRunner(source);
  await assert.rejects(runner.run({ label: "baseline", profiles: [profile], signal: AbortSignal.abort() }), /cancelled/u);
  assert.equal(calls.length, 0);
});

const runtime = process.env["ATLAS_TEST_CONTAINER_RUNTIME"];
test("real container prevents host access, credentials, networking and source mutation", { skip: !runtime }, async (t) => {
  const { root, source } = await fixture(t);
  await writeFile(join(root, "secret"), "host-only");
  await writeFile(join(source, "check.mjs"), `
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os';
    assert.equal(fs.existsSync(${JSON.stringify(join(root, "secret"))}), false);
    assert.equal(fs.existsSync('/workspace/.git'), false);
    assert.equal(process.env.GROQ_API_KEY, undefined); assert.equal(process.env.GITHUB_TOKEN, undefined);
    assert.equal(Object.values(os.networkInterfaces()).flat().filter(x => !x.internal).length, 0);
    fs.writeFileSync('/workspace/source.txt', 'sandbox edit');
  `);
  const runner = await ContainerValidationProfileRunner.create({ repositoryRoot: source, runtime: runtime!, packageManager: "node", timeoutMs: 10_000 });
  const report = await runner.run({ label: "baseline", profiles: [{ ...profile, executable: "node", args: ["check.mjs"] }] });
  assert.equal(report.observations[0]?.outcome, "passed", JSON.stringify(report));
  assert.equal(await readFile(join(source, "source.txt"), "utf8"), "before");
});

test("real container memory exhaustion is an infrastructure failure, not baseline assertion evidence", { skip: !runtime }, async (t) => {
  const { source } = await fixture(t);
  // More than the 2 GiB RAM limit plus Docker's default swap allowance.
  // Allocations happen only in the container, never in the trusted test worker.
  await writeFile(join(source, "exhaust.mjs"), "const kept = []; for (let i = 0; i < 192; i++) kept.push(Buffer.alloc(32 * 1024 * 1024, 1));");
  const runner = await ContainerValidationProfileRunner.create({ repositoryRoot: source, runtime: runtime!, packageManager: "node", timeoutMs: 30_000 });
  const report = await runner.run({ label: "baseline", profiles: [{ ...profile, executable: "node", args: ["exhaust.mjs"] }] });
  assert.equal(report.observations[0]?.outcome, "execution-failed", JSON.stringify(report));
  assert.equal(report.observations[0]?.diagnostics[0]?.code, "command-execution-failed", "the container was killed by its memory quota, not just the timeout");
});
