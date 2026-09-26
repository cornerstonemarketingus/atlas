import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TerminalController } from "../src/platform/terminal/terminal-controller.mjs";
import {
  CONTAINER_WORKDIR, ContainerSandboxError, containerRunArguments, containerWorkdir, minimalRuntimeEnvironment, resolveContainerSandbox,
} from "../src/platform/terminal/container-sandbox.mjs";

const IMAGE = "atlas-test:1";
const sandbox = Object.freeze({ runtime: "/usr/bin/docker", image: IMAGE, cpus: 1, memoryBytes: 512 * 1024 ** 2, pidsLimit: 64, tmpfsBytes: 16 * 1024 ** 2 });

test("run arguments: workspace-only mount, no network, no capabilities, read-only root, limits", () => {
  const args = containerRunArguments({
    sandbox, name: "atlas-c1", workspaceRoot: "/srv/ws/abc", cwd: "/srv/ws/abc/repo", argv: ["npm", "test"],
    env: { PATH: "/host/bin", HOME: "/home/op", CI: "1" }, user: "1000:1000",
  });
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.equal(args[0], "run");
  assert.ok(args.includes("--rm"));
  assert.equal(flag("--network"), "none");
  assert.equal(flag("--cap-drop"), "ALL");
  assert.equal(flag("--security-opt"), "no-new-privileges");
  assert.ok(args.includes("--read-only"));
  assert.equal(flag("--mount"), `type=bind,source=/srv/ws/abc,target=${CONTAINER_WORKDIR}`);
  assert.equal(args.filter((a) => a === "--mount" || a === "--volume" || a === "-v").length, 1, "exactly one host mount");
  assert.equal(flag("--workdir"), "/workspace/repo");
  assert.equal(flag("--pids-limit"), "64");
  assert.equal(flag("--memory"), String(512 * 1024 ** 2));
  assert.equal(flag("--user"), "1000:1000");
  const envs = args.flatMap((a, i) => (a === "--env" ? [args[i + 1]] : []));
  assert.deepEqual(envs.sort(), ["CI=1", "HOME=/workspace", "TMPDIR=/workspace/.tmp"], "host PATH and HOME never enter");
  assert.deepEqual(args.slice(-3), [IMAGE, "npm", "test"], "the command comes last, after the image");
});

test("a network-enabled command gets the bridge network, nothing more", () => {
  const args = containerRunArguments({ sandbox, name: "n", workspaceRoot: "/w", cwd: "/w", argv: ["npm", "ci"], env: {}, network: true, user: null });
  assert.equal(args[args.indexOf("--network") + 1], "bridge");
  assert.ok(!args.includes("--user"));
});

test("cwd outside the workspace and a comma in the mount path are refused", () => {
  assert.throws(() => containerWorkdir("/w/a", "/w/b"), ContainerSandboxError);
  assert.throws(() => containerRunArguments({ sandbox, name: "n", workspaceRoot: "/w,readonly=false", cwd: "/w,readonly=false", argv: ["ls"], env: {} }), /comma/u);
  assert.throws(() => containerRunArguments({ sandbox, name: "bad name", workspaceRoot: "/w", cwd: "/w", argv: ["ls"], env: {} }), ContainerSandboxError);
});

test("asking for a sandbox that cannot work fails instead of falling back", () => {
  assert.equal(resolveContainerSandbox(undefined), null);
  assert.throws(() => resolveContainerSandbox({ runtime: "docker" }), /absolute path/u);
  assert.throws(() => resolveContainerSandbox({ runtime: "/nonexistent/docker" }), /not installed/u);
  assert.throws(() => resolveContainerSandbox({ runtime: process.execPath, image: "Bad Image" }), /image/u);
  assert.throws(() => resolveContainerSandbox({ runtime: process.execPath, memoryBytes: 1 }), /memoryBytes/u);
  assert.throws(() => resolveContainerSandbox({ runtime: process.execPath }, { probe: () => ({ ok: false, reason: "daemon down" }) }), /daemon down/u);
  const ok = resolveContainerSandbox({ runtime: process.execPath, image: IMAGE }, { probe: () => ({ ok: true }) });
  assert.equal(ok.image, IMAGE);
  assert.equal(ok.pidsLimit, 256, "defaults fill the rest");
});

test("the runtime CLI never receives the daemon's credentials", () => {
  const env = minimalRuntimeEnvironment({ PATH: "/bin", DOCKER_HOST: "unix:///x", GITHUB_TOKEN: "ghp_x", ANTHROPIC_API_KEY: "k" });
  assert.deepEqual(env, { PATH: "/bin", DOCKER_HOST: "unix:///x" });
});

// A stand-in runtime: answers `version`, records `run` and `rm`, and for
// a command marked BLOCK hangs until killed. Exercises the controller's wiring without a
// container daemon. POSIX only (it relies on a shebang).
async function fakeRuntime(base) {
  const log = join(base, "runtime.log");
  const path = join(base, "fake-docker");
  await writeFile(path, `#!${process.execPath}
const fs = require("node:fs");
const [verb, ...rest] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([verb, ...rest]) + "\\n");
if (verb === "version") { process.stdout.write("fake"); process.exit(0); }
if (verb === "rm") process.exit(0);
const command = rest.slice(rest.indexOf(${JSON.stringify(IMAGE)}) + 1);
if (command.join(" ").includes("BLOCK")) setInterval(() => {}, 1000);
else process.stdout.write("ran " + command.join(" "));
`);
  await chmod(path, 0o755);
  return { path, log };
}

test("the controller runs commands through the runtime and removes the container on timeout", { skip: process.platform === "win32" }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "atlas-sandbox-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const runtime = await fakeRuntime(base);
  const controller = new TerminalController({ rootDirectory: join(base, "ws"), killGraceMs: 200, container: { runtime: runtime.path, image: IMAGE } });
  assert.deepEqual(controller.capabilities().container, { runtime: runtime.path, image: IMAGE });
  assert.equal(controller.capabilities().networkIsolation, true);
  const workspace = controller.createWorkspace({ tenantId: "t", taskId: "k" });

  const handle = await controller.runCommand(workspace.id, { argv: ["node", "--version"] });
  const result = await handle.result;
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ran node --version");
  assert.equal(result.isolation.level, "container");
  assert.equal(result.isolation.network, "none");

  const slow = await controller.runCommand(workspace.id, { argv: ["node", "-e", "BLOCK=1"], timeoutMs: 300 });
  const slowResult = await slow.result;
  assert.equal(slowResult.timedOut, true);
  const calls = (await readFile(runtime.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const rmCall = calls.find(([verb]) => verb === "rm");
  assert.ok(rmCall, "the container was removed by name");
  assert.equal(rmCall[2], slowResult.isolation.container.name);
});

const dockerUsable = (() => {
  const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 10_000 });
  return !probe.error && probe.status === 0;
})();

test("with a real runtime, the host is not visible and the network is off", { skip: (process.platform !== "linux" && "Linux containers only") || (!dockerUsable && "no usable docker daemon") }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "atlas-sandbox-real-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const controller = new TerminalController({ rootDirectory: join(base, "ws"), container: { runtime: "/usr/bin/docker", image: "node:22-bookworm-slim" }, timeoutMs: 120_000 });
  const workspace = controller.createWorkspace({ tenantId: "t", taskId: "real" });
  // The host path is assembled at run time from its segments: written out
  // literally, the command policy (correctly) refuses it before any container
  // starts. Built this way, only the container can stop the read.
  const segments = JSON.stringify(base.split("/"));
  const script = `const fs=require('node:fs');let home=false;try{fs.readdirSync(${segments}.join(String.fromCharCode(47)));home=true}catch{};require('node:dns').lookup('example.com',(e)=>{console.log(JSON.stringify({home,net:!e}))})`;
  const handle = await controller.runCommand(workspace.id, { argv: ["node", "-e", script] });
  const result = await handle.result;
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { home: false, net: false });
});
