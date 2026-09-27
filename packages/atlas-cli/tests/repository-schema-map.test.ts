import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { RepositorySchemaMap } from "../src/infrastructure/repository-schema-map.js";

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atlas-schemas-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

test("replays SQL migrations in order and compares them with the ORM schema", async () => {
  const root = await repository({
    "app/drizzle/0000_init.sql": "-- create table ignored_comment (x int);\nCREATE TABLE `users` (\n  id integer\n);\nCREATE TABLE IF NOT EXISTS \"posts\" (id int);\nCREATE TEMP TABLE scratch (x int);\n",
    "app/drizzle/0001_rename.sql": "ALTER TABLE posts RENAME TO articles;\n/* DROP TABLE users; */\n",
    "app/drizzle/0002_drop.sql": "create table legacy (x int);\ndrop table if exists legacy;\nCREATE TABLE main.sessions (id text);\n",
    "app/drizzle/0002_other.sql": "create table audit (id int);\n",
    "app/db/schema.ts": "import { sqliteTable, text } from \"drizzle-orm/sqlite-core\";\nexport const users = sqliteTable(\"users\", { id: text(\"id\") });\nexport const articles = sqliteTable('articles', {});\nexport const comments = sqliteTable(`comments`, {});\n",
    "app/tests/fixture.test.ts": "import { sqliteTable } from \"drizzle-orm/sqlite-core\";\nsqliteTable(\"fixture_only\", {});\n",
    "app/examples/demo/schema.ts": "import { sqliteTable } from \"drizzle-orm/sqlite-core\";\nsqliteTable(\"notes\", {});\n",
  });
  try {
    const map = await new RepositorySchemaMap().build(root);
    assert.deepEqual(map.migrations.map((set) => [set.system, set.directory, set.files.length, set.duplicateSequences]), [["Drizzle", "app/drizzle", 4, ["0002"]]]);
    const sql = map.tables.filter((table) => table.source === "sql");
    assert.deepEqual(sql.map((table) => [table.name, table.defined.file, table.defined.line, table.dropped]), [
      ["users", "app/drizzle/0000_init.sql", 2, false],
      ["articles", "app/drizzle/0001_rename.sql", 1, false],
      ["legacy", "app/drizzle/0002_drop.sql", 1, true],
      ["sessions", "app/drizzle/0002_drop.sql", 3, false],
      ["audit", "app/drizzle/0002_other.sql", 1, false],
    ], "comments and temporary tables are not tables; renames and drops are applied in order");
    assert.deepEqual(map.tables.filter((table) => table.source === "drizzle").map((table) => [table.name, table.defined.line]), [["users", 2], ["articles", 3], ["comments", 4]]);
    assert.deepEqual(map.migrations[0]!.drift, { onlyInMigrations: ["audit", "sessions"], onlyInSchema: ["comments"] });
    assert.ok(map.warnings.some((warning) => warning.code === "DUPLICATE_MIGRATION_SEQUENCE"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recognizes migration systems by layout, and Prisma and SQLAlchemy tables", async () => {
  const root = await repository({
    "prisma/schema.prisma": "model User {\n  id Int @id\n}\n\nmodel Post {\n  id Int @id\n  @@map(\"blog_posts\")\n}\n",
    "prisma/migrations/20240101_init/migration.sql": "CREATE TABLE \"User\" (id int);\n",
    "api/alembic/versions/abc123_add_orders.py": "revision = 'abc123'\n",
    "api/models.py": "from sqlalchemy.orm import DeclarativeBase\nclass Order(Base):\n    __tablename__ = \"orders\"\n",
    "svc/migrations/000001_init.up.sql": "create table widgets (id int);\n",
    "svc/migrations/000001_init.down.sql": "drop table widgets;\n",
    "db/V1__baseline.sql": "create table flyway_t (id int);\n",
    "shop/migrations/0001_initial.py": "from django.db import migrations\n",
  });
  try {
    const map = await new RepositorySchemaMap().build(root);
    assert.deepEqual(map.migrations.map((set) => [set.system, set.directory, set.duplicateSequences.length]).sort(), [
      ["Alembic", "api/alembic/versions", 0],
      ["Django", "shop/migrations", 0],
      ["Flyway", "db", 0],
      ["Prisma", "prisma/migrations", 0],
      ["golang-migrate", "svc/migrations", 0],
    ], "an up/down pair is one sequence");
    assert.deepEqual(map.tables.filter((table) => table.source !== "sql").map((table) => [table.name, table.source]), [["orders", "sqlalchemy"], ["User", "prisma"], ["blog_posts", "prisma"]]);
    assert.ok(map.tables.some((table) => table.name === "widgets" && !table.dropped), "down migrations do not undo the schema");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finds OpenAPI, AsyncAPI, GraphQL, protobuf and JSON Schema definitions", async () => {
  const root = await repository({
    "api/openapi.yaml": "openapi: 3.1.0\ninfo:\n  title: Shop API\n  version: 1.0.0\npaths:\n  /items:\n    get:\n      summary: list\n    post:\n      requestBody:\n        content: {}\n  /items/{id}:\n    parameters: []\n    delete:\n      summary: remove\n",
    "api/swagger.json": JSON.stringify({ swagger: "2.0", info: { title: "Old API" }, paths: { "/a": { get: {}, put: {}, parameters: [] } } }),
    "events/asyncapi.yml": "asyncapi: 2.6.0\ninfo:\n  title: Events\nchannels:\n  order/created:\n    subscribe: {}\n  order/shipped:\n    subscribe: {}\n",
    "graph/schema.graphql": "# comment type Fake {\ntype Query {\n  items: [Item]\n  item(id: ID!): Item\n}\ntype Mutation {\n  addItem(name: String!): Item\n}\ntype Item { id: ID! }\n",
    "proto/shop.proto": "syntax = \"proto3\";\npackage shop.v1;\nservice Shop {\n  rpc List (Req) returns (Res);\n  // rpc Hidden (Req) returns (Res);\n  rpc Get (Req) returns (Res);\n}\n",
    "schemas/item.schema.json": JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", title: "Item", type: "object" }),
    "package.json": JSON.stringify({ name: "x", openapi: "not a schema" }),
    "config/app.yaml": "name: app\n",
  });
  try {
    const map = await new RepositorySchemaMap().build(root);
    assert.deepEqual(map.apis.map((api) => [api.kind, api.file, api.title, api.version, api.operations]), [
      ["openapi", "api/openapi.yaml", "Shop API", "3.1.0", 3],
      ["swagger", "api/swagger.json", "Old API", "2.0", 2],
      ["asyncapi", "events/asyncapi.yml", "Events", "2.6.0", 2],
      ["graphql", "graph/schema.graphql", null, null, 3],
      ["protobuf", "proto/shop.proto", "shop.v1", "proto3", 2],
      ["json-schema", "schemas/item.schema.json", "Item", null, 0],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
