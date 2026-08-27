import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DetectedRepositoryCommand } from "../src/domain/repository-commands.js";
import { RepositoryCommandDetector } from "../src/infrastructure/repository-command-detector.js";

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), "atlas-commands-"));
}

function findCommand(
  commands: readonly DetectedRepositoryCommand[],
  source: string,
  name: string,
): DetectedRepositoryCommand | undefined {
  return commands.find((command) => command.source === source && command.name === name);
}

test("classifies package.json scripts across all known categories", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      scripts: {
        build: "tsc -p tsconfig.json",
        test: "node --test dist/**/*.test.js",
        lint: "eslint .",
        format: "prettier --check .",
        typecheck: "tsc --noEmit",
        dev: "vite --watch",
        release: "changeset publish",
      },
    }),
    "utf8",
  );

  const summary = await new RepositoryCommandDetector().detect(root);

  assert.equal(summary.schemaVersion, 1);
  assert.equal(findCommand(summary.commands, "package.json", "build")?.category, "build");
  assert.equal(findCommand(summary.commands, "package.json", "test")?.category, "test");
  assert.equal(findCommand(summary.commands, "package.json", "lint")?.category, "lint");
  assert.equal(findCommand(summary.commands, "package.json", "format")?.category, "format");
  assert.equal(findCommand(summary.commands, "package.json", "typecheck")?.category, "typecheck");
  assert.equal(findCommand(summary.commands, "package.json", "dev")?.category, "dev");
  assert.equal(findCommand(summary.commands, "package.json", "release")?.category, "other");
  assert.equal(summary.commands.length, 7);
});

test("detects Makefile targets and excludes dot-prefixed internal targets", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "Makefile"),
    [
      ".PHONY: build test",
      "build:",
      "\ttsc -p tsconfig.json",
      "",
      "test: build",
      "\tnode --test dist",
      "",
      ".DEFAULT_GOAL := build",
      "",
      "VAR := value",
      "",
      "lint:",
      "\teslint .",
    ].join("\n"),
    "utf8",
  );

  const summary = await new RepositoryCommandDetector().detect(root);

  const names = summary.commands
    .filter((command) => command.source === "Makefile")
    .map((command) => command.name);
  assert.deepEqual(names.sort(), ["build", "lint", "test"]);
  assert.equal(findCommand(summary.commands, "Makefile", "build")?.category, "build");
  assert.equal(findCommand(summary.commands, "Makefile", "test")?.category, "test");
  assert.equal(findCommand(summary.commands, "Makefile", "lint")?.category, "lint");
  assert.equal(names.some((name) => name.startsWith(".")), false);
  assert.equal(
    summary.commands.some((command) => command.source === "Makefile" && command.name === "VAR"),
    false,
  );
});

test("returns an empty summary when no relevant files are present", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const summary = await new RepositoryCommandDetector().detect(root);

  assert.deepEqual(summary, { schemaVersion: 1, commands: [] });
});

test("does not throw on a malformed package.json", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), "{ not valid json", "utf8");

  const summary = await new RepositoryCommandDetector().detect(root);

  assert.deepEqual(summary.commands, []);
});

test("parses a minimal pyproject.toml scripts table", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "pyproject.toml"),
    [
      "[tool.poetry]",
      'name = "example"',
      "",
      "[tool.poetry.scripts]",
      'example-cli = "example.cli:main"',
      "",
      "[project.scripts]",
      'lint-all = "ruff check ."',
    ].join("\n"),
    "utf8",
  );

  const summary = await new RepositoryCommandDetector().detect(root);

  assert.equal(findCommand(summary.commands, "pyproject.toml", "example-cli")?.command, "example.cli:main");
  assert.equal(findCommand(summary.commands, "pyproject.toml", "lint-all")?.category, "lint");
});

test("does not throw on a malformed pyproject.toml", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pyproject.toml"), "[[[not valid toml", "utf8");

  const summary = await new RepositoryCommandDetector().detect(root);

  assert.deepEqual(summary.commands, []);
});
