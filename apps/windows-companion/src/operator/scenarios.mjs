/**
 * Deterministic demo workflows.
 *
 * Each one is a small fixture site plus a script of session calls and the
 * outcome Atlas must produce. They are the regression suite for operator
 * behaviour: that a submit asks, that a refusal stops the run, that a CAPTCHA
 * hands the machine back, that nothing is claimed without evidence.
 */

const captchaPage = {
  title: "Verify",
  text: "Please verify you are human before continuing. Press and hold the button.",
  elements: [{ ref: "b1", role: "button", name: "Press and hold" }],
};

export const SCENARIOS = [
  {
    name: "research a company and prepare a sales brief",
    startUrl: "https://example.invalid/company",
    sites: {
      "https://example.invalid/company": {
        title: "Example Co",
        text: "Example Co builds logistics software. Founded 2014. 210 employees.",
        elements: [
          { ref: "h1", role: "heading", name: "Example Co" },
          { ref: "e1", role: "text", name: "employees", value: "210" },
          { ref: "e2", role: "text", name: "founded", value: "2014" },
          { ref: "l1", role: "link", name: "Read the pricing page", on: true },
        ],
        on: { l1: { navigateTo: "https://example.invalid/pricing" } },
      },
      "https://example.invalid/pricing": {
        title: "Pricing",
        text: "Team plan 40 per seat. Enterprise on request.",
        elements: [{ ref: "p1", role: "text", name: "team price", value: "40 per seat" }],
      },
    },
    async run(session) {
      await session.navigate({ url: "https://example.invalid/company" });
      await session.snapshot({});
      const facts = await session.extract({ fields: [{ name: "employees" }, { name: "founded" }] });
      await session.click({ ref: "l1", intent: "Open the pricing page" });
      await session.snapshot({});
      const pricing = await session.extract({ fields: [{ name: "team price" }] });
      return { facts, pricing };
    },
    expect: (result, { approvals }) => {
      assertEqual(result.facts.employees, "210", "the employee count was read from the page");
      assertEqual(result.pricing["team price"], "40 per seat", "the price was read after navigating");
      assertEqual(approvals.asked.length, 0, "reading and ordinary navigation never ask for approval");
    },
  },

  {
    name: "draft outreach but stop before sending",
    startUrl: "https://example.invalid/mail",
    sites: {
      "https://example.invalid/mail": {
        title: "Compose",
        text: "New message",
        elements: [
          { ref: "to", role: "textbox", name: "To" },
          { ref: "body", role: "textbox", name: "Message body" },
          { ref: "send", role: "button", name: "Send message" },
        ],
        on: { send: { set: { sent: "yes" } } },
      },
    },
    async run(session) {
      await session.navigate({ url: "https://example.invalid/mail" });
      await session.snapshot({});
      await session.type({ ref: "to", text: "buyer@example.invalid" });
      await session.type({ ref: "body", text: "Hello, I read your pricing page." });
      return catchError(() => session.click({ ref: "send", intent: "Send the outreach email" }));
    },
    expect: (result, { approvals, browser }) => {
      assertEqual(result.code, "APPROVAL_REQUIRED", "sending asked for approval");
      assertEqual(browser.state().sent, undefined, "nothing was sent");
      assertEqual(approvals.asked.at(-1).classification.actionClass, "submit", "the send was classified as a submit");
      assertMatch(approvals.asked.at(-1).summary, /example\.invalid/u, "the approval names the site");
    },
  },

  {
    name: "send outreach once the operator approves it",
    startUrl: "https://example.invalid/mail",
    approve: ({ classification }) => classification.actionClass === "submit",
    sites: {
      "https://example.invalid/mail": (state) => ({
        title: "Compose",
        text: state.sent ? "Your message was sent." : "New message",
        elements: state.sent
          ? [{ ref: "ok", role: "text", name: "status", value: "sent" }]
          : [
            { ref: "to", role: "textbox", name: "To" },
            { ref: "send", role: "button", name: "Send message" },
          ],
        on: { send: { set: { sent: "yes" } } },
      }),
    },
    async run(session) {
      await session.navigate({ url: "https://example.invalid/mail" });
      await session.snapshot({});
      await session.type({ ref: "to", text: "buyer@example.invalid" });
      return session.click({ ref: "send", intent: "Send the outreach email" });
    },
    expect: (result, { browser, screenshots }) => {
      assertEqual(browser.state().sent, "yes", "the approved message was sent");
      assertEqual(result.receipt.changed, true, "the page changed, which is the evidence it worked");
      assertTrue(result.receipt.approvalDigest !== null, "the receipt names the approval it was sent under");
      assertTrue(screenshots.stored.length > 0, "a screenshot of the result was kept locally");
    },
  },

  {
    name: "fill a job application but stop before submitting",
    startUrl: "https://example.invalid/apply",
    sites: {
      "https://example.invalid/apply": {
        title: "Apply",
        text: "Backend engineer application",
        elements: [
          { ref: "name", role: "textbox", name: "Full name" },
          { ref: "email", role: "textbox", name: "Email address" },
          { ref: "cv", role: "button", name: "Attach your CV" },
          { ref: "apply", role: "button", name: "Complete application" },
        ],
        on: { apply: { set: { applied: "yes" } } },
      },
    },
    async run(session) {
      await session.navigate({ url: "https://example.invalid/apply" });
      await session.snapshot({});
      await session.type({ ref: "name", text: "Alex Operator" });
      await session.type({ ref: "email", text: "alex@example.invalid" });
      return catchError(() => session.click({ ref: "apply", intent: "Submit the job application" }));
    },
    expect: (result, { browser }) => {
      assertEqual(result.code, "APPROVAL_REQUIRED", "submitting an application asks first");
      assertEqual(browser.state().applied, undefined, "the application was not submitted");
      assertEqual(browser.state().name, "Alex Operator", "the form was still filled in for the operator to review");
    },
  },

  {
    name: "refuse to attach a file without approval",
    startUrl: "https://example.invalid/apply",
    sites: {
      "https://example.invalid/apply": {
        title: "Apply",
        text: "Upload your CV",
        elements: [{ ref: "cv", role: "button", name: "Attach your CV" }],
      },
    },
    async run(session) {
      await session.navigate({ url: "https://example.invalid/apply" });
      await session.snapshot({});
      return catchError(() => session.upload({ ref: "cv", path: "C:/Users/alex/cv.pdf" }));
    },
    expect: (result, { approvals, browser }) => {
      assertEqual(result.code, "APPROVAL_REQUIRED", "uploading asks first");
      assertEqual(approvals.asked.at(-1).classification.actionClass, "transfer", "an upload is a transfer off the machine");
      assertEqual(browser.state().cv, undefined, "no file was attached");
    },
  },

  {
    name: "stop at a CAPTCHA and hand the machine back",
    startUrl: "https://example.invalid/gate",
    approve: () => true,
    sites: { "https://example.invalid/gate": captchaPage },
    async run(session) {
      await session.navigate({ url: "https://example.invalid/gate" });
      const snapshot = await session.snapshot({});
      const attempt = await catchError(() => session.click({ ref: "b1", intent: "Pass the check" }));
      return { snapshot, attempt };
    },
    expect: ({ snapshot, attempt }) => {
      assertEqual(attempt.code, "HUMAN_REQUIRED", "Atlas refused to work the challenge even with approval granted");
      assertMatch(attempt.message, /CAPTCHA or anti-bot challenge/u, "the operator is told exactly what is in the way");
      assertMatch(snapshot, /Hand control to the operator/u, "the snapshot warns before an action is attempted");
    },
  },

  {
    name: "stop at a two-factor prompt",
    startUrl: "https://example.invalid/2fa",
    approve: () => true,
    sites: {
      "https://example.invalid/2fa": {
        title: "Verify",
        text: "Enter the one-time code sent to your phone.",
        elements: [{ ref: "code", role: "textbox", name: "Verification code" }],
      },
    },
    async run(session) {
      await session.navigate({ url: "https://example.invalid/2fa" });
      await session.snapshot({});
      return catchError(() => session.type({ ref: "code", text: "123456" }));
    },
    expect: (result) => {
      assertEqual(result.code, "HUMAN_REQUIRED", "a 2FA prompt stops Atlas");
      assertMatch(result.message, /two-factor/u, "the reason is named");
    },
  },

  {
    name: "ask before typing a password",
    startUrl: "https://example.invalid/login",
    sites: {
      "https://example.invalid/login": {
        title: "Account",
        // No sign-in wording, so this tests sensitive-input classification
        // rather than the human-required wall.
        text: "Update your details.",
        elements: [{ ref: "pw", role: "textbox", name: "New password" }],
      },
    },
    async run(session) {
      await session.navigate({ url: "https://example.invalid/login" });
      await session.snapshot({});
      return catchError(() => session.type({ ref: "pw", text: "hunter2" }));
    },
    expect: (result, { approvals, browser }) => {
      assertEqual(result.code, "APPROVAL_REQUIRED", "typing a credential asks first");
      assertEqual(approvals.asked.at(-1).classification.actionClass, "sensitive_input", "it is classified as sensitive");
      assertEqual(browser.state().pw, undefined, "the password was not typed");
      assertEqual(approvals.asked.at(-1).summary.includes("hunter2"), false, "the approval prompt does not echo the secret");
    },
  },

  {
    name: "update a website through its admin interface",
    startUrl: "https://example.invalid/admin",
    approve: ({ classification }) => classification.actionClass === "submit",
    sites: {
      "https://example.invalid/admin": (state) => ({
        title: "Admin",
        text: state.saved ? "Changes published." : "Edit the home page",
        elements: [
          { ref: "headline", role: "textbox", name: "Headline" },
          { ref: "publish", role: "button", name: "Publish changes" },
        ],
        on: { publish: { set: { saved: "yes" } } },
      }),
    },
    async run(session) {
      await session.navigate({ url: "https://example.invalid/admin" });
      await session.snapshot({});
      await session.type({ ref: "headline", text: "Now shipping in Europe" });
      return session.click({ ref: "publish", intent: "Publish the new headline" });
    },
    expect: (result, { browser }) => {
      assertEqual(browser.state().saved, "yes", "the change was published after approval");
      assertEqual(browser.state().headline, "Now shipping in Europe", "the headline was set first");
      assertEqual(result.receipt.changed, true, "the publish was confirmed by the page changing");
    },
  },

  {
    name: "refuse a destructive click even when it looks routine",
    startUrl: "https://example.invalid/settings",
    sites: {
      "https://example.invalid/settings": {
        title: "Settings",
        text: "Danger zone",
        elements: [{ ref: "del", role: "button", name: "Delete this project" }],
        on: { del: { set: { deleted: "yes" } } },
      },
    },
    async run(session) {
      await session.navigate({ url: "https://example.invalid/settings" });
      await session.snapshot({});
      return catchError(() => session.click({ ref: "del", intent: "Tidy up" }));
    },
    expect: (result, { approvals, browser }) => {
      assertEqual(result.code, "APPROVAL_REQUIRED", "a delete asks regardless of how the model described it");
      assertEqual(approvals.asked.at(-1).classification.actionClass, "destructive", "it is classified from the element, not the model's intent");
      assertEqual(browser.state().deleted, undefined, "nothing was deleted");
    },
  },

  {
    name: "work across pages and notice when a reference goes stale",
    startUrl: "https://example.invalid/step1",
    sites: {
      "https://example.invalid/step1": {
        title: "Step 1",
        text: "First step",
        elements: [{ ref: "next", role: "link", name: "Go to step 2" }],
        on: { next: { navigateTo: "https://example.invalid/step2" } },
      },
      "https://example.invalid/step2": {
        title: "Step 2",
        text: "Second step",
        elements: [{ ref: "field", role: "textbox", name: "Notes" }],
      },
    },
    async run(session) {
      await session.navigate({ url: "https://example.invalid/step1" });
      await session.snapshot({});
      await session.click({ ref: "next", intent: "Continue" });
      // Deliberately reusing step 1's reference after navigating.
      const stale = await catchError(() => session.click({ ref: "next", intent: "Continue again" }));
      await session.snapshot({});
      await session.type({ ref: "field", text: "done" });
      return stale;
    },
    expect: (result, { browser }) => {
      assertEqual(result.code, "STALE_REFERENCE", "a reference from the previous page is refused");
      assertMatch(result.message, /Take a new snapshot/u, "the model is told how to recover");
      assertEqual(browser.state().field, "done", "after a fresh snapshot the run continued");
    },
  },

  {
    name: "report honestly when a click changes nothing",
    startUrl: "https://example.invalid/inert",
    sites: {
      "https://example.invalid/inert": {
        title: "Inert",
        text: "Nothing happens here",
        elements: [{ ref: "b", role: "button", name: "Refresh list" }],
      },
    },
    async run(session) {
      await session.navigate({ url: "https://example.invalid/inert" });
      await session.snapshot({});
      return session.click({ ref: "b", intent: "Refresh" });
    },
    expect: (result) => {
      assertEqual(result.receipt.changed, false, "the receipt records that nothing changed");
      assertMatch(result.summary, /nothing on the page changed/u, "Atlas says so rather than reporting success");
    },
  },
];

async function catchError(run) {
  try {
    await run();
    return { code: null, message: "No error was raised." };
  } catch (error) {
    return { code: error.code ?? "UNKNOWN", message: error.message };
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
}

function assertTrue(value, message) {
  if (!value) throw new Error(message);
}

function assertMatch(value, pattern, message) {
  if (!pattern.test(String(value))) throw new Error(`${message}\n  pattern: ${pattern}\n  value:   ${String(value).slice(0, 300)}`);
}
