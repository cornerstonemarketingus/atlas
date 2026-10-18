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

test("an exited coder with inherited pipes cannot hold timeout recovery open", async t => {
  const { spawnSync } = await import("node:child_process");
  let descendant;
  t.after(() => {
    if (!descendant) return;
    if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(descendant), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else { try { process.kill(-descendant, "SIGKILL"); } catch { /* fixture exited */ } }
  });
  // A separate process group retains the coder's output pipes after it exits.
  // The fixture also self-expires, so the pre-fix failure cannot hang the suite.
  const code = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),6000)'],{detached:true,stdio:['ignore','inherit','inherit']}); console.log(JSON.stringify({pid:child.pid})); child.unref(); process.exit(0);`;
  const started = Date.now();
  const result = await runCoderProcess(process.execPath, ["-e", code], process.cwd(), 1000, { cleanupMs: 150, onProgress: () => {} });
  descendant = JSON.parse(result.stdout).pid;
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 3500, "recovery must not wait for inherited output pipes");
});

test("a failing progress observer cannot crash the coder's lifecycle", async () => {
  const result = await runCoderProcess(process.execPath, ["-e", "setTimeout(()=>console.log('{}'),250)"], process.cwd(), 5000, { intervalMs: 30, onProgress: () => { throw new Error("private observer error"); } });
  assert.equal(result.ok, true);
  assert.equal(result.stdout.trim(), "{}");
});

test("forced cleanup survives the coder exiting before a SIGTERM-resistant descendant", { skip: process.platform !== "linux" }, async t => {
  const { readFileSync } = await import("node:fs");
  let descendant;
  t.after(() => { if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch { /* fixture exited */ } } });
  const descendantCode = `process.on('SIGTERM',()=>{});process.send('ready');setTimeout(()=>process.exit(0),6000);`;
  const code = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>process.exit(0));const child=spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:['ignore','ignore','ignore','ipc']});child.on('message',()=>console.log(JSON.stringify({pid:child.pid})));`;
  const result = await runCoderProcess(process.execPath, ["-e", code], process.cwd(), 1000, { cleanupMs: 150, onProgress: () => {} });
  descendant = JSON.parse(result.stdout).pid;
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  // Orphan reaping is PID 1's responsibility; a zombie has already terminated.
  let state;
  await new Promise(resolve => setTimeout(resolve, 50));
  try { state = readFileSync(`/proc/${descendant}/stat`, "utf8").split(") ")[1][0]; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  assert.ok(state === undefined || state === "Z", "forced cleanup must kill the remaining group after the leader closes");
});

test("invalid bounds fail before starting a coder", () => {
  for (const options of [{ cleanupMs: 0 }, { cleanupMs: 5001 }, { maxBytes: NaN }, { intervalMs: -1 }]) {
    assert.throws(() => runCoderProcess(process.execPath, [], process.cwd(), 1000, options), RangeError);
  }
  assert.throws(() => runCoderProcess(process.execPath, [], process.cwd(), Infinity), RangeError);
});

test("rejected asynchronous progress observers do not abandon the subprocess", async () => {
  const result = await runCoderProcess(process.execPath, ["-e", "setTimeout(()=>console.log('{}'),250)"], process.cwd(), 5000, { intervalMs: 30, onProgress: () => Promise.reject(new Error("private observer rejection")) });
  assert.equal(result.ok, true);
});
