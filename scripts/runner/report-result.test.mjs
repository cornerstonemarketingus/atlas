import test from "node:test";
import assert from "node:assert/strict";
import { renderResult, deliverResult } from "./report-result.mjs";

test("inspection returns useful bounded findings without claiming a generated plan", () => {
  const text = renderResult({ inspection: { fileCount: 42, languages: [{ name: "TypeScript", fileCount: 30 }], frameworks: [], manifests: [{ path: "package.json" }] }, conclusion: "success" });
  assert.match(text, /Files scanned: 42/);
  assert.match(text, /TypeScript \(30\)/);
  assert.match(text, /no implementation plan/);
  assert.ok(text.length <= 16000);
});
test("debug failures and verified coder results remain distinct from job success", () => {
  const debug = renderResult({ debug: { steps: [{ label: "test", ok: false, exitCode: 1, stderr: "assertion failed" }] }, conclusion: "failure" });
  assert.match(debug, /test: failed; exit 1/);
  assert.match(debug, /assertion failed/);
  const code = renderResult({ code: { verification: { status: "regressed", newFailures: ["new failure"] }, edits: [{ path: "a.ts", operation: "update" }] }, status: { status: "completed", pull_request_url: "https://github.com/a/b/pull/1" }, conclusion: "success" });
  assert.match(code, /regressed/);
  assert.match(code, /new failure/);
  assert.match(code, /pull\/1/);
});
test("delivery retries server errors with the same body and fails visibly on rejection", async () => {
  const calls = [];
  await deliverResult({ endpoint: "https://example.test/result", token: "test", payload: { taskId: "one", summary: "result" } }, async (_, init) => { calls.push(init.body); return new Response(null, { status: calls.length === 1 ? 503 : 200 }); });
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1]);
  await assert.rejects(deliverResult({ endpoint: "https://example.test", token: "test", payload: {} }, async () => new Response(null, { status: 403 })), /403/);
});
