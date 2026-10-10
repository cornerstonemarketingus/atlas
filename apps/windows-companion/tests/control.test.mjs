import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DesktopSession } from "../src/desktop/index.mjs";
import { ControlError, OPERATOR_STATES, createFileJournal, createMemoryJournal, createOperatorControl } from "../src/operator/control.mjs";
import { createFixtureBrowser, createScriptedApprovals } from "../src/operator/fixtures.mjs";
import { OperatorError, createOperatorSession } from "../src/operator/session.mjs";

const SHOP = "https://shop.example.invalid/cart";
const SHOP_WITH_TOKEN = "https://shop.example.invalid/cart?token=abc123secret";
const DONE = "https://shop.example.invalid/done";
const WALL = "https://shop.example.invalid/check";
const cart = (on) => ({ title: "Cart", text: "Your cart", elements: [{ ref: "e1", role: "textbox", name: "Notes" }, { ref: "e2", role: "button", name: "Place order" }, { ref: "e3", role: "link", name: "Read more" }], on });
const SITES = {
  [SHOP]: cart({ e2: { navigateTo: DONE } }),
  [SHOP_WITH_TOKEN]: cart({}),
  [DONE]: { title: "Done", text: "Order placed", elements: [] },
  [WALL]: { title: "Check", text: "Please complete the CAPTCHA to continue", elements: [{ ref: "w1", role: "button", name: "Continue" }] },
};
const codeOf = (code) => (error) => error instanceof ControlError && error.code === code;

function rig({ approve = () => true, journal = createMemoryJournal(), audit = undefined, startUrl = SHOP } = {}) {
  const clock = { now: 1_000_000 };
  const audited = [];
  const control = createOperatorControl({ journal, audit: audit ?? ((category, summary) => audited.push([category, summary])), now: () => clock.now });
  const browser = createFixtureBrowser({ sites: SITES, startUrl });
  const fail = { next: false };
  const click = browser.click;
  browser.click = async (arguments_) => { if (fail.next) { fail.next = false; throw new Error("target closed"); } return click(arguments_); };
  const approvals = createScriptedApprovals(approve);
  const session = createOperatorSession({ page: browser, approvals, control });
  return { control, browser, session, approvals, fail, clock, audited };
}

// -- the state machine ----------------------------------------------------------------------------------------------

test("the operator state machine is deterministic: legal moves are receipted with who made them, illegal ones are refused, repeats are harmless", () => {
  const { control } = rig();
  assert.equal(control.state, "idle");
  assert.deepEqual(control.states, OPERATOR_STATES);
  assert.throws(() => control.pause({ actor: "owner" }), codeOf("INVALID_TRANSITION"));
  control.begin({ actor: "owner" });
  assert.equal(control.pause({ actor: "device:Phone", reason: "stepping away" }).changed, true);
  assert.equal(control.pause({ actor: "device:Phone" }).changed, false, "a double tap changes nothing and writes no receipt");
  assert.throws(() => control.begin({}), codeOf("INVALID_TRANSITION"), "a run cannot be begun twice");
  control.resume({ actor: "owner" });
  control.takeover({ actor: "owner" });
  assert.throws(() => control.pause({ actor: "owner" }), codeOf("INVALID_TRANSITION"), "you cannot pause what you already control");
  assert.throws(() => control.resume({ actor: "owner" }), codeOf("INVALID_TRANSITION"));
  control.handBack({ actor: "owner" });
  assert.equal(control.status().epoch, 1);
  control.block({ reason: "a CAPTCHA" });
  assert.throws(() => control.resume({ actor: "owner" }), codeOf("INVALID_TRANSITION"), "a blocked run is not resumed; a person takes over first");
  control.takeover({ actor: "owner" });
  control.handBack({ actor: "owner" });
  control.cancel({ actor: "owner", reason: "changed my mind" });
  assert.equal(control.cancel({ actor: "owner" }).changed, false);
  assert.throws(() => control.resume({ actor: "owner" }), codeOf("INVALID_TRANSITION"));
  control.begin({ actor: "owner" });
  assert.equal(control.status().runId, 2);

  const moves = control.receipts().filter((entry) => entry.type === "transition");
  assert.deepEqual(moves.map((entry) => `${entry.from}>${entry.to}`), ["idle>running", "running>paused", "paused>running", "running>taken_over", "taken_over>running", "running>blocked", "blocked>taken_over", "taken_over>running", "running>cancelled", "cancelled>running"]);
  assert.ok(moves.every((entry, index) => entry.actor && entry.at && entry.seq === (moves[index - 1]?.seq ?? 0) + 1 || entry.seq > (moves[index - 1]?.seq ?? 0)), "every receipt names an actor and a time, and sequence only grows");
  assert.equal(moves[1].actor, "device:Phone");
  assert.equal(moves[1].reason, "stepping away");
});

test("Atlas acts only while running; reads stay open while it is held; cancel stops even reads", () => {
  const { control } = rig();
  control.guard({ kind: "read" });
  assert.equal(control.state, "running", "the first use begins a run");
  const stops = { paused: "OPERATOR_PAUSED", taken_over: "HUMAN_IN_CONTROL", blocked: "OPERATOR_BLOCKED", cancelled: "OPERATOR_CANCELLED" };
  const enter = { paused: () => control.pause({}), taken_over: () => control.takeover({}), blocked: () => control.block({ reason: "wall" }), cancelled: () => control.cancel({}) };
  for (const state of ["paused", "taken_over", "blocked", "cancelled"]) {
    if (state === "blocked") { if (control.state !== "running") { if (control.state === "taken_over") control.handBack({}); else control.resume({}); } }
    enter[state]();
    assert.equal(control.state, state);
    assert.throws(() => control.guard({ kind: "act" }), codeOf(stops[state]));
    if (state === "cancelled") assert.throws(() => control.guard({ kind: "read" }), codeOf("OPERATOR_CANCELLED"));
    else assert.equal(control.guard({ kind: "read" }), true);
    if (state === "paused") control.resume({});
    if (state === "taken_over") control.handBack({});
    if (state === "blocked") { control.takeover({}); control.handBack({}); }
  }
  assert.match(new ControlError("X", "m").message, /m/u);
});

// -- through the real operator session -------------------------------------------------------------------------------

test("pausing stops the browser session before its next step, leaves reading open, and resuming continues", async () => {
  const { control, browser, session } = rig();
  await session.navigate({ url: SHOP });
  await session.snapshot({});
  control.pause({ actor: "device:Phone" });
  const before = { state: browser.state(), url: await browser.url() };
  for (const attempt of [() => session.click({ ref: "e3" }), () => session.type({ ref: "e1", text: "hello" }), () => session.navigate({ url: DONE })]) {
    await assert.rejects(attempt(), codeOf("OPERATOR_PAUSED"));
  }
  assert.deepEqual({ state: browser.state(), url: await browser.url() }, before, "nothing reached the page while paused");
  assert.match(await session.snapshot({}), /Your cart/u, "the owner can still see what Atlas sees");
  control.resume({ actor: "owner" });
  assert.match((await session.click({ ref: "e3" })).summary, /Clicked "Read more"/u);
});

test("a cancelled run refuses even reading until the owner lets Atlas operate again", async () => {
  const { control, session } = rig();
  await session.navigate({ url: SHOP });
  await session.snapshot({});
  control.cancel({ actor: "owner" });
  await assert.rejects(session.snapshot({}), codeOf("OPERATOR_CANCELLED"));
  await assert.rejects(session.extract({ fields: [{ name: "Notes" }] }), codeOf("OPERATOR_CANCELLED"));
  await assert.rejects(session.navigate({ url: SHOP }), codeOf("OPERATOR_CANCELLED"));
  control.begin({ actor: "owner" });
  assert.match(await session.snapshot({}), /Your cart/u);
});

test("taking over: Atlas does not touch the page, and after hand-back nothing it saw before is trusted", async () => {
  const { control, browser, session } = rig();
  await session.navigate({ url: SHOP });
  await session.snapshot({});
  control.takeover({ actor: "owner" });
  await assert.rejects(session.click({ ref: "e3" }), codeOf("HUMAN_IN_CONTROL"));
  browser.goTo(DONE); // the owner uses the browser themselves
  control.handBack({ actor: "owner" });
  await assert.rejects(session.click({ ref: "e3" }), (error) => error instanceof OperatorError && error.code === "STALE_REFERENCE", "a reference from before the takeover is refused");
  assert.match(await session.snapshot({}), /Order placed/u, "Atlas looks again and sees what the owner left");
  assert.equal(control.status().site, "shop.example.invalid");
});

test("an approval that arrives after the owner paused does not run the action", async () => {
  const holder = {};
  const { control, browser, session, approvals } = rig({ approve: () => { holder.control.pause({ actor: "owner", reason: "wait" }); return true; } });
  holder.control = control;
  await session.navigate({ url: SHOP });
  await session.snapshot({});
  await assert.rejects(session.click({ ref: "e2" }), codeOf("OPERATOR_PAUSED"));
  assert.equal(await browser.url(), SHOP, "the order was not placed");
  assert.equal(approvals.asked.length, 1);
  assert.equal(control.status().uncertain.length, 0, "it never started, so there is nothing uncertain");
  assert.equal(control.status().approvalPending, false);
});

test("a consequential action that errors part-way is uncertain: it is never repeated until the owner says whether it happened", async () => {
  const { control, browser, session, fail } = rig();
  await session.navigate({ url: SHOP });
  await session.snapshot({});
  fail.next = true;
  await assert.rejects(session.click({ ref: "e2" }), /target closed/u);
  const [open] = control.status().uncertain;
  assert.match(open.summary, /submit/u);
  await assert.rejects(session.click({ ref: "e2" }), codeOf("ACTION_UNCERTAIN"));
  assert.equal(await browser.url(), SHOP, "no second attempt reached the page");

  assert.throws(() => control.acknowledge({ intentId: open.id, verdict: "maybe" }), codeOf("INVALID_VERDICT"));
  control.acknowledge({ intentId: open.id, verdict: "did_not_happen", actor: "device:Phone" });
  assert.deepEqual(control.status().uncertain, []);
  await session.click({ ref: "e2" });
  assert.equal(await browser.url(), DONE, "after the owner cleared it, the retry went ahead (with a fresh approval)");
  assert.throws(() => control.acknowledge({ intentId: open.id, verdict: "happened" }), codeOf("NOT_UNCERTAIN"));
  assert.throws(() => control.acknowledge({ intentId: "intent-9-9", verdict: "happened" }), codeOf("UNKNOWN_INTENT"));
  const kinds = control.receipts().map((entry) => entry.type);
  assert.deepEqual(kinds.filter((kind) => kind !== "transition"), ["intent", "outcome", "ack", "intent", "outcome"]);
});

test("if the owner confirms an uncertain action did happen, Atlas will not do it again in that run", async () => {
  const { control, browser, session, fail } = rig();
  await session.navigate({ url: SHOP });
  await session.snapshot({});
  fail.next = true;
  await assert.rejects(session.click({ ref: "e2" }), /target closed/u);
  control.acknowledge({ intentId: control.status().uncertain[0].id, verdict: "happened" });
  await assert.rejects(session.click({ ref: "e2" }), codeOf("ACTION_ALREADY_DONE"));
  assert.equal(await browser.url(), SHOP);
});

test("an ordinary action that errors is not made uncertain: only consequential ones are journaled", async () => {
  const { control, session, fail } = rig();
  await session.navigate({ url: SHOP });
  await session.snapshot({});
  fail.next = true;
  await assert.rejects(session.click({ ref: "e3" }), /target closed/u);
  assert.deepEqual(control.status().uncertain, []);
  assert.equal(control.receipts().filter((entry) => entry.type === "intent").length, 0);
  assert.equal((await session.click({ ref: "e3" })).receipt.changed, false);
});

test("a wall only a person can pass blocks the run; handing back is not enough to get past it", async () => {
  const { control, session } = rig({ startUrl: WALL });
  await session.navigate({ url: WALL });
  await session.snapshot({});
  await assert.rejects(session.click({ ref: "w1" }), (error) => error instanceof OperatorError && error.code === "HUMAN_REQUIRED");
  assert.equal(control.state, "blocked");
  assert.match(control.status().lastReason, /CAPTCHA/u);
  await assert.rejects(session.click({ ref: "w1" }), codeOf("OPERATOR_BLOCKED"));
  control.takeover({ actor: "owner" });
  control.handBack({ actor: "owner" });
  await session.snapshot({});
  await assert.rejects(session.click({ ref: "w1" }), (error) => error instanceof OperatorError && error.code === "HUMAN_REQUIRED", "still showing the wall: Atlas stops again");
});

test("status and receipts carry hosts, actions and risk classes, never typed values or full URLs; receipts are mirrored to the audit log", async () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const { control, session, audited } = rig({ startUrl: SHOP_WITH_TOKEN });
  await session.navigate({ url: SHOP_WITH_TOKEN });
  await session.snapshot({});
  await session.type({ ref: "e1", text: secret });
  const everything = JSON.stringify([control.status(), control.receipts(), audited]);
  assert.ok(!everything.includes("ghp_"), "the typed value is nowhere");
  assert.ok(!everything.includes("abc123secret") && !everything.includes("token="), "the URL's query is nowhere");
  assert.equal(control.status().site, "shop.example.invalid");
  assert.ok(control.status().milestones.some((milestone) => milestone.kind === "type" && milestone.risk === "sensitive_input"));
  assert.ok(audited.some(([category]) => category === "operator.intent"));
});

test("pause and cancel always work, even when the audit trail cannot be written; every other change, and every consequential action, fails closed", async () => {
  const flaky = { broken: false, entries: [], append(entry) { if (this.broken) throw new Error("disk full"); this.entries.push(entry); }, load() { return []; } };
  const { control, session, browser } = rig({ journal: flaky });
  await session.navigate({ url: SHOP });
  await session.snapshot({});
  flaky.broken = true;
  control.pause({ actor: "owner" });
  assert.equal(control.state, "paused");
  assert.match(control.status().auditWarning, /not recorded/u);
  assert.throws(() => control.resume({ actor: "owner" }), codeOf("AUDIT_UNAVAILABLE"));
  assert.equal(control.state, "paused", "an unrecorded resume did not happen");
  flaky.broken = false;
  control.resume({ actor: "owner" });
  flaky.broken = true;
  await assert.rejects(session.click({ ref: "e2" }), codeOf("AUDIT_UNAVAILABLE"));
  assert.equal(await browser.url(), SHOP, "a consequential action that cannot be journaled does not run");
  control.cancel({ actor: "owner" });
  assert.equal(control.state, "cancelled");
});

// -- crash recovery -------------------------------------------------------------------------------------------------

test("after a crash mid-action Atlas comes back interrupted, remembers what may have happened, and will not repeat it", () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-operator-"));
  try {
    const path = join(directory, "operator", "journal.jsonl");
    const first = createOperatorControl({ journal: createFileJournal(path) });
    first.guard({ kind: "act" });
    first.intent({ digest: "digest-1", summary: "submit: Place order on shop.example.invalid", actionClass: "submit" });
    // ... the process dies here: no outcome was recorded.
    appendFileSync(path, '{"seq":99,"type":"transition","to":"runn'); // and the last write was torn

    const second = createOperatorControl({ journal: createFileJournal(path) });
    assert.equal(second.state, "interrupted");
    assert.equal(second.status().uncertain.length, 1);
    assert.match(second.status().uncertain[0].summary, /Place order/u);
    assert.throws(() => second.guard({ kind: "act" }), codeOf("OPERATOR_INTERRUPTED"));
    assert.equal(second.guard({ kind: "read" }), true);
    assert.throws(() => second.intent({ digest: "digest-1", summary: "again", actionClass: "submit" }), codeOf("ACTION_UNCERTAIN"));
    assert.deepEqual(second.receipts().filter((entry) => entry.type === "transition").at(-1), { ...second.receipts().filter((entry) => entry.type === "transition").at(-1), from: "running", to: "interrupted", actor: "system" });

    second.takeover({ actor: "owner" });
    second.handBack({ actor: "owner" });
    assert.equal(second.guard({ kind: "act" }), true, "once the owner has looked and handed back, Atlas may act");
    assert.throws(() => second.intent({ digest: "digest-1", summary: "again", actionClass: "submit" }), codeOf("ACTION_UNCERTAIN"), "but the uncertain action stays refused until it is confirmed");
    second.acknowledge({ intentId: second.status().uncertain[0].id, verdict: "did_not_happen", actor: "owner" });
    assert.ok(second.intent({ digest: "digest-1", summary: "again", actionClass: "submit" }));

    const third = createOperatorControl({ journal: createFileJournal(path) });
    assert.equal(third.state, "interrupted", "restarting while running interrupts again");
    assert.deepEqual(third.status().uncertain.map((entry) => entry.summary), ["again"], "the new intent had no outcome either");
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600, "the journal is owner-only");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("an idle or cancelled runtime that restarts stays that way, and recovery never invents a run", () => {
  const journal = createMemoryJournal();
  const first = createOperatorControl({ journal });
  first.begin({ actor: "owner" });
  first.cancel({ actor: "owner" });
  const second = createOperatorControl({ journal });
  assert.equal(second.state, "cancelled");
  assert.equal(second.status().runId, 1);
  assert.equal(createOperatorControl({ journal: createMemoryJournal() }).state, "idle");
});

// -- live status ----------------------------------------------------------------------------------------------------

test("status shows what Atlas is doing now and subscribers hear every change; a broken subscriber stops nothing", async () => {
  const { control, session } = rig();
  const heard = [];
  control.subscribe(() => { throw new Error("bad listener"); });
  const stop = control.subscribe((event) => heard.push(`${event.type}:${event.status.state}`));
  await session.navigate({ url: SHOP });
  await session.snapshot({});
  let during = null;
  const original = control.run.bind(control);
  control.run = (label, fn) => original(label, async () => { during = control.status(); return fn(); });
  await session.click({ ref: "e3" });
  assert.deepEqual([during.currentAction, during.inFlight, during.state], [{ type: "click" }, true, "running"]);
  assert.equal(control.status().currentAction, null);
  control.pause({ actor: "owner" });
  stop();
  control.resume({ actor: "owner" });
  assert.ok(heard.includes("state:paused") && heard.includes("milestone:running"));
  assert.ok(!heard.includes("state:running:resume"));
  assert.equal(heard.filter((entry) => entry === "state:running").length, 1, "events stopped after unsubscribe");
});

// -- the desktop session shares the same control ---------------------------------------------------------------------

function fakeDriver(title = "Untitled - Notepad") {
  const calls = [];
  return {
    calls, fail: false,
    screenshot: async () => Buffer.from("png"),
    windows: async () => [{ id: "1", title }],
    activeWindow: async () => ({ id: "1", title }),
    inspect: async () => ({ window: { title }, tree: [] }),
    focus: async () => ({ title }), click: async () => {}, move: async () => {}, scroll: async () => {},
    type: async (text) => { calls.push(["type", text]); },
    key: async function key(keys) { if (this.fail) throw new Error("driver lost"); calls.push(["key", keys]); },
    launch: async () => {}, clipboardRead: async () => "", clipboardWrite: async () => {},
  };
}

test("the desktop session obeys the same pause, take-over and uncertain-action rules", async () => {
  const control = createOperatorControl({});
  const driver = fakeDriver();
  let approve = async () => {};
  const session = new DesktopSession({ driver, control, approve: (request) => approve(request) });
  await session.perform({ type: "desktop_type", text: "Quarterly summary" });
  control.pause({ actor: "device:Phone" });
  await assert.rejects(session.perform({ type: "desktop_type", text: "more" }), codeOf("OPERATOR_PAUSED"));
  assert.deepEqual(driver.calls, [["type", "Quarterly summary"]]);
  assert.ok((await session.observe()).windows.length, "looking is still allowed while paused");
  control.takeover({ actor: "owner" });
  await assert.rejects(session.perform({ type: "desktop_key", keys: "ctrl+s" }), codeOf("HUMAN_IN_CONTROL"));
  control.handBack({ actor: "owner" });

  // While held, Atlas does not even ask for an approval it could not use.
  let asked = 0;
  approve = async () => { asked += 1; };
  control.pause({ actor: "owner" });
  await assert.rejects(session.perform({ type: "desktop_key", keys: "alt+f4" }), codeOf("OPERATOR_PAUSED"));
  assert.equal(asked, 0, "no approval prompt was raised while paused");
  control.resume({ actor: "owner" });

  approve = async () => { control.pause({ actor: "owner" }); };
  await assert.rejects(session.perform({ type: "desktop_key", keys: "alt+f4" }), codeOf("OPERATOR_PAUSED"));
  assert.ok(!driver.calls.some(([, keys]) => keys === "alt+f4"), "an approval granted while the owner paused did not run the key");
  control.resume({ actor: "owner" });

  approve = async () => {};
  driver.fail = true;
  await assert.rejects(session.perform({ type: "desktop_key", keys: "alt+f4" }), /driver lost/u);
  assert.equal(control.status().uncertain.length, 1);
  driver.fail = false;
  await assert.rejects(session.perform({ type: "desktop_key", keys: "alt+f4" }), codeOf("ACTION_UNCERTAIN"));
  assert.ok(control.status().milestones.some((milestone) => milestone.kind === "desktop_type" && milestone.outcome === "done"));
});
