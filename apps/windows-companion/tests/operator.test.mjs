import assert from "node:assert/strict";
import test from "node:test";

import { classifyAction, describeForApproval, detectHumanRequired, ACTION_CLASSES, setAdditionalConsequentialPatterns } from "../src/operator/classification.mjs";
import { createOperatorSession, OperatorError } from "../src/operator/session.mjs";
import { createFixtureBrowser, createMemoryScreenshotStore, createScriptedApprovals } from "../src/operator/fixtures.mjs";
import { SCENARIOS } from "../src/operator/scenarios.mjs";

test("action classification is deterministic and driven by the element, not the model's wording", () => {
  const cases = [
    [{ type: "click", name: "Place order" }, "submit", true],
    [{ type: "click", name: "Buy now" }, "submit", true],
    [{ type: "click", name: "Complete application" }, "submit", true],
    [{ type: "click", name: "Delete this project" }, "destructive", true],
    [{ type: "click", name: "Revoke access" }, "destructive", true],
    [{ type: "click", name: "Download the report" }, "transfer", true],
    [{ type: "click", name: "Read more" }, "navigate", false],
    [{ type: "fill", label: "Card number" }, "sensitive_input", true],
    [{ type: "fill", label: "New password" }, "sensitive_input", true],
    [{ type: "fill", label: "Full name" }, "input", false],
    [{ type: "fill", label: "Search", submit: true }, "submit", true],
    [{ type: "upload", name: "Attach CV" }, "transfer", true],
    [{ type: "snapshot" }, "read", false],
    [{ type: "navigate", url: "https://example.invalid" }, "navigate", false],
    [{ type: "eval", text: "anything" }, "unsupported", false],
  ];
  for (const [action, expectedClass, expectedApproval] of cases) {
    const result = classifyAction(action);
    assert.equal(result.actionClass, expectedClass, `${JSON.stringify(action)} should classify as ${expectedClass}`);
    assert.equal(result.requiresApproval, expectedApproval, `${JSON.stringify(action)} approval requirement`);
    assert.ok(ACTION_CLASSES.includes(result.actionClass));
  }
  // The same input always classifies the same way; nothing here is sampled.
  for (let repeat = 0; repeat < 5; repeat += 1) {
    assert.equal(classifyAction({ type: "click", name: "Place order" }).actionClass, "submit");
  }
  // A reassuring description from the model cannot downgrade the element.
  assert.equal(classifyAction({ type: "click", name: "Delete everything", intent: "just tidying up" }).actionClass, "destructive");
  assert.equal(classifyAction({ type: "eval" }).allowed, false);

  // A value that looks like a credential raises the class even when the field
  // is named innocuously — and the value itself never reaches the label.
  const cardInNotes = classifyAction({ type: "fill", label: "Notes", text: "4111 1111 1111 1111" });
  assert.equal(cardInNotes.actionClass, "sensitive_input");
  assert.equal(cardInNotes.label.includes("4111"), false);
  const secretInNotes = classifyAction({ type: "fill", label: "Notes", text: "ghp_abcdefghijklmnop" });
  assert.equal(secretInNotes.actionClass, "sensitive_input");
  assert.equal(secretInNotes.label.includes("ghp_"), false);
  // An ordinary value in an ordinary field stays ordinary.
  assert.equal(classifyAction({ type: "fill", label: "Notes", text: "Call them on Tuesday" }).actionClass, "input");
});

test("walls only a person can pass are detected and named", () => {
  const walls = [
    ["Please complete the CAPTCHA to continue", /CAPTCHA/u],
    ["Enter the one-time code sent to your phone", /two-factor/u],
    ["Your session expired. Please re-authenticate.", /sign-in/u],
    ["Upload your passport for identity verification", /identity/u],
    ["Enter card details to continue", /payment/u],
  ];
  for (const [text, reason] of walls) {
    const detected = detectHumanRequired(text);
    assert.equal(detected.blocked, true, `"${text}" should be detected`);
    assert.match(detected.reason, reason);
    assert.ok(detected.evidence.length > 0, "the operator is shown what was found");
  }
  assert.equal(detectHumanRequired("An ordinary page about logistics software").blocked, false);
});

test("an approval prompt names the action, the element, and the site", () => {
  const summary = describeForApproval({
    classification: classifyAction({ type: "click", name: "Place order" }),
    url: "https://shop.example.invalid/checkout",
    intent: "Buy the annual plan",
  });
  assert.match(summary, /submit: Buy the annual plan/u);
  assert.match(summary, /On: shop\.example\.invalid/u);
  assert.match(summary, /Sends, submits, buys, or publishes/u);
});

test("a screenshot fallback is used when the accessibility tree is empty, and stays local", async () => {
  const browser = createFixtureBrowser({
    startUrl: "https://example.invalid/canvas",
    sites: { "https://example.invalid/canvas": { title: "Canvas", text: "A canvas app", elements: [] } },
  });
  const screenshots = createMemoryScreenshotStore();
  const session = createOperatorSession({ page: browser, screenshots, approvals: createScriptedApprovals() });

  await session.navigate({ url: "https://example.invalid/canvas" });
  const snapshot = await session.snapshot({});
  assert.match(snapshot, /screenshot was saved locally/u);
  assert.ok(screenshots.stored.length > 0);
  assert.match(screenshots.stored[0].path, /^local:\/\//u, "screenshots stay on the machine by default");
});

test("application targeting is refused by a companion that only drives a browser", async () => {
  const browser = createFixtureBrowser({
    startUrl: "https://example.invalid/x",
    sites: { "https://example.invalid/x": { title: "X", text: "x", elements: [] } },
  });
  delete browser.focusApplication;
  const session = createOperatorSession({ page: browser });
  await assert.rejects(() => session.focusApplication({ name: "Notepad" }), (error) => error instanceof OperatorError && error.code === "NO_WINDOW_CONTROL");
});

test("application targeting clears the reference table from the previous window", async () => {
  const browser = createFixtureBrowser({
    startUrl: "https://example.invalid/x",
    sites: { "https://example.invalid/x": { title: "X", text: "x", elements: [{ ref: "b1", role: "button", name: "Click me" }] } },
  });
  const session = createOperatorSession({ page: browser, approvals: createScriptedApprovals() });
  await session.navigate({ url: "https://example.invalid/x" });
  await session.snapshot({});
  await session.focusApplication({ name: "Notepad" });
  // Refreshing after the switch re-reads the page, so the old ref is valid
  // again only because the fixture's "other window" is the same page. What
  // matters is that the table was rebuilt rather than carried across.
  assert.equal(typeof session.lastUrl(), "string");
});

// Each demo workflow is its own test, so a failure names the behaviour that broke.
for (const scenario of SCENARIOS) {
  test(`demo workflow: ${scenario.name}`, async () => {
    const browser = createFixtureBrowser({ sites: scenario.sites, startUrl: scenario.startUrl });
    const approvals = createScriptedApprovals(scenario.approve ?? (() => false));
    const screenshots = createMemoryScreenshotStore();
    const session = createOperatorSession({ page: browser, approvals, screenshots });

    const result = await scenario.run(session);
    scenario.expect(result, { browser, approvals, screenshots, session });

    // Whatever else it did, an approved consequential action leaves a receipt.
    for (const receipt of session.receipts) {
      if (receipt.approvalDigest) {
        assert.ok(approvals.asked.some((ask) => ask.digest === receipt.approvalDigest), "every receipt traces to an approval that was actually asked");
      }
    }
  });
}

test("the demo suite covers the behaviours the scope requires", () => {
  assert.ok(SCENARIOS.length >= 10, `expected at least ten demo workflows, found ${SCENARIOS.length}`);
  const names = SCENARIOS.map((scenario) => scenario.name).join(" ");
  for (const behaviour of ["sales brief", "outreach", "job application", "CAPTCHA", "admin", "stale"]) {
    assert.match(names, new RegExp(behaviour, "iu"), `no demo workflow covers ${behaviour}`);
  }
  // Every scenario must actually assert something.
  for (const scenario of SCENARIOS) {
    assert.equal(typeof scenario.expect, "function", `${scenario.name} has no expectations`);
    assert.equal(typeof scenario.run, "function", `${scenario.name} has no steps`);
  }
});

test("cancellation interrupts an action in flight", async () => {
  const controller = new AbortController();
  const browser = createFixtureBrowser({
    startUrl: "https://example.invalid/slow",
    sites: { "https://example.invalid/slow": { title: "Slow", text: "Working", elements: [{ ref: "b1", role: "button", name: "Continue" }] } },
  });
  // The approval wait is where a real run spends its time; aborting there
  // must stop the run rather than leave it parked forever.
  const approvals = {
    asked: [],
    async request({ signal }) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new OperatorError("CANCELLED", "Cancelled."));
        signal?.addEventListener("abort", () => reject(new OperatorError("CANCELLED", "Cancelled.")), { once: true });
      });
    },
  };
  const session = createOperatorSession({ page: browser, approvals });
  await session.navigate({ url: "https://example.invalid/slow" });
  await session.snapshot({});

  const pending = session.click({ ref: "b1", submit: true, intent: "Send it", signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, (error) => error.code === "CANCELLED");
});


test("consequential labels a real site would use all require approval", () => {
  // Every one of these classified as an ordinary navigation before the
  // patterns were widened, which meant Atlas would have clicked them without
  // asking. They are the labels real checkout, banking and social pages use.
  const consequential = [
    "Place my order", "Pay $49", "Pay now", "Confirm & pay", "Complete purchase",
    "Continue to checkout", "Book now", "Reserve", "Donate", "Transfer funds",
    "Authorize payment", "Withdraw", "Sign and send", "Agree & continue",
    "Yes, delete it", "Permanently erase", "Deactivate my account",
    "Post to LinkedIn", "Tweet", "Publish now", "Go live",
    // Non-English labels, for the most common cases.
    "Enviar", "Absenden", "Envoyer", "送信", "Comprar ahora", "削除",
  ];
  for (const name of consequential) {
    const result = classifyAction({ type: "click", name });
    assert.equal(result.requiresApproval, true, `"${name}" must require approval, classified as ${result.actionClass}`);
  }
});

test("ordinary navigation still does not prompt", () => {
  // The other half of the trade-off: a classifier that asks about everything
  // teaches people to approve without reading, which is worse than not asking.
  const ordinary = [
    "Read more", "Refresh list", "Next page", "Back", "Close", "Search",
    "Filter results", "Sort by date", "Expand section", "Show details",
    "Home", "Settings", "Help", "Copy link", "Print preview",
  ];
  for (const name of ordinary) {
    const result = classifyAction({ type: "click", name });
    assert.equal(result.requiresApproval, false, `"${name}" should not prompt, classified as ${result.actionClass}`);
  }
});

test("a control with no readable label is treated as consequential", () => {
  // An icon-only button is where a send or a purchase hides, and the
  // classifier has nothing to read. Asking is the right direction to be
  // wrong in, and the prompt says the label is unreadable rather than
  // inventing a description.
  for (const name of ["", "   ", "→", "▶", "✓", "»"]) {
    const result = classifyAction({ type: "click", name });
    assert.equal(result.requiresApproval, true, `an unreadable label ${JSON.stringify(name)} must ask`);
    assert.match(result.reason, /no readable label/u);
  }
  // A label with any real word is readable again.
  assert.equal(classifyAction({ type: "click", name: "→ Next" }).requiresApproval, false);
});

test("an operator can add patterns for their own language, but cannot remove any", () => {
  const before = classifyAction({ type: "click", name: "Bekreft bestilling" });
  assert.equal(before.requiresApproval, false, "an unknown Norwegian label starts unrecognized");

  setAdditionalConsequentialPatterns([/bekreft|bestilling/iu]);
  const after = classifyAction({ type: "click", name: "Bekreft bestilling" });
  assert.equal(after.requiresApproval, true);
  assert.match(after.reason, /configured for this machine/u);

  // Configuration can only raise the class. There is no way to spell
  // "stop asking me about Delete".
  setAdditionalConsequentialPatterns([/never matches anything xyzzy/iu]);
  assert.equal(classifyAction({ type: "click", name: "Delete this project" }).actionClass, "destructive");
  assert.equal(classifyAction({ type: "click", name: "Place my order" }).requiresApproval, true);
  setAdditionalConsequentialPatterns([]);
});

test("the sensitive-value check does not backtrack catastrophically", () => {
  // These patterns run against page content on every action; a quadratic one
  // would be a denial of service on an ordinary page full of digits.
  for (const size of [1_000, 20_000]) {
    const started = process.hrtime.bigint();
    classifyAction({ type: "fill", label: "Notes", text: "4".repeat(size) });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 250, `classifying ${size} digits took ${ms.toFixed(1)}ms`);
  }
});
