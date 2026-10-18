import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMissionEvidenceVerifier } from "../src/agent/mission-evidence.mjs";
import { MissionService } from "../src/agent/mission-service.mjs";
import { LocalTaskStore } from "../src/store.mjs";

const patch = "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n";
const child = { metadata: { requiredEvidence: ["patch"] } };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-evidence-"));
  const patchDirectory = join(directory, "patches");
  await mkdir(patchDirectory);
  const path = join(patchDirectory, "result.patch");
  await writeFile(path, patch);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path, verify: createMissionEvidenceVerifier({ patchDirectory }) };
}

test("required patch evidence is read from disk and receives its actual digest", async t => {
  const { path, verify } = await fixture(t);
  const result = await verify({ child, result: { evidence: [{ kind: "patch", path, bytes: Buffer.byteLength(patch) }] } });
  assert.equal(result.evidence[0].sha256, createHash("sha256").update(patch).digest("hex"));
  assert.equal(result.evidence[0].verification, "artifact-verified");
});

test("patch verification replaces executor test-success claims with scoped unavailable receipts", async t => {
  const { path, verify } = await fixture(t);
  const result = await verify({ child, result: {
    verification: { validation: { status: "passed" }, liveOutcomes: { status: "passed" } },
    evidence: [{ kind: "patch", path }, { kind: "validation", status: "passed", verification: "independently-verified" }],
  } });
  assert.equal(result.verification.validation.status, "unavailable");
  assert.equal(result.verification.liveOutcomes.status, "not-evaluated");
  assert.deepEqual(result.verification.artifacts, [{ kind: "patch", sha256: result.evidence[0].sha256, bytes: Buffer.byteLength(patch) }]);
  assert.equal(result.evidence[1].verification, "executor-reported");
});

test("required validation fails closed even when executor supplies a passed receipt", async t => {
  const { path, verify } = await fixture(t);
  await assert.rejects(verify({
    child: { metadata: { requiredEvidence: ["patch", "validation"] } },
    result: { evidence: [{ kind: "patch", path }, { kind: "validation", path, bytes: 10, status: "passed" }] },
  }), /Independent validation is unavailable/);
});

test("successful mission persists scoped receipts and hands them to descendants", async t => {
  const { directory, path, verify } = await fixture(t);
  const store = new LocalTaskStore(":memory:");
  t.after(() => store.close());
  let handoff;
  const service = new MissionService({ store, verifyEvidence: verify, execute: async context => {
    if (context.child.id === "review") handoff = context.dependencies[0].result;
    return { verification: { validation: { status: "passed" } }, evidence: [{ kind: "patch", path }] };
  } });
  service.create({ id: "scoped", repository: directory, model: "local", children: [
    { id: "build", dependencies: [], metadata: { requiredEvidence: ["patch"] } },
    { id: "review", dependencies: ["build"] },
  ] });
  for (let count = 0; service.get("scoped").status === "running" && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(service.get("scoped").status, "completed");
  assert.equal(handoff.verification.validation.status, "unavailable");
  assert.equal(store.mission("scoped").snapshot.children[0].result.verification.liveOutcomes.status, "not-evaluated");
});

test("outside, missing, empty, oversized and falsely described artifacts fail closed", async t => {
  const { directory, path, verify } = await fixture(t);
  const outside = join(directory, "outside.patch");
  await writeFile(outside, patch);
  for (const item of [
    { path: outside }, { path: join(directory, "missing.patch") },
    { path, bytes: 1 }, { path, sha256: "fake" }, { path: "relative.patch" },
  ]) await assert.rejects(verify({ child, result: { evidence: [{ kind: "patch", ...item }] } }));
  await writeFile(path, "");
  await assert.rejects(verify({ child, result: { evidence: [{ kind: "patch", path }] } }), /nonempty/);
  await writeFile(path, "Claim: tests passed");
  await assert.rejects(verify({ child, result: { evidence: [{ kind: "patch", path }] } }), /Git patch/);
  await writeFile(path, patch);
  const bounded = createMissionEvidenceVerifier({ patchDirectory: join(directory, "patches"), maxBytes: 5 });
  await assert.rejects(bounded({ child, result: { evidence: [{ kind: "patch", path }] } }), /bounded/);
});

test("ordinary missions and failed children retain their existing result behavior", async t => {
  const { verify } = await fixture(t);
  assert.deepEqual(await verify({ child: {}, result: { summary: "read only" } }), { summary: "read only" });
  assert.deepEqual(await verify({ child, result: { status: "failed" } }), { status: "failed" });
  await assert.rejects(verify({ child, result: { summary: "done" } }), /no patch/);
});

test("failed independent verification blocks mission descendants and is durable", async t => {
  const { directory, path, verify } = await fixture(t);
  const store = new LocalTaskStore(":memory:");
  t.after(() => store.close());
  const service = new MissionService({ store, verifyEvidence: verify, execute: async () => ({ evidence: [{ kind: "patch", path, bytes: 1 }] }) });
  service.create({ id: "evidence", repository: directory, model: "local", children: [
    { id: "build", dependencies: [], metadata: { requiredEvidence: ["patch"] } },
    { id: "review", dependencies: ["build"] },
  ] });
  for (let count = 0; service.get("evidence").status === "running" && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 5));
  const mission = service.get("evidence");
  assert.equal(mission.children[0].error.code, "INVALID_EVIDENCE");
  assert.equal(mission.children[1].state, "blocked");
  assert.equal(store.mission("evidence").status, "failed");
});
