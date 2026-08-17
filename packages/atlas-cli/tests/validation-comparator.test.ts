import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compareValidationSnapshots,
  fingerprintValidationDiagnostic,
  InvalidValidationSnapshotError,
} from "../src/domain/validation-comparator.js";
import type { ValidationDiagnostic, ValidationObservation, ValidationSnapshot } from "../src/domain/validation-result.js";

const command = { executable: "npm", argumentCount: 1, workingDirectory: "repo", exitCode: 1, elapsedMilliseconds: 10 };
const diagnostic = (message: string): ValidationDiagnostic => ({ severity: "error", message, path: "src/a.ts", line: 2 });
const observation = (
  attempt: number,
  diagnostics: readonly ValidationDiagnostic[],
  outcome: ValidationObservation["outcome"] = diagnostics.length === 0 ? "passed" : "failed",
): ValidationObservation => ({ caseId: "tests", kind: "test", attempt, outcome, command, diagnostics });
const snapshot = (label: ValidationSnapshot["label"], observations: readonly ValidationObservation[]): ValidationSnapshot => ({ label, observations });

describe("validation snapshot comparison", () => {
  it("classifies fixed, new, and persistent validation failures", () => {
    const result = compareValidationSnapshots(
      snapshot("baseline", [observation(1, [diagnostic("fixed"), diagnostic("persistent")])]),
      snapshot("post-change", [observation(1, [diagnostic("new"), diagnostic("persistent")])]),
    );
    assert.deepEqual(result.summary, {
      fixed: 1, new: 1, persistent: 1, flakyOrInconclusive: 0,
      baselineInfrastructureFailures: 0, postChangeInfrastructureFailures: 0,
    });
    assert.equal(result.exitRecommendation, "reject");
  });

  it("distinguishes execution infrastructure failures and recommends a rerun", () => {
    const result = compareValidationSnapshots(
      snapshot("baseline", [observation(1, [diagnostic("old")])]),
      snapshot("post-change", [observation(1, [], "execution-failed")]),
    );
    assert.equal(result.summary.postChangeInfrastructureFailures, 1);
    assert.equal(result.summary.flakyOrInconclusive, 1);
    assert.equal(result.exitRecommendation, "rerun");
  });

  it("marks inconsistent repeated observations as flaky", () => {
    const result = compareValidationSnapshots(
      snapshot("baseline", [observation(1, []), observation(2, [])]),
      snapshot("post-change", [observation(1, [diagnostic("intermittent")]), observation(2, [])]),
    );
    assert.equal(result.diagnostics[0]?.classification, "flaky-or-inconclusive");
    assert.equal(result.exitRecommendation, "rerun");
  });

  it("accepts persistent existing failures when no regression is introduced", () => {
    const existing = diagnostic("existing failure");
    const result = compareValidationSnapshots(
      snapshot("baseline", [observation(1, [existing])]),
      snapshot("post-change", [observation(1, [existing])]),
    );
    assert.equal(result.summary.persistent, 1);
    assert.equal(result.exitRecommendation, "accept");
  });

  it("generates stable normalized fingerprints", () => {
    const first = fingerprintValidationDiagnostic({ caseId: "Tests", kind: "test" }, diagnostic("Type  mismatch"));
    const second = fingerprintValidationDiagnostic({ caseId: " tests ", kind: "test" }, diagnostic(" type mismatch "));
    assert.equal(first, second);
  });

  it("rejects duplicate attempts and configured bounds", () => {
    assert.throws(
      () => compareValidationSnapshots(
        snapshot("baseline", [observation(1, []), observation(1, [])]),
        snapshot("post-change", [observation(1, [])]),
      ),
      InvalidValidationSnapshotError,
    );
    assert.throws(
      () => compareValidationSnapshots(snapshot("baseline", [observation(1, [])]), snapshot("post-change", []), {
        maxObservationsPerSnapshot: 0, maxDiagnosticsPerObservation: 1, maxTextLength: 100,
      }),
      InvalidValidationSnapshotError,
    );
  });
});
