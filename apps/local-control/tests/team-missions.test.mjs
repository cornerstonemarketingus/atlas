import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MissionService } from "../src/agent/mission-service.mjs";
import { ToolRegistry } from "../src/agent/tool-registry.mjs";
import { createAgentStepExecutor } from "../src/agent/team/step-executor.mjs";
import { createTeamService } from "../src/agent/team/team-service.mjs";
import { validatePlan } from "../src/agent/team/planner.mjs";
import { capabilitiesFor } from "../src/agent/team/permissions.mjs";
import { AgentFamilyRegistry, TaskDelegation, seedFamilies } from "../src/platform/family/index.mjs";
import { PlatformTaskStore } from "../src/platform/task-store.mjs";
import { LocalTaskStore } from "../src/store.mjs";

/**
 * A scripted model: it answers by what the request is (planning, a step,
 * a verification) so the real runtime around it can be exercised end to end.
 */
function scriptedModel({ plan, verdict = () => true, onStep = null }) {
  const seen = [];
  return {
    seen,
    async *stream(request) {
      const system = request.messages[0].content;
      const last = request.messages.at(-1);
      seen.push({ system, last: last.content ?? "", tools: request.tools.map((t) => t.function.name) });
      if (system.startsWith("You are the planning lead")) {
        yield { type: "text", delta: JSON.stringify(plan) };
      } else if (system.startsWith("You verify")) {
        yield { type: "text", delta: JSON.stringify({ passed: verdict(last.content), reason: verdict(last.content) ? "The report meets the check." : "The report does not show the result." }) };
      } else if (onStep) {
        yield* onStep(request);
      } else if (last.role === "tool") {
        yield { type: "text", delta: `Report: done. Tool said ${last.content.includes("42") ? "42" : "nothing"}.` };
      } else {
        const tool = request.tools[0]?.function.name;
        if (tool) yield { type: "tool_call", id: `call-${seen.length}`, name: tool, arguments: "{}" };
        else yield { type: "text", delta: "Report: reasoned it through." };
      }
      yield { type: "done", usage: { prompt_tokens: 100, completion_tokens: 20 } };
    },
  };
}

async function harness(t, model) {
  const dir = await mkdtemp(join(tmpdir(), "atlas-team-"));
  const store = new LocalTaskStore(join(dir, "atlas.sqlite"));
  const platformStore = new PlatformTaskStore(join(dir, "platform.sqlite"));
  const family = new AgentFamilyRegistry(join(dir, "org.sqlite"));
  seedFamilies(family, "local");
  const delegation = new TaskDelegation(family);
  const toolRegistry = new ToolRegistry({ policy: () => "allow" });
  toolRegistry.register({ name: "browser.extract", description: "Read a value from the page.", capability: "browser.read", risk: "low", timeoutMs: 1000, maxOutputCharacters: 200, requiresApproval: false, inputSchema: { type: "object", properties: {} }, async execute() { return "The page says 42."; } });
  toolRegistry.register({ name: "repository.read", description: "Read a file.", capability: "repository.read", risk: "low", timeoutMs: 1000, maxOutputCharacters: 200, requiresApproval: false, inputSchema: { type: "object", properties: {} }, async execute() { return "file contents: 42"; } });
  toolRegistry.register({ name: "communications.send", description: "Send an email.", capability: "communications.send", risk: "high", timeoutMs: 1000, maxOutputCharacters: 200, requiresApproval: false, inputSchema: { type: "object", properties: {} }, async execute() { throw new Error("must never run"); } });
  let missionService;
  const step = createAgentStepExecutor({
    family, delegation, toolRegistry, client: model, platformStore, approvals: null,
    resultsOf: (missionId, ids) => (missionService.get(missionId)?.children ?? []).filter((c) => ids.includes(c.id)).map((c) => ({ title: c.metadata.stepTitle, summary: c.result?.handoff?.report ?? "" })),
  });
  missionService = new MissionService({ store, execute: (input) => step(input) });
  const team = createTeamService({ family, delegation, missionService, platformStore, toolRegistry, client: model, model: "test-model", workspace: dir });
  t.after(async () => { platformStore.close(); family.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const until = async (id, states) => {
    for (let i = 0; i < 200; i += 1) {
      const mission = missionService.get(id);
      // Wait for the platform task to settle too: it follows the persisted state change.
      const taskStatus = platformStore.getTask("local", mission.children[0].metadata.platformTaskId)?.status;
      if (states.includes(mission.status) && ["completed", "failed", "cancelled"].includes(taskStatus)) return mission;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Mission stayed ${missionService.get(id).status}`);
  };
  return { team, family, delegation, platformStore, missionService, until };
}

const twoStepPlan = {
  summary: "Research, then check the code.",
  successCriteria: ["The value is confirmed in both places."],
  steps: [
    { title: "Find the published value", agent: "Market Research Agent", instructions: "Read the value from the page.", doneWhen: "The report states the value.", dependsOn: [] },
    { title: "Confirm it in the code", agent: "Backend Agent", instructions: "Check the value in the repository.", doneWhen: "The report confirms the value.", dependsOn: [1] },
  ],
};

test("a goal becomes a plan the agents carry out, with delegation, traces, verified artifacts and costs", async (t) => {
  const model = scriptedModel({ plan: twoStepPlan });
  const { team, family, delegation, platformStore, until } = await harness(t, model);
  const started = await team.start({ goal: "Confirm the published value matches the code." });
  assert.equal(started.plan.steps.length, 2);
  assert.equal(started.task.status, "running");
  const done = await until(started.mission.id, ["completed", "failed"]);
  assert.equal(done.status, "completed", JSON.stringify(done.children.map((c) => c.result)));

  const detail = team.detail(started.mission.id);
  assert.equal(detail.taskStatus, "completed");
  assert.deepEqual(detail.steps.map((s) => [s.agent, s.state, s.verified]), [["Market Research Agent", "completed", true], ["Backend Agent", "completed", true]]);
  // Each agent could only use the tools its permissions allow.
  assert.deepEqual(detail.toolCalls.map((c) => [c.agent, c.tool, c.status]), [["Market Research Agent", "browser.extract", "succeeded"], ["Backend Agent", "repository.read", "succeeded"]]);
  assert.ok(model.seen.every((s) => !s.tools.includes("communications.send")), "no agent is offered a send tool it does not hold");
  // Durable delegation: a downward delegation inside Business, a scoped cross-family request to Engineering.
  const types = detail.messages.map((m) => m.type);
  assert.ok(types.includes("TASK_ASSIGNMENT") && types.includes("CROSS_FAMILY_REQUEST") && types.includes("RESULT"), types.join(","));
  // The second step received the first step's result as data, not instructions.
  assert.ok(model.seen.some((s) => /<data source="earlier steps">[\s\S]*42/u.test(s.last)));
  // Verified artifacts with evidence, and spending charged to the agents that worked.
  assert.equal(detail.artifacts.length, 2);
  assert.ok(detail.artifacts.every((a) => a.verification === "verified" && a.evidence[0].kind === "step_check"));
  const researcher = family.listAgents("local").find((a) => a.name === "Market Research Agent");
  assert.ok(researcher.consumed.toolCalls >= 1 && researcher.consumed.inputTokens > 0);
  assert.ok(detail.usage.toolCalls >= 2);
  assert.equal(delegation.getAssignment("local", `mission:${started.mission.id}`).state, "completed");
  assert.deepEqual(platformStore.listTransitions("local", detail.taskId).map((x) => x.to), ["authorized", "queued", "running", "verifying", "completed"]);
});

test("an unverified step fails the mission honestly after one retry", async (t) => {
  const model = scriptedModel({ plan: { ...twoStepPlan, steps: [twoStepPlan.steps[0]] }, verdict: () => false });
  const { team, until } = await harness(t, model);
  const started = await team.start({ goal: "Find the published value on the page." });
  const done = await until(started.mission.id, ["completed", "failed"]);
  assert.equal(done.status, "failed");
  const detail = team.detail(started.mission.id);
  assert.equal(detail.taskStatus, "failed");
  assert.equal(detail.steps[0].verified, false);
  assert.match(detail.steps[0].summary, /^Not verified/u);
  assert.equal(detail.artifacts[0].verification, "rejected");
  assert.equal(model.seen.filter((s) => s.system.startsWith("You verify")).length, 2, "one retry, then stop");
});

test("an agent cannot use a tool outside its permissions, even if the model asks", async (t) => {
  const model = scriptedModel({
    plan: { ...twoStepPlan, steps: [twoStepPlan.steps[0]] },
    async *onStep(request) {
      const last = request.messages.at(-1);
      if (last.role === "tool") yield { type: "text", delta: "Report: the value is 42." };
      else yield { type: "tool_call", id: "sneaky", name: "communications.send", arguments: "{}" };
    },
  });
  const { team, until } = await harness(t, model);
  const started = await team.start({ goal: "Find the published value and email it." });
  await until(started.mission.id, ["completed", "failed"]);
  const detail = team.detail(started.mission.id);
  assert.deepEqual(detail.toolCalls.map((c) => [c.tool, c.status, c.error?.code]), [["communications.send", "denied", "NOT_PERMITTED"]]);
});

test("a running mission can be cancelled, and the platform task says so", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const model = scriptedModel({
    plan: { ...twoStepPlan, steps: [twoStepPlan.steps[0]] },
    async *onStep(request) {
      await Promise.race([gate, new Promise((_, reject) => request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))]);
      yield { type: "text", delta: "Report: late." };
    },
  });
  const { team, until } = await harness(t, model);
  const started = await team.start({ goal: "Find the published value, slowly." });
  await new Promise((resolve) => setTimeout(resolve, 30));
  team.control(started.mission.id, "cancel");
  const done = await until(started.mission.id, ["cancelled", "failed", "completed"]);
  release();
  assert.equal(done.status, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(team.detail(started.mission.id).taskStatus, "cancelled");
});

test("plans are validated against the real organization and cannot form cycles", () => {
  const roster = [{ id: "a1", name: "Market Research Agent" }, { id: "a2", name: "Backend Agent" }];
  assert.equal(validatePlan(twoStepPlan, roster).steps[1].dependencies[0], "step-1");
  assert.throws(() => validatePlan({ steps: [{ ...twoStepPlan.steps[0], agent: "Chief Everything Officer" }] }, roster), (e) => e.code === "UNKNOWN_AGENT");
  assert.throws(() => validatePlan({ steps: [{ ...twoStepPlan.steps[0], dependsOn: [1] }] }, roster), (e) => e.code === "INVALID_DEPENDENCY");
  assert.throws(() => validatePlan({ steps: [{ ...twoStepPlan.steps[1], dependsOn: [2] }, twoStepPlan.steps[0]] }, roster), (e) => e.code === "INVALID_DEPENDENCY");
  assert.throws(() => validatePlan({ steps: Array.from({ length: 9 }, () => twoStepPlan.steps[0]) }, roster), (e) => e.code === "PLAN_TOO_LARGE");
  assert.throws(() => validatePlan({ steps: [{ agent: "Backend Agent", title: "x" }] }, roster), (e) => e.code === "INVALID_STEP");
  assert.ok(capabilitiesFor(["repo.read"]).has("repository.read"));
  assert.ok(!capabilitiesFor(["email.draft", "web.search"]).has("communications.send"));
});

test("without a model, starting a mission explains what to configure", async (t) => {
  const { team } = await harness(t, scriptedModel({ plan: twoStepPlan }));
  const noModel = createTeamService({ family: null, delegation: null, missionService: null, platformStore: null, toolRegistry: null, client: null, model: "m", workspace: "/tmp" });
  await assert.rejects(noModel.start({ goal: "Do something useful today." }), (e) => e.blocked === "BLOCKED_BY_CAPABILITY" && /ATLAS_MODEL_ENDPOINT/u.test(e.unblock));
  await assert.rejects(team.start({ goal: "hi" }), (e) => e.code === "INVALID_GOAL");
});
