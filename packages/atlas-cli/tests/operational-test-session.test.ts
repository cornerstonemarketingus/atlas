import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { isOperationalTestObjective, runOperationalTests } from "../src/agent/operational-test-session.js";
import { planRepositoryTests } from "../src/infrastructure/repository-test-planner.js";
import { BoundedCommandRunner } from "../src/infrastructure/bounded-command-runner.js";
import { SafeValidationProfileRunner } from "../src/infrastructure/validation-profile-runner.js";

const exec = promisify(execFile);
const objective = "Run the test suite for the Atlas repository and report any failures.";
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "atlas-operational-tests-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function suite(root: string, directory: string, failure = false) {
  const cwd = join(root, directory);
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node check.mjs" } }));
  await writeFile(join(cwd, "check.mjs"), `import assert from 'node:assert/strict'; assert.equal(process.env.ATLAS_TEST_SECRET, undefined); console.log('ACTUAL_TEST_EXECUTED'); ${failure ? "assert.fail('fixture assertion failure')" : ""}`);
}
function runner(root: string) {
  return new SafeValidationProfileRunner(new BoundedCommandRunner({ repositoryRoot: root, allowedExecutables: ["npm"], inheritedEnvironmentVariables: ["PATH"], timeoutMs: 10_000 }));
}

test("test-only routing accepts the real objective and refuses mixed or scoped editing objectives", () => {
  for (const text of [objective, "Run tests", "Execute the full test suite and summarize results", "Please run the tests for this repository and list all failures."]) assert.equal(isOperationalTestObjective(text), true, text);
  for (const text of ["Run tests and fix failures", "Do not run the test suite", "Run the test suite for another repository and delete files", "Run tests in apps/web", "Add a test suite", "Run tests; publish the result"]) assert.equal(isOperationalTestObjective(text), false, text);
});

test("a monorepo without a root manifest discovers every default package suite", async (t) => {
  const root = await fixture(t);
  await suite(root, "apps/web");
  await suite(root, "packages/cli");
  await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
  await writeFile(join(root, "node_modules", "ignored", "package.json"), JSON.stringify({ scripts: { test: "exit 1" } }));
  const plan = await planRepositoryTests(root);
  assert.deepEqual(plan.profiles.map((item) => item.cwd), ["apps/web", "packages/cli"]);
  assert.deepEqual(plan.profiles.map((item) => item.args), [["run", "test"], ["run", "test"]]);
  assert.equal(plan.warnings.length, 0);
});

test("a root test orchestrator runs once and an explicit contained scope stays scoped", async (t) => {
  const root = await fixture(t);
  await suite(root, ".");
  await suite(root, "apps/web");
  assert.deepEqual((await planRepositoryTests(root)).profiles.map((item) => item.cwd), ["."]);
  assert.deepEqual((await planRepositoryTests(root, { directory: "apps/web" })).profiles.map((item) => item.cwd), ["apps/web"]);
  await assert.rejects(planRepositoryTests(root, { directory: "../elsewhere" }), /inside the repository/);
  if (process.platform !== "win32") {
    await symlink(join(root, "apps"), join(root, "linked"));
    await assert.rejects(planRepositoryTests(root, { directory: "linked/web" }), /symlink/);
  }
});

test("real failing suite is executed once, reported and never repaired; another suite still executes", async (t) => {
  const root = await fixture(t);
  await suite(root, "a-passing");
  await suite(root, "b-failing", true);
  const plan = await planRepositoryTests(root);
  const progress: number[] = [];
  const result = await runOperationalTests({ sessionId: "tests", plan, runner: runner(root), onProgress: async (value) => { progress.push(value.execution.checks.length); } });
  assert.equal(result.status, "completed", "the request to run and report was fulfilled");
  assert.equal(result.verification?.status, "failed");
  assert.equal(result.execution.outcome, "failed");
  assert.deepEqual(result.execution.checks.map((item) => item.outcome), ["passed", "failed"]);
  assert.deepEqual(progress, [1, 2]);
  assert.match(result.summary!, /fixture assertion failure/);
  assert.equal(result.turns, 0);
  assert.equal(result.toolCalls, 0);
  assert.deepEqual(result.edits, []);
});

test("no tests, abort and execution failures cannot produce completed or verified results", async (t) => {
  const root = await fixture(t);
  let called = false;
  const never = { run: async () => { called = true; throw new Error("must not execute"); } };
  const missing = await runOperationalTests({ sessionId: "none", plan: await planRepositoryTests(root), runner: never });
  assert.equal(missing.status, "failed");
  assert.equal(missing.verification?.status, "inconclusive");
  assert.equal(called, false);
  await suite(root, ".");
  const plan = await planRepositoryTests(root);
  const aborted = await runOperationalTests({ sessionId: "abort", plan, runner: never, signal: AbortSignal.abort() });
  assert.equal(aborted.status, "failed");
  assert.equal(called, false);
  const unavailable = await runOperationalTests({ sessionId: "unavailable", plan, runner: { run: async () => { throw new Error("runtime unavailable"); } } });
  assert.equal(unavailable.status, "failed");
  assert.match(unavailable.summary!, /runtime unavailable/);
});

test("the real CLI executes a suite without model credentials and saves actual evidence", async (t) => {
  const root = await fixture(t);
  await suite(root, ".");
  const progressPath = join(root, "progress.json");
  const { stdout } = await exec(process.execPath, [resolve("dist/src/cli.js"), "code", root, objective, "--progress-file", progressPath, "--format", "json"], {
    env: { PATH: process.env["PATH"], ATLAS_TEST_SECRET: "must-not-reach-tests" }, timeout: 20_000,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.status, "completed");
  assert.equal(result.verification.status, "verified");
  assert.equal(result.execution.checks[0].outcome, "passed");
  assert.equal(result.turns, 0);
  assert.equal(result.inputTokens, 0);
  assert.equal(JSON.parse(await readFile(progressPath, "utf8")).execution.checks.length, 1);
  assert.doesNotMatch(stdout, /must-not-reach-tests/);
});
