import { strict as assert } from "node:assert";
import { it } from "node:test";
import { compactRepositorySummary } from "../src/model/compact-repository-summary.js";

it("bounds initial repository collections and reports what was omitted", () => {
  const many = Array.from({ length: 40 }, (_, index) => ({ path: `apps/${index}`, role: "applications" as const }));
  const compact = compactRepositorySummary({
    schemaVersion: 1, root: "/repo", repositoryName: "repo", git: { isAvailable: true, isRepository: true, branch: "main", headCommit: "abc", isDirty: false },
    fileCount: 400, languages: [], manifests: many.map(({ path }) => ({ path: `${path}/package.json`, kind: "Node.js" })), frameworks: [], architecture: many,
    topLevelDirectories: many.map(({ path }) => path), warnings: [],
  });
  assert.equal(compact.manifests.length, 20);
  assert.equal(compact.architecture.length, 20);
  assert.deepEqual(compact.omitted, { manifests: 20, architecture: 20, topLevelDirectories: 10 });
});
