import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyAutonomy, assessAction, effectsFor, suggestRelaxations, withAutonomy } from "../src/agent/kernel/autonomy.mjs";
import { ToolRegistry } from "../src/agent/tool-registry.mjs";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";
const tool = (capability, extra = {}) => ({ name: `${capability}.do`, capability, risk: "moderate", requiresApproval: false, ...extra });

test("levels follow what an action does: read, sandbox, restorable, outside, consequential, prohibited", () => {
  assert.equal(assessAction({ tool: tool("repository.read") }).level, 0);
  assert.equal(assessAction({ tool: tool("genesis.build") }).level, 1);
  assert.equal(assessAction({ tool: tool("code.write") }).level, 2);
  assert.equal(assessAction({ tool: tool("terminal.run") }).level, 3, "cannot be undone");
  assert.equal(assessAction({ tool: tool("publish.remote") }).level, 3, "acts outside this machine");
  assert.equal(assessAction({ tool: tool("deploy.remote") }).level, 4, "affects production");
  assert.equal(assessAction({ tool: tool("payments.spend") }).level, 4, "spends money");

  const unknown = assessAction({ tool: tool("mcp.someone") });
  assert.equal(unknown.level, 3);
  assert.match(unknown.reasons.join(" "), /does not know/u);
  assert.equal(unknown.mode, "ask");
});

test("arguments can only add effects: destructive commands, production targets, money, credentials", () => {
  const terminal = tool("terminal.run");
  assert.equal(assessAction({ tool: terminal, input: { argv: ["ls", "-la"] } }).level, 3);
  const destroy = assessAction({ tool: terminal, input: { argv: ["sh", "-c", "rm -rf build"] } });
  assert.equal(destroy.level, 4);
  assert.match(destroy.reasons.join(" "), /destroys data/u);
  assert.equal(assessAction({ tool: terminal, input: { command: "git push origin main --force" } }).level, 4);
  assert.equal(assessAction({ tool: terminal, input: { sql: "DROP TABLE users" } }).level, 4);

  assert.equal(assessAction({ tool: tool("code.write"), input: { target: "production" } }).level, 4, "a production target");
  assert.equal(assessAction({ tool: tool("code.write"), input: { note: "production notes" } }).level, 2, "the word alone in free text is not a target");
  assert.equal(assessAction({ tool: tool("code.write"), input: { target: "staging" } }).level, 2, "another target is not production");
  assert.equal(assessAction({ tool: tool("code.write"), input: { amountUsd: 12 } }).level, 4, "money");
  assert.equal(assessAction({ tool: tool("code.write"), input: { amountUsd: 0 } }).level, 2, "no money moves");

  const leak = assessAction({ tool: tool("communications.send"), input: { body: `here: ghp_${"a".repeat(36)}` } });
  assert.equal(leak.level, 5);
  assert.equal(leak.mode, "prohibited");
  assert.match(leak.reasons[0], /credential would leave this machine/u);
  assert.equal(assessAction({ tool: tool("filesystem.write"), input: { content: `-----BEGIN OPENSSH PRIVATE KEY-----` } }).level, 4, "a key that stays local");
  assert.equal(assessAction({ tool: tool("deploy.remote"), input: { command: "DROP DATABASE app" } }).level, 5, "destroying production");

  // Nested arguments are scanned too.
  assert.equal(effectsFor(tool("terminal.run"), { steps: [{ run: "rm -fr /tmp/x" }] }).destroys, true);
  // A restorable file write that contains a destructive command is only text.
  assert.equal(assessAction({ tool: tool("code.write"), input: { path: "Makefile", content: "clean:\n\trm -rf build" } }).level, 2);
  // A tool's own declaration wins over its capability's default.
  assert.equal(assessAction({ tool: tool("terminal.run", { effects: {} }) }).level, 0);
});

test("declared risk and confidence raise a level; low confidence never makes an action prohibited", () => {
  const critical = assessAction({ tool: tool("code.write", { risk: "critical" }) });
  assert.equal(critical.level, 4);
  assert.match(critical.reasons.join(" "), /declared critical/u);
  assert.equal(assessAction({ tool: tool("code.write", { risk: "high" }) }).level, 3);
  assert.equal(assessAction({ tool: tool("code.write", { requiresApproval: true }) }).level, 3);
  assert.equal(assessAction({ tool: tool("code.write"), confidence: 0.3 }).level, 3);
  assert.equal(assessAction({ tool: tool("code.write"), confidence: 0.5 }).level, 2, "0.5 is not unsure");
  assert.equal(assessAction({ tool: tool("deploy.remote"), confidence: 0.1 }).level, 4);
});

test("autonomy only tightens the owner's policy", () => {
  const level = (n) => ({ level: n, mode: "x", reasons: ["r"] });
  assert.equal(applyAutonomy("deny", level(0)).decision, "deny", "deny stays deny");
  assert.equal(applyAutonomy("ask", level(0)).decision, "ask", "never loosens an ask");
  assert.equal(applyAutonomy("allow", level(3)).decision, "allow", "level 3 follows the owner");
  assert.equal(applyAutonomy("ask", level(3)).decision, "ask");
  const strong = applyAutonomy("allow", level(4));
  assert.equal(strong.decision, "ask");
  assert.equal(strong.autonomy.confirmation, "strong");
  assert.equal(applyAutonomy("allow", level(2)).autonomy.confirmation, null);
  assert.equal(applyAutonomy("ask", level(3)).autonomy.confirmation, null, "an ordinary ask needs one answer");
  assert.equal(applyAutonomy("allow", level(5)).decision, "deny");
  assert.equal(applyAutonomy("weird", level(1)).decision, "ask", "an unrecognised answer asks");
});

test("through the tool registry: allowed work runs and is audited, level 4 asks, level 5 never executes", async () => {
  const audited = [];
  const ran = [];
  const registry = new ToolRegistry({ policy: withAutonomy(() => "allow", { audit: (entry) => audited.push(entry) }) });
  registry.register({
    name: "terminal.exec", description: "run", capability: "terminal.run", risk: "moderate", requiresApproval: false,
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    timeoutMs: 1000, maxOutputCharacters: 1000, execute: async ({ input }) => { ran.push(input.command); return "ok"; },
  });
  registry.register({
    name: "communications.post", description: "send", capability: "communications.send", risk: "moderate", requiresApproval: false,
    inputSchema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
    timeoutMs: 1000, maxOutputCharacters: 1000, execute: async ({ input }) => { ran.push(input.body); return "sent"; },
  });
  registry.register({
    name: "repository.peek", description: "read", capability: "repository.read", risk: "low", requiresApproval: false,
    inputSchema: { type: "object", properties: {} }, timeoutMs: 1000, maxOutputCharacters: 1000, execute: async () => "seen",
  });

  assert.equal((await registry.invoke({ name: "repository.peek", rawArguments: "{}", sessionId: "s" })).status, "completed");
  assert.equal(audited.length, 0, "a level 0 read is not audited");

  const listed = await registry.invoke({ name: "terminal.exec", rawArguments: { command: "ls" }, sessionId: "s" });
  assert.equal(listed.status, "completed");
  assert.equal(audited.length, 1);
  assert.equal(audited[0].level, 3);

  const destroy = await registry.invoke({ name: "terminal.exec", rawArguments: { command: "rm -rf /srv/data" }, sessionId: "s", approvals: { check: async () => false } });
  assert.equal(destroy.status, "approval-required");
  assert.equal(destroy.autonomy.level, 4);
  assert.equal(destroy.autonomy.confirmation, "strong");

  const approved = await registry.invoke({ name: "terminal.exec", rawArguments: { command: "rm -rf /srv/data" }, sessionId: "s", approvals: { check: async (digest) => digest === destroy.digest } });
  assert.equal(approved.status, "completed", "an approval for that exact action lets it run");

  const leak = await registry.invoke({ name: "communications.post", rawArguments: { body: `key sk-${"x".repeat(32)}` }, sessionId: "s", approvals: { check: async () => true } });
  assert.equal(leak.status, "rejected");
  assert.equal(leak.code, "PROHIBITED");
  assert.match(leak.message, /will not do this/u);
  assert.deepEqual(ran, ["ls", "rm -rf /srv/data"], "the prohibited send never executed, even with an approval");
});

test("precedent suggests relaxing an ask only after consistent approvals, and never for consequential or always-asking tools", () => {
  const tools = [tool("code.write"), tool("deploy.remote"), tool("terminal.run", { requiresApproval: true }), tool("publish.remote")];
  const approvals = (capability, statuses) => statuses.map((status, index) => ({ capability, status, requestedAt: `2026-10-0${1}T00:00:${String(10 + index)}Z`, resolvedAt: `2026-10-01T00:01:${String(10 + index)}Z` }));
  const policies = [{ capability: "code.write", decision: "ask" }, { capability: "deploy.remote", decision: "ask" }, { capability: "terminal.run", decision: "ask" }, { capability: "publish.remote", decision: "ask" }];

  const many = (status) => Array.from({ length: 5 }, () => status);
  const suggestions = suggestRelaxations({
    policies,
    tools,
    approvals: [
      ...approvals("code.write", many("approved")),
      ...approvals("deploy.remote", many("approved")),
      ...approvals("terminal.run", many("approved")),
      ...approvals("publish.remote", ["approved", "approved", "approved", "approved", "approved", "denied"]),
    ],
  });
  assert.deepEqual(suggestions.map((entry) => entry.capability), ["code.write"]);
  assert.equal(suggestions[0].approved, 5);
  assert.match(suggestions[0].reason, /last 5 requests/u);

  assert.deepEqual(suggestRelaxations({ policies, tools, approvals: approvals("code.write", ["approved", "approved", "approved", "approved"]) }), [], "four is not enough");
  assert.deepEqual(suggestRelaxations({ policies: [{ capability: "code.write", decision: "allow" }], tools, approvals: approvals("code.write", many("approved")) }), [], "already allowed");
  assert.deepEqual(suggestRelaxations({ policies, tools, approvals: [...approvals("code.write", many("approved")), { capability: "code.write", status: "pending", requestedAt: "2026-10-02T00:00:00Z" }] }).length, 1, "pending requests do not count against");
  // Only the most recent decisions count: an old denial falls out of the window.
  const old = { capability: "code.write", status: "denied", requestedAt: "2026-09-01T00:00:00Z", resolvedAt: "2026-09-01T00:00:00Z" };
  assert.equal(suggestRelaxations({ policies, tools, approvals: [old, ...approvals("code.write", many("approved"))], window: 5 }).length, 1);
  assert.equal(suggestRelaxations({ policies, tools, approvals: [old, ...approvals("code.write", many("approved"))], window: 6 }).length, 0);
});

test("a level 4 approval needs a second confirmation, in the store and over HTTP; /v1/autonomy lists levels and suggestions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-autonomy-"));
  const store = new LocalTaskStore(join(directory, "atlas.sqlite"));
  const catalog = [tool("code.write"), tool("deploy.remote")];
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true }), toolCatalog: () => catalog });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const admin = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const call = (path, init = {}) => fetch(`${origin}${path}`, init).then(async (response) => ({ status: response.status, body: await response.json() }));

  const strong = store.createApproval({ capability: "deploy.remote", summary: "Deploy", actionDigest: "a".repeat(64), riskLevel: 4 });
  assert.equal(strong.riskLevel, 4);
  assert.equal(store.approval(strong.id).riskLevel, 4);
  assert.throws(() => store.decideApproval(strong.id, "approved"), (error) => error.code === "CONFIRMATION_REQUIRED");

  const refused = await call(`/v1/approvals/${strong.id}/decision`, { method: "POST", headers: admin, body: JSON.stringify({ decision: "approved" }) });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "CONFIRMATION_REQUIRED");
  assert.equal(store.approval(strong.id).status, "pending", "still waiting");
  const confirmed = await call(`/v1/approvals/${strong.id}/decision`, { method: "POST", headers: admin, body: JSON.stringify({ decision: "approved", confirm: true }) });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.approval.status, "approved");

  const deny = store.createApproval({ capability: "deploy.remote", summary: "Deploy again", actionDigest: "b".repeat(64), riskLevel: 4 });
  assert.equal(store.decideApproval(deny.id, "denied").status, "denied", "saying no never needs a second step");
  const ordinary = store.createApproval({ capability: "code.write", summary: "Write", actionDigest: "c".repeat(64), riskLevel: 3 });
  assert.equal(store.decideApproval(ordinary.id, "approved").status, "approved");
  const legacy = store.createApproval({ capability: "code.write", summary: "Old style", actionDigest: "d".repeat(64), riskLevel: 9 });
  assert.equal(legacy.riskLevel, null, "an out-of-range level is not stored");

  for (let index = 0; index < 5; index += 1) {
    const approval = store.createApproval({ capability: "code.write", summary: `w${index}`, actionDigest: String(index).repeat(64) });
    store.decideApproval(approval.id, "approved");
  }
  store.setPolicy("deploy.remote", "ask");
  const autonomy = await call("/v1/autonomy", { headers: admin });
  assert.equal(autonomy.status, 200);
  assert.equal(autonomy.body.levels.length, 6);
  assert.deepEqual(autonomy.body.tools.map((entry) => [entry.capability, entry.level]), [["code.write", 2], ["deploy.remote", 4]]);
  assert.deepEqual(autonomy.body.suggestions.map((entry) => entry.capability), ["code.write"]);
  const tools = await call("/v1/tools", { headers: admin });
  assert.equal(tools.body.tools[1].autonomy.level, 4);
  assert.equal((await call("/v1/autonomy", {})).status, 401);
});

test("a tool that only files a request is judged where the request is decided", () => {
  const request = tool("genesis.build", { effects: { writes: true, reversible: true, sandboxed: true, requestOnly: true } });
  const assessed = assessAction({ tool: request, input: { mode: "deploy", target: "production" } });
  assert.equal(assessed.level, 1, "the production target is gated by the publisher's own approval");
  assert.match(assessed.reasons[0], /approved separately/u);
  assert.equal(assessAction({ tool: tool("genesis.build"), input: { target: "production" } }).level, 4, "without the declaration it would ask");
});
