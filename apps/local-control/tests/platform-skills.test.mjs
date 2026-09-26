import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PlatformTaskStore } from "../src/platform/index.mjs";
import {
  KnowledgeExchange,
  SkillProposals,
  SkillRegistry,
  WorkflowTemplates,
  globWithin,
  openSkillsDatabase,
  signSkillPackage,
  toolResolver,
} from "../src/platform/skills/index.mjs";

const T = "tenant-a";
const OTHER = "tenant-b";
const HUMAN = { userId: "alice" };
const AGENT = { agentId: "agent-7" };
const FIXTURE = new URL("./fixtures/skills/echo/", import.meta.url);
const read = (path) => readFileSync(new URL(path, FIXTURE), "utf8");

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

const ACME = keypair();
const MALLORY = keypair();

function manifest(overrides = {}) {
  return {
    name: "echo",
    version: "1.0.0",
    publisher: "acme",
    description: "Upper-cases text.",
    tools: [{
      name: "echo.say", description: "Echo text back in upper case.", risk: "read", consequential: false,
      inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", maxLength: 100 } } },
      entry: "tools/echo.mjs",
    }],
    permissions: ["echo.*"],
    tests: [{ name: "echo", argv: ["node", "tests/echo.test.mjs"] }],
    ...overrides,
  };
}

function files(extra = {}) {
  return { "tools/echo.mjs": read("tools/echo.mjs"), "tests/echo.test.mjs": read("tests/echo.test.mjs"), ...extra };
}

function pkg({ manifest: m = {}, files: f = {}, key = ACME } = {}) {
  return signSkillPackage({ manifest: manifest(m), files: files(f), privateKeyPem: key.privateKeyPem });
}

async function harness(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-skills-"));
  const db = openSkillsDatabase(join(directory, "skills.sqlite"));
  const registry = new SkillRegistry({ db, storeDirectory: directory, ...options });
  registry.trustPublisher(T, { publisher: "acme", publicKeyPem: ACME.publicKeyPem, trustedBy: HUMAN });
  registry.setPermissionCeiling(T, ["echo.**", "text.*"], { setBy: HUMAN });
  t.after(async () => {
    try { db.close(); } catch { /* closed */ }
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, db, registry };
}

function approve(registry, p, { tenantId = T, approver = HUMAN } = {}) {
  const approval = registry.requestInstallApproval(tenantId, p, { requestedBy: AGENT });
  registry.approvals.resolve(tenantId, approval.id, { approver, decision: "approved" });
  return approval.id;
}

async function install(registry, p, options = {}) {
  const approvalId = approve(registry, p);
  return registry.install(p, { tenantId: T, approvalId, approvedBy: HUMAN, ...options });
}

async function refused(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("a signed, trusted, tested, approved package installs, activates and loads as a tool", async (t) => {
  const { registry } = await harness(t);
  const installed = await install(registry, pkg());
  assert.equal(installed.version, "1.0.0");
  assert.equal(installed.active, true);
  assert.equal(installed.testReport.ok, true);
  assert.equal(installed.testReport.results[0].exitCode, 0);

  const { tools, refused: bad } = await registry.loadTools(T);
  assert.deepEqual(bad, []);
  assert.equal(tools.length, 1);
  const [tool] = tools;
  assert.equal(tool.name, "echo.say");
  assert.equal(tool.risk, "read");
  assert.ok(Object.isFrozen(tool));
  assert.deepEqual((await tool.execute({ text: "abc" })).output, { echoed: "ABC", skill: "1.0.0" });

  // The approval was consumed: it cannot install anything again.
  assert.equal(registry.approvals.get(T, installed.approvalId).consumed, true);
  const actions = registry.auditLog(T).map((e) => `${e.action}:${e.outcome}`);
  assert.ok(actions.includes("install:ok") && actions.includes("activate:ok") && actions.includes("load:ok"));
  // Another tenant sees nothing.
  assert.deepEqual(registry.listActive(OTHER), []);
});

test("refuses tampered files, unpinned files, bad signatures, untrusted publishers", async (t) => {
  const { registry } = await harness(t);

  const tampered = pkg();
  tampered.files["tools/echo.mjs"] += "\nprocess.exit(0);\n";
  await refused(registry.install(tampered, { tenantId: T, approvalId: "x", approvedBy: HUMAN }), "DIGEST_MISMATCH");

  const extra = pkg();
  extra.files["tools/backdoor.mjs"] = "export const x = 1;";
  await refused(registry.install(extra, { tenantId: T, approvalId: "x", approvedBy: HUMAN }), "DIGEST_MISMATCH");

  const edited = pkg();
  edited.manifest = { ...edited.manifest, permissions: ["echo.**"] };
  await refused(registry.install(edited, { tenantId: T, approvalId: "x", approvedBy: HUMAN }), "BAD_SIGNATURE");

  const wrongKey = pkg({ key: MALLORY });
  await refused(registry.install(wrongKey, { tenantId: T, approvalId: "x", approvedBy: HUMAN }), "BAD_SIGNATURE");

  const stranger = pkg({ manifest: { publisher: "mallory" }, key: MALLORY });
  await refused(registry.install(stranger, { tenantId: T, approvalId: "x", approvedBy: HUMAN }), "UNTRUSTED_PUBLISHER");

  // Trust is per tenant: acme is not trusted in tenant-b.
  await refused(registry.install(pkg(), { tenantId: OTHER, approvalId: "x", approvedBy: HUMAN }), "UNTRUSTED_PUBLISHER");

  // Revoked keys stop verifying.
  registry.revokePublisher(T, { publisher: "acme", revokedBy: HUMAN });
  await refused(registry.install(pkg(), { tenantId: T, approvalId: "x", approvedBy: HUMAN }), "UNTRUSTED_PUBLISHER");

  assert.deepEqual(registry.listVersions(T, "echo"), []);
  assert.ok(registry.auditLog(T).filter((e) => e.action === "install" && e.outcome === "refused").length >= 6);
});

test("refuses permission escalation beyond the tenant ceiling or the skill's own permissions", async (t) => {
  const { registry } = await harness(t);
  const escalated = pkg({ manifest: { permissions: ["echo.*", "terminal.**"] } });
  await refused(registry.install(escalated, { tenantId: T, approvalId: "x", approvedBy: HUMAN }), "PERMISSION_ESCALATION");

  const wildcard = pkg({ manifest: { permissions: ["**"] } });
  await refused(registry.install(wildcard, { tenantId: T, approvalId: "x", approvedBy: HUMAN }), "PERMISSION_ESCALATION");

  // A tool whose name its declared permissions do not cover.
  const m = manifest();
  const sneaky = pkg({ manifest: { tools: [{ ...m.tools[0], name: "text.rewrite" }] } });
  await refused(registry.install(sneaky, { tenantId: T, approvalId: "x", approvedBy: HUMAN }), "PERMISSION_ESCALATION");
});

test("refuses failing declared tests and missing or mismatched approval", async (t) => {
  const { registry } = await harness(t);

  const failing = pkg({
    manifest: { tests: [{ name: "echo", argv: ["node", "tests/echo.test.mjs"] }, { name: "fails", argv: ["node", "tests/fails.test.mjs"] }] },
    files: { "tests/fails.test.mjs": read("tests/fails.test.mjs") },
  });
  const approvalId = approve(registry, failing);
  await refused(registry.install(failing, { tenantId: T, approvalId, approvedBy: HUMAN }), "TESTS_FAILED");
  // The approval survives a refused install; it was not consumed.
  assert.equal(registry.approvals.get(T, approvalId).consumed, false);

  const good = pkg();
  await refused(registry.install(good, { tenantId: T }), "APPROVAL_REQUIRED");
  await refused(registry.install(good, { tenantId: T, approvalId: "apr_missing", approvedBy: HUMAN }), "APPROVAL_REQUIRED");
  // An approval for different content does not transfer.
  await refused(registry.install(good, { tenantId: T, approvalId, approvedBy: HUMAN }), "APPROVAL_REQUIRED");
  // A pending approval is not an approval.
  const pending = registry.requestInstallApproval(T, good, { requestedBy: AGENT });
  await refused(registry.install(good, { tenantId: T, approvalId: pending.id, approvedBy: HUMAN }), "APPROVAL_REQUIRED");
  // Agents cannot approve, nor can the requester.
  assert.throws(() => registry.approvals.resolve(T, pending.id, { approver: { agentId: "agent-9" }, decision: "approved" }), { code: "HUMAN_APPROVAL_REQUIRED" });
  const own = registry.requestInstallApproval(T, good, { requestedBy: HUMAN });
  assert.throws(() => registry.approvals.resolve(T, own.id, { approver: HUMAN, decision: "approved" }), { code: "SELF_APPROVAL" });
  // Approved by bob, but the caller claims alice approved.
  registry.approvals.resolve(T, pending.id, { approver: { userId: "bob" }, decision: "approved" });
  await refused(registry.install(good, { tenantId: T, approvalId: pending.id, approvedBy: HUMAN }), "APPROVAL_REQUIRED");

  assert.deepEqual(registry.listVersions(T, "echo"), []);
  // Correct approval installs once; versions are immutable afterwards.
  await registry.install(good, { tenantId: T, approvalId: pending.id, approvedBy: { userId: "bob" } });
  await refused(install(registry, good), "ALREADY_INSTALLED");
});

test("versions are kept; rollback restores the prior version; deactivate and uninstall", async (t) => {
  const { registry } = await harness(t, { testRunner: async ({ manifest: m }) => ({ ok: true, results: m.tests.map((x) => ({ name: x.name, ok: true, exitCode: 0 })) }) });
  await install(registry, pkg());
  await install(registry, pkg({ manifest: { version: "1.1.0", description: "Upper-cases text, faster." } }));
  assert.equal(registry.activeVersion(T, "echo"), "1.1.0");
  assert.deepEqual(registry.listVersions(T, "echo").map((v) => v.version), ["1.0.0", "1.1.0"]);
  let [tool] = (await registry.loadTools(T)).tools;
  assert.equal((await tool.execute({ text: "a" })).output.skill, "1.1.0");

  assert.deepEqual(registry.rollback(T, "echo", { actor: HUMAN }), { name: "echo", from: "1.1.0", to: "1.0.0" });
  [tool] = (await registry.loadTools(T)).tools;
  assert.equal((await tool.execute({ text: "a" })).output.skill, "1.0.0");
  assert.throws(() => registry.rollback(T, "echo", { actor: HUMAN }), { code: "NO_PREVIOUS_VERSION" });

  registry.activate(T, "echo", "1.1.0", { actor: HUMAN });
  registry.uninstall(T, "echo", "1.0.0", { actor: HUMAN });
  assert.throws(() => registry.rollback(T, "echo", { actor: HUMAN }), { code: "NO_PREVIOUS_VERSION" });
  registry.deactivate(T, "echo", { actor: HUMAN });
  assert.deepEqual((await registry.loadTools(T)).tools, []);
  assert.ok(registry.auditLog(T, { skill: "echo" }).some((e) => e.action === "rollback"));
});

test("digests are re-verified at load: a file tampered after install is refused", async (t) => {
  const { registry } = await harness(t);
  const p = pkg();
  await install(registry, p);
  const object = registry.objectPath(p.manifest.files["tools/echo.mjs"]);
  chmodSync(object, 0o600);
  writeFileSync(object, "export async function execute() { return { output: 'pwned' }; }\n");

  await refused(registry.loadSkill(T, "echo"), "INTEGRITY_FAILURE");
  const { tools, refused: bad } = await registry.loadTools(T);
  assert.deepEqual(tools, []);
  assert.equal(bad[0].code, "INTEGRITY_FAILURE");
  assert.throws(() => registry.activate(T, "echo", "1.0.0", { actor: HUMAN }), { code: "INTEGRITY_FAILURE" });
  assert.ok(registry.auditLog(T).some((e) => e.action === "load" && e.outcome === "refused"));

  // Reinstalling the same content heals the object only through a full, approved install of a new version.
  await install(registry, pkg({ manifest: { version: "1.0.1" } }));
  assert.equal((await registry.loadTools(T)).tools.length, 1);
});

test("a revoked publisher's installed skills stop loading", async (t) => {
  const { registry } = await harness(t);
  await install(registry, pkg());
  registry.revokePublisher(T, { publisher: "acme", revokedBy: HUMAN });
  await refused(registry.loadSkill(T, "echo"), "UNTRUSTED_PUBLISHER");
});

test("glob subsumption is conservative", () => {
  assert.equal(globWithin("echo.say", "echo.*"), true);
  assert.equal(globWithin("echo.*", "echo.**"), true);
  assert.equal(globWithin("echo.**", "echo.*"), false);
  assert.equal(globWithin("echo.a.b", "echo.*"), false);
  assert.equal(globWithin("*.say", "echo.*"), false);
  assert.equal(globWithin("**", "echo.**"), false);
  assert.equal(globWithin("echo.x.**", "echo.**"), true);
});

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

test("an agent's skill proposal never installs itself; tests and a distinct human are required", async (t) => {
  const { db, registry } = await harness(t);
  const proposals = new SkillProposals({ db, registry });
  const proposal = proposals.propose(T, {
    kind: "skill", title: "Echo skill", rationale: "Several tasks re-implemented upper-casing by hand.", payload: { package: pkg() }, proposedBy: AGENT,
  });
  assert.equal(proposal.status, "proposed");
  assert.throws(() => proposals.approve(T, proposal.id, { approver: HUMAN }), { code: "TESTS_REQUIRED" });
  await refused(proposals.install(T, proposal.id, { installedBy: HUMAN }), "APPROVAL_REQUIRED");

  const evaluated = await proposals.evaluate(T, proposal.id);
  assert.equal(evaluated.status, "tests_passed");
  assert.deepEqual(registry.listActive(T), [], "evaluation does not install");

  assert.throws(() => proposals.approve(T, proposal.id, { approver: AGENT }), { code: "HUMAN_APPROVAL_REQUIRED" });
  assert.throws(() => proposals.approve(T, proposal.id, { approver: { userId: "u1", agentId: "agent-7" } }), { code: "HUMAN_APPROVAL_REQUIRED" });
  await refused(proposals.install(T, proposal.id, { installedBy: AGENT }), "HUMAN_APPROVAL_REQUIRED");

  const approved = proposals.approve(T, proposal.id, { approver: HUMAN });
  assert.equal(approved.status, "approved");
  assert.deepEqual(registry.listActive(T), [], "approval does not install");

  const done = await proposals.install(T, proposal.id, { installedBy: HUMAN });
  assert.equal(done.status, "installed");
  assert.equal(done.installedRef, "echo@1.0.0");
  assert.deepEqual(registry.listActive(T), [{ name: "echo", version: "1.0.0" }]);
});

test("a user cannot approve their own proposal, and failing proposals cannot be approved", async (t) => {
  const { db, registry } = await harness(t);
  const proposals = new SkillProposals({ db, registry });
  const own = proposals.propose(T, { kind: "skill", title: "Mine", rationale: "I want this installed quickly.", payload: { package: pkg() }, proposedBy: HUMAN });
  await proposals.evaluate(T, own.id);
  assert.throws(() => proposals.approve(T, own.id, { approver: HUMAN }), { code: "SELF_APPROVAL" });

  const failing = pkg({
    manifest: { version: "2.0.0", tests: [{ name: "fails", argv: ["node", "tests/fails.test.mjs"] }] },
    files: { "tests/fails.test.mjs": read("tests/fails.test.mjs") },
  });
  const bad = proposals.propose(T, { kind: "skill", title: "Broken", rationale: "This one should not pass its tests.", payload: { package: failing }, proposedBy: AGENT });
  assert.equal((await proposals.evaluate(T, bad.id)).status, "tests_failed");
  assert.throws(() => proposals.approve(T, bad.id, { approver: HUMAN }), { code: "TESTS_REQUIRED" });
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const TOOLS = [
  { name: "browser.navigate", inputSchema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", pattern: "^https://" } } } },
  { name: "browser.extract", inputSchema: { type: "object", additionalProperties: false, required: ["selector", "limit"], properties: { selector: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } } } },
];

async function taskHarness(t) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-templates-"));
  const store = new PlatformTaskStore(join(directory, "platform.sqlite"));
  const db = openSkillsDatabase(join(directory, "skills.sqlite"));
  const templates = new WorkflowTemplates({ db, taskStore: store, resolveTool: toolResolver(TOOLS) });
  t.after(async () => { store.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, db, templates };
}

function runTask(store, { verify = true, finish = true } = {}) {
  const task = store.createTask({ tenantId: T, userId: "alice", objective: "Get the price list.", successCriteria: ["Prices extracted."], budget: { toolCalls: 10 } });
  for (const to of ["authorized", "queued", "running"]) store.transitionTask(T, task.id, to);
  const calls = [
    { tool: "browser.navigate", input: { url: "https://shop.example/prices" } },
    { tool: "browser.extract", input: { selector: ".price", limit: 10 } },
    { tool: "browser.extract", input: { selector: ".broken", limit: 1 }, status: "failed" },
  ];
  for (const { tool, input, status = "succeeded" } of calls) {
    const call = store.recordToolCall({ tenantId: T, taskId: task.id, userId: "alice", tool, input, idempotencyKey: `${tool}-${JSON.stringify(input)}` });
    store.updateToolCall(T, call.id, { status, output: {} });
  }
  const artifact = store.submitArtifact({ tenantId: T, taskId: task.id, kind: "prices", content: { prices: [1, 2] } });
  if (verify) store.markArtifactVerified(T, artifact.id, { verified: true, evidence: [{ check: "count", ok: true }] });
  if (finish) {
    store.transitionTask(T, task.id, "verifying");
    store.transitionTask(T, task.id, "completed");
  }
  return task;
}

const PARAMS = [{ name: "url", step: 0, path: "url" }, { name: "limit", step: 1, path: "limit" }];

test("a template is drafted only from a completed task with a verified artifact", async (t) => {
  const { store, templates } = await taskHarness(t);
  const unverified = runTask(store, { verify: false });
  assert.throws(() => templates.draftFromTask(T, unverified.id, { name: "Prices", parameters: PARAMS, draftedBy: AGENT }), { code: "TASK_NOT_VERIFIED" });
  const running = runTask(store, { finish: false });
  assert.throws(() => templates.draftFromTask(T, running.id, { name: "Prices", parameters: PARAMS, draftedBy: AGENT }), { code: "TASK_NOT_VERIFIED" });
  assert.throws(() => templates.draftFromTask(OTHER, running.id, { name: "Prices", parameters: PARAMS, draftedBy: AGENT }), { code: "NOT_FOUND" });

  const verified = runTask(store);
  const { template, approval } = templates.draftFromTask(T, verified.id, { name: "Prices", parameters: PARAMS, draftedBy: AGENT });
  assert.equal(template.status, "draft");
  assert.equal(template.steps.length, 2, "only succeeded calls are kept");
  assert.deepEqual(template.steps[0].input, { url: { $param: "url" } });
  assert.deepEqual(template.parameters.map((p) => [p.name, p.schema.type]), [["url", "string"], ["limit", "integer"]]);
  assert.deepEqual(template.successCriteria, ["Prices extracted."]);
  assert.equal(template.source.taskId, verified.id);

  // Bad parameter paths are refused.
  assert.throws(() => templates.draftFromTask(T, verified.id, { name: "X", parameters: [{ name: "nope", step: 0, path: "missing" }], draftedBy: AGENT }), { code: "INVALID_TEMPLATE" });
  assert.throws(() => templates.draftFromTask(T, verified.id, { name: "X", parameters: [{ name: "nope", step: 9, path: "url" }], draftedBy: AGENT }), { code: "INVALID_TEMPLATE" });

  // Saving needs a human approval of this exact draft.
  assert.throws(() => templates.instantiate(T, template.id, { url: "https://a.example", limit: 3 }), { code: "NOT_SAVED" });
  assert.throws(() => templates.save(T, template.id, { approvalId: approval.id, approvedBy: HUMAN }), { code: "APPROVAL_REQUIRED" });
  assert.throws(() => templates.approvals.resolve(T, approval.id, { approver: AGENT, decision: "approved" }), { code: "HUMAN_APPROVAL_REQUIRED" });
  templates.approvals.resolve(T, approval.id, { approver: HUMAN, decision: "approved" });
  const saved = templates.save(T, template.id, { approvalId: approval.id, approvedBy: HUMAN });
  assert.equal(saved.status, "saved");
  assert.equal(templates.list(T).length, 1);
});

test("instantiate validates parameters and every step against the tool schemas", async (t) => {
  const { store, templates } = await taskHarness(t);
  const task = runTask(store);
  const { template, approval } = templates.draftFromTask(T, task.id, {
    name: "Prices", draftedBy: AGENT,
    parameters: [...PARAMS, { name: "selector", step: 1, path: "selector", schema: { type: "string", minLength: 1 } }],
  });
  templates.approvals.resolve(T, approval.id, { approver: HUMAN, decision: "approved" });
  templates.save(T, template.id, { approvalId: approval.id, approvedBy: HUMAN });

  const plan = templates.instantiate(T, template.id, { url: "https://other.example/list", limit: 5, selector: ".cost" });
  assert.deepEqual(plan.steps, [
    { tool: "browser.navigate", input: { url: "https://other.example/list" } },
    { tool: "browser.extract", input: { selector: ".cost", limit: 5 } },
  ]);
  assert.deepEqual(plan.successCriteria, ["Prices extracted."]);

  const bad = (params) => assert.throws(() => templates.instantiate(T, template.id, params), { code: "INVALID_PARAMS" });
  bad({ url: "https://x.example", limit: 5 });                               // missing selector
  bad({ url: "https://x.example", limit: "5", selector: ".a" });             // wrong type
  bad({ url: "https://x.example", limit: 5, selector: ".a", extra: true });  // unknown parameter
  bad({ url: "http://x.example", limit: 5, selector: ".a" });                // violates browser.navigate schema
  bad({ url: "https://x.example", limit: 500, selector: ".a" });             // violates browser.extract maximum
});

test("a workflow proposal is tested by instantiation and saved only after human approval", async (t) => {
  const { db, templates } = await taskHarness(t);
  const proposals = new SkillProposals({ db, templates });
  const definition = {
    name: "Open page", successCriteria: ["Page opened."],
    steps: [{ tool: "browser.navigate", input: { url: "https://example.com" } }],
    parameters: [{ name: "url", step: 0, path: "url" }],
  };
  const good = proposals.propose(T, { kind: "workflow", title: "Open", rationale: "Many tasks start by opening a page.", payload: { template: definition, tests: [{ name: "https", params: { url: "https://a.example" } }] }, proposedBy: AGENT });
  const bad = proposals.propose(T, { kind: "workflow", title: "Open", rationale: "Many tasks start by opening a page.", payload: { template: definition, tests: [{ name: "http", params: { url: "http://a.example" } }] }, proposedBy: AGENT });
  assert.equal((await proposals.evaluate(T, bad.id)).status, "tests_failed");
  assert.equal((await proposals.evaluate(T, good.id)).status, "tests_passed");
  assert.equal(templates.list(T).length, 0);
  proposals.approve(T, good.id, { approver: HUMAN });
  assert.equal(templates.list(T).length, 0);
  const installed = await proposals.install(T, good.id, { installedBy: HUMAN });
  assert.equal(installed.status, "installed");
  assert.equal(templates.instantiate(T, installed.installedRef, { url: "https://b.example" }).steps[0].input.url, "https://b.example");
});

// ---------------------------------------------------------------------------
// Knowledge exchange
// ---------------------------------------------------------------------------

test("knowledge exchange redacts before storage and needs a reviewer other than the author", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-knowledge-"));
  const db = openSkillsDatabase(join(directory, "skills.sqlite"));
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  const exchange = new KnowledgeExchange({ db });
  const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz0123";
  const entry = exchange.submit(T, {
    title: "Paginating the Initech portal",
    content: { steps: [`Log in with api_key=${secret}`, "Mail jane.doe@initech.example if blocked", "Click next until disabled"] },
    author: AGENT, authorFamily: "research", audience: { scope: "families", families: ["sales"] }, sourceTaskId: "tsk_1", redactTerms: ["Initech"],
  });
  assert.equal(entry.status, "in_review");
  const raw = JSON.stringify(db.prepare("SELECT * FROM knowledge_entries").all());
  assert.ok(!raw.includes(secret) && !raw.includes("jane.doe") && !raw.includes("Initech"), "raw values are never stored");
  const kinds = entry.provenance.redactions;
  assert.ok(kinds.includes("email") && kinds.includes("term"));
  assert.ok(kinds.includes("anthropic_key") || kinds.includes("assigned_secret"));

  assert.deepEqual(exchange.listFor(T, { family: "sales" }), [], "unreviewed entries are invisible");
  assert.throws(() => exchange.review(T, entry.id, { reviewer: AGENT, decision: "publish" }), { code: "SELF_REVIEW" });
  exchange.review(T, entry.id, { reviewer: { agentId: "agent-reviewer" }, decision: "publish", notes: "Checked." });
  assert.throws(() => exchange.review(T, entry.id, { reviewer: HUMAN, decision: "publish" }), { code: "INVALID_STATE" });

  const [seen] = exchange.listFor(T, { family: "sales" });
  assert.deepEqual(Object.keys(seen).sort(), ["content", "id", "provenance", "title"]);
  assert.equal(seen.title, "Paginating the [REDACTED:term] portal");
  assert.equal(seen.content.steps[2], "Click next until disabled");
  assert.ok(seen.content.steps[1].includes("[REDACTED:email]"));
  assert.equal(seen.provenance.author, "agent:agent-7");
  assert.equal(seen.provenance.reviewer, "agent:agent-reviewer");
  assert.equal(seen.provenance.sourceTaskId, "tsk_1");
  assert.match(seen.provenance.contentDigest, /^sha256:/);

  assert.deepEqual(exchange.listFor(T, { family: "support" }), [], "families outside the audience see nothing");
  assert.deepEqual(exchange.listFor(OTHER, { family: "sales" }), [], "other tenants see nothing");

  const wide = exchange.submit(T, { title: "Tenant tip", content: "Use the export button.", author: HUMAN, authorFamily: "ops", audience: { scope: "tenant" } });
  exchange.review(T, wide.id, { reviewer: { userId: "bob" }, decision: "publish" });
  assert.equal(exchange.listFor(T, { family: "support" }).length, 1);
});
