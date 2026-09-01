import assert from "node:assert/strict";
import test from "node:test";
import { currentPeriodStart } from "../app/api/billing/period.mjs";

test("formats a period start with a zero-padded month", () => {
  assert.equal(currentPeriodStart(new Date(Date.UTC(2026, 8, 15))), "2026-09-01");
  assert.equal(currentPeriodStart(new Date(Date.UTC(2026, 0, 1))), "2026-01-01");
  assert.equal(currentPeriodStart(new Date(Date.UTC(2026, 11, 31))), "2026-12-01");
});
