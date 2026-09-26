import assert from "node:assert/strict";
import test from "node:test";

import { changedFilesFrom } from "../app/api/tasks/pr-changes.mjs";

test("changed files keep path, status, counts and patch", () => {
  const result = changedFilesFrom([
    { filename: "a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" },
    { filename: "b.ts", previous_filename: "old.ts", status: "renamed", additions: 0, deletions: 0 },
    { filename: "c.png", status: "weird", additions: 0, deletions: 0 },
    { nope: true },
  ]);
  assert.equal(result.files.length, 3);
  assert.deepEqual(result.files[0], { path: "a.ts", previousPath: null, status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b", truncated: false });
  assert.equal(result.files[1].previousPath, "old.ts");
  assert.equal(result.files[1].patch, null);
  assert.equal(result.files[2].status, "modified");
  assert.equal(result.additions, 2);
  assert.equal(result.deletions, 1);
});

test("patches are capped per file and in total", () => {
  const big = "+".repeat(30_000);
  const payload = Array.from({ length: 12 }, (_, index) => ({ filename: `f${index}.ts`, status: "added", additions: 1, deletions: 0, patch: big }));
  const { files } = changedFilesFrom(payload);
  assert.equal(files[0].patch.length, 20_000);
  assert.equal(files[0].truncated, true);
  const total = files.reduce((sum, file) => sum + file.patch.length, 0);
  assert.equal(total, 200_000);
  assert.equal(files.at(-1).patch, "");
  assert.equal(changedFilesFrom(null).files.length, 0);
});
