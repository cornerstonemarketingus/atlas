import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createLocalControlServer } from "../src/server.mjs";
import { LocalTaskStore } from "../src/store.mjs";
import { AgentSessionStore } from "../src/agent/session-store.mjs";
import { AgentRuntime } from "../src/agent/runtime.mjs";
import { createLocalExecutor } from "../src/agent/executors.mjs";
import { assistantMessageEvent } from "../src/agent/events.mjs";
import { GenesisService, GenesisStore } from "../src/platform/genesis/index.mjs";
import { LOCAL_UI_HTML, LOCAL_UI_JS } from "../src/ui.mjs";

/**
 * First-run blockers in the console, at the daemon's real HTTP handler:
 * Home chat, the Missions form, policy hints and the Genesis detail. The
 * markup checks run everywhere; the browser journey runs when
 * ATLAS_TEST_PLAYWRIGHT points at Playwright (as in render-ui.test.mjs).
 */
const TOKEN = "console-first-run-owner-token-0123456789abcdef";

const idsIn = (markup) => [...markup.matchAll(/\bid=\\?["']([^"'\\]+)\\?["']/gu)].map((match) => match[1]);
const duplicates = (ids) => [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];

test("the rendered console has no duplicate ids, in its page or in the markup its script renders", async (t) => {
  const h = await daemon(t);
  const response = await fetch(`${h.origin}/`);
  assert.equal(response.status, 200);
  const page = idsIn(await response.text());
  assert.ok(page.length > 100, "the page was parsed");
  assert.deepEqual(duplicates(page), [], "every id in the served page is unique");
  // Markup the script builds (render panel, mission detail, ...) shares the document with the page.
  const rendered = idsIn(LOCAL_UI_JS);
  assert.deepEqual(duplicates(rendered), [], "every id the script renders is unique");
  assert.deepEqual(rendered.filter((id) => page.includes(id)), [], "no rendered id repeats one already in the page");
  assert.deepEqual(duplicates(idsIn(LOCAL_UI_HTML)), []);
});

test("each goal form reads its own fields", () => {
  const missions = /<form id="goal-form"[\s\S]*?<\/form>/u.exec(LOCAL_UI_HTML)[0];
  const command = /<form id="command-goal"[\s\S]*?<\/form>/u.exec(LOCAL_UI_HTML)[0];
  const commandIds = idsIn(command);
  for (const id of idsIn(missions)) assert.ok(!commandIds.includes(id), `#${id} is in both forms`);
  // Each handler looks its fields up inside the form that was submitted.
  assert.match(LOCAL_UI_JS, /\$\('#goal-form'\)\.onsubmit=async e=>\{e\.preventDefault\(\);const form=e\.currentTarget/u);
  assert.match(LOCAL_UI_JS, /\$\('#command-goal'\)\.onsubmit=async e=>\{e\.preventDefault\(\);const form=e\.currentTarget/u);
});

let playwright;
try {
  if (process.env.ATLAS_TEST_PLAYWRIGHT) playwright = await import(pathToFileURL(process.env.ATLAS_TEST_PLAYWRIGHT).href);
} catch { /* The dependency-free checks above run everywhere. */ }
const browserTest = { skip: !playwright && "Configure ATLAS_TEST_PLAYWRIGHT for real-browser acceptance", timeout: 120_000 };

test("in a browser: Home answers a first Hello, and a failed session is not reopened", browserTest, async (t) => {
  const h = await daemon(t);
  const { page, errors } = await browser(t, h);
  await page.waitForFunction(() => document.querySelector("#session-executor option[value=local]"));
  assert.equal(await page.locator("#session-executor").inputValue(), "conversation", "with no repository the safe choice is selected");
  await page.locator("#turn-text").fill("Hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.locator("#transcript").getByText("Answered: Hello").waitFor();
  await page.waitForFunction(() => /completed/u.test(document.querySelector("#run-status").textContent));
  assert.equal(h.coderRuns(), 0);

  // Choosing the coder without a repository is explained before anything is sent.
  await page.locator("#session-picker").selectOption("");
  const sessionsBefore = h.runtime.listSessions().length;
  await page.getByText("Where this conversation works").click();
  await page.locator("#session-executor").selectOption("local");
  await page.locator("#turn-text").fill("Hello again");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(() => /needs? a repository|runs the coder inside a repository/u.test(document.querySelector("#run-status").textContent));
  assert.equal(h.runtime.listSessions().length, sessionsBefore, "no session was created to fail");

  // A session that failed is not selected again after a reload.
  const failed = h.runtime.createSession({ title: "Broken", repository: h.root, model: "m", executor: "local" });
  h.runtime.submitTurn(failed.id, { text: "Break" });
  await h.runtime.drain();
  assert.equal(h.runtime.getSession(failed.id).status, "failed");
  await page.reload();
  await page.waitForFunction((id) => [...document.querySelectorAll("#session-picker option")].some((o) => o.value === id), failed.id);
  await page.locator("#session-picker").selectOption(failed.id);
  await page.waitForFunction(() => /failed/u.test(document.querySelector("#run-status").textContent));
  await page.reload();
  await page.locator("#session-picker").waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem("atlas-session")), null);
  await page.waitForFunction(() => document.querySelector("#session-picker").options.length > 1);
  assert.equal(await page.locator("#session-picker").inputValue(), "", "a new conversation is ready");
  assert.deepEqual(errors, []);
});

test("in a browser: Plan and start sends the goal typed on Missions, with a policy hint on Home and Missions", browserTest, async (t) => {
  const h = await daemon(t);
  const { page, errors } = await browser(t, h, "#/missions");
  await page.locator("#goal-form textarea").fill("Research three competitors' pricing pages");
  await page.getByRole("button", { name: "Plan and start" }).click();
  await page.waitForFunction(() => /Planned 1 step/u.test(document.querySelector("#goal-notice").textContent));
  assert.deepEqual(h.goals, ["Research three competitors' pricing pages"]);

  // The mission's first tool needed a capability nobody had allowed yet.
  await page.locator("#mission-detail").getByText("filesystem.read is not allowed by default").first().waitFor();
  assert.equal(await page.locator('#mission-detail a[href="#/computer"]').count() >= 1, true, "Missions links to where to allow it");
  await page.goto(`${h.origin}/#/home`);
  await page.locator("#home-attention").getByText("filesystem.read is not allowed by default").waitFor();
  assert.equal(await page.locator('#home-attention a[href="#/computer"]').count(), 1, "Home links to where to allow it");

  // With every view visited, the live document still has unique ids.
  for (const view of ["home", "command", "automations", "build", "artifacts", "missions", "models", "computer", "settings"]) {
    await page.goto(`${h.origin}/#/${view}`);
    await page.waitForTimeout(150);
  }
  const live = await page.evaluate(() => [...document.querySelectorAll("[id]")].map((el) => el.id));
  assert.deepEqual(duplicates(live), []);
  assert.deepEqual(errors, []);
});

test("in a browser: a blocked Genesis project shows no Ready card and nothing running", browserTest, async (t) => {
  const h = await daemon(t);
  const project = await h.genesis.create("Build a simple customer lead tracker with name, email, phone, status, notes");
  for (const [to, reason] of [["scaffolding", "s"], ["building", "b"], ["verifying", "v"], ["previewing", "p"], ["reviewing", "r"]]) h.genesis.advance(project.id, to, { reason });
  h.genesis.advance(project.id, "ready", { reason: "done", evidence: { kind: "ready", summary: { preview: "http://127.0.0.1:9/", features: ["Leads"], verification: [{ step: "test", ok: true }], inspection: { limited: true }, repairs: 0, limitations: [], folder: h.root } } });
  await h.genesis.change(project.id, "Add Google login");
  h.genesis.advance(project.id, "scaffolding", { reason: "s" });
  h.genesis.advance(project.id, "building", { reason: "b" });
  const task = h.genesis.view(project.id).tasks[0];
  h.genesisStore.updateTask("local", project.id, task.id, { status: "running", attempt: true, evidence: { kind: "start" } });
  h.genesis.advance(project.id, "blocked", { reason: `"${task.title}" needs a coding model. Set one up under Models, then resume.`, evidence: { kind: "capability", missing: "model" } });

  const { page, errors } = await browser(t, h, `#/build/${project.id}`);
  await page.locator("#build-detail").getByText("needs a coding model").first().waitFor();
  assert.match(await page.locator("#build-detail .status").first().textContent(), /Waiting for you/iu);
  assert.equal(await page.locator("#build-detail").getByText("Open the application").count(), 0, "the old Ready card is not shown while blocked");
  assert.equal(await page.locator("#build-detail .step.running").count(), 0, "nothing is shown as running");
  assert.equal(await page.locator("#build-detail .step.blocked").count(), 1);
  assert.deepEqual(errors, []);
});

async function daemon(t) {
  const root = mkdtempSync(join(tmpdir(), "atlas-console-first-run-"));
  const store = new LocalTaskStore(join(root, "local.sqlite"));
  const sessions = new AgentSessionStore(join(root, "agent.sqlite"));
  let coderRuns = 0;
  const runtime = new AgentRuntime({ sessions, executors: {
    local: createLocalExecutor({ runCoder: async () => { coderRuns += 1; return { ok: false, message: "The coder could not verify." }; } }),
    conversation: {
      id: "conversation",
      description: "Talks it through.",
      async run({ turn, emit }) { emit(assistantMessageEvent({ text: `Answered: ${turn.text}`, final: true, turnId: turn.id })); return { status: "completed", summary: "Answered." }; },
    },
  } });
  const genesisStore = new GenesisStore(join(root, "genesis.sqlite"));
  const genesis = new GenesisService({ store: genesisStore, policy: () => ({ decision: "allow" }) });
  const goals = [];
  const team = fakeTeam(goals);
  const server = createLocalControlServer({ store, token: TOKEN, runTask: async () => ({ ok: true, message: "" }), runtime, genesis, team });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await runtime.stop();
    // The browser may still hold a session event stream open.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    sessions.close(); genesisStore.close(); store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, root, runtime, genesis, genesisStore, goals, coderRuns: () => coderRuns };
}

/** The team surface as the console reads it, with a policy-blocked first mission. */
function fakeTeam(goals) {
  const missions = [];
  const block = {
    tool: "filesystem.read", capability: "filesystem.read", reason: "not-allowed-by-default",
    message: "explicit deny by rule 'not-allowed-by-default': filesystem.read is not allowed by default. To let agents use it, open Computer in the Atlas console and set filesystem.read to allow (or ask).",
    hint: "To let agents use it, open Computer in the Atlas console and set filesystem.read to allow (or ask).",
  };
  const summary = (m) => ({ id: m.id, goal: m.goal, status: "failed", taskId: "task-1", taskStatus: "failed", steps: { total: 1, completed: 0, failed: 1 }, agents: ["Market Research Agent"], usage: { toolCalls: 1, inputTokens: 10, outputTokens: 5 }, createdAt: m.at, updatedAt: m.at, policyBlocks: [block] });
  return {
    roster: () => [],
    list: () => missions.map(summary),
    detail: (id) => {
      const m = missions.find((x) => x.id === id);
      return m ? { ...summary(m), steps: [{ id: "s1", title: "Read the brief", agent: "Market Research Agent", dependsOn: [], doneWhen: "The report quotes it.", state: "failed", usage: { toolCalls: 1 }, summary: "Not done.", verified: false }], messages: [], toolCalls: [{ id: "c1", tool: "filesystem.read", agent: "Market Research Agent", status: "denied", error: { code: "POLICY_DENIED", message: block.message } }], artifacts: [], transitions: [] } : null;
    },
    async start({ goal }) {
      goals.push(goal);
      const mission = { id: `team-00000000-0000-4000-8000-00000000000${missions.length}`, goal, at: new Date().toISOString() };
      missions.push(mission);
      return { mission: { id: mission.id }, plan: { steps: [{ title: "Read the brief" }] } };
    },
    control: (id) => summary(missions.find((x) => x.id === id)),
  };
}

async function browser(t, h, hash = "#/home") {
  const instance = await playwright.chromium.launch({ headless: true, ...(process.env.ATLAS_TEST_BROWSER ? { executablePath: process.env.ATLAS_TEST_BROWSER } : {}) });
  t.after(() => instance.close());
  const page = await instance.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${h.origin}/`);
  await page.evaluate((token) => sessionStorage.setItem("atlas-token", token), TOKEN);
  await page.goto(`${h.origin}/${hash}`);
  await page.reload();
  return { page, errors };
}
