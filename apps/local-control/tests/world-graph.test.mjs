import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { importsOf, isTestFile, mapRepository, RepoGraphError } from "../src/agent/kernel/repo-graph.mjs";
import { observationFor } from "../src/agent/kernel/observations.mjs";
import { WorldState } from "../src/agent/kernel/world-state.mjs";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "atlas-graph-"));
  const world = new WorldState();
  t.after(() => { world.close(); rmSync(root, { recursive: true, force: true }); });
  const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  write("package.json", JSON.stringify({ name: "monorepo", private: true }));
  write("packages/core/package.json", JSON.stringify({ name: "@acme/core", devDependencies: { "@acme/core": "workspace:*" } }));
  write("packages/core/src/math.mjs", 'import "./index.mjs";\nexport const add = (a, b) => a + b;\n');
  write("packages/core/src/self.mjs", 'import { add } from "@acme/core";\n');
  write("packages/core/src/index.mjs", 'export { add } from "./math.mjs";\nimport "./missing.mjs";\nimport "../../../../outside.mjs";\n');
  write("packages/app/package.json", JSON.stringify({ name: "app", dependencies: { "@acme/core": "*", react: "*" } }));
  write("packages/app/src/util.ts", "export const twice = (n: number) => n * 2;\n");
  write("packages/app/src/main.ts", 'import { add } from "@acme/core/math";\nimport { twice } from "./util.js";\nimport fs from "node:fs";\nexport const run = () => twice(add(1, 2));\n');
  write("packages/app/src/lazy.mjs", 'import "./widgets";\nexport async function later() { return (await import("./util.ts")).twice(1); }\n');
  write("packages/app/src/widgets/index.mjs", "export const widget = 1;\n");
  write("packages/app/tests/main.test.mjs", 'import { run } from "../src/main.ts";\nconst core = require("@acme/core");\n');
  write("packages/app/node_modules/react/index.js", 'import "./ignored.js";\n');
  write("packages/app/dist/main.js", 'import "../src/main.ts";\n');
  write("scripts/tool.mjs", 'import "../packages/core/src/math.mjs";\n');
  return { root, world, write, file: (path) => `file:${root}:${path}`, pkg: (path) => `package:${root}:${path}` };
}

test("import scanning covers static, dynamic, re-export and require, and tests are recognised", () => {
  assert.deepEqual(importsOf('import a from "./a.mjs";\nimport { b } from \'./b\';\nimport "./c.css";\nexport * from "./d.mjs";\nconst e = await import("./e.mjs");\nconst f = require("f");\nimport type { G } from "./g";'), ["./a.mjs", "./b", "./c.css", "./d.mjs", "./e.mjs", "f", "./g"]);
  assert.ok(isTestFile("tests/a.test.mjs"));
  assert.ok(isTestFile("src/a.spec.ts"));
  assert.ok(isTestFile("packages/x/__tests__/y.js"));
  assert.ok(!isTestFile("src/testing-helpers.mjs"));
  assert.ok(!isTestFile("src/contest.mjs"));
});

test("a repository maps to packages, files and imports as typed relations", (t) => {
  const { root, world, file, pkg } = fixture(t);
  const map = mapRepository(world, root);
  assert.equal(map.packages, 3);
  assert.equal(map.files, 9, "node_modules and dist are skipped");
  assert.equal(map.truncated, false);

  assert.equal(world.get(pkg("packages/core")).attrs.name, "@acme/core");
  assert.equal(world.get(file("packages/app/tests/main.test.mjs")).attrs.kind, "test");
  assert.equal(world.get(file("packages/app/src/main.ts")).attrs.kind, "source");
  assert.equal(world.get(`file:${root}:packages/app/node_modules/react/index.js`), null);

  const edges = (id) => world.relations(id).filter((edge) => edge.from === id).map((edge) => `${edge.relation} ${edge.to.slice(edge.to.indexOf(":") + root.length + 2)}`).sort();
  assert.deepEqual(edges(file("packages/core/src/index.mjs")), ["depends_on packages/core/src/math.mjs", "part_of packages/core"], "unresolved and escaping imports are dropped");
  assert.deepEqual(edges(file("packages/app/src/main.ts")), ["depends_on packages/core", "depends_on packages/app/src/util.ts", "part_of packages/app"].sort(), "a subpath import resolves to its package; .js resolves to .ts");
  assert.deepEqual(edges(file("packages/app/src/lazy.mjs")), ["depends_on packages/app/src/util.ts", "depends_on packages/app/src/widgets/index.mjs", "part_of packages/app"], "a folder import resolves to its index");
  assert.deepEqual(edges(file("packages/core/src/self.mjs")), ["part_of packages/core"], "importing your own package is not a dependency");
  assert.deepEqual(edges(pkg("packages/core")).filter((edge) => edge.startsWith("depends_on")), [], "a package listing itself is not a dependency");
  assert.deepEqual(edges(file("packages/app/tests/main.test.mjs")), ["depends_on packages/core", "part_of packages/app", "tests packages/app/src/main.ts"].sort());
  assert.deepEqual(world.relations(pkg("packages/app")).filter((edge) => edge.from === pkg("packages/app")).map((edge) => [edge.relation, edge.to]).sort(), [["depends_on", pkg("packages/core")], ["part_of", `repository:${root}`]]);
  assert.ok(edges(file("scripts/tool.mjs")).some((edge) => edge.startsWith("part_of")), "a file outside any sub-package belongs to the root package");
  assert.equal(world.relations(file("scripts/tool.mjs")).find((edge) => edge.relation === "part_of").to, pkg("."));
});

test("impact: what a change affects, how it got there, and which tests to run", (t) => {
  const { root, world, file, pkg } = fixture(t);
  mapRepository(world, root);
  const impact = world.impact(file("packages/core/src/math.mjs"));
  const at = (id) => impact.affected.find((entry) => entry.id === id);
  assert.equal(at(file("packages/core/src/index.mjs")).depth, 1);
  assert.deepEqual(at(file("packages/core/src/index.mjs")).via, { relation: "depends_on", from: file("packages/core/src/math.mjs") });
  assert.equal(at(file("scripts/tool.mjs")).depth, 1, "an importer anywhere in the repository");
  assert.equal(at(pkg("packages/core")).depth, 1, "the package it is part of");
  assert.equal(at(pkg("packages/app")).depth, 2, "a package that depends on that package");
  assert.equal(at(file("packages/app/src/main.ts")).depth, 2, "a file importing the package");
  assert.equal(at(file("packages/app/tests/main.test.mjs")).depth, 2);
  assert.deepEqual(impact.tests.map((entry) => entry.attrs.path), ["packages/app/tests/main.test.mjs"]);
  assert.equal(at(file("packages/app/src/util.ts")), undefined, "a file the change does not reach");
  assert.equal(at(file("packages/core/src/math.mjs")), undefined, "the changed file is not its own impact");

  const shallow = world.impact(file("packages/core/src/math.mjs"), { depth: 1 });
  assert.equal(shallow.affected.some((entry) => entry.id === pkg("packages/app")), false, "depth bounds the walk");
  const capped = world.impact(file("packages/core/src/math.mjs"), { limit: 2 });
  assert.equal(capped.affected.length, 2);
  assert.equal(capped.truncated, true);

  const util = world.impact(file("packages/app/src/util.ts"));
  assert.deepEqual(util.tests.map((entry) => entry.attrs.path), ["packages/app/tests/main.test.mjs"], "reached through main.ts");
  assert.ok(util.affected.some((entry) => entry.id === file("packages/app/src/lazy.mjs")), "a dynamic import counts");
  assert.equal(world.impact("file:nope"), null);
});

test("a re-map replaces its own edges and leaves everyone else's; coder runs touch the same file entities", (t) => {
  const { root, world, write, file } = fixture(t);
  mapRepository(world, root);
  world.apply({ source: "someone-else", entities: [{ type: "service", key: "api" }], relations: [{ from: "service:api", relation: "uses", to: file("packages/core/src/math.mjs") }] });
  write("packages/core/src/index.mjs", "export const nothing = 1;\n");
  mapRepository(world, root);
  const impact = world.impact(file("packages/core/src/math.mjs"));
  assert.equal(impact.affected.some((entry) => entry.id === file("packages/core/src/index.mjs")), false, "the removed import is gone");
  assert.ok(impact.affected.some((entry) => entry.id === "service:api"), "another source's edge survives");

  world.upsert({ type: "run", key: "r" });
  const observation = observationFor({ runId: "r", seq: 1, call: { name: "repository.write" }, input: { path: "packages/core/src/math.mjs" }, status: "succeeded", environment: { repository: root } });
  world.apply(observation);
  assert.ok(world.relations(file("packages/core/src/math.mjs")).some((edge) => edge.relation === "touched"), "the run's touch lands on the mapped file");

  const fresh = new WorldState();
  const capped = mapRepository(fresh, root, { maxFiles: 3 });
  fresh.close();
  assert.equal(capped.files, 3);
  assert.equal(capped.truncated, true, "a large repository says the map is partial");
  assert.throws(() => mapRepository(world, join(root, "nope")), (error) => error instanceof RepoGraphError && error.code === "NOT_FOUND");
  assert.throws(() => mapRepository(world, join(root, "package.json")), (error) => error.code === "NOT_A_DIRECTORY");
  assert.throws(() => world.dropRelations({}), /Name the source/u);
});

test("over HTTP: the owner maps a repository and asks what a change affects", async (t) => {
  const { root, world, file } = fixture(t);
  const directory = mkdtempSync(join(tmpdir(), "atlas-graph-http-"));
  const store = new LocalTaskStore(join(directory, "atlas.sqlite"));
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true }), world });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const admin = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const call = (path, init = {}) => fetch(`${origin}${path}`, init).then(async (response) => ({ status: response.status, body: await response.json() }));

  assert.equal((await call("/v1/world/map", { method: "POST", headers: admin, body: JSON.stringify({ repository: "relative/path" }) })).status, 400);
  const missing = await call("/v1/world/map", { method: "POST", headers: admin, body: JSON.stringify({ repository: join(root, "nope") }) });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "NOT_FOUND");
  assert.equal((await call("/v1/world/map", { method: "GET", headers: admin })).status, 405);
  const mapped = await call("/v1/world/map", { method: "POST", headers: admin, body: JSON.stringify({ repository: root }) });
  assert.equal(mapped.status, 200);
  assert.equal(mapped.body.map.files, 9);

  const impact = await call(`/v1/world/impact?id=${encodeURIComponent(file("packages/core/src/math.mjs"))}&depth=2`, { headers: admin });
  assert.equal(impact.status, 200);
  assert.deepEqual(impact.body.tests.map((entry) => entry.attrs.path), ["packages/app/tests/main.test.mjs"]);
  assert.equal((await call("/v1/world/impact?id=file%3Anope", { headers: admin })).status, 404);
  assert.equal((await call("/v1/world", { headers: admin })).status, 200, "the other world routes still answer");
  assert.equal((await call("/v1/health-not-a-route", { headers: admin })).status, 404, "routes after the world routes still run");
  assert.equal((await call("/v1/world/map", { method: "POST", body: "{}" })).status, 401);
});
