// Verifier for test-repair tasks.
//
// Usage: node test-repair-check.mjs <workspace> <repo> --base <commit> --fixed <commit>
//          --test <path> --source <path> [--source <path> ...] [--mutate]
//
// The workspace starts at <base> with the sources from <fixed> applied, so the
// stale test fails. The agent must repair the test, not the source. Passing
// the agent's own test is not enough on its own (deleting assertions would do
// that), so the check is:
//   1. every --source is byte-identical to <fixed> (the behaviour change stays);
//   2. the agent's test file passes;
//   3. every test name the stale file shares with the commit's repaired file is
//      still present (no test was deleted to get green);
//   4. a hidden copy of the commit's own repaired test passes beside it;
//   5. with --mutate, the agent's test FAILS once the sources are put back to
//      <base>, so it really checks the new behaviour. Sources are restored.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export function parseArgs(argv) {
  const [workspace, repo, ...rest] = argv;
  const options = { workspace, repo, sources: [], mutate: false };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--mutate") { options.mutate = true; continue; }
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === "--base") options.base = value;
    else if (flag === "--fixed") options.fixed = value;
    else if (flag === "--test") options.test = value;
    else if (flag === "--source") options.sources.push(value);
    else throw new Error(`unknown option ${flag}`);
  }
  if (!workspace || !repo || !options.base || !options.fixed || !options.test || options.sources.length === 0) {
    throw new Error("usage: test-repair-check.mjs <workspace> <repo> --base <commit> --fixed <commit> --test <path> --source <path>... [--mutate]");
  }
  return options;
}

/** Names passed to test("...") / it("...") in a node:test file. */
export function testNames(text) {
  return new Set([...text.matchAll(/\b(?:test|it)\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/gu)].map((match) => match[2]));
}

function inside(root, path) {
  const target = resolve(root, path);
  if (!target.startsWith(resolve(root) + sep)) throw new Error(`path escapes the workspace: ${path}`);
  return target;
}

function show(repo, commit, path) {
  const result = spawnSync("git", ["-C", repo, "show", `${commit}:${path}`], { maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

function runTest(workspace, file) {
  const result = spawnSync(process.execPath, ["--test", file], { cwd: workspace, encoding: "utf8", timeout: 240_000, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, tail: `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-1500) };
}

export function check(options) {
  const { workspace, repo, base, fixed, test, sources, mutate } = options;
  const failures = [];
  const testPath = inside(workspace, test);
  const fixedSources = new Map();
  for (const source of sources) {
    const expected = show(repo, fixed, source);
    if (expected === null) throw new Error(`${source} does not exist at ${fixed}`);
    fixedSources.set(source, expected);
    const target = inside(workspace, source);
    if (!existsSync(target) || !readFileSync(target).equals(expected)) failures.push(`${source} was changed; repair the test, not the source`);
  }
  if (failures.length > 0) return failures;
  if (!existsSync(testPath)) return [`${test} is missing`];

  const own = runTest(workspace, test);
  if (!own.ok) return [`${test} does not pass:\n${own.tail}`];

  const stale = show(repo, base, test);
  const repaired = show(repo, fixed, test);
  if (repaired === null) throw new Error(`${test} does not exist at ${fixed}`);
  const kept = testNames(readFileSync(testPath, "utf8"));
  const repairedNames = testNames(repaired.toString("utf8"));
  for (const name of stale ? testNames(stale.toString("utf8")) : []) {
    if (repairedNames.has(name) && !kept.has(name)) failures.push(`test removed instead of repaired: ${name}`);
  }

  const hidden = join(dirname(testPath), `.eval-hidden-${process.pid}.test.mjs`);
  try {
    writeFileSync(hidden, repaired);
    const reference = runTest(workspace, hidden);
    if (!reference.ok) failures.push(`the reference test does not pass against the workspace sources:\n${reference.tail}`);
  } finally {
    rmSync(hidden, { force: true });
  }

  if (mutate && failures.length === 0) {
    try {
      for (const source of sources) {
        const target = inside(workspace, source);
        const old = show(repo, base, source);
        if (old === null) rmSync(target, { force: true });
        else writeFileSync(target, old);
      }
      if (runTest(workspace, test).ok) failures.push(`${test} still passes against the old source, so it does not check the new behaviour`);
    } finally {
      for (const [source, content] of fixedSources) {
        const target = inside(workspace, source);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
    }
  }
  return failures;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("\\").join("/").split("/").pop())) {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exit(2); }
  const failures = check(options);
  if (failures.length > 0) { console.error(failures.join("\n")); process.exit(1); }
  console.log("test repaired: it passes, keeps its tests, agrees with the reference" + (options.mutate ? " and fails against the old source" : ""));
}
