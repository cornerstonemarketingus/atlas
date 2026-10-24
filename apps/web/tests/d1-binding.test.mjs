import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { D1_MIGRATIONS_DIR, d1DatabaseBindings } from "../d1-binding.mjs";

const app = fileURLToPath(new URL("..", import.meta.url));

test("the D1 binding points wrangler d1 migrations at the checked-in drizzle/ directory", () => {
  const [binding] = d1DatabaseBindings({ binding: "DB", databaseId: "00000000-0000-4000-8000-000000000000", databaseName: "atlas-local" });
  assert.deepEqual(binding, {
    binding: "DB",
    database_name: "atlas-local",
    database_id: "00000000-0000-4000-8000-000000000000",
    migrations_dir: "drizzle",
  });
  const sql = readdirSync(join(app, D1_MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql"));
  assert.ok(sql.length > 0, "drizzle/ holds the migrations");
  assert.ok(sql.includes("0000_brown_firelord.sql"), "the provisioning workflow's first migration lives there");
  assert.equal(existsSync(join(app, "migrations")), false, "no second migrations directory to drift from");
});

test("no binding is generated without a database id, and the default name is kept", () => {
  assert.deepEqual(d1DatabaseBindings({ binding: "DB" }), []);
  assert.deepEqual(d1DatabaseBindings({ binding: null, databaseId: "x" }), []);
  assert.equal(d1DatabaseBindings({ binding: "DB", databaseId: "x" })[0].database_name, "site-creator-d1");
});

test("vite.config.ts builds its D1 binding through d1DatabaseBindings", () => {
  const source = readFileSync(join(app, "vite.config.ts"), "utf8");
  assert.match(source, /from "\.\/d1-binding\.mjs"/u);
  assert.match(source, /d1_databases:\s*d1DatabaseBindings\(/u);
});

test("a built config that binds D1 resolves migrations_dir to drizzle/", (t) => {
  const built = join(app, "dist", "server", "wrangler.json");
  if (!existsSync(built)) return t.skip("no build output");
  const [database] = JSON.parse(readFileSync(built, "utf8")).d1_databases ?? [];
  // `npm test` builds without ATLAS_D1_DATABASE_ID, which omits the binding.
  if (!database) return t.skip("this build has no D1 binding");
  assert.equal(join(app, "dist", "server", database.migrations_dir), join(app, "drizzle"));
});
