import assert from "node:assert/strict";
import test from "node:test";

import {
  SELF_REPOSITORY, TASK_TOOL, TASK_TOOL_NAME, atlasSystemPrompt, describeStartedTask, taskRequestsFrom,
} from "../app/api/chat/atlas-knowledge.mjs";

const toolReply = (...calls) => ({ choices: [{ message: { content: "", tool_calls: calls } }] });
const call = (args, name = TASK_TOOL_NAME) => ({ id: "c1", type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });

test("the system prompt tells the model it is Atlas, where its code lives, and to act instead of advising", () => {
  const prompt = atlasSystemPrompt({ isOwner: true });
  assert.match(prompt, /You are Atlas/u);
  assert.match(prompt, /cornerstonemarketingus\/atlas/u);
  assert.match(prompt, /apps\/web/u);
  assert.match(prompt, /apps\/local-control/u);
  assert.match(prompt, /start_atlas_task/u);
  assert.match(prompt, /instead of writing a generic plan/u);
  assert.match(prompt, /deployment owner, so you may start work on your own repository/u);
});

test("non-owners are told they cannot start work on Atlas itself", () => {
  const prompt = atlasSystemPrompt({ isOwner: false, repository: "someone/app" });
  assert.match(prompt, /Only the Atlas deployment owner/u);
  assert.match(prompt, /someone\/app/u);
});

test("the tool schema only allows the three real modes", () => {
  assert.equal(TASK_TOOL.function.name, TASK_TOOL_NAME);
  assert.deepEqual(TASK_TOOL.function.parameters.properties.mode.enum, ["coder", "inspect", "debug"]);
  assert.deepEqual(TASK_TOOL.function.parameters.required, ["mode", "objective"]);
});

test("tool calls become task requests, defaulting to the selected project or Atlas itself", () => {
  const selfWork = taskRequestsFrom(toolReply(call({ mode: "coder", objective: "Add a test for defaultMergePolicy." })));
  assert.deepEqual(selfWork.requests, [{ mode: "coder", objective: "Add a test for defaultMergePolicy.", repository: SELF_REPOSITORY }]);

  const project = taskRequestsFrom(toolReply(call({ mode: "inspect", objective: "Map the API routes." })), { defaultRepository: "Someone/App" });
  assert.equal(project.requests[0].repository, "someone/app");

  const explicit = taskRequestsFrom(toolReply(call({ mode: "debug", objective: "Find the failing test.", repository: "cornerstonemarketingus/atlas" })), { defaultRepository: "someone/app" });
  assert.equal(explicit.requests[0].repository, SELF_REPOSITORY);
});

test("malformed, unknown and excess tool calls are reported, never guessed at", () => {
  const result = taskRequestsFrom(toolReply(
    call("{not json"),
    call({ mode: "deploy", objective: "ship it" }),
    call({ mode: "coder", objective: "x" }, "delete_everything"),
    call({ mode: "coder", objective: "fourth call is dropped" }),
  ));
  assert.equal(result.requests.length, 0);
  assert.equal(result.errors.length, 3);
  assert.deepEqual(taskRequestsFrom({ choices: [{ message: { content: "just text" } }] }), { requests: [], errors: [] });
});

test("started-task lines are honest about what will happen", () => {
  const request = { mode: "coder", objective: "Fix the login redirect.", repository: SELF_REPOSITORY };
  assert.match(describeStartedTask(request, { ok: true, taskId: "t1", mergePolicy: "ci-gated" }), /merge it itself once every CI check passes.*task t1/su);
  assert.match(describeStartedTask(request, { ok: true, mergePolicy: "manual" }), /for your review/u);
  assert.match(describeStartedTask(request, { ok: false, message: "Only the Atlas deployment owner can run coder mode" }), /^I could not start a coder run/u);
  assert.doesNotMatch(describeStartedTask({ ...request, mode: "inspect" }, { ok: true }), /merge/u);
});

test("streamed tool calls are assembled from pieces and become task requests", async () => {
  const { createDeltaParser } = await import("../app/api/chat/stream.mjs");
  const { taskRequestsFromCalls } = await import("../app/api/chat/atlas-knowledge.mjs");
  const parser = createDeltaParser();
  const chunk = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n`;
  const deltas = parser.push([
    chunk({ content: "Starting that now." }),
    chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "start_atlas_task", arguments: "{\"mode\":\"co" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: "der\",\"objective\":\"Add a test for defaultMergePolicy.\"}" } }] }),
    "data: [DONE]\n",
  ].join(""));
  assert.deepEqual(deltas, ["Starting that now."]);
  assert.equal(parser.done, true);
  const { requests, errors } = taskRequestsFromCalls(parser.toolCalls);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, [{ mode: "coder", objective: "Add a test for defaultMergePolicy.", repository: SELF_REPOSITORY }]);
});
