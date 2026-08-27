import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RepositoryWorkspaceDetector } from "../src/infrastructure/repository-workspace-detector.js";

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), "atlas-workspace-"));
}

test("detects multiple package-manager lockfiles at the repository root", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package-lock.json"), "{}", "utf8");
  await writeFile(join(root, "Cargo.lock"), "", "utf8");
  await writeFile(join(root, "go.sum"), "", "utf8");
  await writeFile(join(root, "Gemfile.lock"), "", "utf8");

  const summary = await new RepositoryWorkspaceDetector().detect(root);

  assert.deepEqual(
    [...summary.lockfiles].sort((left, right) => left.path.localeCompare(right.path)),
    [
      { path: "Cargo.lock", packageManager: "cargo" },
      { path: "Gemfile.lock", packageManager: "bundler" },
      { path: "go.sum", packageManager: "go" },
      { path: "package-lock.json", packageManager: "npm" },
    ],
  );
  assert.deepEqual(summary.workspaceDeclarations, []);
  assert.equal(summary.schemaVersion, 1);
});

test("detects npm workspaces declared as a string array", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "root", workspaces: ["packages/*", "apps/*"] }),
    "utf8",
  );

  const summary = await new RepositoryWorkspaceDetector().detect(root);

  assert.deepEqual(summary.workspaceDeclarations, [
    { manifestPath: "package.json", kind: "npm-workspaces", patterns: ["packages/*", "apps/*"] },
  ]);
});

test("detects npm workspaces declared as { packages: [...] }", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "root", workspaces: { packages: ["packages/*"] } }),
    "utf8",
  );

  const summary = await new RepositoryWorkspaceDetector().detect(root);

  assert.deepEqual(summary.workspaceDeclarations, [
    { manifestPath: "package.json", kind: "npm-workspaces", patterns: ["packages/*"] },
  ]);
});

test("detects pnpm-workspace.yaml package patterns", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "pnpm-workspace.yaml"),
    "packages:\n  - 'packages/*'\n  - \"apps/*\"\n",
    "utf8",
  );

  const summary = await new RepositoryWorkspaceDetector().detect(root);

  assert.deepEqual(summary.workspaceDeclarations, [
    {
      manifestPath: "pnpm-workspace.yaml",
      kind: "pnpm-workspaces",
      patterns: ["packages/*", "apps/*"],
    },
  ]);
});

test("detects pnpm-workspace.yaml flow-style package patterns", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['packages/*', 'apps/*']\n", "utf8");

  const summary = await new RepositoryWorkspaceDetector().detect(root);

  assert.deepEqual(summary.workspaceDeclarations, [
    {
      manifestPath: "pnpm-workspace.yaml",
      kind: "pnpm-workspaces",
      patterns: ["packages/*", "apps/*"],
    },
  ]);
});

test("detects Cargo.toml [workspace] members", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "Cargo.toml"),
    '[workspace]\nmembers = [\n  "crates/a",\n  "crates/b",\n]\n',
    "utf8",
  );

  const summary = await new RepositoryWorkspaceDetector().detect(root);

  assert.deepEqual(summary.workspaceDeclarations, [
    { manifestPath: "Cargo.toml", kind: "cargo-workspace", patterns: ["crates/a", "crates/b"] },
  ]);
});

test("does not throw on malformed JSON or YAML and records a warning instead", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), "{ not valid json", "utf8");

  const summary = await new RepositoryWorkspaceDetector().detect(root);

  assert.deepEqual(summary.workspaceDeclarations, []);
  assert.ok(
    summary.warnings.some(
      (warning) => warning.code === "MANIFEST_PARSE_FAILED" && warning.message.includes("package.json"),
    ),
  );
});

test("does not throw on a pnpm-workspace.yaml or Cargo.toml without a recognizable list", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pnpm-workspace.yaml"), "not: a\nvalid: shape\n", "utf8");
  await writeFile(join(root, "Cargo.toml"), "[package]\nname = \"example\"\n", "utf8");

  const summary = await new RepositoryWorkspaceDetector().detect(root);

  assert.deepEqual(summary.workspaceDeclarations, []);
});

test("returns an empty summary for a repository with no lockfiles or workspace manifests", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "README.md"), "hello", "utf8");

  const summary = await new RepositoryWorkspaceDetector().detect(root);

  assert.deepEqual(summary, {
    schemaVersion: 1,
    lockfiles: [],
    workspaceDeclarations: [],
    warnings: [],
  });
});
