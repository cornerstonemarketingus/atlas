import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TerminalController } from "../src/platform/terminal/terminal-controller.mjs";
import { evaluateCommand } from "../src/platform/terminal/command-policy.mjs";
import { createRedactor } from "../src/platform/terminal/redaction.mjs";
import { terminalToolDefinitions } from "../src/platform/terminal/tools.mjs";

async function fixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), "atlas-terminal-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const controller = new TerminalController({ rootDirectory: join(base, "workspaces"), killGraceMs: 200, ...options });
  const workspace = controller.createWorkspace({ tenantId: "tenant-1", taskId: "task/../1" });
  return { base, controller, workspace };
}

async function run(controller, workspaceId, request) {
  const handle = await controller.runCommand(workspaceId, request);
  assert.equal(handle.status, "running", JSON.stringify(handle));
  return handle.result;
}

test("creates a 0700 workspace directly under the root, named from sanitized ids", async (t) => {
  const { controller, workspace } = await fixture(t);
  assert.match(workspace.id, /^wks_[0-9a-f]{32}$/);
  assert.equal(join(controller.rootDirectory, workspace.directory.split("/").at(-1)), workspace.directory);
  assert.match(workspace.directory, /tenant-1--task_1--[0-9a-f]{12}$/);
  if (process.platform !== "win32") assert.equal(statSync(workspace.directory).mode & 0o777, 0o700);
  assert.ok(existsSync(join(workspace.directory, ".tmp")));
});

test("template files are written inside the workspace and escapes are refused", async (t) => {
  const { controller } = await fixture(t);
  const seeded = controller.createWorkspace({ tenantId: "t", taskId: "k", template: { files: { "src/a.txt": "hello" } } });
  const result = await run(controller, seeded.id, { argv: ["cat", "src/a.txt"] });
  assert.equal(result.stdout, "hello");
  assert.throws(() => controller.createWorkspace({ tenantId: "t", taskId: "k2", template: { files: { "../../evil": "x" } } }), { code: "INVALID_TEMPLATE" });
});

test("runs node -e and captures stdout, stderr and exit code", async (t) => {
  const { controller, workspace } = await fixture(t);
  const result = await run(controller, workspace.id, { argv: ["node", "-e", "console.log('hi'); console.error('warn')"] });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "hi\n");
  assert.equal(result.stderr, "warn\n");
  assert.equal(result.timedOut, false);
  assert.equal(result.isolation.noShell, true);
  assert.equal(result.isolation.container, false);
  assert.equal(typeof result.durationMs, "number");
});

test("reports a nonzero exit code", async (t) => {
  const { controller, workspace } = await fixture(t);
  const result = await run(controller, workspace.id, { argv: ["node", "-e", "process.exit(3)"] });
  assert.equal(result.exitCode, 3);
  const falseResult = await run(controller, workspace.id, { argv: ["false"] });
  assert.equal(falseResult.exitCode, 1);
});

test("streams output events as they arrive and passes stdin", async (t) => {
  const { controller, workspace } = await fixture(t);
  const handle = await controller.runCommand(workspace.id, {
    argv: ["node", "-e", "process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase()))"],
    stdin: "piped",
  });
  const events = [];
  for await (const event of handle.events) events.push(event);
  assert.deepEqual(events.map((event) => event.stream), ["stdout"]);
  assert.equal(events.map((event) => event.chunk).join(""), "PIPED");
  assert.equal((await handle.result).stdout, "PIPED");
});

test("timeout kills a process that never exits and reports timedOut", async (t) => {
  const { controller, workspace } = await fixture(t);
  const result = await run(controller, workspace.id, { argv: ["node", "-e", "setInterval(()=>{},1000)"], timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.ok(["SIGTERM", "SIGKILL"].includes(result.signal));
  assert.ok(result.durationMs < 5000);
});

test("SIGKILL follows SIGTERM when the process ignores it", async (t) => {
  const { controller, workspace } = await fixture(t);
  const result = await run(controller, workspace.id, {
    argv: ["node", "-e", "process.on('SIGTERM', () => {}); setInterval(()=>{},1000); console.log('ready')"],
    timeoutMs: 300,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
});

test("cancel kills the process group", async (t) => {
  const { controller, workspace } = await fixture(t);
  const handle = await controller.runCommand(workspace.id, { argv: ["node", "-e", "console.log('up'); setInterval(()=>{},1000)"] });
  const iterator = handle.events[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.chunk, "up\n");
  assert.deepEqual(await controller.cancel(handle.id), { commandId: handle.id, cancelled: true });
  const result = await handle.result;
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(controller.getWorkspace(workspace.id).runningCommands, 0);
  assert.deepEqual(await controller.cancel(handle.id), { commandId: handle.id, cancelled: false });
});

test("output beyond the per-stream cap is truncated with a marker", async (t) => {
  const { controller, workspace } = await fixture(t, { maxOutputBytes: 1000 });
  const result = await run(controller, workspace.id, { argv: ["node", "-e", "process.stdout.write('x'.repeat(50000)); process.stderr.write('ok')"] });
  assert.equal(result.truncated.stdout, true);
  assert.equal(result.truncated.stderr, false);
  assert.ok(result.stdout.startsWith("x".repeat(1000)));
  assert.match(result.stdout, /\[atlas: output truncated after 1000 bytes\]/);
  assert.ok(result.stdout.length < 1100);
  assert.equal(result.stderr, "ok");
});

test("filesystem confinement: cwd escapes, outside absolute paths and .. arguments are refused", async (t) => {
  const { base, controller, workspace } = await fixture(t);
  await assert.rejects(controller.runCommand(workspace.id, { argv: ["ls"], cwd: "../.." }), { code: "CWD_OUTSIDE_WORKSPACE" });
  await assert.rejects(controller.runCommand(workspace.id, { argv: ["ls"], cwd: "/etc" }), { code: "CWD_OUTSIDE_WORKSPACE" });
  await assert.rejects(controller.runCommand(workspace.id, { argv: ["cat", "/etc/passwd"] }), { code: "PATH_OUTSIDE_WORKSPACE" });
  await assert.rejects(controller.runCommand(workspace.id, { argv: ["ls", base] }), { code: "PATH_OUTSIDE_WORKSPACE" });
  await assert.rejects(controller.runCommand(workspace.id, { argv: ["cat", "../../secret"] }), { code: "PATH_OUTSIDE_WORKSPACE" });
  await assert.rejects(controller.runCommand(workspace.id, { argv: ["grep", "--file=/etc/passwd", "x"] }), { code: "PATH_OUTSIDE_WORKSPACE" });
  await assert.rejects(
    controller.runCommand(workspace.id, { argv: ["node", "-e", "require('fs').readFileSync('/etc/passwd')"] }),
    { code: "PATH_OUTSIDE_WORKSPACE" },
  );
  await assert.rejects(controller.runCommand(workspace.id, { argv: ["rm", "-rf", "/"] }), { code: "PATH_OUTSIDE_WORKSPACE" });
  await assert.rejects(controller.runCommand(workspace.id, { argv: ["rm", "-rf", "."] }), { code: "RM_DENIED" });
  await assert.rejects(controller.runCommand(workspace.id, { argv: ["cat", "~/.ssh/id_rsa"] }), { code: "PATH_OUTSIDE_WORKSPACE" });

  // A symlink inside the workspace that points outside is followed and refused.
  await symlink("/etc", join(workspace.directory, "link"));
  await assert.rejects(controller.runCommand(workspace.id, { argv: ["cat", "link/passwd"] }), { code: "PATH_OUTSIDE_WORKSPACE" });
  await assert.rejects(controller.runCommand(workspace.id, { argv: ["ls"], cwd: "link" }), { code: "CWD_OUTSIDE_WORKSPACE" });

  // Paths inside the workspace are fine, relative and absolute.
  await mkdir(join(workspace.directory, "sub"));
  await writeFile(join(workspace.directory, "sub", "f.txt"), "inside");
  assert.equal((await run(controller, workspace.id, { argv: ["cat", "../sub/f.txt"], cwd: "sub" })).stdout, "inside");
  assert.equal((await run(controller, workspace.id, { argv: ["cat", join(workspace.directory, "sub", "f.txt")] })).stdout, "inside");
  assert.equal((await run(controller, workspace.id, { argv: ["pwd"], cwd: "sub" })).stdout.trim().endsWith("/sub"), true);
});

test("blocked executables are refused regardless of the allowlist", async (t) => {
  const { controller, workspace } = await fixture(t, { allowedExecutables: ["node", "sudo", "sh", "bash", "curl", "docker", "env"] });
  for (const executable of ["sudo", "sh", "bash", "docker", "env", "kill", "su", "mount"]) {
    await assert.rejects(controller.runCommand(workspace.id, { argv: [executable, "-c", "id"] }), { code: "EXECUTABLE_DENIED" }, executable);
  }
  await assert.rejects(controller.runCommand(workspace.id, { argv: ["curl", "https://example.com"] }), { code: "NETWORK_NOT_ENABLED" });
  await assert.rejects(controller.runCommand(workspace.id, { argv: ["/bin/sh", "-c", "id"] }), { code: "EXECUTABLE_NOT_BARE" });
  await assert.rejects(controller.runCommand(workspace.id, { argv: ["./script"] }), { code: "EXECUTABLE_NOT_BARE" });
  const { controller: defaults, workspace: other } = await fixture(t);
  await assert.rejects(defaults.runCommand(other.id, { argv: ["wget", "x"], network: true }), { code: "EXECUTABLE_NOT_ALLOWED" });
  await assert.rejects(defaults.runCommand(other.id, { argv: ["find", "."] }), { code: "EXECUTABLE_NOT_ALLOWED" });
});

test("privileged and publishing subcommands are denied", () => {
  const workspaceRoot = tmpdir();
  const check = (argv, extra = {}) => evaluateCommand({ argv, workspaceRoot, cwd: workspaceRoot, ...extra });
  assert.throws(() => check(["git", "push", "origin", "main"]), { code: "GIT_SUBCOMMAND_DENIED" });
  assert.throws(() => check(["git", "credential", "fill"]), { code: "GIT_SUBCOMMAND_DENIED" });
  assert.throws(() => check(["git", "config", "--global", "user.name", "x"]), { code: "GIT_SUBCOMMAND_DENIED" });
  assert.throws(() => check(["git", "config", "core.sshCommand", "x"]), { code: "GIT_SUBCOMMAND_DENIED" });
  assert.throws(() => check(["git", "-c", "core.pager=id", "log"]), { code: "GIT_OPTION_DENIED" });
  assert.throws(() => check(["npm", "publish"]), { code: "NPM_SUBCOMMAND_DENIED" });
  assert.throws(() => check(["npm", "install", "-g", "x"]), { code: "NPM_GLOBAL_DENIED" });
  assert.throws(() => check(["sed", "-n", "1e id", "f"]), { code: "SED_EXEC_DENIED" });
  assert.throws(() => check(["sed", "s/a/id/e", "f"]), { code: "SED_EXEC_DENIED" });
  assert.throws(() => check(["chmod", "4755", "f"], { allowedExecutables: ["chmod"] }), { code: "CHMOD_DENIED" });
  assert.equal(check(["git", "status"]).risk, "low");
  assert.equal(check(["git", "commit", "-m", "x"]).risk, "high");
  assert.equal(check(["npm", "install"]).risk, "high");
  assert.equal(check(["npm", "test"]).risk, "moderate");
  assert.equal(check(["npx", "tsc"]).risk, "high");
  assert.equal(check(["node", "-e", "1"]).risk, "moderate");
  assert.equal(check(["echo", "https://example.com/path"]).risk, "low");
});

test("high-risk commands require approval for the exact argv", async (t) => {
  const { controller, workspace } = await fixture(t);
  const pending = await controller.runCommand(workspace.id, { argv: ["git", "commit", "-m", "x"] });
  assert.equal(pending.status, "requires_approval");
  assert.equal(pending.risk, "high");
  const networked = await controller.runCommand(workspace.id, { argv: ["node", "-e", "1"], network: true });
  assert.equal(networked.status, "requires_approval");

  const seen = [];
  const approving = new TerminalController({
    rootDirectory: controller.rootDirectory,
    approve: ({ argv }) => { seen.push(argv); return argv.join(" ") === "git init --quiet ." || argv.join(" ") === "git commit --allow-empty -m approved"; },
  });
  const ws = approving.createWorkspace({ tenantId: "t", taskId: "approve" });
  assert.equal((await run(approving, ws.id, { argv: ["git", "init", "--quiet", "."] })).exitCode, 0);
  const env = { argv: ["git", "commit", "--allow-empty", "-m", "approved"] };
  // Commit needs an identity; supply it through the workspace-local config.
  await run(approving, ws.id, { argv: ["git", "config", "user.email", "atlas@example.invalid"] });
  await run(approving, ws.id, { argv: ["git", "config", "user.name", "Atlas"] });
  const committed = await run(approving, ws.id, env);
  assert.equal(committed.exitCode, 0, committed.stderr);
  const other = await approving.runCommand(ws.id, { argv: ["git", "commit", "--allow-empty", "-m", "different"] });
  assert.equal(other.status, "requires_approval");
  assert.ok(seen.some((argv) => argv.at(-1) === "different"));
});

test("the child environment is rebuilt from nothing: host secrets are not visible", async (t) => {
  const { controller, workspace } = await fixture(t);
  process.env.ATLAS_FAKE_API_KEY = "fake-secret-value-123456";
  process.env.UNRELATED_HOST_VAR = "host-only";
  t.after(() => { delete process.env.ATLAS_FAKE_API_KEY; delete process.env.UNRELATED_HOST_VAR; });
  const result = await run(controller, workspace.id, {
    argv: ["node", "-e", "console.log(JSON.stringify(process.env))"],
    env: { NODE_ENV: "test" },
  });
  const childEnv = JSON.parse(result.stdout);
  assert.equal(childEnv.ATLAS_FAKE_API_KEY, undefined);
  assert.equal(childEnv.UNRELATED_HOST_VAR, undefined);
  assert.equal(childEnv.HOME, workspace.directory);
  assert.equal(childEnv.TMPDIR, join(workspace.directory, ".tmp"));
  assert.equal(childEnv.NODE_ENV, "test");
  assert.ok(!result.stdout.includes("fake-secret-value-123456"));
  await assert.rejects(controller.runCommand(workspace.id, { argv: ["true"], env: { AWS_SECRET_ACCESS_KEY: "x" } }), { code: "ENV_KEY_NOT_ALLOWED" });
  await assert.rejects(controller.runCommand(workspace.id, { argv: ["true"], env: { NODE_OPTIONS: "--require x" } }), { code: "ENV_KEY_NOT_ALLOWED" });
});

test("secret-shaped output and known secret values are redacted", async (t) => {
  const { controller, workspace } = await fixture(t, { knownSecrets: ["hunter2-but-longer"] });
  const token = `ghp_${"a".repeat(36)}`;
  const result = await run(controller, workspace.id, { argv: ["echo", `token ${token} and hunter2-but-longer`] });
  assert.ok(!result.stdout.includes(token));
  assert.match(result.stdout, /\[redacted:github-token\]/);
  assert.match(result.stdout, /\[redacted:known-secret\]/);
  assert.equal(result.redactions, 2);
  const redact = createRedactor();
  assert.equal(redact("commit 3f786850e387550fdab836ed7e6dc881de23001b").count, 0);
  assert.match(redact("API_KEY=abcdef123456").text, /API_KEY=\[redacted:generic-secret\]/);
});

test("the per-workspace concurrency limit is enforced", async (t) => {
  const { controller, workspace } = await fixture(t, { maxConcurrentPerWorkspace: 2 });
  const forever = { argv: ["node", "-e", "setInterval(()=>{},1000)"] };
  const first = await controller.runCommand(workspace.id, forever);
  const second = await controller.runCommand(workspace.id, forever);
  await assert.rejects(controller.runCommand(workspace.id, forever), { code: "CONCURRENCY_LIMIT" });
  // Another workspace has its own budget.
  const other = controller.createWorkspace({ tenantId: "t", taskId: "other" });
  assert.equal((await run(controller, other.id, { argv: ["true"] })).exitCode, 0);
  await controller.cancel(first.id);
  await first.result;
  const third = await controller.runCommand(workspace.id, { argv: ["true"] });
  assert.equal((await third.result).exitCode, 0);
  await controller.cancel(second.id);
});

test("destroyWorkspace removes the directory and refuses a workspace swapped for an outside symlink", async (t) => {
  const { base, controller, workspace } = await fixture(t);
  const running = await controller.runCommand(workspace.id, { argv: ["node", "-e", "setInterval(()=>{},1000)"] });
  assert.deepEqual(await controller.destroyWorkspace(workspace.id), { workspaceId: workspace.id, destroyed: true });
  assert.equal((await running.result).cancelled, true);
  assert.equal(existsSync(workspace.directory), false);
  assert.throws(() => controller.getWorkspace(workspace.id), { code: "WORKSPACE_NOT_FOUND" });

  const victim = join(base, "outside");
  await mkdir(victim);
  await writeFile(join(victim, "keep.txt"), "precious");
  const swapped = controller.createWorkspace({ tenantId: "t", taskId: "swap" });
  await rm(swapped.directory, { recursive: true });
  await symlink(victim, swapped.directory);
  await assert.rejects(controller.destroyWorkspace(swapped.id), { code: "WORKSPACE_OUTSIDE_ROOT" });
  assert.equal(existsSync(join(victim, "keep.txt")), true);
});

test("isolation report states what was actually applied", async (t) => {
  const { controller, workspace } = await fixture(t);
  const result = await run(controller, workspace.id, { argv: ["true"] });
  const capabilities = controller.capabilities();
  assert.equal(result.isolation.level, "process");
  assert.equal(result.isolation.rlimits.applied, capabilities.rlimits.tool === "prlimit");
  if (result.isolation.rlimits.applied) {
    assert.equal(result.isolation.rlimits.cpuSeconds, 120);
    // The limit is really in force inside the child. (The path is assembled at
    // runtime, which also shows the argv path policy cannot see inside code.)
    const limited = await run(controller, workspace.id, {
      argv: ["node", "-e", "const p = ['', 'proc', 'self', 'limits'].join(String.fromCharCode(47)); process.stdout.write(require('fs').readFileSync(p, 'utf8'))"],
    });
    assert.match(limited.stdout, /Max cpu time\s+120\s+120/);
  } else {
    assert.equal(typeof result.isolation.rlimits.reason, "string");
  }
  const { controller: plain, workspace: plainWorkspace } = await fixture(t, { prlimit: false });
  const plainResult = await run(plain, plainWorkspace.id, { argv: ["true"] });
  assert.equal(plainResult.isolation.rlimits.applied, false);
});

test("tool definitions declare strict schemas and validate input before acting", async (t) => {
  const { controller } = await fixture(t);
  const tools = Object.fromEntries(terminalToolDefinitions(controller).map((tool) => [tool.name, tool]));
  assert.deepEqual(Object.keys(tools).sort(), ["terminal.cancel", "terminal.create_workspace", "terminal.destroy_workspace", "terminal.run_command"]);
  for (const tool of Object.values(tools)) assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  assert.equal(tools["terminal.run_command"].consequential, true);
  assert.equal(tools["terminal.cancel"].risk, "low");

  const workspace = await tools["terminal.create_workspace"].execute({ tenantId: "t", taskId: "tool" });
  const result = await tools["terminal.run_command"].execute({ workspaceId: workspace.id, argv: ["node", "-e", "console.log(40+2)"] });
  assert.equal(result.status, "completed");
  assert.equal(result.stdout, "42\n");

  await assert.rejects(tools["terminal.run_command"].execute({ workspaceId: workspace.id, argv: ["ls"], shell: true }), { code: "SCHEMA_VIOLATION" });
  await assert.rejects(tools["terminal.run_command"].execute({ workspaceId: workspace.id, argv: "ls -la" }), { code: "SCHEMA_VIOLATION" });
  await assert.rejects(tools["terminal.run_command"].execute({ workspaceId: "../etc", argv: ["ls"] }), { code: "SCHEMA_VIOLATION" });
  await assert.rejects(tools["terminal.run_command"].execute({ workspaceId: workspace.id, argv: ["ls"], env: { SECRET: "x" } }), { code: "SCHEMA_VIOLATION" });
  await assert.rejects(tools["terminal.create_workspace"].execute({ tenantId: "t" }), { code: "SCHEMA_VIOLATION" });
  await assert.rejects(tools["terminal.cancel"].execute({ commandId: "nope" }), { code: "SCHEMA_VIOLATION" });

  const approval = await tools["terminal.run_command"].execute({ workspaceId: workspace.id, argv: ["npm", "install"] });
  assert.equal(approval.status, "requires_approval");
  assert.deepEqual(await tools["terminal.destroy_workspace"].execute({ workspaceId: workspace.id }), { workspaceId: workspace.id, destroyed: true });
});
