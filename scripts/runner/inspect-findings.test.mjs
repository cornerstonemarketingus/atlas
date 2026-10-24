import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findMarkers, markerPattern, renderFindings, renderUnanswered, requestedMarkers } from "./inspect-findings.mjs";
import { renderResult } from "./report-result.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const git = (cwd, ...args) => { const r = spawnSync("git", args, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout; };

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "atlas-markers-"));
  git(dir, "init", "--quiet", ".");
  git(dir, "config", "user.email", "t@example.invalid");
  git(dir, "config", "user.name", "T");
  await mkdir(join(dir, "src"));
  await mkdir(join(dir, "node_modules/dep"), { recursive: true });
  await writeFile(join(dir, "src/a.ts"), "const a = 1;\n// TODO: handle the empty case\nconst b = 2; // FIXME later\n");
  await writeFile(join(dir, "src/b.py"), "# TODO(anthony): cache this\nprint('TODO in a string is not a comment')\n");
  await writeFile(join(dir, "README.md"), "See TODO.md for the roadmap. The todo list lives there.\n");
  await writeFile(join(dir, "node_modules/dep/index.js"), "// TODO: vendored, not ours\n");
  await writeFile(join(dir, "src/c.css"), "/* TODO tidy */\n.x { color: red; }\n");
  git(dir, "add", "-f", "-A");
  git(dir, "commit", "--quiet", "-m", "init");
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("only marker words the request names are searched for", () => {
  assert.deepEqual(requestedMarkers("List all TODO comments in the Atlas codebase to identify unfinished work."), ["TODO"]);
  assert.deepEqual(requestedMarkers("find the todos and FIXMEs"), ["TODO", "FIXME"]);
  assert.deepEqual(requestedMarkers("Inspect the repository"), []);
  assert.deepEqual(requestedMarkers("How does authentication work?"), []);
  assert.deepEqual(requestedMarkers(undefined), []);
});

test("a TODO search returns real comments with paths and lines, and not mentions, strings or vendored code", async (t) => {
  const dir = await fixture(t);
  const found = findMarkers(dir, ["TODO"]);
  assert.equal(found.ok, true);
  assert.deepEqual(found.matches.map((m) => `${m.path}:${m.line}`).sort(), ["src/a.ts:2", "src/b.py:1", "src/c.css:1"]);
  assert.equal(found.total, 3);
  assert.equal(found.files, 3);
  assert.match(found.matches.find((m) => m.path === "src/a.ts").text, /handle the empty case/u);
  const both = findMarkers(dir, ["TODO", "FIXME"]);
  assert.equal(both.total, 4);
  assert.equal(findMarkers(dir, ["HACK"]).total, 0);
  const text = renderFindings(found).join("\n");
  assert.match(text, /^Found 3 TODO comments in 3 files:/u);
  assert.match(text, /src\/a\.ts:2 {2}\/\/ TODO: handle the empty case/u);
  assert.match(renderFindings(findMarkers(dir, ["HACK"])).join("\n"), /none found/u);
});

test("long lists are counted exactly, bounded in the reply, and say where the rest is", async (t) => {
  const dir = await fixture(t);
  await writeFile(join(dir, "many.js"), Array.from({ length: 600 }, (_u, i) => `// TODO item ${i}`).join("\n"));
  git(dir, "add", "-A");
  const found = findMarkers(dir, ["TODO"]);
  assert.equal(found.total, 603);
  assert.equal(found.matches.length, 500);
  assert.equal(found.truncated, true);
  const lines = renderFindings(found);
  assert.equal(lines.length, 81);
  assert.match(lines[0], /Found 603 TODO comments in 4 files \(showing the first 80;/u);
});

test("a failed search is reported as failed, never as zero findings", () => {
  const found = findMarkers("/nonexistent", ["TODO"], { run: () => ({ status: 128, stdout: "", stderr: "fatal" }) });
  assert.equal(found.ok, false);
  assert.match(found.error, /did not run/u);
});

test("the reply leads with the findings when a search answered, and says an inventory is only an inventory otherwise", () => {
  const inspection = { fileCount: 10, languages: [{ name: "TypeScript", fileCount: 9 }], frameworks: [], manifests: [] };
  const answered = renderResult({ task: { mode: "inspect", objective: "List all TODO comments" }, inspection, conclusion: "success",
    findings: { kind: "markers", answered: true, markers: ["TODO"], total: 1, files: 1, matches: [{ path: "a.ts", line: 2, text: "// TODO: x" }], truncated: false } });
  assert.ok(answered.indexOf("Found 1 TODO comment in 1 file") < answered.indexOf("Files scanned"), "the answer precedes the inventory");
  assert.match(answered, /a\.ts:2 {2}\/\/ TODO: x/u);
  assert.doesNotMatch(answered, /inventory only/u);
  const inventory = renderResult({ task: { mode: "inspect", objective: "Explain how login works" }, inspection, conclusion: "success", findings: { kind: "inventory", answered: false } });
  assert.match(inventory, /inventory only/u);
  assert.match(inventory, /"Explain how login works"\), it was not answered/u);
  assert.match(renderUnanswered(""), /inventory only/u);
  assert.match(markerPattern(["TODO"]), /TODO/u);
});

// The real runner, end to end: this is the run that returned an inventory for a TODO request.
const built = existsSync(join(root, "packages/atlas-cli/dist/src/cli.js"));
for (const [objective, expected] of [["List all TODO comments in the codebase", "answered"], ["Explain how the retry logic works", "inventory"]]) {
  test(`hosted inspect runner: "${objective}"`, { skip: !built && "atlas-cli is not built", timeout: 120_000 }, async (t) => {
    const dir = await fixture(t);
    const out = join(dir, "..", `out-${expected}-${Date.now()}`);
    t.after(() => rm(out, { recursive: true, force: true }));
    const child = spawn(process.execPath, ["scripts/runner/run-task.mjs"], { cwd: root, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: dir, ATLAS_OUTPUT_DIR: out, ATLAS_REPOSITORY_ROOT: dir, ATLAS_TASK_ID: "task-inspect", ATLAS_MODE: "inspect", ATLAS_BRANCH: "main", ATLAS_OBJECTIVE: objective } });
    let stderr = ""; child.stderr.on("data", (c) => { stderr += c; });
    assert.equal(await new Promise((resolve) => child.on("close", resolve)), 0, stderr);
    const status = JSON.parse(readFileSync(join(out, "status.json"), "utf8"));
    const findings = JSON.parse(readFileSync(join(out, "findings.json"), "utf8"));
    assert.equal(status.status, "completed");
    if (expected === "answered") {
      assert.equal(status.answered, true);
      assert.match(status.message, /3 TODO comment\(s\) found/u);
      assert.equal(findings.total, 3);
      assert.deepEqual(findings.matches.map((m) => m.path).sort(), ["src/a.ts", "src/b.py", "src/c.css"]);
    } else {
      assert.equal(status.answered, false);
      assert.match(status.message, /inventory only/u);
      assert.equal(findings.answered, false);
    }
  });
}
