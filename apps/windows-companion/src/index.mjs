import { chromium } from "playwright-core";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { actionRisk } from "./policy.mjs";
import { parseLocalProfile, profileForPrompt } from "./profile.mjs";
import { retryDelay } from "./runtime.mjs";
import { createDesktopDriver, DesktopSession } from "./desktop/index.mjs";
import { buildUnifiedPrompt, isDesktopAction, validateUnifiedAction } from "./operator/unified.mjs";
import { allowHostsFrom, classifyUrl } from "./url-safety.mjs";

const atlasUrl = (process.env.ATLAS_URL ?? "https://atlas-web.cornerstonemarketingus.workers.dev").replace(/\/$/u, "");
const credential = process.env.ATLAS_DEVICE_CREDENTIAL ?? await readCredential();
const ollamaUrl = (process.env.ATLAS_OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/u, "");
const model = process.env.ATLAS_COMPUTER_MODEL ?? "qwen2.5-coder:7b";
const localProfile = parseLocalProfile(process.env.ATLAS_PROFILE_JSON ?? "");
if (!credential) throw new Error("Pair Atlas first with Install-AtlasCompanion.ps1 or set ATLAS_DEVICE_CREDENTIAL.");
const headers = { authorization: `Bearer ${credential}`, "content-type": "application/json" };
const atlasHome = join(process.env.LOCALAPPDATA ?? homedir(), "Atlas");
const profile = join(atlasHome, "computer-profile");
const evidenceRoot = join(atlasHome, "evidence");
await mkdir(profile, { recursive: true });

// The browser opens on first use, so a desktop-only task never waits for it.
let context = null;
let page = null;
async function browserPage() {
  if (page && !page.isClosed()) return page;
  context ??= await chromium.launchPersistentContext(profile, { channel: process.env.ATLAS_BROWSER_CHANNEL ?? "msedge", headless: false, viewport: { width: 1440, height: 900 } });
  page = context.pages()[0] ?? await context.newPage();
  return page;
}

// Desktop control is optional: an unsupported or disabled machine still runs browser tasks.
let desktopDriver = null;
let desktopUnavailable = null;
try { desktopDriver = createDesktopDriver(); }
catch (error) { desktopUnavailable = error instanceof Error ? error.message : "Desktop control is unavailable."; }

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

async function observeBrowser() {
  if (!page || page.isClosed()) return null;
  const snapshot = await page.locator("body").ariaSnapshot({ timeout: 10_000 }).catch(() => "Page accessibility snapshot unavailable.");
  return { url: page.url(), snapshot };
}

async function plan(task, history, desktop) {
  const observation = desktop ? await desktop.observe().catch(() => null) : null;
  const prompt = buildUnifiedPrompt({
    task, profile: profileForPrompt(localProfile), browser: await observeBrowser(), desktop: observation,
    desktopAvailable: Boolean(desktop), history,
  });
  const response = await fetch(`${ollamaUrl}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, stream: false, format: "json", options: { temperature: 0, num_ctx: 16_384, num_predict: 700 }, messages: [{ role: "user", content: prompt }] }), signal: AbortSignal.timeout(120_000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "The local model server is unavailable.");
  try { return validateUnifiedAction(JSON.parse(data.message?.content ?? ""), { desktopAvailable: Boolean(desktop) }); } catch (error) { throw new Error(`The local model returned an unusable action: ${error instanceof Error ? error.message : "invalid response"}`); }
}

/** Tells Atlas what just happened, so Operate shows live progress. Best effort. */
async function progress(taskId, title, detail) {
  try { await atlas("/api/computer/companion/progress", { taskId, title, detail }); } catch { /* progress is advisory */ }
}

async function approval(taskId, action, reason, domain = page && !page.isClosed() ? new URL(page.url()).hostname : "desktop") {
  const encoded = JSON.stringify(action);
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

/**
 * Private and local addresses (routers, NAS admin pages, cloud metadata,
 * this machine's own services) are reachable from the owner's PC but should
 * never be visited just because a model or a page suggested it: they ask.
 */
async function guardNavigation(taskId, target) {
  const verdict = await classifyUrl(target, { allowHosts: allowHostsFrom(process.env.ATLAS_BROWSER_ALLOW_HOSTS) });
  if (!verdict.public) await approval(taskId, { type: "navigate", url: verdict.url }, `Open ${new URL(verdict.url).host}, which is ${verdict.reason} on your network`, new URL(verdict.url).hostname);
  return verdict.url;
}

const byLabel = (label) => page.getByLabel(label, { exact: true }).first();
async function act(taskId, action) {
  const risk = actionRisk(action);
  if (risk.decision === "deny") throw new Error(risk.reason);
  if (risk.decision === "ask") await approval(taskId, action, risk.reason);
  if (action.type !== "done" && action.type !== "extract") await browserPage();
  switch (action.type) {
    case "navigate": return page.goto(await guardNavigation(taskId, action.url), { waitUntil: "domcontentloaded", timeout: 30_000 });
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
  if (task.startUrl) await (await browserPage()).goto(await guardNavigation(task.id, task.startUrl), { waitUntil: "domcontentloaded", timeout: 30_000 });
  const desktop = desktopDriver ? new DesktopSession({
    driver: desktopDriver,
    evidenceDir: join(evidenceRoot, task.id),
    approve: ({ action, risk, window }) => approval(task.id, action, `${risk.reason}${window && !risk.reason.includes(window) ? ` (${window})` : ""}`, "desktop"),
    isActive: () => ensureActive(task.id),
  }) : null;
  const history = [];
  for (let turn = 0; turn < 40; turn += 1) {
    await ensureActive(task.id);
    const action = await plan(task, history, desktop);
    if (action.type === "done") return action.text ?? "Computer task completed.";
    try {
      if (isDesktopAction(action)) {
        const outcome = await desktop.perform(action);
        const evidence = outcome.evidence.map((e) => e.digest).join(", ");
        history.push({ ...redact(action), outcome: "done" });
        await progress(task.id, `Desktop: ${outcome.risk.reason}`, evidence ? `Evidence ${evidence}` : null);
      } else {
        await act(task.id, action);
        history.push({ ...redact(action), outcome: "done" });
        await progress(task.id, `Browser: ${describe(action)}`, page && !page.isClosed() ? page.url() : null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/cancelled|rejected|expired|binding-mismatch|timed out/iu.test(message)) throw error;
      // A failed step is information for the next plan, not the end of the task.
      history.push({ ...redact(action), outcome: `failed: ${message.slice(0, 200)}` });
      await progress(task.id, `Step failed: ${describe(action)}`, message.slice(0, 500));
    }
  }
  throw new Error("Computer task exceeded its 40-step safety limit.");
}

function redact(action) {
  return "text" in action && action.type !== "extract" ? { ...action, text: `[${String(action.text).length} characters]` } : "value" in action ? { ...action, value: `[${String(action.value).length} characters]` } : action;
}

function describe(action) {
  switch (action.type) {
    case "navigate": return `open ${action.url}`;
    case "click": return `click “${action.name}”`;
    case "fill": return `fill “${action.label}”`;
    case "select": return `choose in “${action.label}”`;
    case "check": return `check “${action.label}”`;
    case "press": return `press ${action.key}`;
    case "extract": return "note a finding";
    default: return action.type;
  }
}

console.log(`Atlas companion online. Model: ${model}. Browser profile: ${profile}. Desktop control: ${desktopDriver ? desktopDriver.platform : `off (${desktopUnavailable})`}.`);
let consecutivePollFailures = 0;
for (;;) {
  try {
    const { task } = await atlas("/api/computer/companion/poll", { model, version: "0.3.0", desktop: Boolean(desktopDriver) });
    consecutivePollFailures = 0;
    if (!task) { await new Promise((resolve) => setTimeout(resolve, 5000)); continue; }
    try { const result = await run(task); await atlas("/api/computer/companion/report", { taskId: task.id, status: "completed", result }); }
    catch (error) { const message = error instanceof Error ? error.message : "Computer task failed."; if (message !== "Task cancelled by user.") await atlas("/api/computer/companion/report", { taskId: task.id, status: "failed", error: message }); }
  } catch (error) {
    const delay = retryDelay(consecutivePollFailures += 1);
    console.error(new Date().toISOString(), error instanceof Error ? error.message : error, `Retrying in ${Math.round(delay / 1000)}s.`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
