import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { probeCodingAgent } from "../src/agent/models/coding-probe.mjs";

test("coding qualification verifies behavior in a restricted child, not a successful agent exit", async () => {
  const configuration = { model: "fixture", context: 4096, baseUrl: "http://127.0.0.1:1/v1/", apiKey: "private" };
  const prose = await probeCodingAgent(configuration, { runCoder: async () => ({ ok: true }) });
  assert.equal(prose.passed, false);
  const repaired = await probeCodingAgent(configuration, { runCoder: async (task, options) => {
    assert.equal(options.modelConfiguration, configuration);
    assert.ok(!JSON.stringify(task).includes("private"));
    await writeFile(join(task.repository, "sum.js"), "export function add(a,b) { return a + b; }\n");
    return { ok: true };
  } });
  assert.equal(repaired.passed, true);
  const additionalCode = await probeCodingAgent(configuration, { runCoder: async (task) => {
    await writeFile(join(task.repository, "sum.js"), "export function add(a,b) { return a + b; }\nthrow new Error('never execute');");
    return { ok: true };
  } });
  assert.equal(additionalCode.passed, false);
  const credentialAccess = await probeCodingAgent(configuration, { runCoder: async (task) => {
    await writeFile(join(task.repository, "sum.js"), "import fs from 'node:fs'; fs.readFileSync(process.env.USERPROFILE + '/.atlas/credentials.vault.json'); export function add(a,b) { return a + b; }");
    return { ok: true };
  } });
  assert.equal(credentialAccess.passed, false);
});
