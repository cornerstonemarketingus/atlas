import assert from "node:assert/strict";
import test from "node:test";

import { createQuotaLedger, QuotaError, PLANS } from "../src/agent/browser/quota.mjs";
import { createHostedBrowserService, HostedBrowserError } from "../src/agent/browser/hosted-browser.mjs";
import { createCloudflareBrowserProvider } from "../src/agent/browser/cloudflare-browser.mjs";
import { createOperatorSession } from "../../windows-companion/src/operator/session.mjs";
import { createScriptedApprovals } from "../../windows-companion/src/operator/fixtures.mjs";

/** A provider that records the scope it was handed with every call. */
function fakeProvider() {
  const scopes = [];
  const closed = [];
  return {
    scopes,
    closed,
    async createPage({ tenantScope }) {
      scopes.push(tenantScope);
      let current = "https://example.invalid/start";
      return {
        tenantScope,
        async url() { return current; },
        async title() { return "Start"; },
        async snapshot() { return { text: "A page", elements: [{ ref: "b1", role: "button", name: "Send message" }] }; },
        async goto({ url }) { current = url; },
        async click() {},
        async fill() {},
        async press() {},
        async screenshot() { return Buffer.from("png"); },
        async close() { closed.push(tenantScope); },
      };
    },
  };
}

test("free plans are gated with an answer, not an error", () => {
  const quotas = createQuotaLedger();
  const free = quotas.check({ tenantId: "t1", plan: "free" });
  assert.equal(free.allowed, false);
  assert.equal(free.code, "PLAN_REQUIRED");
  assert.match(free.message, /at no extra cost/u, "the free alternative is named rather than upsold past");

  assert.equal(quotas.check({ tenantId: "t1", plan: "pro" }).allowed, true);
  // An unknown plan is treated as free rather than as unlimited.
  assert.equal(quotas.check({ tenantId: "t1", plan: "enterprise-that-does-not-exist" }).allowed, false);
});

test("concurrency and monthly minutes are enforced where the session is created", () => {
  let clock = Date.parse("2026-06-01T00:00:00Z");
  const quotas = createQuotaLedger({ now: () => clock });

  quotas.open({ tenantId: "t1", plan: "pro", sessionId: "s1" });
  const second = quotas.check({ tenantId: "t1", plan: "pro" });
  assert.equal(second.allowed, false);
  assert.equal(second.code, "CONCURRENCY_REACHED");
  assert.throws(() => quotas.open({ tenantId: "t1", plan: "pro", sessionId: "s2" }), QuotaError);

  // A team plan gets its own allowance; tenants do not share a counter.
  assert.equal(quotas.check({ tenantId: "t2", plan: "pro" }).allowed, true);

  clock += 5 * 60_000;
  const receipt = quotas.close({ tenantId: "t1", sessionId: "s1" });
  assert.equal(receipt.minutes, 5);
  assert.equal(quotas.usage("t1").minutesUsed, 5);
  assert.equal(quotas.usage("t1").activeSessions, 0);

  // A nine-second session still costs a minute: it consumed a container.
  quotas.open({ tenantId: "t1", plan: "pro", sessionId: "s3" });
  clock += 9_000;
  assert.equal(quotas.close({ tenantId: "t1", sessionId: "s3" }).minutes, 1);

  // Burn the monthly allowance and the next open is refused server-side.
  quotas.open({ tenantId: "t1", plan: "pro", sessionId: "s4" });
  clock += PLANS.pro.minutesPerMonth * 60_000;
  quotas.close({ tenantId: "t1", sessionId: "s4" });
  const exhausted = quotas.check({ tenantId: "t1", plan: "pro" });
  assert.equal(exhausted.code, "QUOTA_EXHAUSTED");
  assert.match(exhausted.message, /Windows companion is unaffected/u);

  // A new billing period resets the allowance.
  clock = Date.parse("2026-07-01T00:00:00Z");
  assert.equal(quotas.check({ tenantId: "t1", plan: "pro" }).allowed, true);
  assert.equal(quotas.usage("t1").minutesUsed, 0);
});

test("a tenant cannot read, resume, or close another tenant's session", async () => {
  const provider = fakeProvider();
  const service = createHostedBrowserService({ provider });

  const mine = await service.open({ tenantId: "tenant-a", plan: "pro", sessionId: "session-1" });
  assert.equal(mine.opened, true);

  // The neighbour knows the session id and is still refused.
  assert.throws(() => service.page({ sessionId: "session-1", tenantId: "tenant-b" }), (error) => error.code === "NO_SUCH_SESSION");
  await assert.rejects(() => service.close({ sessionId: "session-1", tenantId: "tenant-b" }), HostedBrowserError);
  await assert.rejects(() => service.cancel({ sessionId: "session-1", tenantId: "tenant-b" }), HostedBrowserError);

  // And the refusal is identical to one for a session that never existed, so
  // the error cannot be used to enumerate other tenants' sessions.
  let missingMessage;
  let foreignMessage;
  try { service.page({ sessionId: "never-existed", tenantId: "tenant-b" }); } catch (error) { missingMessage = error.message; }
  try { service.page({ sessionId: "session-1", tenantId: "tenant-b" }); } catch (error) { foreignMessage = error.message; }
  assert.equal(missingMessage, foreignMessage);

  // The owner still has it.
  assert.ok(service.page({ sessionId: "session-1", tenantId: "tenant-a" }));

  // Each tenant's page is created under its own opaque scope, and the scope
  // is not the tenant id.
  await service.open({ tenantId: "tenant-b", plan: "pro", sessionId: "session-2" });
  assert.equal(provider.scopes.length, 2);
  assert.notEqual(provider.scopes[0], provider.scopes[1]);
  assert.equal(provider.scopes.some((scope) => scope.includes("tenant-a")), false, "the provider never sees a user identifier");
});

test("a hosted session times out, cancels, and produces a billable receipt", async () => {
  let clock = Date.parse("2026-06-01T00:00:00Z");
  const provider = fakeProvider();
  const quotas = createQuotaLedger({ now: () => clock });
  const service = createHostedBrowserService({ provider, quotas, now: () => clock });

  await service.open({ tenantId: "t1", plan: "pro", sessionId: "s1" });
  clock += 3 * 60_000;
  const cancelled = await service.cancel({ sessionId: "s1", tenantId: "t1" });
  assert.equal(cancelled.reason, "cancelled");
  assert.equal(cancelled.minutes, 3);
  assert.deepEqual(provider.closed.length, 1, "cancelling closed the remote container, not just the local handle");

  await service.open({ tenantId: "t1", plan: "pro", sessionId: "s2" });
  clock += PLANS.pro.sessionMinutes * 60_000 + 1_000;
  // Expired sessions are refused before they are swept, too.
  assert.throws(() => service.page({ sessionId: "s2", tenantId: "t1" }), (error) => error.code === "SESSION_EXPIRED");
  const swept = await service.sweep({ tenantId: "t1", plan: "pro" });
  assert.equal(swept.length, 1);
  assert.equal(swept[0].reason, "timed-out");
  assert.equal(provider.closed.length, 2);

  const receipts = service.receipts("t1");
  assert.equal(receipts.length, 2);
  for (const receipt of receipts) {
    assert.ok(receipt.minutes >= 1);
    assert.match(receipt.startedAt, /^\d{4}-/u);
    assert.match(receipt.endedAt, /^\d{4}-/u);
    assert.equal(receipt.tenantId, "t1");
    assert.ok(receipt.periodStart, "a receipt names the billing period it falls in");
  }
});

test("a free user is offered their own companion rather than a dead end", async () => {
  const provider = fakeProvider();
  const withCompanion = createHostedBrowserService({ provider, localCompanionAvailable: () => true });
  const gated = await withCompanion.open({ tenantId: "t1", plan: "free", sessionId: "s1" });
  assert.equal(gated.opened, false);
  assert.equal(gated.fallback, "windows-companion");
  assert.match(gated.message, /run this on your paired companion instead/u);
  assert.equal(provider.scopes.length, 0, "no hosted container was created");

  const withoutCompanion = createHostedBrowserService({ provider, localCompanionAvailable: () => false });
  const plain = await withoutCompanion.open({ tenantId: "t2", plan: "free", sessionId: "s2" });
  assert.equal(plain.fallback, null);
  assert.equal(plain.code, "PLAN_REQUIRED");

  const unconfigured = createHostedBrowserService({ provider: null });
  await assert.rejects(() => unconfigured.open({ tenantId: "t1", plan: "pro", sessionId: "s1" }), (error) => error.code === "NOT_CONFIGURED");
});

test("a hosted page gets the same approval gate as the local companion", async () => {
  const provider = fakeProvider();
  const service = createHostedBrowserService({ provider });
  await service.open({ tenantId: "t1", plan: "pro", sessionId: "s1" });
  const page = service.page({ sessionId: "s1", tenantId: "t1" });

  // The same operator session the Windows companion uses, over the hosted page.
  const approvals = createScriptedApprovals(() => false);
  const session = createOperatorSession({ page, approvals });
  await session.navigate({ url: "https://example.invalid/start" });
  await session.snapshot({});

  await assert.rejects(
    () => session.click({ ref: "b1", intent: "Send the message" }),
    (error) => error.code === "APPROVAL_REQUIRED",
  );
  assert.equal(approvals.asked.at(-1).classification.actionClass, "submit", "hosted execution classifies identically");
});

test("the Cloudflare provider scopes every call and refuses to upload local files", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ path: new URL(url).pathname, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    return Response.json({ result: { text: "page text", elements: [{ role: "button", name: "Continue", selector: "#go" }] } });
  };
  const provider = createCloudflareBrowserProvider({ accountId: "acct1", token: "cf-token", fetchImpl });
  const page = await provider.createPage({ tenantScope: "tenant-opaque" });

  await page.goto({ url: "https://example.invalid/page" });
  const snapshot = await page.snapshot();
  assert.equal(snapshot.elements[0].name, "Continue");
  await page.click({ ref: "e1" });

  // Every call carries the tenant scope, so isolation does not rest on our
  // word alone, and the token stays in the header.
  assert.ok(calls.length >= 3);
  for (const call of calls) {
    assert.equal(call.body.scope, "tenant-opaque");
    assert.equal(call.headers.authorization, "Bearer cf-token");
    assert.equal(call.path.includes("cf-token"), false);
  }

  // Uploading from a hosted container would send the operator's file to a
  // third party first; that is a different decision, and it is refused.
  await assert.rejects(() => page.setInputFiles({ ref: "e1", path: "C:/cv.pdf" }), /cannot upload a file from your machine/u);
  assert.throws(() => createCloudflareBrowserProvider({ accountId: "a" }), /account id and a scoped token/u);
});


test("a hosted session cannot be opened or claimed without a tenant identity", async () => {
  const provider = fakeProvider();
  const service = createHostedBrowserService({ provider });

  // Before this check, a caller that forgot to pass a tenant matched a
  // session opened by another caller that also forgot: `undefined ===
  // undefined` is true, so two unrelated callers shared a browser.
  for (const missing of [undefined, null, "", {}, NaN]) {
    await assert.rejects(
      () => service.open({ tenantId: missing, plan: "pro", sessionId: `s-${Math.random()}` }),
      (error) => error.code === "NO_TENANT",
      `opening with tenantId=${JSON.stringify(missing)} must be refused`,
    );
  }
  assert.equal(provider.scopes.length, 0, "no container was created for a tenant-less request");

  await service.open({ tenantId: "tenant-a", plan: "pro", sessionId: "s1" });
  for (const missing of [undefined, null, ""]) {
    assert.throws(() => service.page({ sessionId: "s1", tenantId: missing }), (error) => error.code === "NO_TENANT");
  }
  assert.ok(service.page({ sessionId: "s1", tenantId: "tenant-a" }), "the real owner is unaffected");

  // A numeric tenant id is a real identity, and is normalized so that 7 and
  // "7" are the same tenant rather than two that can see each other's work.
  await service.open({ tenantId: 7, plan: "pro", sessionId: "s2" });
  assert.ok(service.page({ sessionId: "s2", tenantId: "7" }));
  assert.throws(() => service.page({ sessionId: "s2", tenantId: "8" }), (error) => error.code === "NO_SUCH_SESSION");

  // Reusing a live session identifier must not silently replace it.
  await assert.rejects(
    () => service.open({ tenantId: "tenant-b", plan: "pro", sessionId: "s1" }),
    (error) => error.code === "SESSION_EXISTS",
    "a second tenant cannot take over an in-use session identifier",
  );
  assert.equal(service.page({ sessionId: "s1", tenantId: "tenant-a" }).tenantScope, provider.scopes[0], "the original owner still holds it");
});
