import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { RepositoryImportGraph, testsFor } from "../src/infrastructure/repository-import-graph.js";
import { RepositoryPackageGraph, parseTomlSubset } from "../src/infrastructure/repository-package-graph.js";

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atlas-packages-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

test("discovers npm workspace packages and links internal dependencies with their field", async () => {
  const root = await repository({
    "package.json": json({ name: "monorepo", private: true, workspaces: ["packages/*", "apps/*"], devDependencies: { typescript: "^5.6.0" } }),
    "packages/ui/package.json": json({ name: "@acme/ui", version: "1.2.0", exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } }, peerDependencies: { react: "^19" }, scripts: { build: "tsc", test: "node --test" } }),
    "packages/util/package.json": json({ name: "@acme/util", main: "lib/index.js" }),
    "apps/web/package.json": json({ name: "web", private: true, dependencies: { "@acme/ui": "workspace:*", next: "15.0.0" }, devDependencies: { "@acme/util": "file:../../packages/util" }, bin: { web: "./bin/web.js" } }),
    "node_modules/leftover/package.json": json({ name: "leftover" }),
  });
  try {
    const graph = await new RepositoryPackageGraph().build(root);
    assert.deepEqual(graph.packages.map((item) => item.directory), [".", "apps/web", "packages/ui", "packages/util"], "node_modules is never a package");
    const web = graph.packages.find((item) => item.name === "web")!;
    assert.deepEqual(web.dependencies.map((d) => [d.name, d.range, d.kind, d.internal, d.field]), [
      ["@acme/ui", "workspace:*", "runtime", "packages/ui", "dependencies"],
      ["next", "15.0.0", "runtime", null, "dependencies"],
      ["@acme/util", "file:../../packages/util", "dev", "packages/util", "devDependencies"],
    ]);
    assert.deepEqual(web.entries, [{ field: "bin.web", path: "./bin/web.js" }]);
    const ui = graph.packages.find((item) => item.name === "@acme/ui")!;
    assert.deepEqual(ui.entries.map((entry) => entry.path), ["./dist/index.js", "./dist/index.d.ts"], "import before types");
    assert.deepEqual([ui.version, ui.private, ui.scripts, ui.dependencies[0]?.kind], ["1.2.0", false, ["build", "test"], "peer"]);
    assert.deepEqual(graph.packages[0]!.workspaces, ["packages/*", "apps/*"]);
    assert.deepEqual(graph.edges, [
      { from: "apps/web", to: "packages/ui", name: "@acme/ui", kind: "runtime" },
      { from: "apps/web", to: "packages/util", name: "@acme/util", kind: "dev" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads pnpm workspaces, PEP 621 and Poetry manifests, and reports what it cannot parse", async () => {
  const root = await repository({
    "package.json": json({ name: "root" }),
    "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - \"tools/*\" # comment\nonlyBuiltDependencies: []\n",
    "broken/package.json": "{ not json",
    "services/api/pyproject.toml": [
      "[project]",
      "name = \"acme-api\"",
      "version = \"0.3.0\"",
      "dependencies = [",
      "  \"fastapi>=0.110\",  # web",
      "  \"Acme_Core\",",
      "  \"requests[socks] >=2 ; python_version > '3.8'\",",
      "]",
      "[project.optional-dependencies]",
      "test = [\"pytest\"]",
      "[project.scripts]",
      "acme-api = \"acme_api.cli:main\"",
      "[dependency-groups]",
      "lint = [\"ruff\"]",
    ].join("\n"),
    "libs/core/pyproject.toml": [
      "[tool.poetry]",
      "name = \"acme-core\"",
      "version = \"1.0.0\"",
      "[tool.poetry.dependencies]",
      "python = \"^3.11\"",
      "pydantic = { version = \"^2\", extras = [\"email\"] }",
      "shared = { path = \"../shared\" }",
      "[tool.poetry.group.dev.dependencies]",
      "mypy = \"*\"",
    ].join("\n"),
    "tools/ruff.toml/pyproject.toml": "[tool.ruff]\nline-length = 100\n",
  });
  try {
    const graph = await new RepositoryPackageGraph().build(root);
    assert.deepEqual(graph.packages.find((item) => item.directory === ".")?.workspaces, ["packages/*", "tools/*"]);
    const api = graph.packages.find((item) => item.name === "acme-api")!;
    assert.deepEqual(api.dependencies.map((d) => [d.name, d.range, d.kind, d.internal, d.field]), [
      ["fastapi", ">=0.110", "runtime", null, "project.dependencies"],
      ["Acme_Core", "*", "runtime", "libs/core", "project.dependencies"],
      ["requests", ">=2 ; python_version > '3.8'", "runtime", null, "project.dependencies"],
      ["pytest", "*", "optional", null, "project.optional-dependencies.test"],
      ["ruff", "*", "dev", null, "dependency-groups.lint"],
    ]);
    assert.deepEqual(api.entries, [{ field: "scripts.acme-api", path: "acme_api.cli:main" }]);
    const core = graph.packages.find((item) => item.name === "acme-core")!;
    assert.deepEqual(core.dependencies.map((d) => [d.name, d.range, d.kind]), [["pydantic", "^2", "runtime"], ["shared", "file:../shared", "runtime"], ["mypy", "*", "dev"]]);
    assert.ok(!graph.packages.some((item) => item.directory === "tools/ruff.toml"), "a pyproject with only tool settings is not a package");
    assert.ok(graph.warnings.some((warning) => warning.code === "MANIFEST_UNPARSEABLE" && warning.message.includes("broken/package.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the import graph resolves workspace package specifiers to their source", async () => {
  const root = await repository({
    "package.json": json({ name: "monorepo", workspaces: ["packages/*"] }),
    "packages/ui/package.json": json({ name: "@acme/ui", exports: { ".": { import: "./dist/index.js" } } }),
    "packages/ui/src/index.ts": "export { Button } from \"./button.js\";\n",
    "packages/ui/src/button.ts": "export const Button = 1;\n",
    "packages/ui/src/theme/colors.ts": "export const colors = {};\n",
    "packages/uikit/package.json": json({ name: "@acme/uikit" }),
    "packages/uikit/index.js": "module.exports = {};\n",
    "apps/web/page.ts": "import { Button } from \"@acme/ui\";\nimport { colors } from \"@acme/ui/theme/colors\";\nimport kit from \"@acme/uikit\";\nimport react from \"react\";\n",
    "apps/web/page.test.ts": "import \"./page.js\";\n",
  });
  try {
    const graph = await new RepositoryImportGraph().build(root);
    const edge = (specifier: string) => graph.edges.find((item) => item.from === "apps/web/page.ts" && item.specifier === specifier);
    assert.equal(edge("@acme/ui")?.to, "packages/ui/src/index.ts", "dist/index.js maps back to src/index.ts");
    assert.equal(edge("@acme/ui/theme/colors")?.to, "packages/ui/src/theme/colors.ts");
    assert.equal(edge("@acme/uikit")?.to, "packages/uikit/index.js", "a package whose name extends another's resolves to itself");
    assert.equal(edge("react")?.kind, "package");
    assert.deepEqual(testsFor(graph, "packages/ui/src/button.ts").tests.map((item) => item.test), ["apps/web/page.test.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the TOML subset reads strings, literals, arrays across lines, inline tables and quoted keys", () => {
  const tables = parseTomlSubset([
    "title = 'x # not a comment' # a comment",
    "[a.\"b.c\"]",
    "list = [",
    "  \"one\", 'two',",
    "  [\"nested\"],",
    "]",
    "table = { k = \"v\", n = 1, on = true }",
    "\"quoted key\" = \"q\\\"uote\"",
  ].join("\n"));
  assert.equal(tables.get("")?.["title"], "x # not a comment");
  assert.deepEqual(tables.get("a.b.c"), { list: ["one", "two", ["nested"]], table: { k: "v", n: 1, on: true }, "quoted key": "q\"uote" });
});
