import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveOwners } from "../src/domain/repository-ownership.js";
import { CodeownersOwnershipResolver } from "../src/infrastructure/codeowners-ownership-resolver.js";

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), "atlas-codeowners-"));
}

test("returns an empty index when no CODEOWNERS file is present", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const index = await new CodeownersOwnershipResolver().load(root);

  assert.equal(index.sourcePath, null);
  assert.deepEqual(index.entries, []);
});

test(".github/CODEOWNERS takes priority over a root-level CODEOWNERS file", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".github"));
  await writeFile(join(root, ".github", "CODEOWNERS"), "* @github-owner\n", "utf8");
  await writeFile(join(root, "CODEOWNERS"), "* @root-owner\n", "utf8");

  const index = await new CodeownersOwnershipResolver().load(root);

  assert.equal(index.sourcePath, ".github/CODEOWNERS");
  assert.deepEqual(resolveOwners(index, "README.md"), ["@github-owner"]);
});

test("falls back to root CODEOWNERS, then docs/CODEOWNERS, in priority order", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "CODEOWNERS"), "* @docs-owner\n", "utf8");

  const docsOnly = await new CodeownersOwnershipResolver().load(root);
  assert.equal(docsOnly.sourcePath, "docs/CODEOWNERS");
  assert.deepEqual(resolveOwners(docsOnly, "README.md"), ["@docs-owner"]);

  await writeFile(join(root, "CODEOWNERS"), "* @root-owner\n", "utf8");
  const rootBeatsDocs = await new CodeownersOwnershipResolver().load(root);
  assert.equal(rootBeatsDocs.sourcePath, "CODEOWNERS");
  assert.deepEqual(resolveOwners(rootBeatsDocs, "README.md"), ["@root-owner"]);
});

test("skips blank lines and comment lines", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "CODEOWNERS"),
    [
      "# top-level comment",
      "",
      "   ",
      "*.ts @ts-owner",
      "# trailing comment",
    ].join("\n"),
    "utf8",
  );

  const index = await new CodeownersOwnershipResolver().load(root);

  assert.equal(index.entries.length, 1);
  assert.equal(index.entries[0]?.pattern, "*.ts");
  assert.equal(index.entries[0]?.lineNumber, 4);
  assert.deepEqual(resolveOwners(index, "src/index.ts"), ["@ts-owner"]);
});

test("skips malformed lines (a pattern with no owners) without throwing", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "CODEOWNERS"),
    ["*.ts @ts-owner", "*.md", "*.js @js-owner"].join("\n"),
    "utf8",
  );

  const index = await new CodeownersOwnershipResolver().load(root);

  assert.equal(index.entries.length, 2);
  assert.deepEqual(
    index.entries.map((entry) => entry.pattern),
    ["*.ts", "*.js"],
  );
});

test("a later matching pattern overrides an earlier one when loaded from disk", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "CODEOWNERS"),
    ["* @everyone", "/src/ @src-team"].join("\n"),
    "utf8",
  );

  const index = await new CodeownersOwnershipResolver().load(root);

  assert.deepEqual(resolveOwners(index, "src/index.ts"), ["@src-team"]);
  assert.deepEqual(resolveOwners(index, "README.md"), ["@everyone"]);
});

test("never throws on an oversized CODEOWNERS file; treats it as absent", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const oversized = `${"a".repeat(1024 * 1024 + 1)} @owner\n`;
  await writeFile(join(root, "CODEOWNERS"), oversized, "utf8");

  const index = await new CodeownersOwnershipResolver().load(root);

  assert.equal(index.sourcePath, null);
  assert.deepEqual(index.entries, []);
});

test("never throws when the repository path itself does not exist", async () => {
  const missingRoot = join(tmpdir(), "atlas-codeowners-does-not-exist-xyz");

  const index = await new CodeownersOwnershipResolver().load(missingRoot);

  assert.equal(index.sourcePath, null);
  assert.deepEqual(index.entries, []);
});
