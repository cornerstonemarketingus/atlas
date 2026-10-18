import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runTask, validateFixture } from "../src/index.mjs";

const verifiers = fileURLToPath(new URL("../../../evals/verifiers/", import.meta.url));
const { parseArgs, testNames } = await import(join(verifiers, "test-repair-check.mjs"));
const { CHECKS, secretsIn } = await import(join(verifiers, "answer-check.mjs"));
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@invalid", ...args], { cwd, encoding: "utf8" }).trim();

const staleTest = 'import test from "node:test"; import assert from "node:assert/strict"; import { greet } from "./greet.mjs";\ntest("greets", () => assert.equal(greet(), "hi"));\ntest("is a string", () => assert.equal(typeof greet(), "string"));\n';
const repairedTest = staleTest.replace('"hi"', '"hello"');

/** Commit 1: greet() says "hi" and its test agrees. Commit 2: greet() says "hello" and the test was updated. */
async function repairRepo() {
  const root = await mkdtemp(join(tmpdir(), "eval-repair-"));
  const put = async (path, content) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); };
  git(root, "init", "-q");
  await put("greet.mjs", 'export const greet = () => "hi";\n');
  await put("greet.test.mjs", staleTest);
  git(root, "add", "-A"); git(root, "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD");
  await put("greet.mjs", 'export const greet = () => "hello";\n');
  await put("greet.test.mjs", repairedTest);
  git(root, "add", "-A"); git(root, "commit", "-qm", "say hello");
  const fixed = git(root, "rev-parse", "HEAD");
  const task = {
    id: "greet-test-repair", category: "test-repair", repo: "fixture/repo", baseCommit: base,
    objective: "greet() now says hello on purpose; repair greet.test.mjs without touching greet.mjs.",
    setup: { fromCommit: fixed, paths: ["greet.mjs"] },
    verify: { argv: [process.execPath, join(verifiers, "test-repair-check.mjs"), "{workspace}", "{repo}", "--base", base, "--fixed", fixed, "--test", "greet.test.mjs", "--source", "greet.mjs", "--mutate"] },
    solution: { fromCommit: fixed, paths: ["greet.test.mjs"] }, timeoutMs: 60000, tags: [],
  };
  return { root, task };
}

const editTest = (transform) => async ({ root }) => {
  const path = join(root, "greet.test.mjs");
  await writeFile(path, transform(await readFile(path, "utf8")));
  return { status: "completed" };
};

test("a test-repair task fails untouched and passes with the commit's repaired test", async () => {
  const { root, task } = await repairRepo();
  const report = await validateFixture({ task, repoRoot: root });
  assert.deepEqual(report.problems, []);
});

test("an independent correct repair passes the test-repair check", async () => {
  const { root, task } = await repairRepo();
  const agent = editTest((text) => text.replace('assert.equal(greet(), "hi")', 'assert.match(greet(), /^hello$/u)'));
  assert.equal((await runTask({ task, target: "own-repair", agent, repoRoot: root })).passed, true);
});

test("deleting, weakening the test or reverting the source does not count as a repair", async () => {
  const { root, task } = await repairRepo();
  const cheats = {
    deleted: editTest((text) => text.split("\n").filter((line) => !line.includes('"greets"')).join("\n")),
    weakened: editTest((text) => text.replace('assert.equal(greet(), "hi")', "assert.ok(true)")),
    reverted: async ({ root: ws }) => { await writeFile(join(ws, "greet.mjs"), 'export const greet = () => "hi";\n'); return { status: "completed" }; },
  };
  for (const [name, agent] of Object.entries(cheats)) {
    const result = await runTask({ task, target: name, agent, repoRoot: root });
    assert.equal(result.passed, false, name);
    assert.equal(result.failureClass, "tests_failed", name);
  }
});

test("test names are read from test() and it() calls, and arguments are required", () => {
  assert.deepEqual([...testNames('test("a", () => {});\nit(\'b\', () => {});\ntest(`c ${x}`, fn);')], ["a", "b", "c ${x}"]);
  assert.throws(() => parseArgs(["ws", "repo", "--base", "a", "--fixed", "b", "--test", "t.mjs"]), /usage/u);
  assert.deepEqual(parseArgs(["ws", "repo", "--base", "a", "--fixed", "b", "--test", "t.mjs", "--source", "s.mjs", "--mutate"]).sources, ["s.mjs"]);
});

test("workflow secrets are read only from expressions, never from comments", () => {
  const text = "# uses secrets.IN_A_COMMENT\nenv:\n  A: ${{ secrets.ONE }}\n  B: ${{ secrets.TWO || secrets.ONE }}\n  C: ${{ github.token }}\n";
  assert.deepEqual(secretsIn(text), ["ONE", "TWO"]);
  assert.ok(["report-result-history", "select-migrations-run", "inference-test-summary", "package-inventory", "workflow-secrets", "runner-test-coverage"].every((name) => name in CHECKS));
});

test("a read-only answer may only add ANSWER.json", async () => {
  const { changedSources } = await import(join(verifiers, "answer-check.mjs"));
  const { root } = await repairRepo();
  git(root, "commit", "-q", "--allow-empty", "-m", "eval setup");
  await writeFile(join(root, "ANSWER.json"), "{}\n");
  assert.deepEqual(changedSources(root), []);
  await writeFile(join(root, "greet.mjs"), "export const greet = () => 'changed';\n");
  assert.deepEqual(changedSources(root), ["greet.mjs"]);
  git(root, "add", "greet.mjs"); git(root, "commit", "-qm", "agent commit");
  assert.deepEqual(changedSources(root), ["greet.mjs"], "a committed source change still counts");
});
