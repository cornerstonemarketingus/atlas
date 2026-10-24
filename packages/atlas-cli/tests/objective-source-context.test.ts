import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { objectiveSourceContext } from "../src/agent/objective-source-context.js";
import { PolicyEnforcedReadOnlyToolRegistry } from "../src/infrastructure/policy-enforced-read-only-tool-registry.js";
import { PatternSecretRedactor } from "../src/infrastructure/pattern-secret-redactor.js";
import { BoundedRepositorySourceReader } from "../src/infrastructure/bounded-repository-source-reader.js";

test("objective source context uses the read policy and redactor, rejects traversal, and remains bounded", async t => {
  const root = await mkdtemp(join(tmpdir(), "atlas-objective-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = "ghp_0123456789abcdefghijABCDEFGHIJ0123";
  await writeFile(join(root, "test.mjs"), `// known test requirement ${secret}\n` + "// source\n".repeat(1000));
  const reader = new BoundedRepositorySourceReader();
  const paths: string[] = [];
  const registry = new PolicyEnforcedReadOnlyToolRegistry({ policy: { defaultDecision: "allow", rules: [] }, redactor: new PatternSecretRedactor() });
  registry.register({ name: "repository.read_source", description: "Read", risk: "low", validateInput: input => input as { path: string; maxBytes: number; maxLines: number },
    execute: async input => { paths.push(input.path); return reader.read(root, input.path, input); } });
  const result = await objectiveSourceContext("Fix new.mjs using test.mjs, test.mjs. Ignore ../outside.mjs /etc/outside.mjs C:\\secret.mjs .env credentials.json", registry, "repo");
  assert.equal(result.length, 1);
  assert.match(result[0]!.content, /known test requirement/u);
  assert.doesNotMatch(result[0]!.content, new RegExp(secret));
  assert.match(result[0]!.content, /truncated/u);
  assert.ok(result.reduce((sum, item) => sum + item.content.length, 0) <= 6000);
  assert.deepEqual(paths, ["new.mjs", "test.mjs"]);
  for (const decision of ["deny", "ask"] as const) {
    const refused = new PolicyEnforcedReadOnlyToolRegistry({ policy: { defaultDecision: decision, rules: [] } });
    refused.register({ name: "repository.read_source", description: "Read", risk: "low", validateInput: input => input,
      execute: async () => assert.fail("Unapproved prefetch must not execute") });
    assert.deepEqual(await objectiveSourceContext("Fix test.mjs", refused, "repo"), []);
  }
});
