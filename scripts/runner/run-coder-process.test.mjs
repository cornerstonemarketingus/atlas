import assert from "node:assert/strict";
import test from "node:test";
import { runCoderProcess } from "./run-coder-process.mjs";
test("long coder work exposes safe counters without printing private stderr or breaking JSON", async () => {
  const messages = [];
  const privateOutput = 'private secret prompt\nAtlas progress: {"modelRequests":3,"toolCalls":2,"failedTools":1}\n';
  const code = 'process.stderr.write(' + JSON.stringify(privateOutput) + ');setTimeout(()=>console.log(JSON.stringify({status:"completed"})),500);';
  const result = await runCoderProcess(process.execPath, ["-e", code], process.cwd(), 5000, { intervalMs: 25, onProgress: (line) => messages.push(line) });
  assert.equal(result.ok, true); assert.equal(JSON.parse(result.stdout).status, "completed");
  assert.ok(messages.length); assert.ok(messages.some((line) => line.includes('"modelRequests":3')));
  assert.doesNotMatch(messages.join(""), /private|secret|prompt/);
});
test("coder timeout terminates the subprocess and reports a timeout", async () => {
  const result = await runCoderProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], process.cwd(), 80, { intervalMs: 20, onProgress: () => {} });
  assert.equal(result.timedOut, true); assert.equal(result.ok, false);
});
test("output capture is bounded and spawn errors resolve truthfully", async () => {
  const result = await runCoderProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)"], process.cwd(), 5000, { maxBytes: 1000, onProgress: () => {} });
  assert.equal(result.ok, false); assert.ok(result.stdout.length <= 1000); assert.match(result.stderr, /capture bound/);
  const absent = await runCoderProcess("atlas-nonexistent-executable", [], process.cwd(), 1000, { onProgress: () => {} });
  assert.equal(absent.ok, false); assert.match(absent.stderr, /could not start/);
});
