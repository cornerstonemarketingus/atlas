import { chromium } from "playwright-core";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { actionRisk, validateAction } from "./policy.mjs";
import { parseLocalProfile, profileForPrompt } from "./profile.mjs";
import { retryDelay } from "./runtime.mjs";

const atlasUrl = (process.env.ATLAS_URL ?? "https://atlas-web.cornerstonemarketingus.workers.dev").replace(/\/$/u, "");
const credential = process.env.ATLAS_DEVICE_CREDENTIAL ?? await readCredential();
const ollamaUrl = (process.env.ATLAS_OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/u, "");
const model = process.env.ATLAS_COMPUTER_MODEL ?? "qwen2.5-coder:7b";
const localProfile = parseLocalProfile(process.env.ATLAS_PROFILE_JSON ?? "");
if (!credential) throw new Error("Pair Atlas first with Install-AtlasCompanion.ps1 or set ATLAS_DEVICE_CREDENTIAL.");
const headers = { authorization: `Bearer ${credential}`, "content-type": "application/json" };
const profile = join(process.env.LOCALAPPDATA ?? homedir(), "Atlas", "computer-profile");
await mkdir(profile, { recursive: true });
const context = await chromium.launchPersistentContext(profile, { channel: "msedge", headless: false, viewport: { width: 1440, height: 900 } });
const page = context.pages()[0] ?? await context.newPage();

async function readCredential() {
  const path = process.env.ATLAS_DEVICE_CREDENTIAL_FILE;
  if (!path) return "";
  return (await readFile(path, "utf8")).trim();
}

async function atlas(path, body = {}) {
  const response = await fetch(`${atlasUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.message ?? `Atlas returned ${response.status}`), { status: response.status, data });
  return data;
}

async function plan(task, history) {
  const snapshot = await page.locator("body").ariaSnapshot({ timeout: 10_000 }).catch(() => "Page accessibility snapshot unavailable.");
  const policy = JSON.stringify(task.policy ?? {});
  const prompt = `You control a browser for one bounded task. Return JSON only, with one next action.
Task: ${task.objective}
${profileForPrompt(localProfile)}
Current URL: ${page.url()}
Server policy: ${policy}
Recent actions: ${JSON.stringify(history.slice(-8))}
Accessibility snapshot:\n${snapshot.slice(0, 28_000)}

Allowed JSON actions:
{"type":"navigate","url":"https://..."}
{"type":"click","name":"exact accessible name"}
{"type":"fill","label":"field label","value":"text"}
{"type":"select","label":"field label","value":"option"}
{"type":"check","label":"checkbox label"}
{"type":"press","key":"Enter"}
{"type":"extract","text":"concise finding"}
{"type":"wait"}
{"type":"done","text":"concise result"}
Never bypass access controls, anti-bot checks, CAPTCHAs, or site policies. Never invent identity, qualifications, or facts. Do not perform prohibited policy actions. If a required fact is missing, finish with a clear blocker.`;
  const response = await fetch(`${ollamaUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, stream: false, format: "json", options: { temperature: 0, num_ctx: 16_384, num_predict: 700 }, messages: [{ role: "user", content: prompt }] }), signal: AbortSignal.timeout(120_000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "The local model server is unavailable.");
  try { return validateAction(JSON.parse(data.message?.content ?? "")); } catch (error) { throw new Error(`The local model returned unusable JSON: ${error instanceof Error ? error.message : "invalid response"}`); }
}

async function approval(taskId, action, reason) {
  const encoded = JSON.stringify(action);
  const domain = new URL(page.url()).hostname;
  const created = await atlas("/api/computer/companion/approval", { taskId, action: encoded, summary: reason, domain });
  for (let count = 0; count < 150; count += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await ensureActive(taskId);
    const response = await fetch(`${atlasUrl}/api/computer/companion/approval/${created.approval.id}`, { method: "POST", headers, body: JSON.stringify({ action: encoded }), signal: AbortSignal.timeout(30_000) });
    if (response.ok) return;
    const data = await response.json();
    if (["rejected", "expired", "binding-mismatch"].includes(data.status)) throw new Error(`Action ${data.status}.`);
  }
  throw new Error("Approval timed out.");
}

async function ensureActive(taskId) {
  const { task } = await atlas(`/api/computer/companion/tasks/${encodeURIComponent(taskId)}`);
  if (!task || task.status === "cancelled") throw new Error("Task cancelled by user.");
}

const byLabel = (label) => page.getByLabel(label, { exact: true }).first();
async function act(taskId, action) {
  const risk = actionRisk(action);
  if (risk.decision === "deny") throw new Error(risk.reason);
  if (risk.decision === "ask") await approval(taskId, action, risk.reason);
  switch (action.type) {
    case "navigate": { const target = new URL(action.url); if (!["http:", "https:"].includes(target.protocol)) throw new Error("Navigation must use HTTP or HTTPS."); return page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 }); }
    case "click": return page.getByRole("button", { name: action.name, exact: true }).or(page.getByRole("link", { name: action.name, exact: true })).first().click({ timeout: 10_000 });
    case "fill": return byLabel(action.label).fill(action.value, { timeout: 10_000 });
    case "select": return byLabel(action.label).selectOption({ label: action.value }, { timeout: 10_000 });
    case "check": return byLabel(action.label).check({ timeout: 10_000 });
    case "press": return page.keyboard.press(action.key);
    case "wait": return page.waitForTimeout(1500);
    case "extract": return;
    case "done": return;
    default: throw new Error(`Unsupported action: ${action.type}`);
  }
}

async function run(task) {
  if (task.startUrl) await page.goto(task.startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const history = [];
  for (let turn = 0; turn < 30; turn += 1) {
    await ensureActive(task.id);
    const action = await plan(task, history);
    history.push(action);
    if (action.type === "done") return action.text ?? "Browser task completed.";
    await act(task.id, action);
  }
  throw new Error("Browser task exceeded its 30-step safety limit.");
}

console.log(`Atlas companion online. Model: ${model}. Browser profile: ${profile}`);
let consecutivePollFailures = 0;
for (;;) {
  try {
    const { task } = await atlas("/api/computer/companion/poll", { model, version: "0.2.0" });
    consecutivePollFailures = 0;
    if (!task) { await new Promise((resolve) => setTimeout(resolve, 5000)); continue; }
    try { const result = await run(task); await atlas("/api/computer/companion/report", { taskId: task.id, status: "completed", result }); }
    catch (error) { const message = error instanceof Error ? error.message : "Browser task failed."; if (message !== "Task cancelled by user.") await atlas("/api/computer/companion/report", { taskId: task.id, status: "failed", error: message }); }
  } catch (error) {
    const delay = retryDelay(consecutivePollFailures += 1);
    console.error(new Date().toISOString(), error instanceof Error ? error.message : error, `Retrying in ${Math.round(delay / 1000)}s.`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
