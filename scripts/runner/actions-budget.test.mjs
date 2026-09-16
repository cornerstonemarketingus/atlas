import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ESTIMATED_RUN_MINUTES,
  DEFAULT_RESERVE_MINUTES,
  evaluateActionsBudget,
} from "./actions-budget.mjs";

test("allows a run with plenty of allowance left", () => {
  const verdict = evaluateActionsBudget({ includedMinutes: 2_000, usedMinutes: 100 });
  assert.equal(verdict.decision, "allow");
  assert.equal(verdict.remaining, 1_900);
});

test("blocks a run that would eat into the reserve kept for CI", () => {
  // 2000 included, 1650 used -> 350 left. A 120-minute run leaves 230,
  // under the 300 reserve, so ordinary CI would start failing to run.
  const verdict = evaluateActionsBudget({ includedMinutes: 2_000, usedMinutes: 1_650 });
  assert.equal(verdict.decision, "block");
  assert.match(verdict.reason, /300-minute reserve/u);
});

test("blocks when the allowance is already spent", () => {
  const verdict = evaluateActionsBudget({ includedMinutes: 2_000, usedMinutes: 2_400 });
  assert.equal(verdict.decision, "block");
  assert.equal(verdict.remaining, 0, "overage must not read as negative headroom");
});

test("treats the boundary as allowed, not blocked", () => {
  // Exactly enough: remaining - run == reserve. Blocking here would be off by
  // one against the operator for no reason.
  const verdict = evaluateActionsBudget({
    includedMinutes: 2_000,
    usedMinutes: 2_000 - (DEFAULT_ESTIMATED_RUN_MINUTES + DEFAULT_RESERVE_MINUTES),
  });
  assert.equal(verdict.decision, "allow");
});

test("allows freely when no metered allowance applies", () => {
  // Public repositories and some paid plans report zero included minutes.
  // Reading that as "no budget left" would block every run forever.
  const verdict = evaluateActionsBudget({ includedMinutes: 0, usedMinutes: 50_000 });
  assert.equal(verdict.decision, "allow");
  assert.match(verdict.reason, /No metered Actions allowance/u);
});

test("reports unknown rather than guessing when usage is unreadable", () => {
  for (const input of [{}, { includedMinutes: 2_000 }, { usedMinutes: 10 }, { includedMinutes: NaN, usedMinutes: 10 }]) {
    assert.equal(evaluateActionsBudget(input).decision, "unknown", JSON.stringify(input));
  }
});

test("honours a custom run estimate and reserve", () => {
  // A hosted-API run is minutes, not hours, so the same headroom that blocks
  // a CPU run should comfortably allow a short one.
  const headroom = { includedMinutes: 2_000, usedMinutes: 1_650 };
  assert.equal(evaluateActionsBudget({ ...headroom, estimatedRunMinutes: 3, reserveMinutes: 300 }).decision, "allow");
  assert.equal(evaluateActionsBudget({ ...headroom, estimatedRunMinutes: 3, reserveMinutes: 349 }).decision, "block");
});

test("states the numbers it decided on, not just the verdict", () => {
  // An operator who disagrees has to be able to check the arithmetic without
  // reading the source.
  const verdict = evaluateActionsBudget({ includedMinutes: 2_000, usedMinutes: 1_900 });
  assert.match(verdict.reason, /1900 of 2000 minutes used/u);
  assert.match(verdict.reason, /100 remaining/u);
  assert.match(verdict.reason, /about 120/u);
});
