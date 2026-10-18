import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@invalid", ...args], { cwd, encoding: "utf8" }).trim();

/** A throwaway repo: commit 1 has a broken add(); commit 2 fixes it and adds the test. */
export async function fixtureRepo() {
  const root = await mkdtemp(join(tmpdir(), "eval-fixture-"));
  const put = async (path, content) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); };
  git(root, "init", "-q");
  await put("add.mjs", "export const add = (a, b) => a - b;\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD");
  await put("add.mjs", "export const add = (a, b) => a + b;\n");
  await put("add.test.mjs", 'import test from "node:test"; import assert from "node:assert/strict"; import { add } from "./add.mjs"; test("adds", () => assert.equal(add(2, 3), 5));\n');
  git(root, "add", "-A"); git(root, "commit", "-qm", "fix");
  const fix = git(root, "rev-parse", "HEAD");
  const task = {
    id: "fix-add", category: "bug-localization", repo: "fixture/repo", baseCommit: base,
    objective: "add() subtracts instead of adding; fix it so add.test.mjs passes.",
    setup: { fromCommit: fix, paths: ["add.test.mjs"] },
    verify: { argv: [process.execPath, "--test", "add.test.mjs"] },
    solution: { fromCommit: fix, paths: ["add.mjs"] }, timeoutMs: 20000, tags: [],
  };
  return { root, base, fix, task };
}
