import assert from "node:assert/strict";
import test from "node:test";
import { decideMergeAction } from "./merge-decision.mjs";

test("manual policy always holds, regardless of checks", () => {
  assert.equal(decideMergeAction("manual", []), "hold");
  assert.equal(decideMergeAction("manual", [{ status: "completed", conclusion: "success" }]), "hold");
});

test("legacy none policy still requires passing CI", () => {
  assert.equal(decideMergeAction("none", []), "wait");
  assert.equal(decideMergeAction("none", [{ status: "completed", conclusion: "failure" }]), "hold");
  assert.equal(decideMergeAction("none", [{ status: "completed", conclusion: "success" }]), "merge-now");
});

test("all-skipped checks do not establish a CI pass", () => {
  assert.equal(decideMergeAction("ci-gated", [{ status: "completed", conclusion: "skipped" }]), "hold");
});

test("an unrecognized policy is treated as hold, not a silent merge", () => {
  assert.equal(decideMergeAction("some-future-policy", [{ status: "completed", conclusion: "success" }]), "hold");
});

test("ci-gated with no checks reported yet keeps waiting rather than assuming green", () => {
  assert.equal(decideMergeAction("ci-gated", []), "wait");
});

test("ci-gated waits while any check is still queued or in progress", () => {
  assert.equal(decideMergeAction("ci-gated", [{ status: "completed", conclusion: "success" }, { status: "in_progress", conclusion: null }]), "wait");
  assert.equal(decideMergeAction("ci-gated", [{ status: "queued", conclusion: null }]), "wait");
});

test("ci-gated merges once every reported check completed successfully", () => {
  assert.equal(decideMergeAction("ci-gated", [{ status: "completed", conclusion: "success" }]), "merge-now");
  assert.equal(
    decideMergeAction("ci-gated", [
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "neutral" },
      { status: "completed", conclusion: "skipped" },
    ]),
    "merge-now",
  );
});

test("ci-gated holds if any completed check failed, even if others passed", () => {
  assert.equal(
    decideMergeAction("ci-gated", [
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "failure" },
    ]),
    "hold",
  );
  for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "stale"]) {
    assert.equal(decideMergeAction("ci-gated", [{ status: "completed", conclusion }]), "hold");
  }
});

test("ci-gated holds on an unrecognized completed conclusion rather than guessing", () => {
  assert.equal(decideMergeAction("ci-gated", [{ status: "completed", conclusion: "startup_failure" }]), "hold");
});

test("auto-merge accepts canonical verified and legacy passed receipts, requiring a pass (SEC-7)", async () => {
  const { autoMergeAllowed } = await import("./merge-decision.mjs");
  for (const policy of ["none", "ci-gated"]) {
    assert.equal(autoMergeAllowed(policy, { status: "verified" }).allowed, true);
    assert.equal(autoMergeAllowed(policy, { status: "passed" }).allowed, true);
    assert.equal(autoMergeAllowed(policy, { status: "regressed", newFailures: ["a", "b"], message: "Tests broke." }).allowed, false);
    assert.match(autoMergeAllowed(policy, { status: "regressed", newFailures: ["a", "b"], message: "Tests broke." }).reason, /2 failure\(s\).*Tests broke/u);
    assert.equal(autoMergeAllowed(policy, { status: "inconclusive" }).allowed, false);
    assert.equal(autoMergeAllowed(policy, null).allowed, false, "no verification is not a pass");
  }
  assert.equal(autoMergeAllowed("manual", { status: "passed" }).allowed, false);
});
