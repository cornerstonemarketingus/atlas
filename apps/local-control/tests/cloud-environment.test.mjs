import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import test from "node:test";
import {
  CLOUD_SEAM, CloudflareSandboxEnvironment, EnvironmentError, LocalEnvironment, assertEnvironment, cloudSandboxUrl, digestTreeEntries,
  migrateCloudSnapshotToLocal, migrateLocalSnapshotToCloud, resolveEnvironmentKind,
} from "../src/platform/environments/index.mjs";
import { runCheck } from "../src/platform/self-improve/runtime.mjs";
import { treeEntries } from "../../web/sandbox/tree-manifest.mjs";
import { startFakeBroker } from "./helpers/fake-sandbox-broker.mjs";

// CloudflareSandboxEnvironment against a local HTTP broker with the hosted
// broker's API. Nothing here reaches Cloudflare.

const TOKEN = "atlas-operator-token-do-not-leak-8c1f";
const gitIn = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" } }).trim();

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "atlas-cloud-env-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) };
}

async function localProject(root) {
  const folder = join(root, "projects", "demo");
  mkdirSync(join(folder, "src"), { recursive: true });
  gitIn(folder, "init", "-q", "-b", "main");
  writeFileSync(join(folder, ".gitignore"), "node_modules/\n");
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "demo", type: "module" }));
  writeFileSync(join(folder, "src", "app.mjs"), "export const answer = () => 42;\n");
  writeFileSync(join(folder, "app.test.mjs"), "import test from 'node:test'; import assert from 'node:assert'; import { answer } from './src/app.mjs'; test('answer', () => assert.equal(answer(), 42));\n");
  writeFileSync(join(folder, "run.sh"), "#!/bin/sh\necho run\n");
  chmodSync(join(folder, "run.sh"), 0o755);
  gitIn(folder, "add", "-A");
  gitIn(folder, "commit", "-q", "-m", "init");
  return LocalEnvironment.create({ id: "env_demo", folder, root: join(root, "projects"), snapshotsRoot: join(root, "snapshots"), runCheck });
}

const configured = (broker) => ({ ATLAS_CLOUD_SANDBOX_URL: broker.url, ATLAS_CLOUD_SANDBOX_TOKEN: TOKEN });

function assertNoSecret(error) {
  const visible = `${error.message}\n${JSON.stringify(error.details ?? {})}\n${error.stack}`;
  assert.ok(!visible.includes(TOKEN), "the token never appears in an error");
}

test("cloudflare-sandbox is UNAVAILABLE until a broker URL and token are configured, and resolves once they are", async () => {
  assert.throws(() => resolveEnvironmentKind(CLOUD_SEAM.kind, {}, { env: {} }), (error) => error instanceof EnvironmentError && error.code === "UNAVAILABLE" && /Workers Paid/u.test(error.message));
  assert.throws(() => resolveEnvironmentKind(CLOUD_SEAM.kind, {}, { env: { ATLAS_CLOUD_SANDBOX_URL: "https://atlas.example" } }), (error) => error.code === "UNAVAILABLE", "a URL without a token is not configured");
  assert.equal(resolveEnvironmentKind(CLOUD_SEAM.kind, {}, { env: { ATLAS_CLOUD_SANDBOX_URL: "https://atlas.example", ATLAS_CLOUD_SANDBOX_TOKEN: TOKEN } }), CloudflareSandboxEnvironment);
  assert.equal(resolveEnvironmentKind(CLOUD_SEAM.kind, {}, { env: { ATLAS_CLOUD_SANDBOX_URL: "https://atlas.example" }, vault: { get: async () => TOKEN } }), CloudflareSandboxEnvironment);
  // Plain HTTP only on loopback, never credentials in the URL.
  assert.equal(cloudSandboxUrl({ ATLAS_CLOUD_SANDBOX_URL: "http://atlas.example" }), null);
  assert.equal(cloudSandboxUrl({ ATLAS_CLOUD_SANDBOX_URL: "https://user:pw@atlas.example" }), null);
  assert.equal(cloudSandboxUrl({ ATLAS_CLOUD_SANDBOX_URL: "https://atlas.example/path" }), "https://atlas.example");
  await assert.rejects(CloudflareSandboxEnvironment.create({ id: "demo", env: {} }), (error) => error.code === "UNAVAILABLE");
  await assert.rejects(CloudflareSandboxEnvironment.create({ id: "demo", env: { ATLAS_CLOUD_SANDBOX_URL: "https://atlas.example" }, vault: { get: async () => null } }), (error) => error.code === "UNAVAILABLE");
});

test("the cloud environment implements the contract over HTTPS with the bearer token, and keeps the token out of describe()", async () => {
  const broker = await startFakeBroker({ token: TOKEN });
  try {
    const vault = { get: async (name) => (name === "ATLAS_CLOUD_SANDBOX_TOKEN" ? TOKEN : null) };
    const environment = assertEnvironment(await CloudflareSandboxEnvironment.create({ id: "env_demo", env: { ATLAS_CLOUD_SANDBOX_URL: broker.url }, vault }));
    assert.ok(broker.state.requests.every((request) => request.authorization === `Bearer ${TOKEN}`));
    const description = environment.describe();
    assert.equal(description.kind, "cloudflare-sandbox");
    assert.equal(description.id, "env-demo");
    assert.equal(description.network, "off");
    assert.ok(!JSON.stringify(description).includes(TOKEN));
    await environment.files.write("src/app.mjs", "export const answer = () => 42;\n");
    await environment.files.write("bin/run.sh", "#!/bin/sh\necho hi\n", { executable: true });
    assert.equal((await environment.files.read("src/app.mjs")).toString(), "export const answer = () => 42;\n");
    assert.deepEqual(await environment.files.list(), ["bin/run.sh", "src/app.mjs"]);
    await assert.rejects(environment.files.read("../outside"), (error) => error.code === "UNSAFE_PATH");
    const result = await environment.exec(["node", "-e", "process.stdout.write('ok')"], { timeoutMs: 30_000 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "ok");
    await assert.rejects(environment.exec("rm -rf /"), (error) => error.code === "BAD_COMMAND");
  } finally { await broker.close(); }
});

test("a wrong token is UNAUTHORIZED and the error never carries the credential, even when the broker echoes it", async () => {
  const broker = await startFakeBroker({ token: "the-real-token" });
  try {
    broker.state.echoAuthorization = true;
    const error = await CloudflareSandboxEnvironment.create({ id: "demo", env: configured(broker) }).then(() => null, (caught) => caught);
    assert.equal(error?.code, "UNAUTHORIZED");
    assert.match(error.message, /\[redacted\]/u);
    assertNoSecret(error);
  } finally { await broker.close(); }
});

test("a broker without the sandbox build answers UNAVAILABLE with its reason; a slow broker times out", async () => {
  const off = await startFakeBroker({ token: TOKEN, unavailable: true });
  try {
    const error = await CloudflareSandboxEnvironment.create({ id: "demo", env: configured(off) }).then(() => null, (caught) => caught);
    assert.equal(error?.code, "UNAVAILABLE");
    assert.match(error.message, /Workers Paid plan/u);
    assertNoSecret(error);
  } finally { await off.close(); }
  const slow = await startFakeBroker({ token: TOKEN });
  try {
    slow.state.delayMs = 500;
    await assert.rejects(CloudflareSandboxEnvironment.create({ id: "demo", env: configured(slow), timeoutMs: 100 }), (error) => error.code === "TIMEOUT" && !error.message.includes(TOKEN));
  } finally { await slow.close(); }
  // Nothing listening.
  await assert.rejects(CloudflareSandboxEnvironment.create({ id: "demo", env: { ATLAS_CLOUD_SANDBOX_URL: "http://127.0.0.1:9", ATLAS_CLOUD_SANDBOX_TOKEN: TOKEN } }), (error) => error.code === "UNAVAILABLE" && !error.message.includes(TOKEN));
});

test("cloud snapshot → destroy → restore is verified against the tree digest, and a tampered restore is refused and removed", async () => {
  const broker = await startFakeBroker({ token: TOKEN });
  try {
    const environment = await CloudflareSandboxEnvironment.create({ id: "demo", env: configured(broker) });
    await environment.files.write("src/app.mjs", "export const answer = () => 42;\n");
    const snapshot = await environment.snapshot({ manifest: { state: "building" } });
    assert.match(snapshot.treeDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(snapshot.files, 1);
    assert.ok(!JSON.stringify(snapshot).includes(TOKEN));
    await environment.destroy();
    const { environment: restored, receipt } = await environment.restore(snapshot, { id: "demo-restored" });
    assert.equal(receipt.verified, true);
    assert.equal(receipt.treeDigest, snapshot.treeDigest);
    assert.equal((await restored.files.read("src/app.mjs")).toString(), "export const answer = () => 42;\n");
    // Restore never lands on an existing sandbox.
    await assert.rejects(environment.restore(snapshot, { id: "demo-restored" }), (error) => error.code === "EXISTS");

    broker.state.tamperOnRestore = true;
    await assert.rejects(environment.restore(snapshot, { id: "demo-tampered" }), (error) => error.code === "DIGEST_MISMATCH" && error.details.expected === snapshot.treeDigest);
    assert.equal(broker.state.sandboxes.has("t1-demo-tampered"), false, "the refused sandbox is destroyed");
    broker.state.tamperOnRestore = false;
    await assert.rejects(environment.restore({ ...snapshot, manifest: { ...snapshot.manifest, state: "ready" } }, { id: "demo-edited" }), (error) => error.code === "MANIFEST_MISMATCH");
    await assert.rejects(environment.restore({ ...snapshot, treeDigest: `sha256:${"0".repeat(64)}` }, { id: "demo-forged" }), (error) => error.code === "DIGEST_MISMATCH");
    assert.equal(broker.state.sandboxes.has("t1-demo-forged"), false);
  } finally { await broker.close(); }
});

test("the in-sandbox tree helper digests a workspace exactly as a local snapshot does", async () => {
  const { root, cleanup } = tempRoot();
  try {
    const local = await localProject(root);
    mkdirSync(join(local.folder, "node_modules"));
    writeFileSync(join(local.folder, "node_modules", "ignored.js"), "x");
    writeFileSync(join(local.folder, "src", "new.mjs"), "export const fresh = true;\n");
    const snapshot = await local.snapshot({ manifest: { state: "building" } });
    assert.equal(digestTreeEntries(treeEntries(local.folder)).digest, snapshot.treeDigest);
  } finally { cleanup(); }
});

test("a local snapshot migrates to the cloud and back, verified by the same digest at each end", async () => {
  const { root, cleanup } = tempRoot();
  const broker = await startFakeBroker({ token: TOKEN });
  try {
    const local = await localProject(root);
    const snapshot = await local.snapshot({ manifest: { state: "building" } });
    const { environment: cloud, receipt } = await migrateLocalSnapshotToCloud({ source: local, snapshot, env: configured(broker) });
    assert.equal(receipt.treeDigest, snapshot.treeDigest);
    assert.equal(cloud.id, "env-demo");
    // The executable bit travels as git recorded it in the snapshot. Windows
    // has no POSIX exec bit (git there records run.sh as 100644 and chmod is a
    // no-op), so the mode comes from the snapshot, not from this platform.
    const recordedMode = gitIn(local.store, "ls-tree", snapshot.commit, "run.sh").split(" ")[0];
    if (process.platform !== "win32") assert.equal(recordedMode, "100755", "the fixture's run.sh is executable");
    const upload = broker.state.writes.find((write) => write.sandbox === "t1-env-demo" && write.path === "run.sh");
    assert.equal(upload?.executable, recordedMode === "100755", "the executable bit travels to the sandbox");
    if (recordedMode === "100755") assert.ok(statSync(join(broker.folderOf("t1-env-demo"), "run.sh")).mode & 0o100, "and is set there");

    const cloudSnapshot = await cloud.snapshot({ manifest: { state: "building" } });
    assert.equal(cloudSnapshot.treeDigest, snapshot.treeDigest, "the same files digest the same in the cloud");
    const folder = join(root, "projects", "demo-back");
    const back = await migrateCloudSnapshotToLocal({ cloud, snapshot: cloudSnapshot, folder, root: join(root, "projects"), snapshotsRoot: join(root, "snapshots"), runCheck });
    assert.equal(back.receipt.treeDigest, snapshot.treeDigest);
    assert.equal(readFileSync(join(folder, "src", "app.mjs"), "utf8"), "export const answer = () => 42;\n");
    assert.equal((await back.environment.exec([process.execPath, "--test"], { timeoutMs: 60_000 })).exitCode, 0);
    assert.equal([...broker.state.sandboxes.keys()].filter((name) => name !== "t1-env-demo").length, 0, "the temporary sandbox is destroyed");
    await assert.rejects(migrateLocalSnapshotToCloud({ source: local, snapshot, env: configured(broker) }), (error) => error.code === "EXISTS", "migration needs a fresh sandbox");
  } finally { await broker.close(); cleanup(); }
});

test("a tampered local snapshot store is refused before anything is uploaded", async () => {
  const { root, cleanup } = tempRoot();
  const broker = await startFakeBroker({ token: TOKEN });
  try {
    const local = await localProject(root);
    const snapshot = await local.snapshot({ manifest: { state: "verifying" } });
    const blob = gitIn(local.folder, "rev-parse", `${snapshot.commit}:src/app.mjs`);
    const objectPath = join(local.store, "objects", blob.slice(0, 2), blob.slice(2));
    assert.ok(existsSync(objectPath));
    const evil = Buffer.from("export const answer = () => 41;\n");
    chmodSync(objectPath, 0o644);
    writeFileSync(objectPath, deflateSync(Buffer.concat([Buffer.from(`blob ${evil.length}\0`), evil])));
    await assert.rejects(migrateLocalSnapshotToCloud({ source: local, snapshot, env: configured(broker) }), (error) => error.code === "DIGEST_MISMATCH");
    assert.equal(broker.state.requests.length, 0, "nothing reached the broker");
  } finally { await broker.close(); cleanup(); }
});
