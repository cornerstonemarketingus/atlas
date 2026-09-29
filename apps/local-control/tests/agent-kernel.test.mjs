import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry } from "../src/agent/tool-registry.mjs";
import { CAPABILITIES, capabilitiesCovering, mountCapabilities } from "../src/agent/kernel/capabilities.mjs";
import { createKernel } from "../src/agent/kernel/kernel.mjs";
import { observationFor, recordToolCall } from "../src/agent/kernel/observations.mjs";
import { createWorldRoutes } from "../src/agent/kernel/routes.mjs";
import { WorldState, cleanAttributes } from "../src/agent/kernel/world-state.mjs";
import { PERMISSION_CAPABILITIES, capabilitiesFor, toolsForAgent } from "../src/agent/team/permissions.mjs";

function world(t) {
  const state = new WorldState();
  t.after(() => state.close());
  return state;
}

function registry(capabilities, { policy = () => "allow" } = {}) {
  const tools = new ToolRegistry({ policy });
  for (const capability of capabilities) {
    tools.register({
      name: `${capability}.tool`, description: `A ${capability} tool.`, capability, risk: "low", timeoutMs: 1000, maxOutputCharacters: 500, requiresApproval: false,
      inputSchema: { type: "object", properties: { path: { type: "string" }, url: { type: "string" } } },
      async execute(input) { return `done ${JSON.stringify(input)}`; },
    });
  }
  return tools;
}

/** A model that calls the tools it is given in order, then reports. */
function scriptedModel(steps) {
  const requests = [];
  return {
    requests,
    async *stream(request) {
      requests.push({ tools: request.tools.map((t) => t.function.name), messages: request.messages.map((m) => ({ role: m.role, content: String(m.content ?? "") })) });
      const step = steps.shift() ?? { say: "Report: finished." };
      if (step.call) yield { type: "tool_call", id: `call-${requests.length}`, name: step.call, arguments: JSON.stringify(step.input ?? {}) };
      else yield { type: "text", delta: step.say };
      yield { type: "done", usage: { prompt_tokens: 50, completion_tokens: 10 } };
    },
  };
}

const identity = { agentId: "agent-1", name: "Builder", systemPrompt: "You are a test agent." };

test("world state: entities merge and version, relations need both ends, and a bad observation changes nothing", (t) => {
  const state = world(t);
  const first = state.upsert({ type: "repository", key: "acme/app", attrs: { branch: "main" } });
  assert.equal(first.id, "repository:acme/app");
  assert.equal(first.version, 1);
  assert.equal(state.upsert({ type: "repository", key: "acme/app", attrs: { branch: "main" } }).version, 1, "no change, no new version");
  const second = state.upsert({ type: "repository", key: "acme/app", attrs: { language: "ts", branch: null } });
  assert.deepEqual(second.attrs, { language: "ts" });
  assert.equal(second.version, 2);
  assert.throws(() => state.upsert({ type: "spaceship", key: "x" }), (error) => error.code === "UNKNOWN_TYPE");
  assert.throws(() => state.relate("repository:acme/app", "likes", "repository:acme/app"), (error) => error.code === "UNKNOWN_RELATION");
  assert.throws(() => state.relate("repository:acme/app", "uses", "service:nope"), (error) => error.code === "UNKNOWN_ENTITY");
  assert.throws(() => state.apply({ entities: [{ type: "file", key: "a.txt" }], relations: [{ from: "file:a.txt", relation: "part_of", to: "repository:missing" }] }));
  assert.equal(state.get("file:a.txt"), null, "rolled back as a whole");
});

test("world state never stores secret values; credentials are references only", (t) => {
  const state = world(t);
  const credential = state.upsert({ type: "credential", key: "stripe", attrs: { name: "STRIPE_KEY", provider: "stripe", ref: "vault:stripe", value: "sk_live_x", note: "x" } });
  assert.deepEqual(credential.attrs, { name: "STRIPE_KEY", provider: "stripe", ref: "vault:stripe" });
  const service = state.upsert({ type: "service", key: "api", attrs: { url: "https://api.example", apiKey: "k", config: { nested: { password: "p", port: 443 } }, headers: [{ authorization: "Bearer t", accept: "json" }] } });
  assert.doesNotMatch(JSON.stringify(service.attrs), /"k"|"p"|Bearer/u);
  assert.equal(service.attrs.config.nested.port, 443);
  assert.deepEqual(cleanAttributes("file", { accessToken: "t", path: "a" }), { path: "a" });
});

test("world state: a snapshot shows the focus, its neighbours, and a run's trace keeps order", (t) => {
  const state = world(t);
  state.apply({ entities: [{ type: "task", key: "t1", attrs: { title: "Fix login" } }, { type: "file", key: "src/login.ts" }, { type: "person", key: "ann@example.com" }], relations: [{ from: "file:src/login.ts", relation: "part_of", to: "task:t1" }] });
  const snap = state.snapshot({ focus: ["task:t1"] });
  assert.deepEqual(snap.entities.map((e) => e.id).sort(), ["file:src/login.ts", "task:t1"]);
  assert.match(snap.text, /file:src\/login.ts -part_of-> task:t1/u);
  state.trace("r1", "goal", { a: 1 });
  state.trace("r1", "act", { b: 2 });
  assert.deepEqual(state.traceOf("r1").map((entry) => [entry.seq, entry.phase]), [[1, "goal"], [2, "act"]]);
});

test("capabilities mount by name, narrow to permissions, and report gaps", () => {
  const tools = registry(["repository.read", "repository.write", "browser.read", "communications.send"]);
  const mount = mountCapabilities(tools, { capabilities: ["code", "browser", "payments"], allowedToolCapabilities: ["repository.read", "browser.read"] });
  assert.deepEqual([...mount.names].sort(), ["browser.read.tool", "repository.read.tool"], "repository.write is outside the permission ceiling");
  assert.deepEqual(mount.gaps, ["payments"], "no payment tool exists yet");
  assert.deepEqual(mountCapabilities(tools, { capabilities: ["email"], allowedToolCapabilities: [] }).gaps, [], "not permitted is not a gap");
  assert.throws(() => mountCapabilities(tools, { capabilities: ["telepathy"] }), (error) => error.code === "UNKNOWN_CAPABILITY");
});

test("for every family permission, the kernel mounts exactly the tools the old team runner allowed", () => {
  const every = [...new Set(Object.values(PERMISSION_CAPABILITIES).flat())];
  const tools = registry(every);
  for (const permission of Object.keys(PERMISSION_CAPABILITIES)) {
    const agent = { permissions: [permission] };
    const allowed = capabilitiesFor(agent.permissions);
    const kernelTools = mountCapabilities(tools, { capabilities: capabilitiesCovering(allowed), allowedToolCapabilities: allowed }).names;
    assert.deepEqual([...kernelTools].sort(), [...toolsForAgent(tools, agent).names].sort(), permission);
  }
  for (const capability of every) assert.ok(Object.values(CAPABILITIES).some((members) => members.includes(capability)), `${capability} belongs to a capability`);
});

test("the kernel runs goal → perceive → act → observe → verify → retry → finish and updates the world", async (t) => {
  const state = world(t);
  state.apply({ entities: [{ type: "task", key: "step-1", attrs: { title: "Check the page" } }, { type: "file", key: "notes.md", attrs: { hint: "earlier finding" } }], relations: [{ from: "file:notes.md", relation: "part_of", to: "task:step-1" }] });
  const tools = registry(["repository.read", "browser.read", "communications.send"]);
  const model = scriptedModel([
    { call: "repository.read.tool", input: { path: "src/app.ts" } },
    { say: "Report: read it." },
    { call: "browser.read.tool", input: { url: "https://example.com/account?token=abc#x" } },
    { say: "Report: read the file and the page; the value is 42." },
  ]);
  const kernel = createKernel({ toolRegistry: tools, world: state });
  const verdicts = [{ passed: false, reason: "The page was not checked." }, { passed: true, reason: "Checked." }];
  const recorded = [];
  const result = await kernel.run({
    runId: "run-1",
    task: { type: "task", key: "step-1" },
    goal: { title: "Check the page", instructions: "Read the file and the page.", doneWhen: "the value is reported" },
    intelligence: { client: model, model: "test" },
    identity,
    capabilities: ["code", "browser"],
    environment: { kind: "local", repository: "acme/app" },
    policy: { allowedToolCapabilities: ["repository.read", "browser.read"] },
    memory: { recall: () => ({ ids: ["m1"], text: "- [m1] the value used to be 41" }) },
  }, {
    budget: { record: (entry) => recorded.push(entry) },
    executeTool: async (call, { allowedTools, toolLog, toolOutcomes }) => {
      assert.ok(allowedTools.has(call.name));
      const outcome = await tools.invoke({ name: call.name, rawArguments: call.arguments, sessionId: "s" });
      toolLog.push({ tool: call.name, status: "succeeded", code: null });
      toolOutcomes.push({ actionKey: call.name, status: "succeeded" });
      return String(outcome.output);
    },
    verify: async () => verdicts.shift(),
  });
  assert.equal(result.verdict.passed, true);
  assert.equal(result.usage.toolCalls, 2);
  assert.ok(recorded.some((entry) => entry.toolCalls === 1), "tool calls are charged to the budget");
  assert.deepEqual(model.requests[0].tools.sort(), ["browser.read.tool", "repository.read.tool"], "communications is not mounted");
  const firstPrompt = model.requests[0].messages[1].content;
  assert.match(firstPrompt, /<data[^>]*world state[^>]*>[\s\S]*file:notes.md/u, "the agent perceives the world state as data");
  assert.match(firstPrompt, /the value used to be 41/u, "memory is retrieved");
  assert.match(model.requests[2].messages.at(-1).content, /does not yet satisfy/u, "the retry carries the reviewer's reason");

  assert.deepEqual(state.traceOf("run-1").map((entry) => entry.phase), ["goal", "mount", "perceive", "retrieve", "plan", "act", "verify", "decide", "plan", "act", "verify", "finish"]);
  assert.equal(state.get("run:run-1").attrs.status, "verified");
  assert.ok(state.relations("run:run-1").some((edge) => edge.relation === "created_by" && edge.to === "agent:agent-1"));
  const file = state.get("file:acme/app:src/app.ts");
  assert.equal(file.attrs.lastStatus, "succeeded");
  assert.ok(state.relations(file.id).some((edge) => edge.relation === "part_of" && edge.to === "repository:acme/app"));
  assert.ok(state.get("browser_resource:https://example.com/account"), "query strings and fragments are never stored");
  assert.doesNotMatch(JSON.stringify(state.find({ limit: 200 })), /token=abc/u);
});

test("a failed run is recorded as unverified; a pending approval is part of the world", async (t) => {
  const state = world(t);
  const tools = registry(["communications.send"]);
  const kernel = createKernel({ toolRegistry: tools, world: state });
  const result = await kernel.run({
    runId: "run-2",
    goal: { title: "Email the client", instructions: "Send it.", doneWhen: "the email is sent" },
    intelligence: { client: scriptedModel([{ call: "communications.send.tool", input: { path: "x" } }, { say: "Report: requested." }, { say: "Report: still waiting." }]), model: "test" },
    identity,
    capabilities: ["email"],
    policy: { attempts: 2 },
  }, {
    executeTool: async (call, { toolLog, toolOutcomes }) => {
      toolLog.push({ tool: call.name, status: "awaiting_approval", code: "APPROVAL_REQUIRED" });
      toolOutcomes.push({ actionKey: call.name, status: "awaiting_approval" });
      return "This action needs the owner's approval.";
    },
    verify: async () => ({ passed: false, reason: "1 action(s) are still waiting for approval." }),
  });
  assert.equal(result.verdict.passed, false);
  assert.equal(state.get("run:run-2").attrs.status, "unverified");
  const waits = state.relations("run:run-2").filter((edge) => edge.relation === "waits_on");
  assert.equal(waits.length, 1);
  assert.equal(state.get(waits[0].to).attrs.status, "pending");
  assert.equal(state.traceOf("run-2").filter((entry) => entry.phase === "decide").at(-1).data.next, "escalate");
});

test("an external harness (the coder) runs inside the kernel: traced, its artifact in the world, verified only with output", async (t) => {
  const state = world(t);
  const kernel = createKernel({ toolRegistry: registry([]), world: state });
  const done = await kernel.runHarness({ runId: "coder-1", goal: { title: "Fix the login redirect" }, capabilities: ["code"], harness: "atlas-cli", environment: { kind: "local", repository: "/work/app" } },
    async () => ({ ok: true, summary: "Fixed.", artifacts: [{ kind: "patch", key: "lane-1.patch", attrs: { bytes: 120 } }] }));
  assert.equal(done.verdict.passed, true);
  assert.deepEqual(state.traceOf("coder-1").map((e) => e.phase), ["goal", "mount", "act", "observe", "verify", "finish"]);
  assert.equal(state.get("run:coder-1").attrs.status, "verified");
  assert.ok(state.relations("artifact:lane-1.patch").some((e) => e.relation === "produced" && e.from === "run:coder-1"));
  assert.ok(state.relations("artifact:lane-1.patch").some((e) => e.relation === "part_of" && e.to === "repository:/work/app"));

  const empty = await kernel.runHarness({ runId: "coder-2", goal: { title: "Nothing to do" }, capabilities: ["code"], harness: "atlas-cli" }, async () => ({ ok: true, artifacts: [] }));
  assert.equal(empty.verdict.passed, false, "success without output is not verified");
  const crashed = await kernel.runHarness({ runId: "coder-3", goal: { title: "Crash" }, capabilities: ["code"], harness: "atlas-cli" }, async () => { throw new Error("worktree missing"); });
  assert.equal(crashed.verdict.passed, false);
  assert.match(crashed.verdict.reason, /worktree missing/u);
  assert.equal(state.get("run:coder-3").attrs.status, "unverified");
  const cancelled = await kernel.runHarness({ runId: "coder-4", goal: { title: "Stop" }, capabilities: ["code"], harness: "atlas-cli" }, async () => ({ ok: false, cancelled: true }));
  assert.equal(state.get("run:coder-4").attrs.status, "cancelled");
  assert.equal(cancelled.verdict.passed, false);
});

test("tool calls made outside a run (chat) are recorded too, and never break the caller", (t) => {
  const state = world(t);
  recordToolCall(state, { runId: "chat:s1", runAttrs: { kind: "conversation" }, seq: "c1", call: { name: "filesystem.read" }, input: { path: "/tmp/a.txt" }, status: "succeeded" });
  assert.equal(state.get("file:/tmp/a.txt").attrs.lastTool, "filesystem.read");
  assert.ok(state.relations("run:chat:s1").some((edge) => edge.relation === "part_of"));
  assert.doesNotThrow(() => recordToolCall({ upsert() { throw new Error("disk full"); } }, { runId: "x", seq: 1, call: { name: "t" }, status: "failed" }));
  const observation = observationFor({ runId: "r", seq: 1, call: { name: "communications.send" }, input: { to: "Ann@Example.com" }, status: "succeeded" });
  assert.ok(observation.entities.some((e) => e.type === "person" && e.key === "ann@example.com"));
});

test("/v1/world is owner-only and shows entities, relations and traces", (t) => {
  const state = world(t);
  state.apply({ entities: [{ type: "task", key: "t1" }, { type: "run", key: "r1" }], relations: [{ from: "run:r1", relation: "part_of", to: "task:t1" }] });
  state.trace("r1", "goal", {});
  const sent = [];
  const handle = createWorldRoutes({ world: state, send: (_response, status, body) => { sent.push({ status, body }); return true; } });
  const call = (path, role = "admin", method = "GET") => { handle({ url: path, method }, {}, { role }); return sent.at(-1); };
  assert.equal(handle({ url: "/v1/other", method: "GET" }, {}, { role: "admin" }), false);
  assert.equal(call("/v1/world", "device").status, 403);
  assert.equal(call("/v1/world", "admin", "POST").status, 405);
  assert.equal(call("/v1/world?type=task").body.entities.length, 1);
  assert.equal(call(`/v1/world/entities/${encodeURIComponent("run:r1")}`).body.relations[0].relation, "part_of");
  assert.equal(call("/v1/world/entities/run%3Anope").status, 404);
  assert.deepEqual(call("/v1/world/runs/r1/trace").body.trace.map((entry) => entry.phase), ["goal"]);
});
