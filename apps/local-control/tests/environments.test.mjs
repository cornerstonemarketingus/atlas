import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deflateSync } from "node:zlib";
import test from "node:test";
import { CLOUD_SEAM, EnvironmentError, LocalEnvironment, assertEnvironment, resolveEnvironmentKind, treeDigest } from "../src/platform/environments/index.mjs";
import { GenesisService, GenesisStore } from "../src/platform/genesis/index.mjs";
import { GenesisExecutor } from "../src/platform/genesis/executor.mjs";
import { PreviewManager } from "../src/platform/genesis/preview.mjs";
import { inspectOverHttp } from "../src/platform/genesis/inspector.mjs";
import { runCheck } from "../src/platform/self-improve/runtime.mjs";

const gitIn = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" } }).trim();

function tempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) };
}

/** A small git workspace inside `<root>/projects`, with loose objects in its snapshot store (few objects). */
async function smallEnvironment(root) {
  const folder = join(root, "projects", "demo-1234");
  mkdirSync(join(folder, "src"), { recursive: true });
  gitIn(folder, "init", "-q", "-b", "main");
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "demo", type: "module", scripts: { test: "node --test" } }));
  writeFileSync(join(folder, "src", "app.mjs"), "export const answer = () => 42;\n");
  writeFileSync(join(folder, "app.test.mjs"), "import test from 'node:test'; import assert from 'node:assert'; import { answer } from './src/app.mjs'; test('answer', () => assert.equal(answer(), 42));\n");
  gitIn(folder, "add", "-A");
  gitIn(folder, "commit", "-q", "-m", "init");
  return LocalEnvironment.create({ id: "env_demo", folder, root: join(root, "projects"), snapshotsRoot: join(root, "snapshots"), runCheck });
}

test("a local environment implements the contract, and the cloud seam refuses instead of pretending", async () => {
  const { root, cleanup } = tempRoot("atlas-env-");
  try {
    const environment = assertEnvironment(await smallEnvironment(root));
    const description = environment.describe();
    assert.equal(description.kind, "local");
    assert.deepEqual(description.capabilities, ["files", "exec", "snapshot", "restore", "git"]);
    assert.ok((await environment.files.list()).includes("src/app.mjs"));
    environment.files.write("notes/todo.txt", "hello");
    assert.equal(environment.files.read("notes/todo.txt").toString(), "hello");
    assert.throws(() => environment.files.read("../../outside.txt"), (error) => error.code === "UNSAFE_PATH");
    assert.throws(() => environment.files.write(".git/config", "x"), (error) => error.code === "UNSAFE_PATH");
    const result = await environment.exec([process.execPath, "--test"], { timeoutMs: 60_000 });
    assert.equal(result.exitCode, 0, result.stdout + result.stderr);
    await assert.rejects(environment.exec("rm -rf /"), (error) => error.code === "BAD_COMMAND");
    assert.throws(() => resolveEnvironmentKind(CLOUD_SEAM.kind, { local: LocalEnvironment }), (error) => error instanceof EnvironmentError && error.code === "UNAVAILABLE");
    assert.equal(resolveEnvironmentKind("local", { local: LocalEnvironment }), LocalEnvironment);
  } finally { cleanup(); }
});

test("snapshot → destroy → restore recreates the same files in a fresh folder, and they still pass their test", async () => {
  const { root, cleanup } = tempRoot("atlas-env-");
  try {
    const environment = await smallEnvironment(root);
    writeFileSync(join(environment.folder, "src", "extra.mjs"), "export const extra = true;\n");
    const snapshot = await environment.snapshot({ manifest: { state: "building", pendingEffects: [] } });
    assert.match(snapshot.treeDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.match(snapshot.manifestDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(snapshot.seq, 1);
    const destroyed = await environment.destroy();
    assert.equal(existsSync(environment.folder), false);
    assert.ok(existsSync(destroyed.snapshotsKept));
    const { environment: restored, receipt } = await environment.restore(snapshot, { folder: join(root, "projects", "demo-restored") });
    assert.equal(receipt.verified, true);
    assert.equal(receipt.treeDigest, snapshot.treeDigest);
    assert.equal(readFileSync(join(restored.folder, "src", "extra.mjs"), "utf8"), "export const extra = true;\n");
    assert.equal(gitIn(restored.folder, "rev-parse", "HEAD"), snapshot.commit);
    assert.equal(gitIn(restored.folder, "remote"), "", "the restored workspace has no remote");
    assert.equal((await restored.exec([process.execPath, "--test"], { timeoutMs: 60_000 })).exitCode, 0);
    // A restore never lands on top of existing files.
    await assert.rejects(environment.restore(snapshot, { folder: restored.folder }), (error) => error.code === "EXISTS");
    await assert.rejects(environment.restore(snapshot, { folder: join(root, "elsewhere") }), (error) => error.code === "UNSAFE_PATH");
  } finally { cleanup(); }
});

test("restore reproduces the exact bytes even when git is set to rewrite line endings (Windows' default autocrlf)", async () => {
  const { root, cleanup } = tempRoot("atlas-env-crlf-");
  const config = join(root, "crlf.gitconfig");
  writeFileSync(config, "[core]\n\tautocrlf = true\n");
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  try {
    const environment = await smallEnvironment(root);
    writeFileSync(join(environment.folder, "src", "lines.mjs"), "export const a = 1;\nexport const b = 2;\n");
    const snapshot = await environment.snapshot({ manifest: { state: "building" } });
    await environment.destroy();
    const { environment: restored, receipt } = await environment.restore(snapshot, { folder: join(root, "projects", "demo-crlf") });
    assert.equal(receipt.treeDigest, snapshot.treeDigest);
    assert.equal(readFileSync(join(restored.folder, "src", "lines.mjs"), "utf8"), "export const a = 1;\nexport const b = 2;\n");
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous;
    cleanup();
  }
});

test("a tampered snapshot is refused: changed stored content and an edited manifest both fail closed", async () => {
  const { root, cleanup } = tempRoot("atlas-env-");
  try {
    const environment = await smallEnvironment(root);
    const snapshot = await environment.snapshot({ manifest: { state: "verifying" } });
    // Replace the stored object for src/app.mjs with different content. Git copies
    // local objects without re-hashing them, so only the digest can notice.
    const blob = gitIn(environment.folder, "rev-parse", `${snapshot.commit}:src/app.mjs`);
    const objectPath = join(environment.store, "objects", blob.slice(0, 2), blob.slice(2));
    assert.ok(existsSync(objectPath), "the snapshot store keeps loose objects for a small snapshot");
    const evil = Buffer.from("export const answer = () => 41;\n");
    chmodSync(objectPath, 0o644);
    writeFileSync(objectPath, deflateSync(Buffer.concat([Buffer.from(`blob ${evil.length}\0`), evil])));
    const target = join(root, "projects", "tampered");
    await assert.rejects(environment.restore(snapshot, { folder: target }), (error) => error.code === "DIGEST_MISMATCH" && error.details.expected === snapshot.treeDigest);
    assert.equal(existsSync(target), false, "nothing from a refused restore is left behind");

    const edited = { ...snapshot, manifest: { ...snapshot.manifest, state: "ready" } };
    await assert.rejects(environment.restore(edited, { folder: target }), (error) => error.code === "MANIFEST_MISMATCH");
    const recommitted = { ...snapshot, treeDigest: `sha256:${"0".repeat(64)}` };
    await assert.rejects(environment.restore(recommitted, { folder: target }), (error) => error.code === "DIGEST_MISMATCH");
    // The digest reflects the bytes on disk.
    const before = await treeDigest(environment.folder, snapshot.commit);
    writeFileSync(join(environment.folder, "src", "app.mjs"), "changed\n");
    assert.notEqual((await treeDigest(environment.folder, snapshot.commit)).digest, before.digest);
  } finally { cleanup(); }
});

/** One "daemon": a store on the shared database file, the service and the executor. */
function daemon(root, { coder = null } = {}) {
  const store = new GenesisStore(join(root, "genesis.sqlite"));
  const genesis = new GenesisService({ store, policy: () => ({ decision: "allow" }) });
  const preview = new PreviewManager({ registryPath: join(root, "previews.json"), runPrepare: runCheck });
  const executor = new GenesisExecutor({ genesis, projectsRoot: join(root, "projects"), runCheck, coder, preview, inspector: async (project, running) => inspectOverHttp(project, running) });
  return { store, genesis, preview, executor, stop: async () => { await preview.stopAll(); store.close(); } };
}

test("a project restores from its snapshot after its folder is deleted, and builds and verifies again", async () => {
  const { root, cleanup } = tempRoot("atlas-env-genesis-");
  const one = daemon(root);
  try {
    const project = await one.genesis.create("Build a REST API for managing inventory items");
    const done = await one.executor.run(project.id);
    assert.equal(done.state, "ready", JSON.stringify(done.transitions.at(-1)));
    const snapshots = one.store.snapshots(project.id);
    assert.deepEqual(snapshots.map((s) => s.state), ["building", "verifying", "previewing", "reviewing", "ready"], "every stage starts from a snapshot");
    const latest = snapshots.at(-1).snapshot;
    assert.equal(latest.manifest.state, "ready");
    assert.deepEqual(latest.manifest.lastVerifiedCheck.results.map((r) => [r.name, r.exitCode]), [["check", 0], ["test", 0], ["build", 0]]);
    assert.ok(latest.manifest.tasks.every((t) => ["passed", "skipped"].includes(t.status)));

    // Stop: the workspace is gone.
    await one.preview.stopAll();
    rmSync(done.workspace, { recursive: true, force: true });
    const receipt = await one.executor.resumeFromSnapshot(project.id);
    assert.equal(receipt.restored, true, JSON.stringify(receipt));
    assert.equal(receipt.state, "building");
    assert.equal(receipt.snapshot.treeDigest, latest.treeDigest);
    assert.notEqual(receipt.workspace, done.workspace);
    assert.ok(existsSync(join(receipt.workspace, ".atlas", "genesis.json")));
    const moved = one.genesis.view(project.id);
    assert.equal(moved.transitions.at(-1).evidence.kind, "resume-receipt");
    assert.equal(moved.workspace, receipt.workspace);

    const again = await one.executor.run(project.id);
    assert.equal(again.state, "ready", JSON.stringify(again.transitions.at(-1)));
    const checks = again.transitions.findLast((t) => t.to === "previewing").evidence.results;
    assert.deepEqual(checks.map((r) => [r.name, r.exitCode]), [["check", 0], ["test", 0], ["build", 0]], "the restored project passes its own checks");

    // A snapshot edited at rest is refused, and the project is left as it was.
    const db = new DatabaseSync(join(root, "genesis.sqlite"));
    const row = db.prepare("SELECT seq, snapshot_json FROM genesis_snapshots WHERE project_id = ? ORDER BY seq DESC LIMIT 1").get(project.id);
    const forged = JSON.parse(row.snapshot_json);
    forged.manifest.repairsUsed = 99;
    db.prepare("UPDATE genesis_snapshots SET snapshot_json = ? WHERE seq = ?").run(JSON.stringify(forged), row.seq);
    db.close();
    const refused = await one.executor.resumeFromSnapshot(project.id);
    assert.equal(refused.restored, false);
    assert.equal(refused.code, "MANIFEST_MISMATCH");
    assert.equal(one.genesis.view(project.id).state, "ready");
  } finally {
    await one.stop();
    cleanup();
  }
});

/** Daemon 1 performs an external effect during a coder task, writes half its work, then dies mid-task. */
async function crashMidTask(root, perform) {
  let crashed;
  const crash = new Promise((resolveCrash) => { crashed = resolveCrash; });
  const coder = async ({ workspace, kind, effect }) => {
    if (kind !== "task") return { ok: true, summary: kind, model: "scripted" };
    await effect("mailbox:provision", perform, { action: "provision reminder mailbox" });
    writeFileSync(join(workspace, "src", "notify.mjs"), "export function notify( {\n");
    crashed();
    return new Promise(() => {});
  };
  coder.available = async () => true;
  const one = daemon(root, { coder });
  const project = await one.genesis.create("Build a small app where my team can log in and track tasks, and email me reminders");
  assert.equal(project.state, "approved");
  one.executor.run(project.id);
  await crash;
  const interruptedFolder = one.store.get("local", project.id).workspace;
  await one.stop();
  return { project, interruptedFolder };
}

test("a restart mid-build resumes from the snapshot without repeating a completed external side effect", async () => {
  const { root, cleanup } = tempRoot("atlas-env-restart-");
  const sideEffects = [];
  const provision = (by) => async () => { sideEffects.push(by); return { mailbox: "reminders@example.invalid" }; };
  const NOTIFY = "export function notify() {\n  return false;\n}\n";

  const { project, interruptedFolder } = await crashMidTask(root, provision("daemon-1"));

  // Daemon 2 starts on the same database.
  const calls = [];
  const coder2 = async ({ workspace, kind, effect }) => {
    if (kind === "task") {
      const outcome = await effect("mailbox:provision", provision("daemon-2"), { action: "provision reminder mailbox" });
      calls.push({ kind, replayed: outcome.replayed, receipt: outcome.receipt });
      writeFileSync(join(workspace, "src", "notify.mjs"), NOTIFY);
    } else calls.push({ kind });
    return { ok: true, summary: kind, model: "scripted" };
  };
  coder2.available = async () => true;
  const two = daemon(root, { coder: coder2 });
  try {
    const [receipt, ...others] = await two.executor.recover();
    assert.equal(others.length, 0);
    assert.equal(receipt.restored, true, JSON.stringify(receipt));
    assert.equal(receipt.state, "building");
    assert.equal(receipt.snapshot.state, "building");
    assert.deepEqual(receipt.effects, { completed: ["mailbox:provision"], inDoubt: [] });
    assert.equal(receipt.previousWorkspace, interruptedFolder);
    assert.ok(existsSync(join(interruptedFolder, "src", "notify.mjs")), "the interrupted folder is left as it was");
    assert.equal(existsSync(join(receipt.workspace, "src", "notify.mjs")), false, "the restored folder is the stage's verified starting point");
    const transitions = two.genesis.view(project.id).transitions;
    assert.deepEqual(transitions.slice(-2).map((t) => [t.from, t.to, t.evidence.kind]), [["building", "paused", "recovery"], ["paused", "building", "resume-receipt"]]);
    assert.equal(transitions.at(-1).actor, "recovery");

    const done = await two.executor.run(project.id);
    assert.equal(done.state, "ready", JSON.stringify(done.transitions.at(-1), null, 1));
    assert.deepEqual(sideEffects, ["daemon-1"], "the external side effect happened exactly once");
    const task = calls.find((c) => c.kind === "task");
    assert.equal(task.replayed, true);
    assert.deepEqual(task.receipt, { mailbox: "reminders@example.invalid" });
    assert.equal(two.store.effect(project.id, "mailbox:provision").status, "done");
    assert.ok(existsSync(join(done.workspace, "src", "notify.mjs")));
  } finally {
    await two.stop();
    cleanup();
  }
});

test("an effect whose outcome is in doubt is never repeated automatically; a failed one may be retried", async () => {
  const { root, cleanup } = tempRoot("atlas-env-effects-");
  const one = daemon(root);
  try {
    const project = await one.genesis.create("Build a REST API for managing inventory items");
    let performed = 0;
    const perform = async () => { performed += 1; return { ok: true }; };
    assert.equal(one.store.claimEffect(project.id, "deploy:1", { action: "deploy" }), true);
    // Atlas stopped after claiming: the effect may or may not have happened.
    await assert.rejects(one.executor.effect(project.id, "deploy:1", perform), (error) => error.code === "EFFECT_IN_DOUBT" && error.intent.action === "deploy");
    assert.equal(performed, 0);
    one.store.resolveEffect(project.id, "deploy:1", { happened: false, note: "checked the host: nothing deployed" });
    assert.deepEqual(await one.executor.effect(project.id, "deploy:1", perform), { replayed: false, receipt: { ok: true } });
    assert.deepEqual(await one.executor.effect(project.id, "deploy:1", perform), { replayed: true, receipt: { ok: true } });
    assert.equal(performed, 1);
    await assert.rejects(one.executor.effect(project.id, "bad key with spaces", perform));
    // A performer that throws records a failure; the next attempt runs it again.
    await assert.rejects(one.executor.effect(project.id, "email:1", async () => { throw new Error("smtp down"); }), /smtp down/u);
    assert.equal(one.store.effect(project.id, "email:1").status, "failed");
    assert.equal((await one.executor.effect(project.id, "email:1", perform)).replayed, false);
    assert.equal(one.store.effect(project.id, "email:1").attempts, 2);
  } finally {
    await one.stop();
    cleanup();
  }
});

test("after a restart, a snapshot that fails verification is not restored: the project is held with the reason", async () => {
  const { root, cleanup } = tempRoot("atlas-env-refuse-");
  const { project, interruptedFolder } = await crashMidTask(root, async () => ({ ok: true }));
  // Tamper with the stored snapshot record while Atlas is stopped.
  const db = new DatabaseSync(join(root, "genesis.sqlite"));
  const row = db.prepare("SELECT seq, snapshot_json FROM genesis_snapshots WHERE project_id = ? ORDER BY seq DESC LIMIT 1").get(project.id);
  const forged = JSON.parse(row.snapshot_json);
  forged.manifest.tasks = forged.manifest.tasks.map((t) => ({ ...t, status: "passed" }));
  db.prepare("UPDATE genesis_snapshots SET snapshot_json = ? WHERE seq = ?").run(JSON.stringify(forged), row.seq);
  db.close();
  const two = daemon(root);
  try {
    const [receipt] = await two.executor.recover();
    assert.equal(receipt.restored, false);
    assert.equal(receipt.code, "MANIFEST_MISMATCH");
    const held = two.genesis.view(project.id);
    assert.equal(held.state, "blocked");
    assert.equal(held.resumeTo, "building", "resuming by hand still returns to the interrupted stage");
    assert.equal(held.transitions.at(-1).evidence.kind, "resume-refused");
    assert.equal(held.workspace, interruptedFolder, "the project was not pointed at unverified files");
    assert.ok(held.tasks.some((t) => t.status !== "passed"), "the forged task statuses were not applied");
  } finally {
    await two.stop();
    cleanup();
  }
});
