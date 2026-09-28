import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkpointDirectory, SessionCheckpointError, SessionCheckpointRecorder, undoSession } from "../src/infrastructure/session-checkpoint.js";

async function repository(t: test.TestContext, files: Record<string, string> = {}): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atlas-checkpoint-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const read = (root: string, path: string) => readFile(join(root, path), "utf8");
const exists = (root: string, path: string) => stat(join(root, path)).then(() => true, () => false);

test("undo puts back updated, created, deleted and renamed files, with their mode", async (t) => {
  const root = await repository(t, { "src/a.ts": "a1\n", "src/gone.ts": "gone\n", "src/old.ts": "moved\n", "run.sh": "#!/bin/sh\n" });
  await chmod(join(root, "run.sh"), 0o755);
  const recorder = new SessionCheckpointRecorder(root);
  await recorder.recordBefore(["src/a.ts", "src/new.ts", "src/gone.ts", "src/old.ts", "src/moved.ts", "run.sh"]);
  // What the session did.
  await writeFile(join(root, "src/a.ts"), "a2\n");
  await writeFile(join(root, "src/new.ts"), "new\n");
  await rm(join(root, "src/gone.ts"));
  await rm(join(root, "src/old.ts"));
  await writeFile(join(root, "src/moved.ts"), "moved\n");
  await rm(join(root, "run.sh"));
  await writeFile(join(root, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o600 });

  assert.equal(await recorder.save("s1"), "s1");
  const result = await undoSession(root);
  assert.equal(result.sessionId, "s1");
  assert.deepEqual([...result.restored].sort(), ["run.sh", "src/a.ts", "src/gone.ts", "src/moved.ts", "src/new.ts", "src/old.ts"]);
  assert.deepEqual(result.conflicts, []);
  assert.equal(await read(root, "src/a.ts"), "a1\n");
  assert.equal(await exists(root, "src/new.ts"), false);
  assert.equal(await read(root, "src/gone.ts"), "gone\n");
  assert.equal(await read(root, "src/old.ts"), "moved\n");
  assert.equal(await exists(root, "src/moved.ts"), false);
  assert.equal(await read(root, "run.sh"), "#!/bin/sh\n");
  assert.equal((await stat(join(root, "run.sh"))).mode & 0o777, 0o755);
});

test("a file edited after the session is a conflict, and then nothing is restored", async (t) => {
  const root = await repository(t, { "a.ts": "a1\n", "b.ts": "b1\n" });
  const recorder = new SessionCheckpointRecorder(root);
  await recorder.recordBefore(["a.ts", "b.ts"]);
  await writeFile(join(root, "a.ts"), "a2\n");
  await writeFile(join(root, "b.ts"), "b2\n");
  await recorder.save("s1");
  await writeFile(join(root, "b.ts"), "b3 by a person\n");

  const result = await undoSession(root, { sessionId: "s1" });
  assert.deepEqual(result.conflicts, ["b.ts"]);
  assert.deepEqual(result.restored, []);
  assert.equal(await read(root, "a.ts"), "a2\n", "all or nothing");
  assert.equal(await read(root, "b.ts"), "b3 by a person\n", "a person's later edit is never overwritten");
  // The checkpoint is still there to retry once the conflict is resolved.
  await writeFile(join(root, "b.ts"), "b2\n");
  assert.deepEqual([...(await undoSession(root, { sessionId: "s1" })).restored].sort(), ["a.ts", "b.ts"]);
});

test("the first state of a path is kept across several edits in one session", async (t) => {
  const root = await repository(t, { "a.ts": "original\n" });
  const recorder = new SessionCheckpointRecorder(root);
  await recorder.recordBefore(["a.ts"]);
  await writeFile(join(root, "a.ts"), "second\n");
  await recorder.recordBefore(["a.ts"]);
  await writeFile(join(root, "a.ts"), "third\n");
  await recorder.save("s1");
  await undoSession(root);
  assert.equal(await read(root, "a.ts"), "original\n");
});

test("dry run reports without writing; an undone session is not offered again", async (t) => {
  const root = await repository(t, { "a.ts": "a1\n" });
  const recorder = new SessionCheckpointRecorder(root);
  await recorder.recordBefore(["a.ts"]);
  await writeFile(join(root, "a.ts"), "a2\n");
  await recorder.save("s1");

  const dry = await undoSession(root, { dryRun: true });
  assert.deepEqual(dry.restored, ["a.ts"]);
  assert.equal(await read(root, "a.ts"), "a2\n");

  await undoSession(root);
  await assert.rejects(undoSession(root), SessionCheckpointError);
  await assert.rejects(undoSession(root, { sessionId: "s1" }), /No undo checkpoint/);
});

test("undo without a session id takes the latest one", async (t) => {
  const root = await repository(t, { "a.ts": "1\n" });
  const first = new SessionCheckpointRecorder(root);
  await first.recordBefore(["a.ts"]);
  await writeFile(join(root, "a.ts"), "2\n");
  await first.save("first");
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  const second = new SessionCheckpointRecorder(root);
  await second.recordBefore(["a.ts"]);
  await writeFile(join(root, "a.ts"), "3\n");
  await second.save("second");

  assert.equal((await undoSession(root)).sessionId, "second");
  assert.equal(await read(root, "a.ts"), "2\n");
  assert.equal((await undoSession(root)).sessionId, "first");
  assert.equal(await read(root, "a.ts"), "1\n");
});

test("checkpoints live inside .git and a session that changed nothing saves none", async (t) => {
  const root = await repository(t, { "a.ts": "1\n" });
  const unchanged = new SessionCheckpointRecorder(root);
  await unchanged.recordBefore(["a.ts", "never-created.ts"]);
  assert.equal(await unchanged.save("noop"), null);

  const recorder = new SessionCheckpointRecorder(root);
  await recorder.recordBefore(["a.ts"]);
  await writeFile(join(root, "a.ts"), "2\n");
  await recorder.save("s1");
  const directory = await checkpointDirectory(root);
  assert.equal(directory, join(root, ".git", "atlas", "checkpoints"));
  assert.deepEqual(await readdir(directory), ["s1.json"]);
  assert.equal((await stat(join(directory, "s1.json"))).mode & 0o777, 0o600);
});

test("paths outside the repository or through a symlink are neither recorded nor restored", async (t) => {
  const root = await repository(t, { "a.ts": "1\n" });
  const outside = await repository(t, { "secret.txt": "keep\n" });
  await symlink(outside, join(root, "linked"));
  const recorder = new SessionCheckpointRecorder(root);
  await recorder.recordBefore(["../outside.txt", "/etc/passwd", "linked/secret.txt", "a.ts"]);
  await writeFile(join(outside, "secret.txt"), "changed\n");
  await writeFile(join(root, "a.ts"), "2\n");
  await recorder.save("s1");
  const saved = JSON.parse(await readFile(join(await checkpointDirectory(root), "s1.json"), "utf8")) as { files: { path: string }[] };
  assert.deepEqual(saved.files.map((file) => file.path), ["a.ts"]);
  await undoSession(root);
  assert.equal(await read(outside, "secret.txt"), "changed\n");
});

test("session ids are validated before they reach a file name", async (t) => {
  const root = await repository(t);
  await assert.rejects(undoSession(root, { sessionId: "../../etc/passwd" }), /Invalid session id/);
});

test("atlas code saves a checkpoint of its edits and atlas undo takes them back", async (t) => {
  const { createServer } = await import("node:http");
  const { main } = await import("../src/cli.js");
  const root = await repository(t, { "a.txt": "original\n" });
  // A loopback stand-in for the model: one edit, then a final answer.
  let turn = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      turn += 1;
      const message = turn === 1
        ? { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "repository.propose_change_set", arguments: JSON.stringify({ edits: [{ operation: "update", path: "a.txt", content: "edited by the session\n" }, { operation: "create", path: "b.txt", content: "new\n" }] }) } }] }
        : { role: "assistant", content: "Done." };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: `r${turn}`, model: "openai/gpt-oss-120b", choices: [{ index: 0, message, finish_reason: turn === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;

  const errors: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...parts: unknown[]) => { errors.push(parts.join(" ")); };
  console.log = () => undefined;
  process.env["ATLAS_CHECKPOINT_TEST_KEY"] = "test-key";
  try {
    await main(["code", root, "change a.txt", "--model", "openai/gpt-oss-120b", "--provider", "groq",
      "--base-url", `http://127.0.0.1:${port}/v1`, "--api-key-env", "ATLAS_CHECKPOINT_TEST_KEY", "--no-verify", "--retry-attempts", "1"]);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    delete process.env["ATLAS_CHECKPOINT_TEST_KEY"];
  }
  assert.equal(await read(root, "a.txt"), "edited by the session\n", "the session's edit landed");
  const hint = errors.find((line) => line.startsWith("To take back this session's edits:"));
  assert.ok(hint, `the undo command is printed on stderr: ${errors.join(" | ")}`);
  const sessionId = /--session (\S+)$/u.exec(hint)?.[1];
  assert.ok(sessionId);

  console.log = () => undefined;
  try {
    assert.equal(await main(["undo", root, "--session", sessionId]), 0);
  } finally {
    console.log = originalLog;
  }
  assert.equal(await read(root, "a.txt"), "original\n");
  assert.equal(await exists(root, "b.txt"), false);
});
