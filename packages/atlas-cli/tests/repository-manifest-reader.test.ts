import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ManifestDependency } from "../src/domain/repository-manifest.js";
import { RepositoryManifestReader } from "../src/infrastructure/repository-manifest-reader.js";

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), "atlas-manifest-"));
}

function findDependency(
  dependencies: readonly ManifestDependency[],
  name: string,
): ManifestDependency | undefined {
  return dependencies.find((dependency) => dependency.name === name);
}

test("parses a Node.js package.json manifest", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "example-app",
      version: "1.2.3",
      dependencies: { express: "^4.18.0", react: "^18.0.0" },
      devDependencies: { typescript: "^5.7.0" },
    }),
    "utf8",
  );

  const summary = await new RepositoryManifestReader().read(root);

  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.manifests.length, 1);
  const manifest = summary.manifests[0];
  assert.ok(manifest);
  assert.equal(manifest.ecosystem, "npm");
  assert.equal(manifest.path, "package.json");
  assert.equal(manifest.name, "example-app");
  assert.equal(manifest.version, "1.2.3");
  assert.deepEqual(manifest.dependencies, [
    { name: "express", versionRange: "^4.18.0" },
    { name: "react", versionRange: "^18.0.0" },
  ]);
  assert.deepEqual(manifest.devDependencies, [{ name: "typescript", versionRange: "^5.7.0" }]);
});

test("parses a PEP 621 pyproject.toml manifest", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "pyproject.toml"),
    [
      "[project]",
      'name = "example-lib"',
      'version = "0.4.0"',
      "dependencies = [",
      '  "requests>=2.28,<3.0",',
      '  "click",',
      "]",
      "",
    ].join("\n"),
    "utf8",
  );

  const summary = await new RepositoryManifestReader().read(root);

  assert.equal(summary.manifests.length, 1);
  const manifest = summary.manifests[0];
  assert.ok(manifest);
  assert.equal(manifest.ecosystem, "python-pep621");
  assert.equal(manifest.name, "example-lib");
  assert.equal(manifest.version, "0.4.0");
  assert.deepEqual(findDependency(manifest.dependencies, "click"), {
    name: "click",
    versionRange: null,
  });
  assert.deepEqual(findDependency(manifest.dependencies, "requests"), {
    name: "requests",
    versionRange: ">=2.28,<3.0",
  });
  assert.equal(manifest.devDependencies.length, 0);
});

test("parses a Poetry-style pyproject.toml manifest", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "pyproject.toml"),
    [
      "[tool.poetry]",
      'name = "example-service"',
      'version = "2.1.0"',
      "",
      "[tool.poetry.dependencies]",
      'python = "^3.11"',
      'requests = "^2.28"',
      "",
      "[tool.poetry.dev-dependencies]",
      'pytest = "^7.0"',
      "",
    ].join("\n"),
    "utf8",
  );

  const summary = await new RepositoryManifestReader().read(root);

  assert.equal(summary.manifests.length, 1);
  const manifest = summary.manifests[0];
  assert.ok(manifest);
  assert.equal(manifest.ecosystem, "python-poetry");
  assert.equal(manifest.name, "example-service");
  assert.equal(manifest.version, "2.1.0");
  assert.equal(findDependency(manifest.dependencies, "python"), undefined);
  assert.deepEqual(findDependency(manifest.dependencies, "requests"), {
    name: "requests",
    versionRange: "^2.28",
  });
  assert.deepEqual(manifest.devDependencies, [{ name: "pytest", versionRange: "^7.0" }]);
});

test("parses a Cargo.toml manifest", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "Cargo.toml"),
    [
      "[package]",
      'name = "example-crate"',
      'version = "0.9.1"',
      "",
      "[dependencies]",
      'serde = { version = "1.0", features = ["derive"] }',
      'log = "0.4"',
      "",
      "[dev-dependencies]",
      'criterion = "0.5"',
      "",
    ].join("\n"),
    "utf8",
  );

  const summary = await new RepositoryManifestReader().read(root);

  assert.equal(summary.manifests.length, 1);
  const manifest = summary.manifests[0];
  assert.ok(manifest);
  assert.equal(manifest.ecosystem, "cargo");
  assert.equal(manifest.name, "example-crate");
  assert.equal(manifest.version, "0.9.1");
  assert.deepEqual(findDependency(manifest.dependencies, "log"), {
    name: "log",
    versionRange: "0.4",
  });
  assert.deepEqual(findDependency(manifest.dependencies, "serde"), {
    name: "serde",
    versionRange: "1.0",
  });
  assert.deepEqual(manifest.devDependencies, [{ name: "criterion", versionRange: "0.5" }]);
});

test("parses a go.mod manifest with a require block", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "go.mod"),
    [
      "module github.com/example/service",
      "",
      "go 1.21",
      "",
      "require (",
      "\tgithub.com/gin-gonic/gin v1.9.1",
      "\tgithub.com/stretchr/testify v1.8.4 // indirect",
      ")",
      "",
      "require golang.org/x/sync v0.5.0",
      "",
    ].join("\n"),
    "utf8",
  );

  const summary = await new RepositoryManifestReader().read(root);

  assert.equal(summary.manifests.length, 1);
  const manifest = summary.manifests[0];
  assert.ok(manifest);
  assert.equal(manifest.ecosystem, "go");
  assert.equal(manifest.name, "github.com/example/service");
  assert.equal(manifest.version, null);
  assert.deepEqual(findDependency(manifest.dependencies, "github.com/gin-gonic/gin"), {
    name: "github.com/gin-gonic/gin",
    versionRange: "v1.9.1",
  });
  assert.deepEqual(findDependency(manifest.dependencies, "github.com/stretchr/testify"), {
    name: "github.com/stretchr/testify",
    versionRange: "v1.8.4",
  });
  assert.deepEqual(findDependency(manifest.dependencies, "golang.org/x/sync"), {
    name: "golang.org/x/sync",
    versionRange: "v0.5.0",
  });
  assert.equal(manifest.devDependencies.length, 0);
});

test("parses a requirements.txt manifest", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "requirements.txt"),
    [
      "# top-level comment",
      "requests>=2.28,<3.0",
      "click",
      "-r dev-requirements.txt",
      "flask==2.3.0  # pinned",
      "",
    ].join("\n"),
    "utf8",
  );

  const summary = await new RepositoryManifestReader().read(root);

  assert.equal(summary.manifests.length, 1);
  const manifest = summary.manifests[0];
  assert.ok(manifest);
  assert.equal(manifest.ecosystem, "python-requirements");
  assert.equal(manifest.name, null);
  assert.equal(manifest.version, null);
  assert.equal(manifest.dependencies.length, 3);
  assert.deepEqual(findDependency(manifest.dependencies, "requests"), {
    name: "requests",
    versionRange: ">=2.28,<3.0",
  });
  assert.deepEqual(findDependency(manifest.dependencies, "click"), {
    name: "click",
    versionRange: null,
  });
  assert.deepEqual(findDependency(manifest.dependencies, "flask"), {
    name: "flask",
    versionRange: "==2.3.0",
  });
  assert.equal(manifest.devDependencies.length, 0);
});

test("skips a malformed package.json without throwing", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), "{ this is not valid json", "utf8");

  const warnings: import("../src/domain/repository-summary.js").InspectionWarning[] = [];
  const summary = await new RepositoryManifestReader().read(root, warnings);

  assert.deepEqual(summary, { schemaVersion: 1, manifests: [] });
  assert.ok(warnings.some((warning) => warning.code === "MANIFEST_PARSE_FAILED"));
});

test("returns an empty summary when no manifests are present", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const summary = await new RepositoryManifestReader().read(root);

  assert.deepEqual(summary, { schemaVersion: 1, manifests: [] });
});
