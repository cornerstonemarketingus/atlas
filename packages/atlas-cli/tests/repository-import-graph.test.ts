import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { RepositoryImportGraph, isTestFile, stripJsonComments, testsFor } from "../src/infrastructure/repository-import-graph.js";

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atlas-imports-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

test("resolves TypeScript and JavaScript imports, including ESM .js specifiers for .ts sources", async () => {
  const root = await repository({
    "src/auth/session.ts": "export const session = 1;\n",
    "src/auth/index.ts": "export * from \"./session.js\";\n",
    "src/api.ts": "import { session } from \"./auth/index.js\";\nimport express from \"express\";\nconst lazy = await import(\"./lazy\");\n",
    "src/lazy.mjs": "export default 1;\n",
    "src/legacy.cjs": "const api = require(\"./api\");\nrequire(\"./missing\");\n",
  });
  try {
    const graph = await new RepositoryImportGraph().build(root);
    const edge = (from: string, specifier: string) => graph.edges.find((item) => item.from === from && item.specifier === specifier);
    assert.equal(edge("src/auth/index.ts", "./session.js")?.to, "src/auth/session.ts");
    assert.equal(edge("src/api.ts", "./auth/index.js")?.to, "src/auth/index.ts");
    assert.deepEqual([edge("src/api.ts", "express")?.kind, edge("src/api.ts", "express")?.to], ["package", null]);
    assert.equal(edge("src/api.ts", "./lazy")?.to, "src/lazy.mjs");
    assert.equal(edge("src/api.ts", "./lazy")?.line, 3);
    assert.equal(edge("src/legacy.cjs", "./api")?.to, "src/api.ts");
    assert.equal(edge("src/legacy.cjs", "./missing")?.kind, "unresolved", "unresolvable relative imports are reported, not dropped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves Python absolute, relative and package imports", async () => {
  const root = await repository({
    "app/__init__.py": "",
    "app/models.py": "class User: pass\n",
    "app/views.py": "from .models import User\nfrom . import helpers\nimport os, app.models\n",
    "app/helpers/__init__.py": "",
    "tests/test_views.py": "from app.views import *\n",
  });
  try {
    const graph = await new RepositoryImportGraph().build(root);
    const to = (from: string, specifier: string) => graph.edges.find((edge) => edge.from === from && edge.specifier === specifier)?.to;
    assert.equal(to("app/views.py", ".models"), "app/models.py");
    assert.equal(to("app/views.py", "."), "app/__init__.py");
    assert.equal(to("app/views.py", "app.models"), "app/models.py");
    assert.equal(graph.edges.find((edge) => edge.specifier === "os")?.kind, "package");
    assert.equal(to("tests/test_views.py", "app.views"), "app/views.py");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finds the tests that exercise a file, each with the import chain that proves it", async () => {
  const root = await repository({
    "src/auth/session.ts": "export const s = 1;\n",
    "src/auth/token.ts": "import { s } from \"./session.js\";\n",
    "src/server.ts": "import \"./auth/token.js\";\n",
    "tests/session.test.ts": "import { s } from \"../src/auth/session.js\";\n",
    "tests/server.test.ts": "import \"../src/server.js\";\n",
    "tests/unrelated.test.ts": "export {};\n",
  });
  try {
    const graph = await new RepositoryImportGraph().build(root);
    const result = testsFor(graph, "src/auth/session.ts");
    assert.deepEqual(result.tests.map((item) => item.test), ["tests/session.test.ts", "tests/server.test.ts"], "direct test first, unrelated test absent");
    assert.deepEqual(result.tests[1]!.chain.map((link) => link.file), ["tests/server.test.ts", "src/server.ts", "src/auth/token.ts"]);
    assert.equal(result.tests[1]!.chain[0]!.line, 1);
    assert.deepEqual(testsFor(graph, "src/auth/session.ts", 1).tests.map((item) => item.test), ["tests/session.test.ts"], "depth bounds the search");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("test file conventions for both languages", () => {
  for (const path of ["a.test.ts", "b.spec.mjs", "tests/x.ts", "src/__tests__/y.js", "test_models.py", "models_test.py"]) assert.equal(isTestFile(path), true, path);
  for (const path of ["src/testing.ts", "src/contest.py", "latest.ts"]) assert.equal(isTestFile(path), false, path);
});

test("works on Atlas's own coder: the tests for the verified coder session are found", async () => {
  const graph = await new RepositoryImportGraph().build(new URL("../../", import.meta.url).pathname.replace(/dist\/?$/u, ""));
  const result = testsFor(graph, "src/agent/verified-coder-session.ts");
  assert.ok(result.tests.some((item) => item.test === "tests/verified-coder-session.test.ts"), JSON.stringify(result.tests.slice(0, 3)));
});

test("multi-line imports are read, with the specifier's own line as evidence", async () => {
  const root = await repository({
    "src/a.ts": "export const a = 1; export const b = 2;\n",
    "src/b.ts": "import {\n  a,\n  b,\n} from \"./a.js\";\nimport \"./side-effect.js\";\nexport {\n  a,\n} from \"./a.js\";\n",
    "src/side-effect.ts": "\n",
  });
  try {
    const graph = await new RepositoryImportGraph().build(root);
    const edges = graph.edges.filter((edge) => edge.from === "src/b.ts").map((edge) => [edge.specifier, edge.line, edge.to]);
    assert.deepEqual(edges, [["./a.js", 4, "src/a.ts"], ["./side-effect.js", 5, "src/side-effect.ts"], ["./a.js", 8, "src/a.ts"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atlas tests-for: JSON with evidence chains, and a clear error for a file that is not there", async () => {
  const { main } = await import("../src/cli.js");
  const root = await repository({ "src/a.ts": "export {};\n", "tests/a.test.ts": "import \"../src/a.js\";\n" });
  const output: string[] = [];
  const errors: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (line: unknown) => { output.push(String(line)); };
  console.error = (line: unknown) => { errors.push(String(line)); };
  try {
    assert.equal(await main(["tests-for", root, "src/a.ts", "--format", "json"]), 0);
    const parsed = JSON.parse(output.join("\n")) as { tests: { test: string; chain: { line: number }[] }[] };
    assert.deepEqual(parsed.tests.map((item) => item.test), ["tests/a.test.ts"]);
    assert.equal(parsed.tests[0]!.chain[0]!.line, 1);
    assert.equal(await main(["tests-for", root, "src/missing.ts"]), 1);
    assert.match(errors.join("\n"), /not a TypeScript, JavaScript or Python source file/u);
    assert.equal(await main(["tests-for", root]), 2);
  } finally {
    console.log = log;
    console.error = error;
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves tsconfig paths and baseUrl aliases from the nearest config, following relative extends", async () => {
  const root = await repository({
    "tsconfig.base.json": "{\n  // shared\n  \"compilerOptions\": { \"paths\": { \"@shared/*\": [\"shared/*\"], }, },\n}\n",
    "shared/format.ts": "export const format = 1;\n",
    "web/tsconfig.json": "{ \"extends\": \"../tsconfig.base\", \"compilerOptions\": { \"baseUrl\": \".\", \"paths\": { \"@/*\": [\"src/*\"], \"@/lib/*\": [\"lib/*\"], \"config\": [\"src/config.ts\"] } } }\n",
    "web/src/button.tsx": "import { format } from \"@/format\";\nimport { util } from \"@/lib/util\";\nimport config from \"config\";\nimport { page } from \"src/page\";\nimport react from \"react\";\n",
    "web/src/format.ts": "export const format = 2;\n",
    "web/src/config.ts": "export default {};\n",
    "web/src/page.ts": "export const page = 1;\n",
    "web/lib/util.ts": "export const util = 1;\n",
    "api/tsconfig.json": "{ \"extends\": \"../tsconfig.base.json\" }\n",
    "api/handler.ts": "import { format } from \"@shared/format\";\n",
    "other/index.ts": "import { format } from \"@/format\";\n",
  });
  try {
    const graph = await new RepositoryImportGraph().build(root);
    const edge = (from: string, specifier: string) => graph.edges.find((item) => item.from === from && item.specifier === specifier);
    assert.equal(edge("web/src/button.tsx", "@/format")?.to, "web/src/format.ts");
    assert.equal(edge("web/src/button.tsx", "@/lib/util")?.to, "web/lib/util.ts", "the longest matching pattern wins");
    assert.equal(edge("web/src/button.tsx", "config")?.to, "web/src/config.ts", "exact patterns without a star");
    assert.equal(edge("web/src/button.tsx", "src/page")?.to, "web/src/page.ts", "baseUrl resolves bare specifiers");
    assert.deepEqual([edge("web/src/button.tsx", "react")?.kind, edge("web/src/button.tsx", "react")?.to], ["package", null]);
    assert.equal(edge("api/handler.ts", "@shared/format")?.to, "shared/format.ts", "paths inherited through extends resolve from the base config's directory");
    assert.equal(edge("other/index.ts", "@/format")?.kind, "package", "a config only applies beneath its directory");
    assert.ok(!graph.files.some((file) => file.endsWith(".json")), "configs are read, not listed as source files");
    assert.deepEqual(testsFor(graph, "web/lib/util.ts").tests, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unparseable tsconfig is a warning, not a failure", async () => {
  const root = await repository({ "tsconfig.json": "{ nope", "a.ts": "import b from \"./b\";\n", "b.ts": "export default 1;\n" });
  try {
    const graph = await new RepositoryImportGraph().build(root);
    assert.equal(graph.edges[0]?.to, "b.ts");
    assert.ok(graph.warnings.some((warning) => warning.code === "PROJECT_CONFIG_UNREADABLE"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stripJsonComments keeps comment-like text inside strings", () => {
  assert.deepEqual(JSON.parse(stripJsonComments('{ "a": "http://x/*y*/", /* c */ "b": [1, 2,], // t\n "c": "q\\"//" }')), { a: "http://x/*y*/", b: [1, 2], c: 'q"//' });
});
