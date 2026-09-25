import assert from "node:assert/strict";
import test from "node:test";
import { isDraftPullRequest } from "./pull-request-policy.mjs";

test("manual coder proposals are drafts for human review", () => {
  assert.equal(isDraftPullRequest("manual"), true);
});

test("automatic merge policies keep pull requests active", () => {
  assert.equal(isDraftPullRequest("ci-gated"), false);
  assert.equal(isDraftPullRequest("none"), false);
});