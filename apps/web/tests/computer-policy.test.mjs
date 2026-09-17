import assert from "node:assert/strict";
import test from "node:test";
import { computerExecutionPolicy, normalizeComputerWorkflow } from "../app/api/computer/computer-policy.mjs";

test("normalizes unknown computer workflows to custom", () => {
  assert.equal(normalizeComputerWorkflow("job-application"), "job-application");
  assert.equal(normalizeComputerWorkflow("unknown"), "custom");
});

test("requires approval for externally visible workflow actions", () => {
  const jobs = computerExecutionPolicy("job-application");
  const outreach = computerExecutionPolicy("sales-outreach");
  assert.ok(jobs.alwaysApprove.includes("submit_job_application"));
  assert.ok(outreach.alwaysApprove.includes("send_sales_outreach"));
  assert.ok(outreach.prohibited.includes("send_bulk_unsolicited_messages"));
  assert.equal(outreach.stopOnAmbiguity, true);
});
