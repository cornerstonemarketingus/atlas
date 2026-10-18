import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import { goldAgent, runTask } from "../src/index.mjs";
import { fixtureRepo } from "./helpers.mjs";

test("a successful parent exit cannot override the verification deadline", async (t) => {
  const { root, task } = await fixtureRepo();
  // Reproduce the POSIX inherited-pipe lifecycle deterministically on Windows
  // too: the successful parent is gone, but close arrives after the deadline.
  t.mock.method(childProcess, "spawn", () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 1;
    child.kill = () => false;
    setTimeout(() => { child.stdout.end(); child.stderr.end(); child.emit("close", 0); }, 1100);
    return child;
  });
  t.mock.method(process, "kill", () => false);
  syncBuiltinESMExports();
  try {
    const result = await runTask({ task: { ...task, timeoutMs: 1000 },
      target: "deadline-regression", agent: goldAgent(root), repoRoot: root });
    assert.equal(result.evidence.verify.exitCode, 0);
    assert.equal(result.evidence.verify.timedOut, true);
    assert.equal(result.passed, false);
    assert.equal(result.failureClass, "timeout");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
