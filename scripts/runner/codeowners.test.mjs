import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Every CODEOWNERS entry must still match a tracked file. A protected file
// that is renamed or moved would otherwise lose owner review silently: the
// old path matches nothing and GitHub raises no error.

const root = fileURLToPath(new URL("../../", import.meta.url));
const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
const entries = readFileSync(`${root}.github/CODEOWNERS`, "utf8").split("\n")
  .map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
  .map((line) => { const [pattern, ...owners] = line.split(/\s+/u); return { pattern, owners }; });

test("CODEOWNERS entries are anchored paths with an owner", () => {
  assert.ok(entries.length > 0);
  for (const { pattern, owners } of entries) {
    assert.ok(pattern.startsWith("/"), `${pattern} must be anchored at the repository root`);
    assert.ok(!/[*?[]/u.test(pattern), `${pattern}: use a plain file or directory path so this test can check it`);
    assert.ok(owners.length > 0 && owners.every((owner) => owner.startsWith("@")), `${pattern} needs an @owner`);
  }
});

test("every CODEOWNERS entry still protects at least one tracked file", () => {
  const unmatched = entries.map(({ pattern }) => pattern).filter((pattern) => {
    const path = pattern.slice(1);
    return path.endsWith("/") ? !tracked.some((file) => file.startsWith(path)) : !tracked.includes(path);
  });
  assert.deepEqual(unmatched, [], `These CODEOWNERS entries match no file: ${unmatched.join(", ")}`);
});
