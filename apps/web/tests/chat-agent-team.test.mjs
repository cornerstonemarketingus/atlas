import assert from "node:assert/strict";
import test from "node:test";

import { HOSTED_ROSTER, MAX_DEPTH, availableRoster, createAgentTeam } from "../app/api/chat/agent-team.mjs";

const endpoint = { baseUrl: "https://model.test/v1", apiKey: "k", model: "m" };
const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const text = (content) => json({ choices: [{ message: { content } }] });
const tool = (id, name, args) => json({ choices: [{ message: { content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });

/**
 * A fake model that plays every part: the planner (JSON plan), each agent
 * (by the step title in its prompt), and the checker (JSON verdict).
 */
function fakeModel({ plan, agents = {}, verdicts = {} }) {
  const log = [];
  const calls = {};
  const fetcher = async (url, init) => {
    if (!String(url).startsWith("https://model.test")) return new Response("<title>Page</title><p>facts</p>", { headers: { "content-type": "text/html" } });
    const body = JSON.parse(init.body);
    const system = body.messages[0].content;
    const user = body.messages.find((message) => message.role === "user")?.content ?? "";
    if (system.startsWith("You are the planning lead")) { log.push("plan"); return text(JSON.stringify(plan)); }
    const title = /Step: (.*)/u.exec(user)?.[1] ?? "";
    if (system.startsWith("You check")) {
      calls[`verify:${title}`] = (calls[`verify:${title}`] ?? 0) + 1;
      const verdict = verdicts[title]?.[calls[`verify:${title}`] - 1] ?? { passed: true, reason: "ok" };
      log.push(`verify:${title}`);
      return text(JSON.stringify(verdict));
    }
    calls[title] = (calls[title] ?? 0) + 1;
    log.push(`agent:${title}`);
    const script = agents[title];
    const next = typeof script === "function" ? script(calls[title], body) : null;
    return next ?? text(`Report for ${title}`);
  };
  return { fetcher, log };
}

function team(fetcher, environment = {}) {
  const events = [];
  const instance = createAgentTeam({ endpoint, fetcher, sleep: async () => {}, toolContext: { environment, allowlist: new Set(["owner/repo"]), githubToken: async () => "t", fetcher } });
  const run = (goal) => instance.handler({ function: { name: "run_agent_team", arguments: JSON.stringify({ goal }) } }, { emit: (type, data) => events.push({ type, data }) });
  return { instance, run, events };
}

const step = (title, agent, dependsOn = []) => ({ title, agent, instructions: `Do ${title}`, doneWhen: `${title} answered`, dependsOn });

test("the roster only offers tools this deployment has", () => {
  const withoutSearch = availableRoster({});
  assert.deepEqual(withoutSearch.find((agent) => agent.id === "researcher").tools, ["read_web_page"]);
  assert.ok(availableRoster({ ATLAS_TAVILY_API_KEY: "x" }).find((agent) => agent.id === "researcher").tools.includes("web_search"));
  assert.ok(HOSTED_ROSTER.every((agent) => !agent.tools.includes("start_atlas_task")));
});

test("the planner's steps run in dependency order and the lead gets every verified report", async () => {
  const { fetcher, log } = fakeModel({ plan: { summary: "Audit", successCriteria: ["done"], steps: [step("Map code", "Code Analyst"), step("Research", "Researcher"), step("Review", "Code Reviewer", [1])] } });
  const { run, events } = team(fetcher);
  const outcome = await run("Audit the app");
  assert.equal(outcome.ok, true);
  assert.match(outcome.label, /3\/3 steps verified/u);
  assert.match(outcome.content, /<data source="agent team results">[\s\S]*Report for Map code[\s\S]*Report for Research[\s\S]*Report for Review/u);
  assert.ok(log.indexOf("agent:Review") > log.indexOf("verify:Map code"), "Review waits for Map code to be verified");
  const agents = events.filter((event) => event.type === "agent").map((event) => event.data);
  assert.equal(agents[0].name, "Planning lead");
  assert.ok(agents.some((agent) => agent.name === "Code Reviewer" && agent.state === "done" && agent.parentId === agents[0].id));
  // The review step saw the earlier step's report as data.
});

test("a report that fails its check gets one retry with the reason", async () => {
  const { fetcher, log } = fakeModel({
    plan: { summary: "s", successCriteria: ["c"], steps: [step("Find tests", "Test Engineer")] },
    verdicts: { "Find tests": [{ passed: false, reason: "no file paths cited" }, { passed: true, reason: "ok" }] },
  });
  const { run } = team(fetcher);
  const outcome = await run("Find the tests");
  assert.equal(log.filter((entry) => entry === "agent:Find tests").length, 2);
  assert.match(outcome.content, /Find tests \(Test Engineer, completed; check: ok\)/u);
});

test("failed steps skip their dependents instead of guessing", async () => {
  const { fetcher } = fakeModel({
    plan: { summary: "s", successCriteria: ["c"], steps: [step("A", "Code Analyst"), step("B", "Code Reviewer", [1])] },
    agents: { A: () => new Response("boom", { status: 500 }) },
  });
  const { run } = team(fetcher);
  const outcome = await run("goal");
  assert.match(outcome.content, /Step 1: A \(Code Analyst, failed\)/u);
  assert.match(outcome.content, /Step 2: B \(Code Reviewer, skipped\)/u);
});

test("agents use their own tools, and can hand work to child agents one level down", async () => {
  const { fetcher, log } = fakeModel({
    plan: { summary: "s", successCriteria: ["c"], steps: [step("Survey", "Architect")] },
    agents: {
      Survey: (count, body) => {
        const names = body.tools.map((definition) => definition.function.name);
        assert.ok(names.includes("delegate_to_child_agents"));
        assert.ok(!names.includes("start_atlas_task"));
        if (count === 1) return tool("d1", "delegate_to_child_agents", { tasks: [{ title: "Part one", instructions: "look at x" }, { title: "Part two", instructions: "look at y" }] });
        return null;
      },
      "Part one": (count, body) => {
        // Children at the depth limit cannot delegate again.
        assert.ok(!body.tools.map((definition) => definition.function.name).includes("delegate_to_child_agents"));
        return null;
      },
    },
  });
  const { run, events } = team(fetcher);
  const outcome = await run("Survey the architecture");
  assert.equal(outcome.ok, true);
  assert.ok(log.includes("agent:Part one") && log.includes("agent:Part two"));
  const agents = events.filter((event) => event.type === "agent").map((event) => event.data);
  const surveyor = agents.find((agent) => agent.title === "Survey");
  const child = agents.find((agent) => agent.title === "Part one");
  assert.equal(child.parentId, surveyor.id);
  assert.equal(child.depth, MAX_DEPTH);
  const toolEvents = events.filter((event) => event.type === "tool").map((event) => event.data);
  assert.ok(toolEvents.some((event) => event.agentId === surveyor.id && event.label === "2 child agents reported"));
});

test("a plan the model cannot produce is reported, not invented", async () => {
  const { fetcher } = fakeModel({ plan: { steps: [{ title: "x", agent: "Wizard", instructions: "i", doneWhen: "d" }] } });
  const { run, events } = team(fetcher);
  const outcome = await run("goal");
  assert.equal(outcome.ok, false);
  assert.match(outcome.content, /Planning failed: .*Wizard/u);
  assert.equal(events.at(-1).data.state, "failed");
});
