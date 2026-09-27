import assert from "node:assert/strict";
import test from "node:test";
import { parseDurationMs, retryAfterHeaderMs, suggestedWaitFromMessage } from "../src/infrastructure/rate-limit-timing.js";

test("parses the Go durations Groq reports", () => {
  assert.equal(parseDurationMs("7.66s"), 7_660);
  assert.equal(parseDurationMs("340ms"), 340);
  assert.equal(parseDurationMs("2m59.56s"), 179_560);
  assert.equal(parseDurationMs("1h2m3s"), 3_723_000);
  assert.equal(parseDurationMs("1.5us"), 1);
  assert.equal(parseDurationMs(""), undefined);
  assert.equal(parseDurationMs("soon"), undefined);
  assert.equal(parseDurationMs("12"), undefined);
});

test("finds the suggested wait in an error message", () => {
  assert.equal(suggestedWaitFromMessage("Please try again in 21.645s."), 21_645);
  assert.equal(suggestedWaitFromMessage("on tokens per day (TPD): Limit 100000. Please try again in 7m12.5s. Need more tokens?"), 432_500);
  assert.equal(suggestedWaitFromMessage("rate limited"), undefined);
});

test("reads retry-after in seconds only", () => {
  assert.equal(retryAfterHeaderMs(new Headers({ "retry-after": "3" })), 3_000);
  assert.equal(retryAfterHeaderMs(new Headers({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" })), undefined);
  assert.equal(retryAfterHeaderMs(new Headers()), undefined);
});
