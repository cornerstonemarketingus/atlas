import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { RepositoryMap } from "../src/infrastructure/repository-map.js";

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atlas-map-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const json = (value: unknown) => JSON.stringify(value);

test("combines packages, imports, configuration, delivery and data into one map with evidence", async () => {
  const root = await repository({
    "package.json": json({ name: "mono", private: true, workspaces: ["packages/*", "apps/*"] }),
    "packages/core/package.json": json({ name: "@m/core", main: "dist/index.js" }),
    "packages/core/src/index.ts": "export * from \"./util.js\";\n",
    "packages/core/src/util.ts": "export const util = process.env.CORE_FLAG;\n",
    "packages/core/src/orphan.ts": "export const orphan = 1;\n",
    "packages/core/tests/index.test.ts": "import \"../src/index.js\";\nprocess.env.FIXTURE_ONLY;\n",
    "apps/api/package.json": json({ name: "api", dependencies: { "@m/core": "workspace:*" } }),
    "apps/api/src/server.ts": "import { util } from \"@m/core\";\nimport \"./routes.js\";\nconst key = process.env.API_TOKEN;\n",
    "apps/api/src/routes.ts": "import { util } from \"@m/core\";\n",
    "apps/api/drizzle/0000_init.sql": "create table users (id int);\n",
    "apps/api/db/schema.ts": "import { sqliteTable } from \"drizzle-orm/sqlite-core\";\nsqliteTable(\"users\", {});\n",
    ".env.example": "API_TOKEN=\n",
    ".github/workflows/deploy.yml": "on:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    steps:\n      - run: npx wrangler deploy\n        env:\n          CF: ${{ secrets.CF_TOKEN }}\n",
  });
  try {
    const map = await new RepositoryMap().build(root);
    const core = map.packages.find((item) => item.name === "@m/core")!;
    assert.deepEqual([core.sourceFiles, core.testFiles, core.reachedByTests], [3, 1, 2], "orphan.ts is the one source file no test reaches");
    assert.deepEqual(core.entries, [{ field: "main", path: "dist/index.js", source: "packages/core/src/index.ts" }], "a built entry resolves to its source");
    const api = map.packages.find((item) => item.name === "api")!;
    assert.deepEqual([api.sourceFiles, api.testFiles, api.reachedByTests, api.dependsOn], [3, 0, 0, ["packages/core"]]);
    assert.deepEqual(map.hubs[0], { file: "packages/core/src/index.ts", importers: 3, evidence: [
      { file: "apps/api/src/routes.ts", line: 1 }, { file: "apps/api/src/server.ts", line: 1 }, { file: "packages/core/tests/index.test.ts", line: 1 },
    ] });
    assert.deepEqual(map.configuration.undeclared, ["CORE_FLAG"], "declared variables and test-only reads are not reported");
    assert.deepEqual(map.configuration.secrets, ["CF_TOKEN"]);
    assert.deepEqual(map.delivery.ci, ["GitHub Actions (1 workflow)"]);
    assert.deepEqual(map.delivery.targets.map((target) => [target.target, target.triggeredBy]), [["Cloudflare Workers", ["push [main]"]]]);
    assert.deepEqual(map.data.migrations.map((set) => [set.system, set.files, set.drift]), [["Drizzle", 1, { onlyInMigrations: [], onlyInSchema: [] }]]);
    assert.equal(map.data.tables, 1);
    assert.ok(Object.values(map.basis).every((text) => text.length > 20), "every section states what it rests on");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sources can be replaced, and warnings from every analyzer are kept", async () => {
  const empty = { files: [], edges: [], warnings: [] };
  const map = await new RepositoryMap(undefined, undefined, {
    packages: async () => ({ packages: [], edges: [], warnings: [{ code: "P", message: "p" }] }),
    imports: async () => ({ ...empty, warnings: [{ code: "I", message: "i" }] }),
    configuration: async () => ({ variables: [], declarationFiles: [], warnings: [] }),
    delivery: async () => ({ ci: [], workflows: [], targets: [], warnings: [{ code: "D", message: "d" }] }),
    schemas: async () => ({ migrations: [], tables: [], apis: [], warnings: [] }),
  }).build("/nowhere");
  assert.deepEqual(map.warnings.map((warning) => warning.code), ["P", "I", "D"]);
  assert.deepEqual([map.packages, map.hubs, map.delivery.ci], [[], [], []]);
});
