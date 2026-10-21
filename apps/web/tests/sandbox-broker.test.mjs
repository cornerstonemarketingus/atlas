import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ENVIRONMENT_ID, UNAVAILABLE_REASON, handleSandboxRequest, sandboxReadiness, validBackupRecord } from "../app/api/sandbox/broker.mjs";
import { PREVIEW_REGISTRY, WORKSPACE, createPreviewRegistry, createSandboxCore, handleSandboxObjectRequest, routePreviewRequest, workspacePath } from "../worker/sandbox-core.mjs";
import { sandboxEnabled, withSandboxBindings } from "../sandbox/wrangler-sandbox.mjs";
import { treeEntries } from "../sandbox/tree-manifest.mjs";

// Cloud environments run on Cloudflare Sandboxes. Nothing here talks to
// Cloudflare: the container, files, backups and storage are fakes with the
// shapes of the Sandbox SDK 1.0 / Durable Object container API.

const OWNER = { userId: "operator", dbUserId: null };
const BACKUP = { id: "0f8fad5b-d9cb-469f-a165-70867728950e", dir: WORKSPACE, size: 10, sha256: "a".repeat(64), format: "tar+zstd/1", name: "x" };

function memoryStorage() {
  const map = new Map();
  return {
    map,
    get: async (key) => structuredClone(map.get(key)),
    put: async (key, value) => { map.set(key, structuredClone(value)); },
    deleteAll: async () => { map.clear(); },
  };
}

const stream = (text) => new ReadableStream({ start(controller) { if (text) controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });

/** A container whose commands are answered by `respond(argv)` → { stdout, stderr, exitCode }. */
function fakeContainer(respond) {
  const container = {
    running: false, started: [], execs: [], destroyed: 0,
    start(options) { this.running = true; this.started.push(options); },
    async setInactivityTimeout() {},
    async destroy() { this.running = false; this.destroyed += 1; },
    async exec(argv, options) {
      this.execs.push({ argv, options });
      if (!this.running) throw new Error("not running");
      const inner = argv[0] === "timeout" ? argv.slice(3) : argv;
      const answer = await respond(inner, options) ?? {};
      return { stdout: stream(answer.stdout ?? ""), stderr: stream(answer.stderr ?? ""), exitCode: Promise.resolve(answer.exitCode ?? 0) };
    },
    getTcpPort(port) { return { fetch: async (request) => new Response(`port ${port} ${new URL(request.url).pathname}`) }; },
  };
  return container;
}

/** Answers realpath like Linux would for a workspace whose `link` points at /etc. */
function defaultRespond(argv) {
  if (argv[0] === "realpath") {
    const path = argv.at(-1);
    return { stdout: `${path.replace(`${WORKSPACE}/link`, "/etc")}\n` };
  }
  if (argv[0] === "node") return { stdout: JSON.stringify({ entries: [{ mode: "100644", path: "a.txt", sha256: "b".repeat(64) }] }) };
  return { stdout: "" };
}

function fakeFiles() {
  const written = new Map();
  return {
    written,
    mkdir: async () => {},
    writeFile: async (path, bytes) => { written.set(path, Buffer.from(bytes)); },
    stat: async (path) => ({ type: written.has(path) ? "file" : "directory", size: BigInt(written.get(path)?.length ?? 0) }),
    readFile: async (path) => new Response(written.get(path)),
  };
}

function core({ respond = defaultRespond, backups, previewDomain = "previews.example.com" } = {}) {
  const container = fakeContainer(respond);
  const storage = memoryStorage();
  const files = fakeFiles();
  const prefixes = [];
  const sandbox = createSandboxCore({
    container, files, storage, image: "atlas-image", previewDomain,
    backupsFor: (tenant) => { prefixes.push(tenant); return backups ?? { backup: async () => BACKUP, restore: async () => {} }; },
  });
  return { sandbox, container, storage, files, prefixes };
}

/** An ATLAS_SANDBOX namespace whose objects run the real wire protocol over fake containers. */
function fakeNamespace(options = {}) {
  const objects = new Map();
  const calls = [];
  const namespace = {
    calls, objects,
    idFromName: (name) => ({ name }),
    get: ({ name }) => {
      if (!objects.has(name)) {
        const made = core(options);
        objects.set(name, { ...made, registry: createPreviewRegistry(made.storage) });
      }
      const object = objects.get(name);
      return { fetch: async (request) => { calls.push({ name, url: request.url }); return handleSandboxObjectRequest({ core: object.sandbox, registry: object.registry }, request); } };
    },
  };
  return namespace;
}

function broker(request, route, { account = OWNER, tenantId = 7, environment = { ATLAS_SANDBOX: fakeNamespace() } } = {}) {
  return handleSandboxRequest(request, route, {
    authenticate: async () => account,
    isOwner: (caller) => caller?.userId === "operator",
    resolveTenant: async () => (tenantId === null ? null : { tenantId }),
    environment,
  });
}

const post = (path, body, method = "POST") => new Request(`https://atlas.test/api/sandbox/${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("the broker is for the deployment owner only, and is off with its reason until the sandbox build is deployed", async () => {
  assert.equal((await broker(post("demo", {}), { id: "demo" }, { account: null })).status, 401);
  assert.equal((await broker(post("demo", {}), { id: "demo" }, { account: { userId: "github:someone", dbUserId: 3 } })).status, 403);
  const off = await broker(post("demo", {}), { id: "demo" }, { environment: {} });
  assert.equal(off.status, 503);
  const body = await off.json();
  assert.equal(body.code, "UNAVAILABLE");
  assert.match(body.message, /Workers Paid plan/u);
  assert.match(body.message, /deploy/u);
  assert.deepEqual(sandboxReadiness({}), { available: false, reason: UNAVAILABLE_REASON });
  assert.equal(sandboxReadiness({ ATLAS_SANDBOX: fakeNamespace() }).available, true);
  // A workspace the caller is not in.
  assert.equal((await broker(post("demo", {}), { id: "demo" }, { tenantId: null })).status, 403);
});

test("sandboxes are named by the caller's tenant, never by the request", async () => {
  const namespace = fakeNamespace();
  const created = await broker(post("demo", { internet: false, tenant: "999", name: "t999-demo" }), { id: "demo" }, { environment: { ATLAS_SANDBOX: namespace }, tenantId: 7 });
  assert.equal(created.status, 200);
  const description = await created.json();
  assert.equal(description.name, "t7-demo");
  assert.equal(description.internet, false);
  assert.deepEqual([...namespace.objects.keys()], ["t7-demo"]);
  // Another tenant's "demo" is another sandbox.
  await broker(post("demo", {}), { id: "demo" }, { environment: { ATLAS_SANDBOX: namespace }, tenantId: 8 });
  assert.deepEqual([...namespace.objects.keys()].sort(), ["t7-demo", "t8-demo"]);
  // Network is off unless asked for at creation.
  assert.equal(namespace.objects.get("t7-demo").container.started[0].enableInternet, false);
  for (const bad of ["Demo", "-x", "a_b", "a/b", "x".repeat(41), ""]) assert.equal(ENVIRONMENT_ID.test(bad), false, bad);
  assert.equal((await broker(post("Demo", {}), { id: "Demo" }, { environment: { ATLAS_SANDBOX: namespace } })).status, 400);
});

test("exec takes argv only, with bounded time and output", async () => {
  const environment = { ATLAS_SANDBOX: fakeNamespace() };
  await broker(post("demo", {}), { id: "demo" }, { environment });
  for (const argv of ["rm -rf /", [], [""], ["ls", 3], ["a\0b"]]) {
    const refused = await broker(post("demo/exec", { argv }), { id: "demo", operation: "exec" }, { environment });
    assert.equal(refused.status, 400, JSON.stringify(argv));
    assert.equal((await refused.json()).code, "BAD_COMMAND");
  }
  assert.equal((await broker(post("demo/exec", { argv: ["ls"], timeoutMs: 999_999_999 }), { id: "demo", operation: "exec" }, { environment })).status, 400);
  assert.equal((await broker(post("demo/exec", { argv: ["ls"], maxOutputBytes: 1 << 30 }), { id: "demo", operation: "exec" }, { environment })).status, 400);
  const ran = await broker(post("demo/exec", { argv: ["ls", "-la"], timeoutMs: 5000 }), { id: "demo", operation: "exec" }, { environment });
  assert.equal(ran.status, 200);
  const container = environment.ATLAS_SANDBOX.objects.get("t7-demo").container;
  const last = container.execs.at(-1);
  assert.deepEqual(last.argv, ["timeout", "--kill-after=5", "5", "ls", "-la"], "the command runs under timeout, as argv");
  assert.equal(last.options.cwd, WORKSPACE);
});

test("exec output is capped and the cap is reported", async () => {
  const { sandbox } = core({ respond: (argv) => (argv[0] === "yes" ? { stdout: "y\n".repeat(1000), stderr: "e", exitCode: 0 } : defaultRespond(argv)) });
  await sandbox.create({ name: "t1-a", tenant: "1" });
  const result = await sandbox.exec({ argv: ["yes"], timeoutMs: 1000, maxOutputBytes: 10 });
  assert.equal(result.stdout, "y\ny\ny\ny\ny\n");
  assert.deepEqual(result.truncated, { stdout: true, stderr: false });
});

test("file paths stay inside the workspace, including through symlinks", async () => {
  assert.equal(workspacePath("src/a.mjs"), `${WORKSPACE}/src/a.mjs`);
  for (const bad of ["../etc/passwd", "/etc/passwd", "a/../../b", ".git/config", "", "a\0b", "a\\b"]) assert.throws(() => workspacePath(bad), (error) => error.code === "UNSAFE_PATH", bad);
  const environment = { ATLAS_SANDBOX: fakeNamespace() };
  await broker(post("demo", {}), { id: "demo" }, { environment });
  const traversal = await broker(new Request("https://atlas.test/api/sandbox/demo/files?path=../../etc/passwd"), { id: "demo", operation: "files" }, { environment });
  assert.equal(traversal.status, 400);
  // `link` → /etc inside the container: refused after realpath.
  const viaLink = await broker(new Request("https://atlas.test/api/sandbox/demo/files?path=link/passwd"), { id: "demo", operation: "files" }, { environment });
  assert.equal(viaLink.status, 400);
  assert.equal((await viaLink.json()).code, "UNSAFE_PATH");
  const written = await broker(post("demo/files", { path: "bin/run.sh", contentBase64: Buffer.from("echo hi\n").toString("base64"), executable: true }, "PUT"), { id: "demo", operation: "files" }, { environment });
  assert.equal(written.status, 200);
  const object = environment.ATLAS_SANDBOX.objects.get("t7-demo");
  assert.deepEqual(object.container.execs.at(-1).argv.slice(3), ["chmod", "755", "--", `${WORKSPACE}/bin/run.sh`]);
  const read = await broker(new Request("https://atlas.test/api/sandbox/demo/files?path=bin/run.sh"), { id: "demo", operation: "files" }, { environment });
  assert.equal(Buffer.from((await read.json()).contentBase64, "base64").toString(), "echo hi\n");
});

test("snapshot returns the backup record and the digest manifest; snapshots are kept per tenant", async () => {
  const environment = { ATLAS_SANDBOX: fakeNamespace() };
  await broker(post("demo", {}), { id: "demo" }, { environment });
  const snapshot = await broker(post("demo/snapshot", {}), { id: "demo", operation: "snapshot" }, { environment });
  assert.equal(snapshot.status, 200);
  const body = await snapshot.json();
  assert.deepEqual(body.backup, BACKUP);
  assert.deepEqual(body.entries, [{ mode: "100644", path: "a.txt", sha256: "b".repeat(64) }]);
  assert.deepEqual(environment.ATLAS_SANDBOX.objects.get("t7-demo").prefixes, ["7"], "the backup goes under the tenant's prefix");
});

test("restore goes only into a fresh sandbox, refuses forged records, and leaves nothing when it fails", async () => {
  assert.equal(validBackupRecord(BACKUP), true);
  for (const forged of [{ ...BACKUP, id: "../x" }, { ...BACKUP, sha256: "z" }, { ...BACKUP, format: "zip" }, null]) assert.equal(validBackupRecord(forged), false);
  const environment = { ATLAS_SANDBOX: fakeNamespace() };
  assert.equal((await broker(post("copy/restore", { backup: { ...BACKUP, id: "nope" } }), { id: "copy", operation: "restore" }, { environment })).status, 400);
  const restored = await broker(post("copy/restore", { backup: BACKUP }), { id: "copy", operation: "restore" }, { environment });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).entries.length, 1);
  const again = await broker(post("copy/restore", { backup: BACKUP }), { id: "copy", operation: "restore" }, { environment });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).code, "EXISTS");

  const integrity = Object.assign(new Error("changed"), { code: "BACKUP_INTEGRITY" });
  const failing = core({ backups: { backup: async () => BACKUP, restore: async () => { throw integrity; } } });
  await assert.rejects(failing.sandbox.restore({ name: "t7-x", tenant: "7", backup: BACKUP }), (error) => error.code === "BACKUP_INTEGRITY");
  assert.equal(failing.storage.map.size, 0, "a failed restore keeps no record");
  assert.equal(failing.container.destroyed, 1, "and destroys the container");
});

test("destroy removes the sandbox; previews are tokened and checked in constant time", async () => {
  const namespace = fakeNamespace();
  const environment = { ATLAS_SANDBOX: namespace, ATLAS_SANDBOX_PREVIEW_DOMAIN: "previews.example.com" };
  await broker(post("demo", {}), { id: "demo" }, { environment });
  assert.equal((await broker(post("demo/preview", { port: 80 }), { id: "demo", operation: "preview" }, { environment })).status, 400);
  const preview = await broker(post("demo/preview", { port: 5173 }), { id: "demo", operation: "preview" }, { environment });
  assert.equal(preview.status, 200);
  const { url } = await preview.json();
  assert.match(url, /^https:\/\/5173-[0-9a-f]{32}\.previews\.example\.com\/$/u);
  assert.ok(namespace.objects.has(PREVIEW_REGISTRY));
  const served = await routePreviewRequest(new Request(`${url}app?x=1`), environment);
  assert.equal(await served.text(), "port 5173 /app");
  const wrongToken = url.replace(/5173-[0-9a-f]{32}/u, `5173-${"0".repeat(32)}`);
  assert.equal((await routePreviewRequest(new Request(wrongToken), environment)).status, 404);
  assert.equal(await routePreviewRequest(new Request("https://atlas.test/"), environment), null, "app hostnames are not previews");

  const destroyed = await broker(new Request("https://atlas.test/api/sandbox/demo", { method: "DELETE" }), { id: "demo" }, { environment });
  assert.deepEqual(await destroyed.json(), { destroyed: true, snapshotsKept: true });
  assert.equal((await routePreviewRequest(new Request(`${url}app`), environment)).status, 404, "a destroyed sandbox's preview is gone");
});

test("previews need a configured domain", async () => {
  const { sandbox } = core({ previewDomain: null });
  await sandbox.create({ name: "t1-a", tenant: "1" });
  await assert.rejects(sandbox.preview({ port: 3000 }), (error) => error.code === "PREVIEW_NOT_CONFIGURED");
});

test("the sandbox build is off by default and adds the container, object, migration and bucket only when enabled", () => {
  const settings = JSON.parse(readFileSync(new URL("../sandbox.config.json", import.meta.url), "utf8"));
  assert.equal(settings.enabled, false, "cloud environments need Workers Paid; they stay off until the owner turns them on");
  assert.equal(sandboxEnabled(settings, {}), false);
  assert.equal(sandboxEnabled(settings, { ATLAS_CLOUD_SANDBOX: "1" }), true);
  assert.equal(sandboxEnabled({ enabled: true }, { ATLAS_CLOUD_SANDBOX: "0" }), false);
  const base = { main: "./worker/index.ts", compatibility_flags: ["nodejs_compat"], durable_objects: { bindings: [{ name: "INFERENCE_GOVERNOR", class_name: "InferenceGovernorObject" }] }, migrations: [{ tag: "v1-inference-governor", new_sqlite_classes: ["InferenceGovernorObject"] }], r2_buckets: [] };
  const merged = withSandboxBindings(base, { backupBucket: "atlas-sandbox-backups", previewDomain: "previews.example.com" });
  assert.equal(merged.main, "./worker/index-sandbox.ts");
  assert.equal(merged.containers[0].scheduling_policy, "durable_object");
  assert.ok(existsSync(merged.containers[0].images.atlas.dockerfile));
  assert.deepEqual(merged.durable_objects.bindings.map((binding) => binding.name), ["INFERENCE_GOVERNOR", "ATLAS_SANDBOX"]);
  assert.deepEqual(merged.migrations.map((migration) => migration.tag), ["v1-inference-governor", "v2-atlas-sandbox"]);
  assert.deepEqual(merged.r2_buckets, [{ binding: "ATLAS_SANDBOX_BACKUPS", bucket_name: "atlas-sandbox-backups" }]);
  assert.equal(merged.vars.ATLAS_SANDBOX_PREVIEW_DOMAIN, "previews.example.com");
  assert.throws(() => withSandboxBindings(base, { backupBucket: "Bad_Bucket" }));
  // The image's helper tag matches the pinned package (a mismatch is a protocol error at runtime).
  const pinned = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies["@cloudflare/sandbox"];
  assert.match(pinned, /^\d+\.\d+\.\d+$/u, "the Sandbox SDK is pinned to an exact version");
  assert.match(readFileSync(new URL("../sandbox/Dockerfile", import.meta.url), "utf8"), new RegExp(`cloudflare/sandbox:${pinned.replaceAll(".", "\\.")} `, "u"));
  // The default build that CI deploys carries no container.
  const built = new URL("../dist/server/wrangler.json", import.meta.url);
  if (existsSync(built) && process.env.ATLAS_CLOUD_SANDBOX !== "1") {
    const deployed = JSON.parse(readFileSync(built, "utf8"));
    assert.equal(deployed.containers, undefined);
    assert.ok(!(deployed.durable_objects?.bindings ?? []).some((binding) => binding.name === "ATLAS_SANDBOX"));
  }
});

test("the in-sandbox tree manifest lists what a commit would hold, with git modes", () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-tree-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" } });
    git("init", "-q", "-b", "main");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    writeFileSync(join(root, "src", "a.mjs"), "a\n");
    writeFileSync(join(root, "run.sh"), "echo\n");
    chmodSync(join(root, "run.sh"), 0o755);
    writeFileSync(join(root, "gone.txt"), "x");
    git("add", "-A"); git("commit", "-q", "-m", "init");
    rmSync(join(root, "gone.txt"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "x.js"), "ignored");
    writeFileSync(join(root, "new.txt"), "untracked");
    symlinkSync("src/a.mjs", join(root, "alias"));
    const entries = treeEntries(root);
    assert.deepEqual(entries.map((entry) => [entry.mode, entry.path]), [
      ["100644", ".gitignore"], ["120000", "alias"], ["100644", "new.txt"], ["100755", "run.sh"], ["100644", "src/a.mjs"],
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
