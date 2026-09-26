import assert from "node:assert/strict";
import test from "node:test";
import { cloudBrowserAccess } from "../app/api/computer/browser-plan.mjs";

test("keeps hosted browsing unavailable on the free plan", () => {
  assert.deepEqual(cloudBrowserAccess("free", true), { available: false, entitled: false, configured: true, monthlyMinutes: 0 });
});

test("gates paid access on deployment readiness and exposes plan allowances", () => {
  assert.deepEqual(cloudBrowserAccess("pro", false), { available: false, entitled: true, configured: false, monthlyMinutes: 60 });
  assert.deepEqual(cloudBrowserAccess("team", true), { available: true, entitled: true, configured: true, monthlyMinutes: 300 });
});

test("keeps the operator unrestricted without pretending it has a minute cap", () => {
  assert.deepEqual(cloudBrowserAccess("operator", true, true), { available: true, entitled: true, configured: true, monthlyMinutes: null });
});

test("hosted browsing is never 'configured' without an executor to run it (SEC-10)", async () => {
  const { hostedBrowserConfigured } = await import("../app/api/computer/browser-plan.mjs");
  assert.equal(hostedBrowserConfigured({ ATLAS_CLOUDFLARE_BROWSER_ENABLED: "true" }), false, "the flag alone queues work nothing consumes");
  assert.equal(hostedBrowserConfigured({ ATLAS_CLOUDFLARE_BROWSER_ENABLED: "true" }, true), true);
  assert.equal(hostedBrowserConfigured({}, true), false);
});
