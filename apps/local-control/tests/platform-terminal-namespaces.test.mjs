import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chownSync, existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { TerminalController } from "../src/platform/terminal/terminal-controller.mjs";
import {
  NamespaceSandboxError, namespaceRunArguments, resolveNamespaceSandbox,
} from "../src/platform/terminal/namespace-sandbox.mjs";
import { EngineeringWorkflow, createTerminalCommandRunner } from "../src/platform/engineering/index.mjs";

// §19 Terminal — Linux namespace runner. Behaviour tests run only where
// resolution succeeds; resolution itself runs a probe inside real namespaces.
let skipNamespaces = false;
try {
  resolveNamespaceSandbox(true);
} catch (error) {
  skipNamespaces = `namespace isolation unavailable here: ${error.message}`;
}

// A probe script is seeded into the workspace and handed its targets on stdin,
// so the argv path policy (which would refuse outside paths) is not what stops
// these attempts — the sandbox is.
const PROBE = `
const fs = require("fs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const out = {};
const attempt = (label, fn) => { try { out[label] = { ok: true, value: fn() }; } catch (e) { out[label] = { ok: false, code: e.code || e.message }; } };
(async () => {
  for (const op of input.ops) {
    if (op.kind === "write") attempt(op.label, () => fs.writeFileSync(op.path, "x"));
    if (op.kind === "exists") attempt(op.label, () => fs.existsSync(op.path));
    if (op.kind === "chown") attempt(op.label, () => fs.chownSync(op.path, 0, 0));
    if (op.kind === "setuid") attempt(op.label, () => process.setuid(0));
    if (op.kind === "kill") attempt(op.label, () => process.kill(op.pid, 0));
    if (op.kind === "spawn") attempt(op.label, () => { const r = require("child_process").spawnSync(op.file, op.args, { encoding: "utf8" }); return { status: r.status, stderr: (r.stderr || "").slice(0, 200) }; });
    if (op.kind === "connect") out[op.label] = await new Promise((resolve) => {
      const socket = require("net").connect({ host: op.host, port: op.port });
      socket.setTimeout(2000, () => { socket.destroy(); resolve({ ok: false, code: "TIMEOUT" }); });
      socket.on("connect", () => { socket.end(); resolve({ ok: true }); });
      socket.on("error", (e) => resolve({ ok: false, code: e.code }));
    });
  }
  const status = fs.readFileSync("/proc/self/status", "utf8");
  out.self = {
    uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(), pid: process.pid,
    procPids: fs.readdirSync("/proc").filter((n) => /^[0-9]+$/.test(n)).map(Number),
    noNewPrivs: /NoNewPrivs:\\s+1/.test(status), capEff: status.match(/CapEff:\\s+(\\S+)/)[1],
    interfaces: Object.keys(require("os").networkInterfaces()),
  };
  process.stdout.write(JSON.stringify(out));
})();
`;

const SPAWNER = `
const { spawn } = require("child_process");
const fs = require("fs");
// A grandchild in its own session and process group: a plain group kill
// would miss it; tearing down the PID namespace must not.
spawn(process.execPath, ["-e", "setInterval(() => require('fs').appendFileSync('beat', '.'), 40)"], { detached: true, stdio: "ignore" }).unref();
setInterval(() => {}, 1000);
`;

async function fixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), "atlas-sandbox-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const controller = new TerminalController({ rootDirectory: join(base, "workspaces"), killGraceMs: 200, namespaces: true, ...options });
  const workspace = controller.createWorkspace({ tenantId: "tenant-1", taskId: "task-1", template: { files: { "probe.js": PROBE, "spawner.js": SPAWNER } } });
  return { base, controller, workspace };
}

async function run(controller, workspaceId, request) {
  const handle = await controller.runCommand(workspaceId, request);
  assert.equal(handle.status, "running", JSON.stringify(handle));
  return handle.result;
}

async function probe(controller, workspace, ops, extra = {}) {
  const result = await run(controller, workspace.id, { argv: ["node", "probe.js"], stdin: JSON.stringify({ ops }), ...extra });
  assert.equal(result.exitCode, 0, result.stderr);
  return { result, out: JSON.parse(result.stdout) };
}

async function hostServer(t) {
  let connections = 0;
  const server = createServer((socket) => { connections += 1; socket.end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, connections: () => connections };
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// namespaces backend

test("namespaces: runs the command and reports exactly what was applied", { skip: skipNamespaces }, async (t) => {
  const { controller, workspace } = await fixture(t);
  const result = await run(controller, workspace.id, { argv: ["node", "-e", "console.log('hi'); console.error('warn')"] });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, "hi\n");
  assert.equal(result.stderr, "warn\n");
  const { isolation } = result;
  assert.equal(isolation.level, "namespaces");
  assert.equal(isolation.network, "none");
  assert.equal(isolation.pid, "isolated");
  assert.equal(isolation.fs, "readonly-root");
  assert.equal(isolation.user.uid, 65534);
  assert.equal(isolation.noNewPrivs, true);
  assert.equal(isolation.container, false);
    assert.equal(controller.capabilities().networkIsolation, true);
});

test("namespaces: network is blocked — a host TCP server is unreachable", { skip: skipNamespaces }, async (t) => {
  const server = await hostServer(t);
  const { controller, workspace } = await fixture(t);
  const { out } = await probe(controller, workspace, [{ kind: "connect", label: "host", host: "127.0.0.1", port: server.port }]);
  assert.equal(out.host.ok, false);
  assert.match(out.host.code, /ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|TIMEOUT/);
  assert.equal(server.connections(), 0);
  assert.deepEqual(out.self.interfaces, []);
});

test("namespaces: network: true falls back to the host network only with approval, and says so", { skip: skipNamespaces }, async (t) => {
  const server = await hostServer(t);
  const requests = [];
  const { controller, workspace } = await fixture(t, { approve: (request) => { requests.push(request); return true; } });
  const { result, out } = await probe(controller, workspace, [{ kind: "connect", label: "host", host: "127.0.0.1", port: server.port }], { network: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].risk, "high");
  assert.equal(out.host.ok, true);
  assert.equal(result.isolation.network, "host");
  
  const { controller: strict, workspace: strictWorkspace } = await fixture(t);
  const refused = await strict.runCommand(strictWorkspace.id, { argv: ["node", "probe.js"], network: true, stdin: "{}" });
  assert.equal(refused.status, "requires_approval");
});

test("namespaces: PID namespace — the child sees only its own processes", { skip: skipNamespaces }, async (t) => {
  const { controller, workspace } = await fixture(t);
  const { out } = await probe(controller, workspace, [{ kind: "kill", label: "host", pid: process.pid }]);
  assert.ok(out.self.pid < 20, `pid ${out.self.pid}`);
  assert.ok(out.self.procPids.length < 10, `visible pids: ${out.self.procPids}`);
  assert.ok(out.self.procPids.includes(1));
  // Signalling the test runner's host pid fails: it does not exist in there
  // (or, if the number happens to be reused inside, it is not the runner).
  if (!out.self.procPids.includes(process.pid)) assert.equal(out.host.code, "ESRCH");
});

test("namespaces: writes outside the workspace fail; /tmp is private; siblings are invisible", { skip: skipNamespaces }, async (t) => {
  const { controller, workspace } = await fixture(t);
  const sibling = controller.createWorkspace({ tenantId: "tenant-2", taskId: "other" });
  const { out } = await probe(controller, workspace, [
    { kind: "write", label: "etc", path: "/etc/atlas-sandbox-test" },
    { kind: "write", label: "usr", path: "/usr/atlas-sandbox-test" },
    { kind: "write", label: "rootHome", path: "/root/atlas-sandbox-test" },
    { kind: "write", label: "sibling", path: join(sibling.directory, "stolen") },
    { kind: "exists", label: "siblingVisible", path: sibling.directory },
    { kind: "write", label: "tmp", path: "/tmp/atlas-sandbox-private" },
    { kind: "write", label: "workspace", path: join(workspace.directory, "made-inside.txt") },
  ]);
  assert.equal(out.etc.ok, false);
  assert.match(out.etc.code, /EROFS|EACCES/);
  assert.equal(out.usr.ok, false);
  assert.equal(out.rootHome.ok, false);
  assert.equal(out.sibling.ok, false);
  assert.equal(out.siblingVisible.value, false);
  assert.equal(out.tmp.ok, true);
  assert.equal(existsSync("/tmp/atlas-sandbox-private"), false, "the child's /tmp write must not reach the host /tmp");
  assert.equal(out.workspace.ok, true);
  assert.equal(existsSync(join(sibling.directory, "stolen")), false);
  assert.equal(existsSync("/etc/atlas-sandbox-test"), false);
  const made = statSync(join(workspace.directory, "made-inside.txt"));
  if (process.getuid() === 0) assert.equal(made.uid, 65534);
});

test("namespaces: the command runs as an unprivileged uid with no capabilities and no_new_privs", { skip: skipNamespaces }, async (t) => {
  const { controller, workspace } = await fixture(t);
  const { out } = await probe(controller, workspace, []);
  assert.equal(out.self.uid, 65534);
  assert.equal(out.self.gid, 65534);
  assert.ok(out.self.groups.every((gid) => gid === 65534), `groups ${out.self.groups}`);
  assert.equal(out.self.noNewPrivs, true);
  assert.equal(BigInt(`0x${out.self.capEff}`), 0n);
});

test("namespaces: privileged operations fail inside (mount, chown to root, setuid, hostname)", { skip: skipNamespaces }, async (t) => {
  const { controller, workspace } = await fixture(t);
  const target = join(workspace.directory, "probe.js");
  const mountBin = ["/usr/bin/mount", "/bin/mount"].find((path) => existsSync(path));
  const hostnameBin = ["/usr/bin/hostname", "/bin/hostname"].find((path) => existsSync(path));
  const ops = [
    { kind: "chown", label: "chown", path: target },
    { kind: "setuid", label: "setuid" },
    { kind: "write", label: "sysctl", path: "/proc/sys/kernel/hostname" },
  ];
  if (mountBin) ops.push({ kind: "spawn", label: "mount", file: mountBin, args: ["-t", "tmpfs", "none", join(workspace.directory, ".tmp")] });
  if (hostnameBin) ops.push({ kind: "spawn", label: "hostname", file: hostnameBin, args: ["pwned"] });
  const { out } = await probe(controller, workspace, ops);
  assert.equal(out.chown.ok, false);
  assert.equal(out.chown.code, "EPERM");
  assert.equal(out.setuid.ok, false);
  assert.equal(out.sysctl.ok, false);
  if (mountBin) assert.notEqual(out.mount.value.status, 0, "mount must fail");
  if (hostnameBin) assert.notEqual(out.hostname.value.status, 0, "hostname must fail");
  assert.equal(statSync(target).uid === 0 && process.getuid() !== 0, false);
});


async function assertHeartbeatStops(workspace) {
  const beat = join(workspace.directory, "beat");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const before = existsSync(beat) ? readFileSync(beat).length : 0;
  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = existsSync(beat) ? readFileSync(beat).length : 0;
  assert.equal(after, before, "a process inside the namespace kept running after the command ended");
}

test("namespaces: timeout kills the whole namespace, including detached grandchildren", { skip: skipNamespaces }, async (t) => {
  const { controller, workspace } = await fixture(t);
  const result = await run(controller, workspace.id, { argv: ["node", "spawner.js"], timeoutMs: 800 });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.ok(["SIGTERM", "SIGKILL"].includes(result.signal), `signal ${result.signal}`);
  assert.ok(existsSync(join(workspace.directory, "beat")), "the grandchild should have started");
  await assertHeartbeatStops(workspace);
});

test("namespaces: cancel kills the whole namespace", { skip: skipNamespaces }, async (t) => {
  const { controller, workspace } = await fixture(t);
  const handle = await controller.runCommand(workspace.id, { argv: ["node", "spawner.js"], timeoutMs: 30_000 });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual(await controller.cancel(handle.id), { commandId: handle.id, cancelled: true });
  const result = await handle.result;
  assert.equal(result.cancelled, true);
  assert.ok(result.durationMs < 5_000);
  await assertHeartbeatStops(workspace);
});

test("namespaces: rlimits still apply inside the namespace", { skip: skipNamespaces }, async (t) => {
  const { controller, workspace } = await fixture(t);
  const result = await run(controller, workspace.id, {
    argv: ["node", "-e", "process.stdout.write(require('fs').readFileSync(['', 'proc', 'self', 'limits'].join(String.fromCharCode(47)), 'utf8'))"],
  });
  if (controller.capabilities().rlimits.tool === "prlimit") {
    assert.equal(result.isolation.rlimits.applied, true);
    assert.match(result.stdout, /Max cpu time\s+120\s+120/);
  }
});

const HERE = fileURLToPath(new URL(".", import.meta.url));
const USERNS_SCRIPT = `
const { TerminalController } = await import(${JSON.stringify(join(HERE, "../src/platform/terminal/terminal-controller.mjs"))});
const root = process.argv[1];
const controller = new TerminalController({ rootDirectory: root + "/w", namespaces: true, killGraceMs: 200 });
const inner = "const fs=require('fs'); let w; try { fs.writeFileSync('/etc/x','1'); w='ok' } catch (e) { w=e.code } console.log(JSON.stringify({ uid: process.getuid(), ifs: Object.keys(require('os').networkInterfaces()), etc: w, pids: fs.readdirSync('/proc').filter(n=>/^[0-9]+$/.test(n)).length }))";
const ws = controller.createWorkspace({ tenantId: "t", taskId: "k", template: { files: { "inner.js": inner } } });
const handle = await controller.runCommand(ws.id, { argv: ["node", "inner.js"] });
const result = await handle.result;
process.stdout.write(JSON.stringify({ isolation: result.isolation, stdout: result.stdout, stderr: result.stderr }));
`;

test("namespaces (userns mode): an unprivileged daemon gets the same isolation through a user namespace", async (t) => {
  const setpriv = ["/usr/bin/setpriv", "/bin/setpriv"].find((path) => existsSync(path));
  if (process.getuid?.() !== 0 || !setpriv) { t.skip("needs root and setpriv to impersonate an unprivileged daemon"); return; }
  const base = await mkdtemp(join(tmpdir(), "atlas-userns-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  chownSync(base, 65534, 65534);
  const child = spawnSync(setpriv, ["--reuid=65534", "--regid=65534", "--clear-groups", "--", process.execPath, "--input-type=module", "-e", USERNS_SCRIPT, base], {
    encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH },
  });
  if (child.status !== 0 && /SANDBOX_UNAVAILABLE|unavailable/.test(child.stderr)) { t.skip(`userns mode unavailable: ${child.stderr.trim().split("\n").at(-1)}`); return; }
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.isolation.mode, "userns");
  assert.equal(report.isolation.user.userNamespace, true);
  assert.equal(report.isolation.user.hostUid, 65534);
  assert.equal(report.isolation.network, "none");
  const inside = JSON.parse(report.stdout);
  assert.equal(inside.uid, 65534);
  assert.deepEqual(inside.ifs, []);
  assert.notEqual(inside.etc, "ok");
  assert.ok(inside.pids < 10);
});

// ---------------------------------------------------------------------------
// Fails closed, and callers can require isolation

test("an unusable namespace sandbox fails closed instead of falling back", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "atlas-sandbox-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  assert.equal(resolveNamespaceSandbox(undefined), null);
  assert.equal(resolveNamespaceSandbox(false), null);
  assert.throws(() => resolveNamespaceSandbox({ tool: "chroot" }), { code: "INVALID_SANDBOX" });
  assert.throws(() => resolveNamespaceSandbox({ tmpfsBytes: 5 }), { code: "INVALID_SANDBOX" });
  assert.throws(() => resolveNamespaceSandbox(true, { probe: () => ({ ok: false, reason: "probe failed: uid is 0" }) }), (error) => {
    assert.ok(error instanceof NamespaceSandboxError);
    assert.equal(error.code, "NAMESPACES_UNAVAILABLE");
    return true;
  });
  assert.throws(
    () => new TerminalController({ rootDirectory: join(base, "a"), namespaces: { tool: "unshare" }, killGraceMs: 200, container: { runtime: process.execPath } }),
    { code: "INVALID_SANDBOX" },
    "container and namespaces together are refused",
  );
  if (process.getuid?.() === 0) {
    assert.throws(() => resolveNamespaceSandbox({ tool: "bwrap" }), /bwrap/, "bwrap is refused (or missing) for a root daemon");
  }
});

test("the setup argv carries the command only as positional parameters", () => {
  const sandbox = { tool: "unshare", mode: "root", tmpfs: "1048576", paths: { unshare: "/u", mount: "/m", mkdir: "/k", setpriv: "/s", sh: "/bin/sh" } };
  const evil = "$(touch /pwned); `id`";
  const { file, args } = namespaceRunArguments({ sandbox, file: "/usr/bin/node", args: ["-e", evil], workspaceRoot: "/w/ws", rootDirectory: "/w", cwd: "/w/ws" });
  assert.equal(file, "/u");
  assert.ok(args.includes("--net") && args.includes("--pid") && args.includes("--kill-child") && args.includes("--mount"));
  const script = args[args.indexOf("-c") + 1];
  assert.ok(!script.includes(evil) && !script.includes("/usr/bin/node"), "nothing caller-supplied is inside the script");
  assert.deepEqual(args.slice(-3), ["/usr/bin/node", "-e", evil]);
  const networked = namespaceRunArguments({ sandbox, file: "/x", args: [], network: true, workspaceRoot: "/w/ws", rootDirectory: "/w", cwd: "/w/ws" });
  assert.ok(!networked.args.includes("--net"), "network-enabled keeps the host network");
  const bwrap = namespaceRunArguments({ sandbox: { tool: "bwrap", tmpfs: "1048576", paths: { bwrap: "/b" } }, file: "/x", args: ["y"], workspaceRoot: "/w/ws", rootDirectory: "/w", cwd: "/w/ws" });
  assert.equal(bwrap.file, "/b");
  for (const flag of ["--unshare-all", "--die-with-parent", "--cap-drop"]) assert.ok(bwrap.args.includes(flag), flag);
  assert.ok(!bwrap.args.includes("--share-net"));
  assert.deepEqual(bwrap.args.slice(-3), ["--", "/x", "y"]);
});

test("requireIsolation refuses the process runner in the controller and the engineering runner", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "atlas-sandbox-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  assert.throws(() => new TerminalController({ rootDirectory: join(base, "a"), requireIsolation: true }), { code: "ISOLATION_REQUIRED" });
  const plain = new TerminalController({ rootDirectory: join(base, "b") });
  assert.equal(plain.isolation, "process");
  assert.equal(createTerminalCommandRunner({ controller: plain }).isolation, "process");
  assert.throws(() => createTerminalCommandRunner({ controller: plain, requireIsolation: true }), { code: "ISOLATION_REQUIRED" });

  const common = { repository: base, workDirectory: join(base, "work"), ownership: { order: [] }, coders: {} };
  assert.throws(() => new EngineeringWorkflow({ ...common, requireIsolation: true }), { code: "ISOLATION_REQUIRED" });
  assert.throws(() => new EngineeringWorkflow({ ...common, requireIsolation: true, commandRunner: { run: async () => ({}) } }), { code: "ISOLATION_REQUIRED" });
});

test("an isolated controller satisfies requireIsolation and runs a prepared checkout sandboxed", { skip: skipNamespaces }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "atlas-sandbox-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const controller = new TerminalController({ rootDirectory: join(base, "w"), namespaces: true, requireIsolation: true, killGraceMs: 200 });
  assert.equal(controller.isolation, "namespaces");
  assert.equal(controller.capabilities().networkIsolation, true);
  const runner = createTerminalCommandRunner({ controller, requireIsolation: true });
  assert.equal(runner.isolation, "namespaces");
  // The pipeline checks a repository out on the host (as the daemon) before running commands in it.
  const repo = runner.prepareDirectory({ taskId: "task", name: "backend" });
  await mkdir(repo, { recursive: true });
  await import("node:fs/promises").then((fs) => fs.writeFile(join(repo, "check.js"), "require('fs').writeFileSync('out.txt', String(process.getuid())); console.log('checked')"));
  const outcome = await runner.run({ cwd: repo, argv: ["node", "check.js"] });
  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.equal(outcome.stdout, "checked\n");
  assert.equal(readFileSync(join(repo, "out.txt"), "utf8"), "65534");
});
