import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateSchema } from "../../../packages/atlas-contracts/src/index.mjs";
import { registerDesktopTools } from "../src/agent/tools/desktop-tools.mjs";
import { AuthorizedToolExecutor, PlatformTaskStore, PolicyEngine } from "../src/platform/index.mjs";
import {
  DesktopController,
  DesktopSafetyStore,
  SimulatedDesktop,
  desktopActionDigest,
  desktopToolDefinitions,
  encodePng,
  findElement,
  pngSize,
  runControlLoop,
} from "../src/platform/desktop/index.mjs";

const OWNER = "owner-1";
const AGENT = "agent-1";

/**
 * The same digest-bound approval inbox shape the daemon uses for desktop
 * actions (main.mjs buildDesktopSession): an "ask" action creates a pending
 * approval for sha256(JSON.stringify(action)); once the owner approves that
 * digest, the identical action may run exactly once.
 */
function approvalInbox() {
  const pending = new Map();
  const approved = new Set();
  return {
    pending,
    grant(digest) { assert.ok(pending.has(digest), "only a requested digest can be approved"); pending.delete(digest); approved.add(digest); },
    approve: async ({ digest, risk }) => {
      if (approved.delete(digest)) return;
      pending.set(digest, risk.reason);
      throw Object.assign(new Error("This desktop action needs your approval."), { code: "APPROVAL_REQUIRED" });
    },
  };
}

async function setup(t, { charDelayMs = 0, policyCheck = null, storePath = ":memory:", driver = null, allowedApps = ["notes", "mail"], onIndicator = undefined } = {}) {
  const base = await mkdtemp(join(tmpdir(), "atlas-desktop-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  let now = new Date("2026-09-01T10:00:00.000Z").getTime();
  const store = new DesktopSafetyStore({ path: storePath === "file" ? join(base, "desktop.db") : storePath, clock: () => new Date(now) });
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  const device = store.enrollDevice({ ownerId: OWNER, name: "Test PC", platform: "simulated" });
  store.approveDevice(device.id, { ownerId: OWNER });
  const desktop = driver ?? new SimulatedDesktop({ charDelayMs });
  const indicator = [];
  const readable = join(base, "readable");
  await mkdir(readable);
  const inbox = approvalInbox();
  const controller = new DesktopController({
    driver: desktop, store, deviceId: device.id, allowedApps, readableRoots: [readable], policyCheck, approve: inbox.approve,
    onIndicator: onIndicator === undefined ? (event) => indicator.push(event) : onIndicator,
  });
  const approve = (scope = { allowedApps: ["notes"] }, extra = {}) => {
    const approval = store.requestSessionApproval({ deviceId: device.id, requestedBy: AGENT, purpose: "write a note", scope, ...extra });
    return store.approveSession(approval.id, { decidedBy: OWNER });
  };
  const openSession = async (scope, extra) => controller.createSession({ approvalId: approve(scope, extra).id, requestedBy: AGENT });
  return { base, readable, store, device, desktop, controller, indicator, inbox, approve, openSession, advance: (ms) => { now += ms; } };
}

/** Scripted planner for "write a note titled X with body Y and save it". */
function notesPlanner({ title, body, beforeAction = null }) {
  return async ({ observation, step }) => {
    const find = (name) => findElement(observation, { name, app: "notes" });
    if (find("Status")?.value === `Saved ${title}`) return { done: true, result: find("Status").value };
    const target = (name) => ({ ref: find(name).ref, name, app: "notes" });
    const valueIs = (name, value) => (o) => findElement(o, { name, app: "notes" })?.value === value;
    let plan;
    if (!find("Title")) plan = { action: { type: "launchApp", app: "notes" }, postcondition: (o) => Boolean(findElement(o, { name: "Title", app: "notes" })) };
    else if (find("Title").value !== title) plan = { action: { type: "typeText", text: title, target: target("Title") }, postcondition: valueIs("Title", title) };
    else if (find("Body").value !== body) plan = { action: { type: "typeText", text: body, target: target("Body") }, postcondition: valueIs("Body", body) };
    else plan = { action: { type: "click", target: target("Save") }, postcondition: valueIs("Status", `Saved ${title}`) };
    if (beforeAction) await beforeAction({ plan, step, observation });
    return plan;
  };
}

// ---------------------------------------------------------------------------
// Enrollment and session approvals
// ---------------------------------------------------------------------------

test("device enrollment: pending until the owner approves; only the owner decides; revocation is durable", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "atlas-desktop-enroll-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const path = join(base, "d.db");
  let store = new DesktopSafetyStore({ path });
  const device = store.enrollDevice({ ownerId: OWNER, name: "Laptop", platform: "linux" });
  assert.equal(device.status, "pending");
  assert.match(device.id, /^dev_[0-9a-f]{32}$/);
  const ask = () => store.requestSessionApproval({ deviceId: device.id, requestedBy: AGENT, purpose: "x", scope: { allowedApps: ["notes"] } });
  assert.throws(ask, { code: "DEVICE_NOT_ENROLLED" });
  assert.throws(() => store.approveDevice(device.id, { ownerId: "intruder" }), { code: "NOT_OWNER" });
  assert.equal(store.approveDevice(device.id, { ownerId: OWNER }).status, "enrolled");
  assert.throws(() => store.approveDevice(device.id, { ownerId: OWNER }), { code: "INVALID_STATE" });
  store.close();

  store = new DesktopSafetyStore({ path });
  assert.equal(store.getDevice(device.id).status, "enrolled");
  assert.throws(() => store.revokeDevice(device.id, { by: "intruder" }), { code: "NOT_OWNER" });
  assert.equal(store.revokeDevice(device.id, { by: OWNER, reason: "lost" }).status, "revoked");
  store.close();
  store = new DesktopSafetyStore({ path });
  assert.equal(store.getDevice(device.id).status, "revoked");
  assert.throws(ask, { code: "DEVICE_REVOKED" });
  store.close();
});

test("no unattended access: a session needs an owner-approved, unused, unexpired approval id", async (t) => {
  const { store, device, controller, approve, advance } = await setup(t);
  await assert.rejects(controller.createSession({}), { code: "APPROVAL_REQUIRED" });
  await assert.rejects(controller.createSession({ approvalId: "apr_" + "0".repeat(32) }), { code: "NO_APPROVAL" });

  const pending = store.requestSessionApproval({ deviceId: device.id, requestedBy: AGENT, purpose: "p", scope: { allowedApps: ["notes"] } });
  await assert.rejects(controller.createSession({ approvalId: pending.id }), { code: "APPROVAL_REQUIRED" });
  assert.throws(() => store.approveSession(pending.id, { decidedBy: AGENT }), { code: "NOT_OWNER" });
  assert.throws(() => store.requestSessionApproval({ deviceId: device.id, requestedBy: AGENT, purpose: "p", scope: {} }), { code: "INVALID_SCOPE" });

  const approved = approve();
  await assert.rejects(controller.createSession({ approvalId: approved.id, requestedBy: "someone-else" }), { code: "APPROVAL_MISMATCH" });
  const session = await controller.createSession({ approvalId: approved.id, requestedBy: AGENT });
  assert.equal(session.status, "active");
  assert.equal(session.approvedBy, OWNER);
  await assert.rejects(controller.createSession({ approvalId: approved.id }), { code: "APPROVAL_USED" });

  const stale = approve();
  advance(11 * 60 * 1000);
  await assert.rejects(controller.createSession({ approvalId: stale.id }), { code: "APPROVAL_EXPIRED" });
  assert.ok(controller.audit().filter((row) => row.action === "session.create" && row.outcome === "refused").length >= 5);
});

// ---------------------------------------------------------------------------
// Control loop on the simulated desktop (through the companion's DesktopSession)
// ---------------------------------------------------------------------------

test("control loop completes a small notes workflow on the simulated desktop via element refs", async (t) => {
  const { controller, desktop, openSession, indicator } = await setup(t);
  const session = await openSession();
  const outcome = await runControlLoop({ controller, sessionId: session.id, goal: "save a note", planner: notesPlanner({ title: "Groceries", body: "milk, eggs" }) });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  assert.equal(outcome.result, "Saved Groceries");
  assert.equal(desktop.files.get("notes/Groceries.txt"), "milk, eggs");
  assert.equal(outcome.steps, 4);
  assert.ok(outcome.history.every((entry) => entry.verified === true && !entry.recovered));
  assert.ok(outcome.history.every((entry) => entry.attempts.every((a) => a.coordinateFallback === false)));
  assert.deepEqual(desktop.launched, ["notes"]);
  assert.equal(desktop.indicator.state, "active");

  // Input actions carry the companion session's before/after evidence, stored here by digest.
  const click = controller.audit({ sessionId: session.id }).find((row) => row.action === "desktop_click" && row.outcome === "succeeded");
  assert.match(click.screenshotDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(controller.getScreenshot(click.screenshotDigest).mediaType, "image/png");

  await controller.stop(session.id, { by: OWNER });
  assert.deepEqual(indicator.map((e) => e.state), ["active", "inactive"]);
  assert.equal(desktop.indicator.state, "inactive");
  await assert.rejects(controller.listWindows(session.id), { code: "SESSION_ENDED" });
});

test("recovers once from a moved window: the stale ref is re-located by accessible name", async (t) => {
  const { controller, desktop, openSession } = await setup(t);
  const session = await openSession();
  let moved = false;
  const planner = notesPlanner({
    title: "Moved",
    body: "still works",
    beforeAction: ({ plan }) => {
      if (!moved && plan.action.type === "click") { moved = true; desktop.moveWindow(desktop.windowByApp("notes").id, 600, 300); }
    },
  });
  const outcome = await runControlLoop({ controller, sessionId: session.id, goal: "save", planner });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const clickStep = outcome.history.find((entry) => entry.action.type === "click");
  assert.deepEqual(clickStep.attempts.map((a) => (a.ok ? "ok" : a.code)), ["STALE_ELEMENT", "ok"]);
  assert.deepEqual([clickStep.recovered.by, clickStep.recovered.name], ["accessible_name", "Save"]);
  assert.equal(desktop.files.get("notes/Moved.txt"), "still works");
});

test("coordinate clicks are a flagged fallback; a missed click after a move is recovered by name", async (t) => {
  const { controller, desktop, openSession } = await setup(t);
  const session = await openSession();
  await controller.launchApp(session.id, { app: "notes" });
  const first = await controller.observe(session.id);
  await controller.typeText(session.id, { text: "Coords", target: { ref: findElement(first, { name: "Title" }).ref } });
  const save = findElement(await controller.observe(session.id), { name: "Save" });
  const [cx, cy] = [save.bounds.x + 5, save.bounds.y + 5];
  desktop.moveWindow(desktop.windowByApp("notes").id, 700, 400); // the old coordinates now hit nothing

  const planner = async ({ observation }) => {
    if (findElement(observation, { name: "Status" })?.value === "Saved Coords") return { done: true };
    return {
      action: { type: "click", x: cx, y: cy, target: { name: "Save", app: "notes" } },
      postcondition: (o) => findElement(o, { name: "Status" })?.value === "Saved Coords",
    };
  };
  const outcome = await runControlLoop({ controller, sessionId: session.id, goal: "save", planner });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  assert.deepEqual(outcome.history[0].attempts.map((a) => [a.ok ? "ok" : a.code, a.coordinateFallback]), [["NO_TARGET", true], ["ok", false]]);
  const clicks = controller.audit({ sessionId: session.id }).filter((row) => row.action === "desktop_click");
  assert.deepEqual(clicks.map((row) => [row.outcome, row.coordinateFallback]), [["succeeded", false], ["refused", true], ["succeeded", false]]);
});

test("escalates when recovery fails instead of guessing further", async (t) => {
  const { controller, openSession } = await setup(t);
  const session = await openSession();
  await controller.launchApp(session.id, { app: "notes" });
  const escalations = [];
  const planner = async () => ({ action: { type: "click", x: 5, y: 5, target: { name: "Does not exist" } }, postcondition: () => false });
  const outcome = await runControlLoop({ controller, sessionId: session.id, goal: "x", planner, onEscalate: (o) => escalations.push(o) });
  assert.equal(outcome.status, "escalated");
  assert.equal(outcome.code, "RECOVERY_FAILED");
  assert.equal(escalations.length, 1);
});

// ---------------------------------------------------------------------------
// Digest-bound approvals from the companion's rules are kept
// ---------------------------------------------------------------------------

test("consequential actions still need the companion's digest-bound approval, once per exact action", async (t) => {
  const { controller, desktop, inbox, openSession } = await setup(t);
  const session = await openSession();
  await controller.launchApp(session.id, { app: "notes" });
  const body = findElement(await controller.observe(session.id), { name: "Body" });
  await controller.click(session.id, { target: { ref: body.ref } });
  const text = "my password is hunter2";
  await assert.rejects(controller.typeText(session.id, { text }), { code: "APPROVAL_REQUIRED" });
  const digest = desktopActionDigest({ type: "desktop_type", text });
  assert.ok(inbox.pending.has(digest));
  assert.equal(desktop.windowByApp("notes").get("body").value, "");

  inbox.grant(digest);
  await assert.rejects(controller.typeText(session.id, { text: `${text}!` }), { code: "APPROVAL_REQUIRED" }, "a different action is not covered");
  const done = await controller.typeText(session.id, { text });
  assert.equal(done.risk.decision, "ask");
  assert.equal(desktop.windowByApp("notes").get("body").value, text);
  await assert.rejects(controller.typeText(session.id, { text }), { code: "APPROVAL_REQUIRED" }, "an approval is spent by one use");
  await assert.rejects(controller.keyPress(session.id, { key: "ctrl+alt+delete" }), { code: "ACTION_DENIED" });
  assert.ok(!JSON.stringify(controller.audit({ sessionId: session.id })).includes("hunter2"));
});

// ---------------------------------------------------------------------------
// Emergency stop, expiry, revocation, pause
// ---------------------------------------------------------------------------

test("emergency stop mid-run aborts the in-flight action, refuses everything after, and requires explicit re-arm", async (t) => {
  const { controller, desktop, openSession, approve, indicator } = await setup(t, { charDelayMs: 3 });
  const session = await openSession();
  const body = "x".repeat(400);
  const planner = notesPlanner({
    title: "T",
    body,
    beforeAction: ({ plan }) => {
      if (plan.action.type === "typeText" && plan.action.text === body) setTimeout(() => controller.emergencyStop({ by: OWNER, reason: "user hit stop" }), 40);
    },
  });
  const outcome = await runControlLoop({ controller, sessionId: session.id, goal: "save", planner });
  assert.equal(outcome.status, "stopped", JSON.stringify(outcome));
  assert.equal(outcome.code, "EMERGENCY_STOPPED");
  const typed = desktop.windowByApp("notes").get("body").value.length;
  assert.ok(typed > 0 && typed < body.length, `in-flight typing should have been cut off (typed ${typed})`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(desktop.windowByApp("notes").get("body").value.length, typed, "nothing more is typed after the abort");
  assert.equal(desktop.files.size, 0);

  assert.equal(controller.getSession(session.id).status, "emergency_stopped");
  assert.equal(indicator.at(-1).state, "inactive");
  await assert.rejects(controller.listWindows(session.id), { code: "EMERGENCY_STOPPED" });
  const fresh = approve();
  await assert.rejects(controller.createSession({ approvalId: fresh.id }), { code: "EMERGENCY_STOPPED" });

  assert.throws(() => controller.rearm({ by: OWNER }), { code: "REARM_REQUIRES_CONFIRMATION" });
  assert.throws(() => controller.rearm({ confirm: "REARM" }), { code: "REARM_REQUIRES_CONFIRMATION" });
  controller.rearm({ by: OWNER, confirm: "REARM" });
  await assert.rejects(controller.listWindows(session.id), { code: "EMERGENCY_STOPPED" }, "old sessions stay closed after re-arm");
  const next = await controller.createSession({ approvalId: fresh.id });
  assert.equal((await controller.listWindows(next.id)).length, 1);

  const rows = controller.audit();
  assert.ok(rows.some((row) => row.action === "desktop_type" && row.outcome === "aborted" && row.errorCode === "EMERGENCY_STOPPED"));
  assert.ok(rows.some((row) => row.action === "emergency.stop"));
  assert.ok(rows.some((row) => row.action === "emergency.rearm" && row.actor === OWNER));
});

test("emergency stop survives a restart: a reopened store is still stopped", async (t) => {
  const { store, controller, openSession, base } = await setup(t, { storePath: "file" });
  await openSession();
  await controller.emergencyStop({ by: OWNER });
  store.close();
  const reopened = new DesktopSafetyStore({ path: join(base, "desktop.db") });
  t.after(() => reopened.close());
  assert.equal(reopened.emergencyState().stopped, true);
});

test("session expiry: actions after the TTL are refused and the indicator is turned off", async (t) => {
  const { controller, openSession, advance, indicator } = await setup(t);
  const session = await openSession({ allowedApps: ["notes"] }, { sessionTtlMs: 60_000 });
  assert.equal(session.expiresAt, "2026-09-01T10:01:00.000Z");
  await controller.listWindows(session.id);
  advance(60_001);
  await assert.rejects(controller.listWindows(session.id), { code: "SESSION_EXPIRED" });
  assert.equal(controller.getSession(session.id).status, "expired");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(indicator.map((e) => e.state), ["active", "inactive"]);
  await assert.rejects(controller.resume(session.id), { code: "INVALID_STATE" });
});

test("a revoked device's sessions and approvals are refused immediately", async (t) => {
  const { store, device, controller, openSession, approve } = await setup(t);
  const session = await openSession();
  const unused = approve();
  store.revokeDevice(device.id, { by: OWNER, reason: "stolen" });
  await assert.rejects(controller.listWindows(session.id), (error) => ["SESSION_REVOKED", "DEVICE_REVOKED"].includes(error.code));
  await assert.rejects(controller.createSession({ approvalId: unused.id }), (error) => ["DEVICE_REVOKED", "APPROVAL_REQUIRED"].includes(error.code));
  assert.equal(store.getSessionApproval(unused.id).status, "expired");
});

test("pause aborts in-flight actions and refuses new ones until resume", async (t) => {
  const { controller, desktop, openSession, indicator } = await setup(t, { charDelayMs: 2 });
  const session = await openSession();
  await controller.launchApp(session.id, { app: "notes" });
  const ref = findElement(await controller.observe(session.id), { name: "Body" }).ref;
  const typing = controller.typeText(session.id, { text: "y".repeat(300), target: { ref } });
  setTimeout(() => controller.pause(session.id, { by: OWNER }), 20);
  await assert.rejects(typing, { code: "SESSION_PAUSED" });
  await assert.rejects(controller.listWindows(session.id), { code: "SESSION_PAUSED" });
  await controller.resume(session.id, { by: OWNER });
  assert.equal((await controller.listWindows(session.id)).length, 1);
  assert.ok(desktop.windowByApp("notes").get("body").value.length < 300);
  assert.deepEqual(indicator.map((e) => e.state), ["active", "paused", "active"]);
});

// ---------------------------------------------------------------------------
// Scope, allowlists, policy, audit
// ---------------------------------------------------------------------------

test("unallowlisted apps cannot be launched; allowlisted apps outside the session scope cannot either", async (t) => {
  const { controller, desktop, openSession } = await setup(t);
  const session = await openSession({ allowedApps: ["notes"] });
  await assert.rejects(controller.launchApp(session.id, { app: "terminal" }), { code: "APP_NOT_ALLOWLISTED" });
  await assert.rejects(controller.launchApp(session.id, { app: "mail" }), { code: "SCOPE_DENIED" });
  await assert.rejects(controller.launchApp(session.id, { app: "/bin/sh -c evil" }), { code: "INVALID_ACTION" });
  assert.deepEqual(desktop.launched, []);
  const refused = controller.audit({ sessionId: session.id }).filter((row) => row.outcome === "refused");
  assert.deepEqual(refused.map((row) => row.errorCode), ["APP_NOT_ALLOWLISTED", "SCOPE_DENIED", "INVALID_ACTION"]);
});

test("typing into a window outside the approved apps is refused and changes nothing", async (t) => {
  const { controller, desktop, openSession } = await setup(t);
  const session = await openSession({ allowedApps: ["notes"] });
  await controller.launchApp(session.id, { app: "notes" });
  const mail = desktop.openWindow("mail"); // opened by the person, now focused
  await desktop.userClick(mail.id, "Message");
  await assert.rejects(controller.typeText(session.id, { text: "wire the money" }), { code: "SCOPE_DENIED" });
  const observed = await controller.observe(session.id);
  assert.equal(observed.focused.app, "mail");
  await assert.rejects(controller.click(session.id, { target: { ref: findElement(observed, { name: "Send" }).ref } }), { code: "SCOPE_DENIED" });
  await assert.rejects(controller.keyPress(session.id, { key: "enter" }), { code: "SCOPE_DENIED" });
  assert.equal(mail.get("message").value, "");
  assert.deepEqual(desktop.outbox, []);
  // Window-title scoping narrows further.
  const narrow = await openSession({ allowedWindows: ["Budget"] });
  await assert.rejects(controller.focusWindow(narrow.id, { windowId: desktop.windowByApp("notes").id }), { code: "SCOPE_DENIED" });
});

test("typed text is redacted in the audit trail; screenshots are stored by digest", async (t) => {
  const { controller, store, openSession } = await setup(t);
  const session = await openSession();
  await controller.launchApp(session.id, { app: "notes" });
  const observed = await controller.observe(session.id, { screenshot: true });
  const secret = "correct-horse-battery-staple";
  await controller.typeText(session.id, { text: secret, target: { ref: findElement(observed, { name: "Body" }).ref } });
  const rows = controller.audit({ sessionId: session.id });
  assert.ok(!JSON.stringify(rows).includes(secret));
  const typed = rows.find((row) => row.action === "desktop_type");
  assert.equal(typed.params.text, `[REDACTED ${secret.length} chars]`);
  assert.equal(typed.outcome, "succeeded");
  const shotRow = rows.find((row) => row.action === "desktop_screenshot");
  assert.equal(shotRow.screenshotDigest, observed.screenshotDigest);
  assert.match(observed.screenshotDigest, /^sha256:[0-9a-f]{64}$/);
  const image = store.getScreenshot(observed.screenshotDigest);
  assert.deepEqual(pngSize(image.bytes), { width: 160, height: 100 });
  assert.equal(image.mediaType, "image/png");
});

test("the per-action policy hook can deny or demand approval, and never sees raw text", async (t) => {
  const seen = [];
  const policyCheck = ({ action, params, window }) => {
    seen.push({ action, params, app: window?.app ?? null });
    if (action === "desktop_key" && params.keys === "ctrl+s") return { effect: "require_approval", reason: "saving needs a person" };
    if (action === "desktop_scroll") return { effect: "deny", reason: "no scrolling today" };
    return { effect: "allow" };
  };
  const { controller, openSession } = await setup(t, { policyCheck });
  const session = await openSession();
  await controller.launchApp(session.id, { app: "notes" });
  await assert.rejects(controller.keyPress(session.id, { key: "Control + S" }), { code: "APPROVAL_REQUIRED" });
  await assert.rejects(controller.scroll(session.id, { dy: 3 }), { code: "POLICY_DENIED" });
  await controller.typeText(session.id, { text: "secret words", target: { ref: findElement(await controller.observe(session.id), { name: "Body" }).ref } });
  const typed = seen.find((entry) => entry.action === "desktop_type");
  assert.equal(typed.params.text, "[REDACTED 12 chars]");
  assert.equal(typed.app, "notes");
});

test("readFile only reads regular files under permitted roots, symlinks resolved", async (t) => {
  const { controller, readable, base, openSession } = await setup(t);
  const session = await openSession();
  await writeFile(join(readable, "ok.txt"), "hello");
  await writeFile(join(base, "secret.txt"), "nope");
  await symlink(join(base, "secret.txt"), join(readable, "link.txt"));
  assert.equal((await controller.readFile(session.id, { path: join(readable, "ok.txt") })).content, "hello");
  await assert.rejects(controller.readFile(session.id, { path: join(base, "secret.txt") }), { code: "PATH_NOT_PERMITTED" });
  await assert.rejects(controller.readFile(session.id, { path: join(readable, "link.txt") }), { code: "PATH_NOT_PERMITTED" });
  await assert.rejects(controller.readFile(session.id, { path: join(readable, "..", "secret.txt") }), { code: "PATH_NOT_PERMITTED" });
  assert.ok(!JSON.stringify(controller.audit({ sessionId: session.id })).includes("hello"));
});

test("indicator: rendered on start/stop by the driver and the host callback; no indicator means no control", async (t) => {
  const { controller, desktop, openSession, indicator } = await setup(t);
  const a = await openSession();
  const b = await openSession();
  await controller.stop(a.id);
  await controller.stop(b.id);
  assert.deepEqual(indicator.map((e) => [e.state, e.sessionId]), [["active", a.id], ["active", b.id], ["inactive", a.id], ["inactive", b.id]]);
  assert.deepEqual(desktop.indicator.history.map((e) => e.state), ["active", "active", "inactive", "inactive"]);
  assert.deepEqual(indicator[0].scope, { allowedApps: ["notes"], allowedWindows: [] });

  const broken = await setup(t, { driver: Object.assign(new SimulatedDesktop(), { renderIndicator() { throw new Error("overlay crashed"); } }) });
  await assert.rejects(broken.openSession(), { code: "INDICATOR_FAILED" });
  assert.equal(broken.store.listSessions({ live: true }).length, 0);

  // A plain companion driver (no renderIndicator) with no host indicator is refused outright.
  const bare = new SimulatedDesktop();
  bare.renderIndicator = undefined;
  const none = await setup(t, { driver: bare, onIndicator: null });
  await assert.rejects(none.openSession(), { code: "INDICATOR_UNAVAILABLE" });
});

test("unsupported capabilities are refused honestly", async (t) => {
  const { controller, openSession } = await setup(t, { driver: new SimulatedDesktop({ capabilities: { input: false } }) });
  const session = await openSession();
  await assert.rejects(controller.click(session.id, { x: 1, y: 1 }), { code: "UNSUPPORTED" });
  assert.equal(controller.capabilities().reasons.input, "disabled in this simulated desktop");
});

// ---------------------------------------------------------------------------
// Tools: platform executor and the daemon's existing desktop tools
// ---------------------------------------------------------------------------

test("desktop.session.* tools run through AuthorizedToolExecutor; open requires an approvalId; out-of-scope typing is denied", async (t) => {
  const { controller, desktop, approve } = await setup(t);
  const dir = await mkdtemp(join(tmpdir(), "atlas-desktop-exec-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const platform = new PlatformTaskStore(join(dir, "p.sqlite"));
  t.after(() => platform.close());
  const executor = new AuthorizedToolExecutor({ store: platform, policy: new PolicyEngine({ version: "desktop.test", rules: [] }) });
  const tools = desktopToolDefinitions(controller);
  for (const tool of tools) executor.register(tool);
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.ok(validateSchema(byName["desktop.session.open"].inputSchema, {}).some((e) => e.path === "$.approvalId"));

  const task = platform.createTask({ tenantId: "local", userId: OWNER, objective: "write a note", successCriteria: ["note saved"] });
  for (const to of ["authorized", "queued", "running"]) platform.transitionTask("local", task.id, to, { actor: "test" });
  const granted = ["desktop.session.*", "desktop.emergency_stop"];
  const call = (tool, input, grantedPermissions = granted) => executor.invoke({ tenantId: "local", userId: OWNER, taskId: task.id, tool, input, grantedPermissions });

  assert.equal((await call("desktop.session.open", {})).result.error.code, "INVALID_INPUT");
  assert.equal((await call("desktop.session.open", { approvalId: approve().id }, [])).status, "denied");
  const opened = await call("desktop.session.open", { approvalId: approve().id, requestedBy: AGENT });
  assert.equal(opened.status, "succeeded", JSON.stringify(opened.result));
  const sessionId = opened.result.output.id;

  assert.equal((await call("desktop.session.launch_app", { sessionId, app: "notes" })).status, "succeeded");
  const observed = (await call("desktop.session.observe", { sessionId })).result.output;
  const title = findElement(observed, { name: "Title" });
  assert.equal((await call("desktop.session.type_text", { sessionId, text: "hi", target: { ref: title.ref } })).status, "succeeded");
  assert.equal(desktop.windowByApp("notes").get("title").value, "hi");

  desktop.openWindow("mail");
  const leak = await call("desktop.session.type_text", { sessionId, text: "leak" });
  assert.equal(leak.status, "failed");
  assert.equal(leak.result.error.code, "SCOPE_DENIED");

  assert.equal((await call("desktop.emergency_stop", { reason: "test" })).status, "succeeded");
  const after = await call("desktop.session.observe", { sessionId, screenshot: true });
  assert.equal(after.result.error.code, "EMERGENCY_STOPPED");
});

test("the daemon's existing desktop.* registry tools run behind an approved session via guardedSession", async (t) => {
  const { controller, desktop, openSession } = await setup(t);
  const session = await openSession();
  const tools = {};
  registerDesktopTools({ register: (definition) => { tools[definition.name] = definition; } }, { session: controller.guardedSession(session.id) });

  assert.match(await tools["desktop.act"].execute({ input: { action: { type: "launch_app", app: "notes" } } }), /done \(launch_app\)/);
  const observed = JSON.parse(await tools["desktop.observe"].execute({ input: {} }));
  assert.equal(observed.focused.title, "Notes - Untitled");
  desktop.openWindow("mail");
  await assert.rejects(tools["desktop.act"].execute({ input: { action: { type: "desktop_type", text: "leak" } } }), { code: "SCOPE_DENIED" });
  await assert.rejects(tools["desktop.act"].execute({ input: { action: { type: "launch_app", app: "terminal" } } }), { code: "APP_NOT_ALLOWLISTED" });
  await controller.stop(session.id);
  await assert.rejects(tools["desktop.screenshot"].execute({ input: {} }), { code: "SESSION_ENDED" });
});

test("encodePng writes a valid PNG header", () => {
  const png = encodePng(2, 1, Buffer.from([255, 0, 0, 0, 255, 0]));
  assert.deepEqual(pngSize(png), { width: 2, height: 1 });
  assert.equal(pngSize(Buffer.from("not a png at all, clearly")), null);
});
