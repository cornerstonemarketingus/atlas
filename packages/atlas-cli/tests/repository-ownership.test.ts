import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveOwners,
  type RepositoryOwnershipIndex,
} from "../src/domain/repository-ownership.js";

function indexOf(
  entries: RepositoryOwnershipIndex["entries"],
  sourcePath: string | null = ".github/CODEOWNERS",
): RepositoryOwnershipIndex {
  return { schemaVersion: 1, sourcePath, entries };
}

test("a path matching no pattern resolves to an empty owners list", () => {
  const index = indexOf([{ pattern: "*.md", owners: ["@docs-team"], lineNumber: 1 }]);
  assert.deepEqual(resolveOwners(index, "src/index.ts"), []);
});

test("an empty index (no CODEOWNERS file) resolves to an empty owners list", () => {
  const index = indexOf([], null);
  assert.deepEqual(resolveOwners(index, "src/index.ts"), []);
});

test("a later matching pattern overrides an earlier one", () => {
  const index = indexOf([
    { pattern: "*", owners: ["@everyone"], lineNumber: 1 },
    { pattern: "/src/", owners: ["@src-team"], lineNumber: 2 },
  ]);
  assert.deepEqual(resolveOwners(index, "src/index.ts"), ["@src-team"]);
  assert.deepEqual(resolveOwners(index, "README.md"), ["@everyone"]);
});

test("a leading slash anchors a pattern to the repository root", () => {
  const index = indexOf([{ pattern: "/build", owners: ["@build-team"], lineNumber: 1 }]);
  assert.deepEqual(resolveOwners(index, "build/output.txt"), ["@build-team"]);
  assert.deepEqual(resolveOwners(index, "src/build/output.txt"), []);
});

test("an unanchored pattern matches at any depth", () => {
  const index = indexOf([{ pattern: "*.md", owners: ["@docs-team"], lineNumber: 1 }]);
  assert.deepEqual(resolveOwners(index, "README.md"), ["@docs-team"]);
  assert.deepEqual(resolveOwners(index, "docs/guide/README.md"), ["@docs-team"]);
});

test("a trailing-slash directory pattern matches nested files", () => {
  const index = indexOf([{ pattern: "docs/", owners: ["@docs-team"], lineNumber: 1 }]);
  assert.deepEqual(resolveOwners(index, "docs/guide/README.md"), ["@docs-team"]);
  assert.deepEqual(resolveOwners(index, "docs/README.md"), ["@docs-team"]);
  assert.deepEqual(resolveOwners(index, "other/docs.md"), []);
});

test("a directory pattern does not match a bare file with the same name", () => {
  const index = indexOf([{ pattern: "/vendor/", owners: ["@vendor-team"], lineNumber: 1 }]);
  assert.deepEqual(resolveOwners(index, "vendor"), []);
  assert.deepEqual(resolveOwners(index, "vendor/lib.js"), ["@vendor-team"]);
});

test("multiple owners on a matching pattern are all returned in file order", () => {
  const index = indexOf([
    { pattern: "*.ts", owners: ["@alice", "@bob"], lineNumber: 1 },
  ]);
  assert.deepEqual(resolveOwners(index, "src/index.ts"), ["@alice", "@bob"]);
});

test("a globstar pattern matches across directory boundaries", () => {
  const index = indexOf([{ pattern: "apps/**/logs", owners: ["@sre"], lineNumber: 1 }]);
  assert.deepEqual(resolveOwners(index, "apps/logs"), ["@sre"]);
  assert.deepEqual(resolveOwners(index, "apps/a/b/logs"), ["@sre"]);
  assert.deepEqual(resolveOwners(index, "other/apps/a/logs"), []);
});
