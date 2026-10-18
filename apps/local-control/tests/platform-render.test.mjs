import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  RENDER_CAPABILITIES, RENDER_TOOLS, RenderError, RenderPolicyError, RenderRunner, assertContainerInvocation, blenderFramePath,
  buildBlenderJob, normalizeWorkspacePath, renderRequirements, validateRenderJob,
} from "../src/platform/render/index.mjs";
import { ArtifactStore } from "../src/platform/artifacts/index.mjs";
import { containerRunArguments, resolveContainerSandbox } from "../src/platform/terminal/container-sandbox.mjs";
import { RENDER_TOOLS as REGISTRY_RENDER_TOOLS, WorkerRegistry, capabilityGaps, normalizeCapabilities } from "../src/platform/workers/registry.mjs";

const SANDBOX = Object.freeze({ runtime: "/usr/bin/docker", image: "node:22-bookworm-slim", cpus: 1, memoryBytes: 512 * 1024 ** 2, pidsLimit: 64, tmpfsBytes: 16 * 1024 ** 2 });
const FFMPEG_IMAGE = "atlas/ffmpeg:test";
const code = (expected) => (error) => { assert.equal(error.code, expected, `${error.code}: ${error.message}`); return true; };

function ffmpegJob(overrides = {}) {
  return {
    tool: "ffmpeg",
    args: ["-hide_banner", "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "out/clip.mp4"],
    outputs: ["out/clip.mp4"],
    ...overrides,
  };
}

// ---------------------------------------------------------------- argv validation

test("a well-formed ffmpeg job validates and normalizes /workspace paths", () => {
  const job = validateRenderJob({
    tool: "ffmpeg",
    args: ["-y", "-i", "/workspace/media/in.mov", "-vf", "scale=iw/2:ih/2,fps=30000/1001", "-c:v", "libx264", "-map", "0:v", "-ss", "00:00:01", "/workspace/out/a.mp4"],
    inputs: ["media/in.mov"], outputs: ["/workspace/out/a.mp4"], timeoutMs: 5_000, maxOutputBytes: 1_000_000,
  });
  assert.deepEqual(job.outputs, ["out/a.mp4"]);
  assert.equal(job.timeoutMs, 5_000);
  assert.ok(Object.isFrozen(job) && Object.isFrozen(job.args));
});

test("URLs and protocol tricks are refused anywhere in argv (no network)", () => {
  const inputs = ["in.mp4"];
  const attempts = [
    ["-i", "http://evil.example/x.mp4", "out.mp4"],
    ["-i", "HTTPS://evil.example/x.mp4", "out.mp4"],
    ["-i", "concat:in.mp4|/etc/passwd", "out.mp4"],
    ["-i", "subfile,,start,0,end,0,,:in.mp4", "out.mp4"],
    ["-i", "subfile:in.mp4", "out.mp4"],
    ["-i", "file:in.mp4", "out.mp4"],
    ["-i", "data:text/plain;base64,AAAA", "out.mp4"],
    ["-i", "pipe:0", "out.mp4"],
    ["-i", "tcp://10.0.0.1:9000", "out.mp4"],
    ["-i", "in.mp4", "rtmp://live.example/app"],
    ["-i", "in.mp4", "-f", "mpegts", "udp:239.0.0.1:1234"],
    ["-i", "in.mp4", "-f", "lavfi", "-i", "movie=http\\://evil/x.mp4", "out.mp4"],
    ["-i", "in.mp4", "-vf", "movie=filename=crypto\\:in.mp4", "out.mp4"],
    ["-i", "in.mp4", "-metadata", "comment=gopher:x", "out.mp4"],
    ["-i", "in.mp4", "ftp:out.mp4"],
    ["-i", "in.mp4", "unix:/run/x.sock"],
    ["-i", "in.mp4", "ws://h/x"],
    ["-i", "in.mp4", "x-custom+scheme:out.mp4"],
    ["-i", "in.mp4", "-f", "tee", "out.mp4|[f=mpegts]udp\\://1.2.3.4:5"],
  ];
  for (const args of attempts) {
    assert.throws(() => validateRenderJob({ tool: "ffmpeg", args, inputs, outputs: ["out.mp4"] }), RenderPolicyError, `accepted ${JSON.stringify(args)}`);
  }
  assert.throws(() => validateRenderJob({ tool: "ffmpeg", args: ["-i", "http://x/y", "out.mp4"], inputs, outputs: ["out.mp4"] }), code("NETWORK_REFUSED"));
});

test("path traversal and absolute paths outside /workspace are refused, including inside filter graphs", () => {
  const inputs = ["in.mp4"];
  const attempts = [
    { args: ["-i", "../secret.mp4", "out.mp4"], code: "PATH_TRAVERSAL" },
    { args: ["-i", "in.mp4", "out/../../x.mp4"], code: "PATH_TRAVERSAL" },
    { args: ["-i", "/etc/passwd", "out.mp4"], code: "PATH_OUTSIDE_WORKSPACE" },
    { args: ["-i", "/workspace/../etc/passwd", "out.mp4"], code: "PATH_TRAVERSAL" },
    { args: ["-i", "/workspacex/in.mp4", "out.mp4"], code: "PATH_OUTSIDE_WORKSPACE" },
    { args: ["-i", "in.mp4", "-vf", "drawbox=x=1,overlay=/home/op/.ssh/id_rsa", "out.mp4"], code: "PATH_OUTSIDE_WORKSPACE" },
    { args: ["-i", "in.mp4", "-vf", "scale=1:1,null='/root/x'", "out.mp4"], code: "PATH_OUTSIDE_WORKSPACE" },
    { args: ["-i", "in.mp4", "C:\\Windows\\x.mp4"], code: "PATH_OUTSIDE_WORKSPACE" },
    { args: ["-i", "in.mp4", "\\\\server\\share\\x.mp4"], code: "PATH_OUTSIDE_WORKSPACE" },
    { args: ["-i", "in.mp4", "/tmp/out.mp4"], code: "PATH_OUTSIDE_WORKSPACE" },
  ];
  for (const { args, code: expected } of attempts) {
    assert.throws(() => validateRenderJob({ tool: "ffmpeg", args, inputs, outputs: ["out.mp4"] }), code(expected), JSON.stringify(args));
  }
  for (const bad of ["../x", "/etc/x", "a/../../x", "./a", "a//b", "a\\b", "http://x", ".atlas-render/x", ".tmp/x", "a,b", "a\nb", ""]) {
    assert.throws(() => normalizeWorkspacePath(bad), RenderPolicyError, `accepted path ${JSON.stringify(bad)}`);
  }
});

test("outputs are limited to declared paths; inputs must be declared", () => {
  const base = { tool: "ffmpeg", inputs: ["in.mp4"] };
  assert.throws(() => validateRenderJob({ ...base, args: ["-i", "in.mp4", "out.mp4", "extra.mp4"], outputs: ["out.mp4"] }), code("OUTPUT_UNDECLARED"));
  assert.throws(() => validateRenderJob({ ...base, args: ["-i", "in.mp4", "out.mp4"], outputs: ["out.mp4", "other.mp4"] }), code("OUTPUT_NOT_IN_ARGV"));
  assert.throws(() => validateRenderJob({ ...base, args: ["-i", "other.mp4", "out.mp4"], outputs: ["out.mp4"] }), code("INPUT_UNDECLARED"));
  assert.throws(() => validateRenderJob({ ...base, args: ["-i", "in.mp4", "-"], outputs: ["out.mp4"] }), code("OUTPUT_UNDECLARED"));
  assert.throws(() => validateRenderJob({ ...base, args: ["-i", "-", "out.mp4"], outputs: ["out.mp4"] }), code("INPUT_UNDECLARED"));
  assert.throws(() => validateRenderJob({ ...base, args: ["-i", "in.mp4", "in.mp4"], outputs: ["in.mp4"] }), code("INVALID_JOB"), "an input cannot be overwritten");
  assert.throws(() => validateRenderJob({ ...base, args: ["-i", "in.mp4", "out.mp4"], outputs: ["out.mp4", "out.mp4"] }), code("INVALID_JOB"));
  assert.throws(() => validateRenderJob({ ...base, args: ["-i", "in.mp4", "out.mp4"], outputs: [] }), code("INVALID_JOB"));
  assert.throws(() => validateRenderJob({ ...base, args: ["-f", "lavfi", "-i", "testsrc", "-f", "lavfi", "out.mp4"], outputs: ["out.mp4"] }), code("FORMAT_REFUSED"));
});

test("ffmpeg options and filters that reach files, sockets, devices or plugins are refused", () => {
  const run = (args) => () => validateRenderJob({ tool: "ffmpeg", args, inputs: ["in.mp4"], outputs: ["out.mp4"] });
  for (const opt of ["-protocol_whitelist", "-filter_script", "-filter_complex_script", "-passlogfile", "-dump_attachment", "-attach", "-vstats_file", "-progress", "-sdp_file", "-fpre", "-report"]) {
    assert.throws(run(["-i", "in.mp4", opt, "x", "out.mp4"]), code("OPTION_REFUSED"), opt);
  }
  assert.throws(run(["-i", "in.mp4", "-dump_attachment:t", "x", "out.mp4"]), code("OPTION_REFUSED"), "stream specifiers do not hide an option");
  assert.throws(run(["-i", "in.mp4", "-/filter_complex", "graph.txt", "out.mp4"]), code("OPTION_REFUSED"), "-/opt reads a value from a file");
  for (const format of ["tee", "rtp", "v4l2", "x11grab", "alsa", "pipe", "concat", "hls", "segment", "fifo"]) {
    assert.throws(run(["-f", format, "-i", "in.mp4", "out.mp4"]), code("FORMAT_REFUSED"), format);
  }
  for (const graph of ["movie=in.mp4", "amovie=in.mp4", "sendcmd=c=x", "zmq", "azmq=bind_address=x", "frei0r=distort0r", "ladspa=f=x", "subtitles=in.srt", "null,lut3d=x.cube", "drawtext=fontfile=x.ttf:text=a", "drawtext=textfile=t.txt"]) {
    assert.throws(run(["-i", "in.mp4", "-vf", graph, "out.mp4"]), code("FILTER_REFUSED"), graph);
    assert.throws(run(["-i", "in.mp4", "-filter_complex", `[0:v]${graph}[v]`, "out.mp4"]), code("FILTER_REFUSED"), graph);
  }
  assert.throws(run(["-f", "lavfi", "-i", "movie=in.mp4", "out.mp4"]), code("FILTER_REFUSED"), "lavfi inputs get the same filter checks");
});

test("argv shape, job fields and bounds are validated", () => {
  const ok = ffmpegJob();
  assert.throws(() => validateRenderJob({ ...ok, tool: "sh" }), code("INVALID_JOB"));
  assert.throws(() => validateRenderJob({ ...ok, args: "-i x out.mp4" }), code("INVALID_ARGV"), "a string is not an argv");
  assert.throws(() => validateRenderJob({ ...ok, args: [...ok.args.slice(0, -1), "out/clip.mp4\u0000"] }), code("INVALID_ARGV"));
  assert.throws(() => validateRenderJob({ ...ok, args: ["-c:v", "a\nb", ...ok.args] }), code("INVALID_ARGV"));
  assert.throws(() => validateRenderJob({ ...ok, args: [...ok.args, 7] }), code("INVALID_ARGV"));
  assert.throws(() => validateRenderJob({ ...ok, args: Array(600).fill("-y").concat(["out/clip.mp4"]) }), code("INVALID_ARGV"));
  assert.throws(() => validateRenderJob({ ...ok, timeoutMs: 0 }), code("INVALID_JOB"));
  assert.throws(() => validateRenderJob({ ...ok, timeoutMs: 1.5 }), code("INVALID_JOB"));
  assert.throws(() => validateRenderJob({ ...ok, maxOutputBytes: -1 }), code("INVALID_JOB"));
  assert.throws(() => validateRenderJob({ ...ok, image: "Bad Image;rm" }), code("INVALID_JOB"));
  assert.throws(() => validateRenderJob({ ...ok, shell: true }), code("INVALID_JOB"), "unknown fields are refused, not ignored");
});

// ---------------------------------------------------------------- blender

test("the Blender argv builder emits a headless, autoexec-disabled render with exact outputs", () => {
  const one = buildBlenderJob({ scene: "scenes/shot.blend", output: "renders/shot_####", frame: 7, engine: "CYCLES", threads: 4 });
  assert.deepEqual(one.args, ["-b", "scenes/shot.blend", "--disable-autoexec", "-E", "CYCLES", "-o", "/workspace/renders/shot_####", "-F", "PNG", "-t", "4", "-f", "7"]);
  assert.deepEqual(one.inputs, ["scenes/shot.blend"]);
  assert.deepEqual(one.outputs, ["renders/shot_0007.png"]);
  const anim = buildBlenderJob({ scene: "a.blend", output: "out/f", frames: { start: 1, end: 3 }, format: "JPEG" });
  assert.deepEqual(anim.args.slice(-5), ["-s", "1", "-e", "3", "-a"]);
  assert.deepEqual(anim.outputs, ["out/f0001.jpg", "out/f0002.jpg", "out/f0003.jpg"]);
  assert.equal(blenderFramePath("x/##", 5, "exr"), "x/05.exr");
  assert.throws(() => buildBlenderJob({ scene: "a.blend", output: "o/f", frames: { start: 0, end: 5000 } }), code("INVALID_JOB"));
  assert.throws(() => buildBlenderJob({ scene: "../a.blend", output: "o/f", frame: 1 }), code("PATH_TRAVERSAL"));
  assert.throws(() => buildBlenderJob({ scene: "a.py", output: "o/f", frame: 1 }), code("INVALID_JOB"));
  assert.throws(() => buildBlenderJob({ scene: "a.blend", output: "/tmp/f", frame: 1 }), code("PATH_OUTSIDE_WORKSPACE"));
  assert.throws(() => buildBlenderJob({ scene: "a.blend", output: "o/f", frame: 1, engine: "EVIL" }), code("INVALID_JOB"));
});

test("raw Blender args are allowlisted: no scripts, no autoexec, outputs must match -o", () => {
  const base = { tool: "blender", inputs: ["a.blend"], outputs: ["o/f0001.png"] };
  const good = ["-b", "a.blend", "--disable-autoexec", "-o", "/workspace/o/f", "-F", "PNG", "-f", "1"];
  assert.ok(validateRenderJob({ ...base, args: good }));
  for (const evil of [["--python", "x.py"], ["-P", "x.py"], ["--python-expr", "import os"], ["-y"], ["--enable-autoexec"], ["--addons", "x"], ["--python-text", "t"]]) {
    assert.throws(() => validateRenderJob({ ...base, args: [...good.slice(0, 3), ...evil, ...good.slice(3)] }), code("OPTION_REFUSED"), evil.join(" "));
  }
  assert.throws(() => validateRenderJob({ ...base, args: ["-b", "a.blend", "-o", "/workspace/o/f", "-f", "1"] }), code("AUTOEXEC_REQUIRED"));
  assert.throws(() => validateRenderJob({ ...base, args: ["a.blend", "--disable-autoexec", "-f", "1"] }), code("INVALID_ARGV"), "must be headless");
  assert.throws(() => validateRenderJob({ ...base, args: ["-b", "b.blend", "--disable-autoexec", "-o", "/workspace/o/f", "-f", "1"] }), code("INPUT_UNDECLARED"));
  assert.throws(() => validateRenderJob({ ...base, args: ["-b", "a.blend", "--disable-autoexec", "-o", "/workspace/elsewhere/f", "-f", "1"] }), code("OUTPUT_UNDECLARED"));
  assert.throws(() => validateRenderJob({ ...base, args: ["-b", "a.blend", "--disable-autoexec", "-o", "//o/f", "-f", "1"] }), RenderPolicyError, "blend-relative output is refused");
  assert.throws(() => validateRenderJob({ ...base, args: ["-b", "a.blend", "--disable-autoexec", "-f", "1"] }), code("OUTPUT_UNDECLARED"), "-o is required before rendering");
  assert.throws(() => validateRenderJob({ ...base, args: ["-b", "a.blend", "--disable-autoexec", "-o", "/tmp/f", "-f", "1"] }), code("PATH_OUTSIDE_WORKSPACE"));
});

// ---------------------------------------------------------------- capabilities

test("render capabilities are declared consistently with the worker registry", () => {
  assert.deepEqual([...REGISTRY_RENDER_TOOLS], [...RENDER_TOOLS]);
  assert.deepEqual(RENDER_CAPABILITIES, { ffmpeg: "render.ffmpeg", blender: "render.blender" });
  const caps = normalizeCapabilities({ terminal: "container", render: ["render.ffmpeg", "blender", "ffmpeg"] });
  assert.deepEqual(caps.render, ["blender", "ffmpeg"]);
  assert.throws(() => normalizeCapabilities({ terminal: "process", render: ["ffmpeg"] }), /container/u, "render without a container sandbox is not a valid declaration");
  assert.throws(() => normalizeCapabilities({ render: ["ffmpeg"] }), /container/u);
  assert.throws(() => normalizeCapabilities({ terminal: "container", render: ["godot"] }), /render must list/u);
  assert.deepEqual(capabilityGaps(caps, renderRequirements("ffmpeg")), []);
  assert.deepEqual(capabilityGaps(normalizeCapabilities({ terminal: "container" }), renderRequirements("blender")), ["no render.blender"]);
  assert.deepEqual(normalizeCapabilities({}).render, []);

  const registry = new WorkerRegistry(":memory:", { isOwner: ({ userId }) => userId === "owner", clock: () => new Date("2026-10-18T00:00:00Z") });
  const w = registry.register({ tenantId: "t", name: "render-box", kind: "local", capabilities: { terminal: "container", render: ["ffmpeg"] } });
  registry.approveEnrollment("t", w.id, { approver: "owner" });
  registry.heartbeat("t", w.id);
  assert.equal(registry.schedule({ tenantId: "t", requirements: renderRequirements("ffmpeg"), risk: "low" }).worker?.id, w.id);
  assert.equal(registry.schedule({ tenantId: "t", requirements: renderRequirements("blender"), risk: "low" }).worker, null);
  assert.throws(() => registry.heartbeat("t", w.id, { capabilities: { terminal: "container", render: ["ffmpeg", "blender"] } }), code("CAPABILITY_GROWTH"));
  registry.close();
});

// ---------------------------------------------------------------- runner (injected runtime)

/**
 * A stand-in container runtime. It records every spawn and, for `run`,
 * acts on the staging directory named by the single --mount, the way a real
 * container would see /workspace.
 */
function fakeSpawner(behaviour) {
  const calls = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.signals = [];
    child.kill = (signal) => { child.signals.push(signal); if (behaviour.closeOnKill !== false) setImmediate(() => child.emit("close", null, signal)); return true; };
    const mount = args[args.indexOf("--mount") + 1] ?? "";
    const staging = /source=(.*),target=\/workspace$/u.exec(mount)?.[1];
    setImmediate(async () => {
      try {
        const close = await behaviour.run({ staging, child, args });
        if (close !== undefined) child.emit("close", close, null);
      } catch (error) {
        child.emit("error", error);
      }
    });
    return child;
  };
  return { spawn, calls };
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "atlas-render-ws-"));
  await mkdir(join(root, "media"), { recursive: true });
  await writeFile(join(root, "media", "in.mov"), "input-bytes");
  return root;
}

function runner(spawner, overrides = {}) {
  const killed = [];
  const r = new RenderRunner({
    container: { runtime: SANDBOX.runtime },
    resolveSandbox: () => SANDBOX,
    images: { ffmpeg: FFMPEG_IMAGE },
    spawn: spawner.spawn,
    killContainer: (sandbox, name) => { killed.push(name); return true; },
    pollIntervalMs: 10,
    killGraceMs: 50,
    knownSecrets: [],
    ...overrides,
  });
  return { r, killed };
}

const transcode = (overrides = {}) => ({
  tool: "ffmpeg", args: ["-i", "media/in.mov", "-c:v", "libx264", "out/a.mp4"], inputs: ["media/in.mov"], outputs: ["out/a.mp4"], ...overrides,
});

async function writeIn(staging, rel, content) {
  await mkdir(dirname(join(staging, rel)), { recursive: true });
  await writeFile(join(staging, rel), content);
}

test("a successful job runs only the container runtime and returns hashed outputs copied into the workspace", async () => {
  const ws = await workspace();
  let stagedInput;
  const spawner = fakeSpawner({ run: async ({ staging, child }) => {
    stagedInput = await readFile(join(staging, "media", "in.mov"), "utf8");
    child.stderr.emit("data", Buffer.from("frame=1 fps=0\n"));
    await writeIn(staging, "out/a.mp4", "encoded-video");
    return 0;
  } });
  const { r } = runner(spawner);
  const result = await r.run(ws, transcode());
  assert.equal(result.status, "succeeded", result.error);
  assert.equal(result.ok, true);
  assert.equal(stagedInput, "input-bytes", "declared inputs are staged");
  const sha = createHash("sha256").update("encoded-video").digest("hex");
  assert.deepEqual(result.files, [{ path: "out/a.mp4", bytes: 13, sha256: sha }]);
  assert.equal(await readFile(join(ws, "out", "a.mp4"), "utf8"), "encoded-video");
  assert.match(result.logs.stderr, /frame=1/u);
  assert.equal(result.capability, "render.ffmpeg");
  assert.equal(result.isolation.network, "none");

  assert.equal(spawner.calls.length, 1);
  const [{ file, args, options }] = spawner.calls;
  assert.equal(file, SANDBOX.runtime, "the only process started is the container runtime");
  assert.equal(options.shell, false);
  assert.equal(args[0], "run");
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.ok(!args[args.indexOf("--mount") + 1].includes(ws), "the workspace itself is never mounted");
  assert.deepEqual(args.slice(args.indexOf(FFMPEG_IMAGE)), [FFMPEG_IMAGE, "ffmpeg", "-i", "media/in.mov", "-c:v", "libx264", "out/a.mp4"]);
  assert.equal(options.env.GITHUB_TOKEN, undefined);
  const leftovers = (await readdir(tmpdir())).filter((n) => n.startsWith("atlas-render-") && !n.startsWith("atlas-render-ws-"));
  assert.ok(!spawner.calls.some((c) => leftovers.some((l) => c.args.join(" ").includes(l))), "the staging directory is removed");
  await rm(ws, { recursive: true, force: true });
});

test("an image whose entrypoint is the tool gets the bare args", async () => {
  const ws = await workspace();
  const spawner = fakeSpawner({ run: async ({ staging }) => { await writeIn(staging, "out/a.mp4", "x"); return 0; } });
  const { r } = runner(spawner, { images: { ffmpeg: { image: FFMPEG_IMAGE, entrypointRunsTool: true } } });
  assert.equal((await r.run(ws, transcode())).ok, true);
  const { args } = spawner.calls[0];
  assert.deepEqual(args.slice(args.indexOf(FFMPEG_IMAGE)), [FFMPEG_IMAGE, "-i", "media/in.mov", "-c:v", "libx264", "out/a.mp4"]);
  await rm(ws, { recursive: true, force: true });
});

test("without a container runtime the runner fails closed and never spawns host ffmpeg", async () => {
  const ws = await workspace();
  const cases = [
    { name: "no container configured", options: { container: undefined, resolveSandbox: resolveContainerSandbox } },
    { name: "container: false", options: { container: false, resolveSandbox: resolveContainerSandbox } },
    { name: "runtime not installed", options: { container: { runtime: "/nonexistent/docker" }, resolveSandbox: resolveContainerSandbox } },
    { name: "daemon down", options: { container: { runtime: process.execPath }, resolveSandbox: (opt) => resolveContainerSandbox(opt, { probe: () => ({ ok: false, reason: "daemon down" }) }) } },
    { name: "resolver returns nothing", options: { container: { runtime: "/usr/bin/docker" }, resolveSandbox: () => null } },
    { name: "resolver returns a relative runtime", options: { container: { runtime: "/usr/bin/docker" }, resolveSandbox: () => ({ ...SANDBOX, runtime: "ffmpeg" }) } },
  ];
  for (const { name, options } of cases) {
    const spawner = fakeSpawner({ run: async () => 0 });
    const { r } = runner(spawner, options);
    await assert.rejects(r.run(ws, transcode()), (error) => {
      assert.ok(error instanceof RenderError, name);
      assert.equal(error.code, "REQUIRES_CONTAINER_SANDBOX", name);
      assert.match(error.message, /container sandbox/u);
      return true;
    }, name);
    assert.equal(spawner.calls.length, 0, `${name}: nothing was spawned (no host fallback)`);
    assert.deepEqual(r.status(), { available: false, reason: r.status().reason, capabilities: [] }, name);
    assert.deepEqual(r.registryCapabilities(), [], `${name}: no render capability is declared`);
  }
  assert.ok(!existsSync(join(ws, "out")), "no output was produced on the host");
  await rm(ws, { recursive: true, force: true });
});

test("the pre-spawn guard refuses anything but a networkless container run of the staging dir", () => {
  const staging = "/tmp/atlas-render-x";
  const args = containerRunArguments({ sandbox: { ...SANDBOX, image: FFMPEG_IMAGE }, name: "atlas-render-1", workspaceRoot: staging, cwd: staging, argv: ["ffmpeg", "-version"], env: {}, user: null });
  const check = (patch) => () => assertContainerInvocation({ file: SANDBOX.runtime, args, sandbox: SANDBOX, stagingRoot: staging, image: FFMPEG_IMAGE, ...patch });
  check({})();
  assert.throws(check({ file: "/usr/bin/ffmpeg" }), code("REQUIRES_CONTAINER_SANDBOX"));
  assert.throws(check({ file: "ffmpeg", sandbox: null }), code("REQUIRES_CONTAINER_SANDBOX"));
  assert.throws(check({ args: args.map((a) => (a === "none" ? "bridge" : a)) }), /network/u);
  assert.throws(check({ args: [...args.slice(0, 1), "--volume", "/:/host", ...args.slice(1)] }), /one mount/u);
  assert.throws(check({ stagingRoot: "/home/op/workspace" }), /staging/u);
  assert.throws(check({ args: args.filter((a) => a !== "--read-only") }), /isolation/u);
  assert.throws(check({ args: ["exec", ...args.slice(1)] }), /container run/u);
});

test("images: blender needs a configured image; a job may only pick a configured image", async () => {
  const ws = await workspace();
  await writeFile(join(ws, "a.blend"), "BLENDER");
  const spawner = fakeSpawner({ run: async () => 0 });
  const { r } = runner(spawner);
  await assert.rejects(r.run(ws, buildBlenderJob({ scene: "a.blend", output: "o/f", frame: 1 })), code("IMAGE_NOT_CONFIGURED"));
  await assert.rejects(r.run(ws, transcode({ image: "attacker/ffmpeg:latest" })), code("IMAGE_NOT_ALLOWED"));
  assert.deepEqual(r.registryCapabilities(), ["ffmpeg"]);
  assert.equal(spawner.calls.length, 0);

  const blenderSpawner = fakeSpawner({ run: async ({ staging }) => { await writeIn(staging, "o/f0001.png", "PNG"); return 0; } });
  const { r: withBlender } = runner(blenderSpawner, { images: { ffmpeg: FFMPEG_IMAGE, blender: { image: "atlas/blender:4", entrypointRunsTool: false } } });
  const result = await withBlender.run(ws, buildBlenderJob({ scene: "a.blend", output: "o/f", frame: 1 }));
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.files.map((f) => f.path), ["o/f0001.png"]);
  const { args } = blenderSpawner.calls[0];
  assert.deepEqual(args.slice(args.indexOf("atlas/blender:4"), args.indexOf("atlas/blender:4") + 5), ["atlas/blender:4", "blender", "-b", "a.blend", "--disable-autoexec"]);
  assert.deepEqual(withBlender.registryCapabilities(), ["ffmpeg", "blender"]);
  await rm(ws, { recursive: true, force: true });
});

test("inputs must exist inside the workspace (symlink escapes are refused before anything runs)", async () => {
  const ws = await workspace();
  const outside = await mkdtemp(join(tmpdir(), "atlas-render-outside-"));
  await writeFile(join(outside, "secret.mov"), "host secret");
  await symlink(join(outside, "secret.mov"), join(ws, "media", "link.mov"));
  const spawner = fakeSpawner({ run: async () => 0 });
  const { r } = runner(spawner);
  await assert.rejects(r.run(ws, transcode({ args: ["-i", "media/link.mov", "out/a.mp4"], inputs: ["media/link.mov"] })), code("INPUT_OUTSIDE_WORKSPACE"));
  await assert.rejects(r.run(ws, transcode({ args: ["-i", "media/none.mov", "out/a.mp4"], inputs: ["media/none.mov"] })), code("INPUT_MISSING"));
  assert.equal(spawner.calls.length, 0);
  await rm(ws, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("undeclared files and symlinked outputs fail the job and nothing is copied back", async () => {
  const ws = await workspace();
  const outside = await mkdtemp(join(tmpdir(), "atlas-render-outside-"));
  await writeFile(join(outside, "host.txt"), "host secret");

  const extra = fakeSpawner({ run: async ({ staging }) => { await writeIn(staging, "out/a.mp4", "ok"); await writeIn(staging, "ffmpeg2pass-0.log", "x"); return 0; } });
  const r1 = await runner(extra).r.run(ws, transcode());
  assert.equal(r1.status, "policy_violation");
  assert.deepEqual(r1.undeclared, ["ffmpeg2pass-0.log"]);
  assert.deepEqual(r1.files, []);
  assert.ok(!existsSync(join(ws, "out", "a.mp4")), "a declared output is not published when the job broke the rules");
  assert.ok(!existsSync(join(ws, "ffmpeg2pass-0.log")));

  const link = fakeSpawner({ run: async ({ staging }) => { await mkdir(join(staging, "out"), { recursive: true }); await symlink(join(outside, "host.txt"), join(staging, "out", "a.mp4")); return 0; } });
  const r2 = await runner(link).r.run(ws, transcode());
  assert.equal(r2.status, "policy_violation");
  assert.match(r2.violations[0], /not a regular file/u);
  assert.ok(!existsSync(join(ws, "out", "a.mp4")), "a symlink planted by the container is never followed on the host");

  const missing = fakeSpawner({ run: async () => 0 });
  const r3 = await runner(missing).r.run(ws, transcode());
  assert.equal(r3.ok, false);
  assert.deepEqual(r3.missing, ["out/a.mp4"]);

  const failed = fakeSpawner({ run: async ({ staging, child }) => { child.stderr.emit("data", "Invalid argument\n"); await writeIn(staging, "out/a.mp4", "partial"); return 1; } });
  const r4 = await runner(failed).r.run(ws, transcode());
  assert.equal(r4.status, "failed");
  assert.equal(r4.exitCode, 1);
  assert.ok(!existsSync(join(ws, "out", "a.mp4")), "partial output of a failed run is discarded");
  await rm(ws, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("publishing refuses to write through a workspace symlink that points outside", async () => {
  const ws = await workspace();
  const outside = await mkdtemp(join(tmpdir(), "atlas-render-outside-"));
  await symlink(outside, join(ws, "out"));
  const spawner = fakeSpawner({ run: async ({ staging }) => { await writeIn(staging, "out/a.mp4", "x"); return 0; } });
  await assert.rejects(runner(spawner).r.run(ws, transcode()), code("OUTPUT_OUTSIDE_WORKSPACE"));
  assert.deepEqual(await readdir(outside), []);
  await rm(ws, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("the timeout removes the container and reports timed_out", async () => {
  const ws = await workspace();
  const spawner = fakeSpawner({ run: async () => undefined }); // never exits on its own
  const { r, killed } = runner(spawner);
  const started = Date.now();
  const result = await r.run(ws, transcode({ timeoutMs: 60 }));
  assert.equal(result.status, "timed_out");
  assert.equal(result.ok, false);
  assert.equal(killed.length, 1, "the container was removed by name");
  assert.match(killed[0], /^atlas-render-/u);
  assert.ok(Date.now() - started < 5_000);
  await rm(ws, { recursive: true, force: true });
});

test("a client that ignores signals cannot hold the job open", async () => {
  const ws = await workspace();
  const spawner = fakeSpawner({ closeOnKill: false, run: async () => undefined });
  const result = await runner(spawner).r.run(ws, transcode({ timeoutMs: 20 }));
  assert.equal(result.status, "timed_out");
  assert.deepEqual(spawner.calls.length, 1);
  await rm(ws, { recursive: true, force: true });
});

test("output beyond maxOutputBytes stops the run and discards everything", async () => {
  const ws = await workspace();
  const spawner = fakeSpawner({ run: async ({ staging }) => { await writeIn(staging, "out/a.mp4", Buffer.alloc(4096)); return undefined; } });
  const { r, killed } = runner(spawner);
  const result = await r.run(ws, transcode({ maxOutputBytes: 1024, timeoutMs: 10_000 }));
  assert.equal(result.status, "output_limit");
  assert.equal(killed.length, 1, "stopped while running, not after the timeout");
  assert.ok(!existsSync(join(ws, "out", "a.mp4")));

  // Also enforced at the end for a fast job that exits before the next poll.
  const fast = fakeSpawner({ run: async ({ staging }) => { await writeIn(staging, "out/a.mp4", Buffer.alloc(4096)); return 0; } });
  const result2 = await runner(fast, { pollIntervalMs: 60_000 }).r.run(ws, transcode({ maxOutputBytes: 1024 }));
  assert.equal(result2.status, "output_limit");
  assert.ok(!existsSync(join(ws, "out", "a.mp4")));
  await rm(ws, { recursive: true, force: true });
});

test("logs are bounded to a tail and redacted", async () => {
  const ws = await workspace();
  const secret = "s3cr3t-value-that-is-long-enough";
  const spawner = fakeSpawner({ run: async ({ staging, child }) => {
    child.stderr.emit("data", Buffer.alloc(100_000, "a"));
    child.stderr.emit("data", Buffer.from(`\nfinal error line ${secret}\n`));
    child.stdout.emit("data", "ok");
    await writeIn(staging, "out/a.mp4", "x");
    return 0;
  } });
  const result = await runner(spawner, { maxLogBytes: 1024, knownSecrets: [secret] }).r.run(ws, transcode());
  assert.ok(Buffer.byteLength(result.logs.stderr) <= 1024 + 64);
  assert.ok(result.logs.stderrTruncatedBytes > 99_000);
  assert.match(result.logs.stderr, /final error line/u, "the tail (where ffmpeg reports errors) is kept");
  assert.ok(!result.logs.stderr.includes(secret));
  assert.equal(result.logs.redactions, 1);
  await rm(ws, { recursive: true, force: true });
});

test("a runtime that fails to start is reported, not retried on the host", async () => {
  const ws = await workspace();
  const spawner = fakeSpawner({ run: async () => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); } });
  const result = await runner(spawner).r.run(ws, transcode());
  assert.equal(result.ok, false);
  assert.match(result.error, /container runtime failed to start/u);
  assert.equal(spawner.calls.length, 1);
  assert.equal(spawner.calls[0].file, SANDBOX.runtime);
  await rm(ws, { recursive: true, force: true });
});

test("with an artifact store, published video outputs are stored as kind 'video' with render provenance", async () => {
  const ws = await workspace();
  const storeRoot = await mkdtemp(join(tmpdir(), "atlas-render-store-"));
  const store = new ArtifactStore({ root: storeRoot });
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(32)]);
  const spawner = fakeSpawner({ run: async ({ staging }) => {
    await writeIn(staging, "out/a.mp4", mp4);
    await writeIn(staging, "out/fake.webm", "not really webm");
    await writeIn(staging, "out/poster.png", "png-ish");
    return 0;
  } });
  const { r } = runner(spawner, { artifactStore: store });
  const job = { tool: "ffmpeg", args: ["-i", "media/in.mov", "out/a.mp4", "out/fake.webm", "out/poster.png"], inputs: ["media/in.mov"], outputs: ["out/a.mp4", "out/fake.webm", "out/poster.png"] };
  await assert.rejects(r.run(ws, job), code("TENANT_REQUIRED"), "a store needs a tenant, checked before anything runs");
  assert.equal(spawner.calls.length, 0);

  const result = await r.run(ws, job, { tenantId: "t1", runId: "run_1" });
  assert.equal(result.ok, true, result.error);
  const [video, fake, poster] = result.files;
  assert.equal(video.artifactError, undefined, JSON.stringify(video.artifactError));
  assert.equal(video.artifact.sha256, video.sha256, "the store and the render agree on the digest");
  assert.equal(video.artifact.created, true);
  const record = store.get("t1", video.sha256);
  assert.equal(record.kind, "video");
  assert.equal(record.mediaType, "video/mp4");
  assert.deepEqual(record.provenance, { runId: "run_1", step: "render", source: "render.ffmpeg" });
  assert.equal(fake.artifactError.code, "CONTENT_MISMATCH", "the store's content sniffing still applies; the render result records it");
  assert.equal(poster.artifact, undefined, "only video outputs go to the store");
  assert.equal(poster.artifactError, undefined);
  store.close?.();
  await rm(ws, { recursive: true, force: true });
  await rm(storeRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------- real container

const REAL_IMAGE = process.env.ATLAS_RENDER_TEST_IMAGE ?? "linuxserver/ffmpeg:latest";
const REAL_ENTRYPOINT_RUNS_TOOL = (process.env.ATLAS_RENDER_TEST_ENTRYPOINT_RUNS_TOOL ?? (process.env.ATLAS_RENDER_TEST_IMAGE ? "0" : "1")) === "1";

function realContainerSkipReason() {
  const runtime = ["/usr/bin/docker", "/usr/local/bin/docker", "/usr/bin/podman"].find((p) => existsSync(p));
  if (!runtime) return { skip: "no docker/podman binary installed" };
  try {
    resolveContainerSandbox({ runtime });
  } catch (error) {
    return { skip: `container runtime not usable (${error.message})` };
  }
  const inspect = spawnSync(runtime, ["image", "inspect", REAL_IMAGE], { stdio: "ignore", timeout: 15_000 });
  if (inspect.status !== 0) return { skip: `image ${REAL_IMAGE} is not present locally (pull it, or set ATLAS_RENDER_TEST_IMAGE); tests never pull` };
  return { runtime };
}

const real = realContainerSkipReason();

test("real container: ffmpeg encodes a 1-second lavfi test clip inside the sandbox", { skip: real.skip ?? false, timeout: 240_000 }, async () => {
  const ws = await mkdtemp(join(tmpdir(), "atlas-render-real-"));
  const r = new RenderRunner({ container: { runtime: real.runtime }, images: { ffmpeg: { image: REAL_IMAGE, entrypointRunsTool: REAL_ENTRYPOINT_RUNS_TOOL } } });
  assert.deepEqual(r.status().capabilities, ["render.ffmpeg"]);
  const result = await r.run(ws, {
    tool: "ffmpeg",
    args: ["-hide_banner", "-nostdin", "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", "out/clip.mp4"],
    outputs: ["out/clip.mp4"],
    timeoutMs: 180_000,
    maxOutputBytes: 10 * 1024 ** 2,
  });
  assert.equal(result.status, "succeeded", `${result.error}\n${result.logs.stderr}`);
  const [file] = result.files;
  const bytes = await readFile(join(ws, "out", "clip.mp4"));
  assert.equal(file.path, "out/clip.mp4");
  assert.equal(file.bytes, bytes.length);
  assert.ok(bytes.length > 500, "a real encode, not an empty file");
  assert.equal(file.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(bytes.subarray(4, 8).toString("latin1"), "ftyp", "an MP4 container");
  assert.match(result.logs.stderr, /frame=\s*10\b/u, "ffmpeg encoded 10 frames (1 s at 10 fps)");
  assert.ok((await lstat(join(ws, "out", "clip.mp4"))).isFile());
  await rm(ws, { recursive: true, force: true });
});
