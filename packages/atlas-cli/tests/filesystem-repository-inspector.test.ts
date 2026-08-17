import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { FilesystemRepositoryInspector } from "../src/infrastructure/filesystem-repository-inspector.js";
import { GitClient } from "../src/infrastructure/git-client.js";
import {
  nodeRepositoryFileSystem,
  type RepositoryFileSystem,
} from "../src/infrastructure/repository-file-system.js";

const execFileAsync = promisify(execFile);

test("summarizes files without following ignored dependency directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-inspect-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "src", "index.ts"), "export {};\n");
    await writeFile(join(root, "node_modules", "ignored.js"), "");

    const summary = await new FilesystemRepositoryInspector().inspect(root);

    assert.equal(summary.schemaVersion, 1);
    assert.equal(summary.fileCount, 2);
    assert.deepEqual(summary.languages, [{ name: "TypeScript", fileCount: 1 }]);
    assert.deepEqual(summary.manifests, [{ path: "package.json", kind: "Node.js" }]);
    assert.deepEqual(summary.frameworks, []);
    assert.deepEqual(summary.architecture, [{ path: "src", role: "source" }]);
    assert.deepEqual(summary.topLevelDirectories, ["src"]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("detects frameworks and conventional architecture from repository evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-frameworks-"));
  try {
    await mkdir(join(root, "apps", "web", "src"), { recursive: true });
    await mkdir(join(root, "services"));
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "package.json"), JSON.stringify({
      dependencies: { next: "1.0.0", react: "1.0.0" },
      devDependencies: { vite: "1.0.0" },
    }));
    await writeFile(join(root, "vite.config.ts"), "export default {};\n");

    const summary = await new FilesystemRepositoryInspector().inspect(root);

    assert.deepEqual(summary.frameworks, [
      { name: "Next.js", evidence: ["package.json"] },
      { name: "React", evidence: ["package.json"] },
      { name: "Vite", evidence: ["vite.config.ts"] },
    ]);
    assert.deepEqual(summary.architecture, [
      { path: join("apps"), role: "applications" },
      { path: join("apps", "web", "src"), role: "source" },
      { path: join("services"), role: "services" },
      { path: join("tests"), role: "tests" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("warns instead of failing on a malformed package manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-malformed-"));
  try {
    await writeFile(join(root, "package.json"), "{not-json");

    const summary = await new FilesystemRepositoryInspector().inspect(root);

    assert.deepEqual(summary.frameworks, []);
    assert.equal(summary.warnings[0]?.code, "MANIFEST_PARSE_FAILED");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("uses Git ignore rules from root and nested ignore files", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-ignore-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "ignored"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, ".gitignore"), "ignored/\n*.tmp\n");
    await writeFile(join(root, "src", "kept.ts"), "export {};\n");
    await writeFile(join(root, "root.tmp"), "ignored\n");
    await writeFile(join(root, "ignored", "package.json"), "{not-json");
    await writeFile(join(root, "nested", ".gitignore"), "*.log\n");
    await writeFile(join(root, "nested", "kept.py"), "pass\n");
    await writeFile(join(root, "nested", "ignored.log"), "ignored\n");
    await execFileAsync("git", ["init", "--quiet", root], { windowsHide: true });

    const summary = await new FilesystemRepositoryInspector().inspect(root);

    assert.equal(summary.git.isRepository, true);
    assert.equal(summary.fileCount, 4);
    assert.deepEqual(summary.languages, [
      { name: "Python", fileCount: 1 },
      { name: "TypeScript", fileCount: 1 },
    ]);
    assert.deepEqual(summary.manifests, []);
    assert.deepEqual(summary.architecture, [{ path: "src", role: "source" }]);
    assert.deepEqual(summary.warnings, []);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("reports when its file scan limit is reached", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-limit-"));
  try {
    await writeFile(join(root, "one.ts"), "");
    await writeFile(join(root, "two.ts"), "");
    const inspector = new FilesystemRepositoryInspector(undefined, { maxFiles: 1, maxDepth: 2 });

    const summary = await inspector.inspect(root);

    assert.equal(summary.fileCount, 1);
    assert.equal(summary.warnings[0]?.code, "SCAN_LIMIT_REACHED");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("warns and falls back to filesystem inspection when Git is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-no-git-inspection-"));
  try {
    await writeFile(join(root, "index.ts"), "export {};\n");
    const inspector = new FilesystemRepositoryInspector(
      new GitClient("atlas-command-that-does-not-exist"),
    );

    const summary = await inspector.inspect(root);

    assert.equal(summary.git.isAvailable, false);
    assert.equal(summary.fileCount, 1);
    assert.equal(summary.warnings[0]?.code, "GIT_UNAVAILABLE");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("warns when directory depth truncates inspection", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-depth-"));
  try {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "root.ts"), "export {};\n");
    await writeFile(join(root, "nested", "hidden.ts"), "export {};\n");
    const inspector = new FilesystemRepositoryInspector(undefined, { maxFiles: 10, maxDepth: 0 });

    const summary = await inspector.inspect(root);

    assert.equal(summary.fileCount, 1);
    assert.equal(summary.warnings[0]?.code, "DEPTH_LIMIT_REACHED");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("continues after a recoverable directory read failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-unreadable-"));
  try {
    const blockedPath = join(root, "blocked");
    await mkdir(blockedPath);
    await writeFile(join(blockedPath, "secret.ts"), "export {};\n");
    await writeFile(join(root, "visible.py"), "pass\n");
    const fileSystem: RepositoryFileSystem = {
      ...nodeRepositoryFileSystem,
      readDirectory: async (path) => {
        if (path === blockedPath) throw new Error("simulated access failure");
        return nodeRepositoryFileSystem.readDirectory(path);
      },
    };
    const inspector = new FilesystemRepositoryInspector(
      undefined,
      undefined,
      undefined,
      fileSystem,
    );

    const summary = await inspector.inspect(root);

    assert.equal(summary.fileCount, 1);
    assert.deepEqual(summary.languages, [{ name: "Python", fileCount: 1 }]);
    assert.equal(summary.warnings[0]?.code, "PATH_UNREADABLE");
    assert.match(summary.warnings[0]?.message ?? "", /blocked/u);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
