import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScopedMemoryStore, MemoryError } from "../src/platform/memory/memory-store.mjs";
import { redactSecrets } from "../src/platform/memory/redaction.mjs";

const T1 = "tenant-a";
const T2 = "tenant-b";
const coder = { agentId: "agt-coder-1", family: "coding", userId: "u1" };
const coder2 = { agentId: "agt-coder-2", family: "coding", userId: "u1" };
const browser = { agentId: "agt-browser-1", family: "browser", userId: "u1" };
const user = { userId: "u1" };

function store(options) {
  return new ScopedMemoryStore(":memory:", options);
}

function observation(s, overrides = {}) {
  return s.write({
    tenantId: T1,
    owner: "agt-coder-1",
    scope: "family",
    scopeRef: "coding",
    content: "The build uses pnpm workspaces and node 22.",
    provenance: { source: "tool_output", sourceRefs: ["art_build_log"], producedBy: "agt-coder-1", toolCallId: "tcl_1" },
    ...overrides,
  });
}

test("reports whether FTS5 retrieval is live", () => {
  const s = store();
  assert.ok(["fts5", "like"].includes(s.searchMode));
  assert.equal(s.capabilities().fts5, s.searchMode === "fts5");
  const e = observation(s);
  assert.equal(s.retrieve(T1, coder, { query: "pnpm workspaces" })[0].id, e.id);
  assert.equal(s.retrieve(T1, coder, { query: "kubernetes" }).length, 0);
});

test("tenant isolation: no read path returns another tenant's data", () => {
  const s = store();
  const e = observation(s, { scope: "organization", scopeRef: "org" });
  assert.equal(s.retrieve(T1, coder).length, 1);
  assert.equal(s.retrieve(T2, coder).length, 0);
  assert.equal(s.retrieve(T2, coder, { query: "pnpm" }).length, 0);
  assert.equal(s.get(T2, coder, e.id), null);
  assert.equal(JSON.parse(s.export(T2, coder)).entries.length, 0);
  assert.deepEqual(s.history(T2, coder, e.id), []);
  assert.throws(() => s.retrieve(undefined, coder), { code: "TENANT_REQUIRED" });
  assert.throws(() => s.retrieve("", coder), { code: "TENANT_REQUIRED" });
  assert.throws(() => s.correct(e.id, "x", { tenantId: T2, by: "agt-x", reason: "r" }), { code: "NOT_FOUND" });
  assert.throws(() => s.delete(e.id, { tenantId: T2, by: "u2" }), { code: "NOT_FOUND" });
});

test("every entry carries provenance; missing provenance is refused", () => {
  const s = store();
  const e = observation(s);
  assert.deepEqual(e.provenance, { source: "tool_output", sourceRefs: ["art_build_log"], producedBy: "agt-coder-1", toolCallId: "tcl_1" });
  assert.equal(e.kind, "observation");
  assert.equal(e.version, 1);
  assert.throws(() => observation(s, { provenance: undefined }), { code: "PROVENANCE_REQUIRED" });
  assert.throws(() => observation(s, { kind: "verified_fact" }), { code: "PROMOTION_REQUIRED" });
  assert.throws(() => observation(s, { content: "x".repeat(20_000) }), { code: "CONTENT_TOO_LARGE" });
});

test("family scoping: only agents of the family read family memory", () => {
  const s = store();
  observation(s, { access: { readers: ["family:coding", "agent:*", "family:*"] } });
  assert.equal(s.retrieve(T1, coder).length, 1);
  assert.equal(s.retrieve(T1, coder2).length, 1);
  assert.equal(s.retrieve(T1, browser).length, 0, "an ACL glob cannot widen family memory to another family");
  assert.equal(s.retrieve(T1, user).length, 0);
  // A user named explicitly can read.
  observation(s, { access: { readers: ["family:coding", "user:u1"] } });
  assert.equal(s.retrieve(T1, user).length, 1);
});

test("other scopes follow their default readers", () => {
  const s = store();
  const base = { tenantId: T1, owner: "agt-coder-1", content: "note", provenance: { source: "chat", sourceRefs: [] } };
  const agentOnly = s.write({ ...base, scope: "agent", scopeRef: "agt-coder-1" });
  const taskNote = s.write({ ...base, scope: "task", scopeRef: "tsk_1" });
  const userNote = s.write({ ...base, scope: "user", scopeRef: "u1" });
  const projectNote = s.write({ ...base, scope: "project", scopeRef: "p1" });
  const ids = (principal) => s.retrieve(T1, principal).map((e) => e.id).sort();
  assert.deepEqual(ids({ agentId: "agt-other", family: "coding", userId: "u2" }), []);
  assert.deepEqual(ids({ agentId: "agt-other", taskId: "tsk_1" }), [taskNote.id]);
  assert.deepEqual(ids({ userId: "u1" }), [userNote.id]);
  assert.deepEqual(ids({ agentId: "agt-other", projectIds: ["p1"] }), [projectNote.id]);
  assert.equal(ids(coder).length, 4, "the owner reads its own non-family entries");
  assert.ok(ids(coder).includes(agentOnly.id));
});

test("correction creates a new version and keeps history", () => {
  const s = store();
  const e = observation(s);
  const fixed = s.correct(e.id, "The build uses npm workspaces and node 22.", { tenantId: T1, by: "agt-coder-2", reason: "lockfile is package-lock.json" });
  assert.equal(fixed.version, 2);
  assert.equal(fixed.provenance.source, "correction");
  assert.deepEqual(fixed.provenance.sourceRefs, [e.id]);
  const live = s.retrieve(T1, coder);
  assert.deepEqual(live.map((x) => x.id), [fixed.id]);
  const history = s.history(T1, coder, fixed.id);
  assert.deepEqual(history.map((x) => x.version), [1, 2]);
  assert.equal(history[0].superseded_by, fixed.id);
  assert.match(history[0].content, /pnpm/);
  assert.throws(() => s.correct(e.id, "again", { tenantId: T1, by: "agt-coder-2", reason: "r" }), { code: "ALREADY_SUPERSEDED" });
  assert.ok(s.auditLog(T1).some((row) => row.action === "correct" && row.detail.supersedes === e.id));
});

test("deletion erases content of the lineage; tombstone keeps id and audit only", () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-mem-"));
  const file = join(dir, "memory.db");
  try {
    const s = new ScopedMemoryStore(file);
    const e = observation(s, { content: "zebracorn-unique-token appears in the logs" });
    const v2 = s.correct(e.id, "zebracorn-unique-token appears twice in the logs", { tenantId: T1, by: "agt-coder-2", reason: "recount" });
    const shared = s.shareAcrossFamily(v2.id, { tenantId: T1, toFamily: "browser", approvedBy: "u1", redact: (text) => text });
    assert.equal(s.retrieve(T1, browser, { query: "zebracorn" }).length, 1);

    const result = s.delete(e.id, { tenantId: T1, by: "u1", reason: "user request" });
    assert.deepEqual(result.erasedIds.sort(), [e.id, v2.id, shared.id].sort());
    for (const principal of [coder, browser, user]) {
      assert.equal(s.retrieve(T1, principal, { query: "zebracorn" }).length, 0);
      assert.equal(s.retrieve(T1, principal).length, 0);
      assert.doesNotMatch(s.export(T1, principal), /zebracorn/);
      assert.equal(s.get(T1, principal, e.id), null);
    }
    const tomb = s.history(T1, coder, e.id);
    assert.ok(tomb.every((entry) => entry.deleted === true && entry.content === undefined));
    const audit = s.auditLog(T1).find((row) => row.action === "delete");
    assert.equal(audit.entryId, e.id);
    assert.doesNotMatch(JSON.stringify(s.auditLog(T1)), /zebracorn/);
    s.close();
    assert.doesNotMatch(readFileSync(file).toString("latin1"), /zebracorn/, "secure_delete zeroes erased text on disk");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("promotion rules: evidence required, self-verification refused, pattern needs verified", () => {
  const s = store();
  const e = observation(s, { kind: "hypothesis" });
  assert.throws(() => s.promote(e.id, { tenantId: T1, verifier: "agt-verifier", evidence: [] }), { code: "EVIDENCE_REQUIRED" });
  assert.throws(() => s.promote(e.id, { tenantId: T1, verifier: "agt-verifier" }), { code: "EVIDENCE_REQUIRED" });
  assert.throws(() => s.promote(e.id, { tenantId: T1, verifier: "agt-coder-1", evidence: ["art_test_run"] }), { code: "SELF_VERIFICATION" });
  assert.throws(() => s.promote(e.id, { tenantId: T1, verifier: "agt-verifier", evidence: ["x"], toKind: "pattern" }), { code: "INVALID_PROMOTION" });

  const fact = s.promote(e.id, { tenantId: T1, verifier: "agt-verifier", evidence: ["art_test_run"] });
  assert.equal(fact.kind, "verified_fact");
  assert.equal(fact.verified_by, "agt-verifier");
  assert.ok(fact.verified_at);
  assert.deepEqual(fact.evidence, ["art_test_run"]);

  const pattern = s.promote(e.id, { tenantId: T1, verifier: "u1", evidence: ["art_run_2", "art_run_3"] });
  assert.equal(pattern.kind, "pattern");

  // Correcting a verified fact drops verification.
  const corrected = s.correct(e.id, "Revised text", { tenantId: T1, by: "agt-x", reason: "r" });
  assert.equal(corrected.kind, "observation");
  assert.equal(corrected.verified_at, null);
});

test("cross-family share requires approval and applies redaction with a provenance link", () => {
  const s = store();
  const e = observation(s, { content: "Customer ACME contract value is 1.2M; login flow uses SSO." });
  assert.throws(() => s.shareAcrossFamily(e.id, { tenantId: T1, toFamily: "browser", redact: (t) => t }), { code: "APPROVAL_REQUIRED" });
  assert.throws(() => s.shareAcrossFamily(e.id, { tenantId: T1, toFamily: "browser", approvedBy: "agt-coder-1", redact: (t) => t }), { code: "SELF_APPROVAL" });
  assert.throws(() => s.shareAcrossFamily(e.id, { tenantId: T1, toFamily: "browser", approvedBy: "u1" }), { code: "REDACTION_REQUIRED" });
  assert.equal(s.retrieve(T1, browser).length, 0);

  const copy = s.shareAcrossFamily(e.id, { tenantId: T1, toFamily: "browser", approvedBy: "u1", redact: (t) => t.replace(/ACME contract value is [^;]+/u, "[customer detail removed]") });
  assert.equal(copy.scope_ref, "browser");
  assert.equal(copy.redacted, true);
  assert.doesNotMatch(copy.content, /ACME|1\.2M/);
  assert.equal(copy.provenance.source, "cross_family_share");
  assert.deepEqual(copy.provenance.sourceRefs, [e.id]);
  assert.equal(copy.provenance.approvedBy, "u1");
  assert.equal(copy.shared_from, e.id);
  const seen = s.retrieve(T1, browser);
  assert.deepEqual(seen.map((x) => x.id), [copy.id]);
  // The original is still not readable by the other family.
  assert.equal(s.get(T1, browser, e.id), null);
});

test("retention expiry erases due entries; task retention ends with the task", () => {
  let now = new Date("2026-01-01T00:00:00Z");
  const s = store({ clock: () => now });
  const shortLived = observation(s, { retention: { policy: "days", days: 1 } });
  const forever = observation(s, { retention: { policy: "indefinite" } });
  const taskBound = observation(s, { scope: "task", scopeRef: "tsk_9", retention: { policy: "task" } });
  assert.equal(s.retrieve(T1, coder).length, 3);

  now = new Date("2026-01-02T00:00:01Z");
  assert.equal(s.retrieve(T1, coder).some((x) => x.id === shortLived.id), false, "expired entries are hidden before sweep");
  const swept = s.expire(now);
  assert.deepEqual(swept.ids, [shortLived.id]);
  assert.equal(s.expire(now).expired, 0);
  assert.ok(s.retrieve(T1, coder).some((x) => x.id === forever.id));

  const ended = s.endTask(T1, "tsk_9");
  assert.deepEqual(ended.ids, [taskBound.id]);
  assert.deepEqual(s.retrieve(T1, coder).map((x) => x.id), [forever.id]);
});

test("secret-like strings are redacted before storage", () => {
  const s = store();
  const secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX";
  const e = observation(s, { content: `Deploy used key ${secret} and password=hunter2hunter2 via https://bob:pa55w0rd@example.com and ghp_${"a".repeat(36)}` });
  assert.equal(e.redacted, true);
  assert.doesNotMatch(e.content, /sk-ant-api03|hunter2|pa55w0rd|ghp_a/);
  assert.match(e.content, /\[REDACTED:anthropic_key\]/);
  assert.doesNotMatch(s.export(T1, coder), /hunter2/);
  assert.equal(observation(s, { content: "Nothing secret here." }).redacted, false);
  const r = redactSecrets("AKIAABCDEFGHIJKLMNOP and Bearer abcdefghijklmnopqrstuvwxyz");
  assert.deepEqual(r.kinds.sort(), ["aws_access_key", "bearer_token"]);
});

test("audit log records reads, writes and deletes without content", () => {
  const s = store();
  const e = observation(s);
  s.retrieve(T1, coder, { query: "pnpm" });
  s.delete(e.id, { tenantId: T1, by: "u1" });
  const actions = s.auditLog(T1).map((row) => row.action);
  assert.deepEqual(actions, ["write", "read", "delete"]);
  assert.equal(s.auditLog(T2).length, 0);
  assert.ok(new MemoryError("X", "y") instanceof Error);
});
