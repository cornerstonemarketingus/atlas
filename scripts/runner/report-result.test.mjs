import test from "node:test";
import assert from "node:assert/strict";
import { renderResult, deliverResult, deliveryMessage, buildResultPayload, deliveryFailure, resultEndpoint, requestRunnerIdentity } from "./report-result.mjs";

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

test('an absent hosted task is not reported as successful result delivery', async () => {
  const request = { endpoint: 'https://example.test/result', token: 'test', payload: {} };
  const missing = await deliverResult(request, async () => new Response(null, { status: 404 }));
  const delivered = await deliverResult(request, async () => new Response(null, { status: 200 }));
  assert.deepEqual(missing, { delivered: false, reason: 'task-not-found' });
  assert.deepEqual(delivered, { delivered: true });
  assert.match(deliveryMessage(missing, 'task-id', null), /^Result was not delivered: no hosted task exists/);
  assert.match(deliveryMessage(delivered, 'task-id', null), /^Delivered result for task task-id/);
});

test("result payload carries a valid correlation id and omits a missing or forged one", async () => {
  const id = `cor_${"0f".repeat(16)}`;
  assert.deepEqual(buildResultPayload({ taskId: "one", summary: "result", correlationId: id }), { taskId: "one", summary: "result", correlationId: id });
  assert.deepEqual(buildResultPayload({ taskId: "one", summary: "result", correlationId: null }), { taskId: "one", summary: "result" });
  assert.deepEqual(buildResultPayload({ taskId: "one", summary: "result", correlationId: "cor_x\ninjected" }), { taskId: "one", summary: "result" });
  let sent;
  await deliverResult({ endpoint: "https://example.test/result", token: "test", payload: buildResultPayload({ taskId: "one", summary: "result", correlationId: id }) }, async (_, init) => { sent = JSON.parse(init.body); return new Response(null, { status: 200 }); });
  assert.equal(sent.correlationId, id);
});

async function callbackServer(t, handler) {
  const { createServer } = await import("node:http");
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}/result`;
}

test("real HTTP lost acknowledgement retries identical evidence without duplicate accepted results", { timeout: 5000 }, async (t) => {
  const bodies = [];
  const accepted = new Map();
  const endpoint = await callbackServer(t, async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    bodies.push(body);
    const result = JSON.parse(body);
    // Models the production receiver's stable task/run/attempt insert identity.
    // Its OIDC verification and D1 transaction are covered in the web suite.
    const id = `result:${result.taskId}:123:1`;
    if (!accepted.has(id)) accepted.set(id, result.summary);
    if (bodies.length === 1) response.destroy(); // committed; acknowledgement lost
    else response.writeHead(200).end();
  });
  const payload = { taskId: "one", summary: "Tests passed; artifact retained", correlationId: `cor_${"0f".repeat(16)}` };
  assert.deepEqual(await deliverResult({ endpoint, token: "fixture-token", payload }), { delivered: true });
  assert.deepEqual(bodies, [JSON.stringify(payload), JSON.stringify(payload)]);
  assert.equal(accepted.size, 1);
});

test("real HTTP connection resets exhaust a bounded retry budget with safe diagnostics", { timeout: 5000 }, async (t) => {
  let requests = 0;
  const endpoint = await callbackServer(t, async (request, response) => {
    for await (const _chunk of request) { /* consume the body before resetting */ }
    requests++;
    response.destroy();
  });
  await assert.rejects(deliverResult({ endpoint, token: "fixture-token", payload: { summary: "private evidence" } }), (error) => {
    assert.match(error.message, /Result delivery failed: transport unavailable after 3 attempts/);
    assert.doesNotMatch(error.message, /127\.0\.0\.1|fixture-token|private evidence/);
    return true;
  });
  assert.equal(requests, 3);
});

test("timeouts retry, but permanent HTTP rejections and configuration errors do not", async () => {
  const request = { endpoint: "https://example.test/result", token: "fixture-token", payload: {} };
  let attempts = 0;
  assert.deepEqual(await deliverResult(request, async () => {
    if (++attempts === 1) throw new DOMException("private provider diagnostic", "TimeoutError");
    return new Response(null, { status: 200 });
  }), { delivered: true });
  assert.equal(attempts, 2);
  for (const status of [400, 401, 403, 409, 429]) {
    attempts = 0;
    await assert.rejects(deliverResult(request, async () => {
      attempts++;
      return new Response("private provider diagnostic", { status });
    }), new RegExp(`HTTP ${status}`));
    assert.equal(attempts, 1);
  }
  attempts = 0;
  await assert.rejects(deliverResult(request, async () => {
    attempts++;
    throw new TypeError("private configuration diagnostic");
  }), /^ResultDeliveryError: Result delivery failed: request could not be sent\.$/);
  assert.equal(attempts, 1);
});

test("real HTTP redirects remain forbidden and credentials never reach the destination", { timeout: 5000 }, async (t) => {
  let destinationRequests = 0;
  const destination = await callbackServer(t, (_request, response) => {
    destinationRequests++;
    response.writeHead(200).end();
  });
  let redirects = 0;
  const endpoint = await callbackServer(t, (_request, response) => {
    redirects++;
    response.writeHead(307, { location: destination }).end();
  });
  await assert.rejects(deliverResult({ endpoint, token: "fixture-token", payload: {} }), /^ResultDeliveryError: Result delivery failed: request could not be sent\.$/);
  assert.equal(redirects, 1);
  assert.equal(destinationRequests, 0);
});

test("retry snapshots the payload once and bounds HTTP server failures", async () => {
  const payload = { taskId: "one", summary: "original evidence" };
  const bodies = [];
  let firstSignal;
  await assert.rejects(deliverResult({ endpoint: "https://example.test/result", token: "fixture-token", payload }, async (_url, init) => {
    bodies.push(init.body);
    assert.equal(init.redirect, "error");
    if (firstSignal) assert.notEqual(init.signal, firstSignal);
    else firstSignal = init.signal;
    payload.summary = "changed while awaiting acknowledgement";
    return new Response(null, { status: 503 });
  }), /HTTP 503/);
  assert.deepEqual(bodies, Array(3).fill(JSON.stringify({ taskId: "one", summary: "original evidence" })));
});

test("callback diagnostics distinguish credential deployment, task ownership and storage without reflecting bodies", async () => {
  const request = { endpoint: "https://example.test/result?private=hidden", token: "private-token", payload: { summary: "private-summary" } };
  for (const [status, code, expected] of [
    [401, "RUNNER_AUTHENTICATION_REQUIRED", /id-token: write/],
    [503, "GITHUB_VERIFICATION_CREDENTIAL_MISSING", /deploy ATLAS_GITHUB_TOKEN/],
    [409, "RESULT_OWNERSHIP_MISMATCH", /execution claim/],
    [503, "RESULT_STORAGE_UNAVAILABLE", /D1/],
  ]) {
    await assert.rejects(deliverResult(request, async () => new Response("private-upstream-token", {
      status, headers: { "x-atlas-result-error": code },
    })), error => {
      const diagnostic = deliveryFailure(error);
      assert.equal(diagnostic.stage, "callback");
      assert.equal(diagnostic.httpStatus, status);
      assert.equal(diagnostic.code, code);
      assert.match(diagnostic.message, expected);
      assert.doesNotMatch(JSON.stringify(diagnostic), /private|hidden|example\.test/);
      return true;
    });
  }
  await assert.rejects(deliverResult(request, async () => new Response("private-body", {
    status: 403, headers: { "x-atlas-result-error": "private-injected-header" },
  })), error => {
    assert.equal(deliveryFailure(error).code, "CALLBACK_HTTP_403");
    assert.doesNotMatch(JSON.stringify(deliveryFailure(error)), /private/);
    return true;
  });
  assert.doesNotMatch(JSON.stringify(deliveryFailure(new Error("private-secret"))), /private-secret/);
});

test("OIDC uses the Worker audience, rejects redirects and validates the returned identity", async () => {
  const env = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://identity.actions.githubusercontent.com/token?existing=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "private-request-token" };
  const token = await requestRunnerIdentity(env, async (url, init) => {
    assert.equal(url.searchParams.get("audience"), "atlas-runner-results");
    assert.equal(url.searchParams.get("existing"), "1");
    assert.equal(init.headers.authorization, "Bearer private-request-token");
    assert.equal(init.redirect, "error");
    return Response.json({ value: "signed-identity" });
  });
  assert.equal(token, "signed-identity");
  await assert.rejects(requestRunnerIdentity({}, () => assert.fail("identity unavailable must fail before a request")), error => deliveryFailure(error).code === "OIDC_UNAVAILABLE");
  for (const response of [Response.json({ value: "" }), new Response("private-invalid-json")]) {
    await assert.rejects(requestRunnerIdentity(env, async () => response), error => {
      assert.equal(deliveryFailure(error).code, "OIDC_INVALID_RESPONSE");
      assert.doesNotMatch(JSON.stringify(deliveryFailure(error)), /private/);
      return true;
    });
  }
  await assert.rejects(requestRunnerIdentity(env, async () => new Response("private-rejection", { status: 403 })), error => {
    assert.equal(deliveryFailure(error).code, "OIDC_REJECTED");
    assert.equal(deliveryFailure(error).httpStatus, 403);
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  await assert.rejects(requestRunnerIdentity(env, async () => { throw new Error("private-url-or-token"); }), error => {
    assert.equal(deliveryFailure(error).code, "OIDC_REQUEST_FAILED");
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
});

test("result endpoint configuration is diagnosed without leaking embedded credentials", () => {
  assert.equal(resultEndpoint(""), "https://atlas-web.cornerstonemarketingus.workers.dev/api/tasks/result");
  assert.equal(resultEndpoint("https://atlas.example/api/tasks/result"), "https://atlas.example/api/tasks/result");
  for (const value of ["http://atlas.example/result", "https://user:private@atlas.example/result", "private-not-a-url", "https://atlas.example/result#private"]) {
    assert.throws(() => resultEndpoint(value), error => {
      const diagnostic = deliveryFailure(error);
      assert.equal(diagnostic.stage, "configuration");
      assert.equal(diagnostic.code, "INVALID_RESULT_ENDPOINT");
      assert.doesNotMatch(diagnostic.message, /private|user:|atlas\.example/);
      return true;
    });
  }
});

test("report CLI retains a safe diagnostic and Actions summary when reporting setup fails", async t => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const directory = mkdtempSync(path.join(tmpdir(), "atlas-result-delivery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const summary = path.join(directory, "summary.md");
  const script = new URL("./report-result.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname], {
    cwd: directory,
    env: { ...process.env, ATLAS_TASK_ID: "2cb4e27b-536c-476b-93a2-8db3f3a3ba72", ATLAS_OUTPUT_DIR: directory, GITHUB_STEP_SUMMARY: summary, ATLAS_RESULT_URL: "https://user:private@atlas.example/result", ACTIONS_ID_TOKEN_REQUEST_URL: "", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "private-token" },
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 1);
  const receipt = JSON.parse(readFileSync(path.join(directory, "delivery.json"), "utf8"));
  assert.equal(receipt.code, "INVALID_RESULT_ENDPOINT");
  assert.equal(receipt.delivered, false);
  assert.match(readFileSync(summary, "utf8"), /Atlas result delivery/);
  assert.doesNotMatch(`${result.stderr}${JSON.stringify(receipt)}${readFileSync(summary, "utf8")}`, /private|user:|atlas\.example/);
});

test("coder report workflow delivers failures even when the scanner build fails and retains receipts", async () => {
  const { readFileSync } = await import("node:fs");
  const workflow = readFileSync(new URL("../../.github/workflows/atlas-coder.yml", import.meta.url), "utf8");
  assert.match(workflow, /- name: Deliver redacted findings\n\s+if: always\(\)/);
  assert.match(workflow, /- name: Download result data\n\s+if: always\(\)/);
  assert.match(workflow, /path: atlas-output\/delivery\.json/);
  assert.match(workflow, /id-token: write/);
});


test("deadline reporting describes retained checkpoint and recovery without claiming completed work", () => {
  const text = renderResult({
    conclusion: "failure", status: { status: "failed", message: "Execution deadline reached." },
    progress: { phase: "agent", turns: 3, toolCalls: 4, inputTokens: 900, outputTokens: 50, edits: [{ path: "src/example.ts", operation: "update" }] },
    recovery: { baseCommit: "a".repeat(40), trackedDiff: "private-diff-not-for-summary", untracked: [{ path: "private-path", content: "private-content" }] },
  });
  assert.match(text, /Model turns.*3/);
  assert.match(text, /Progress checkpoint saved at phase 'agent'/);
  assert.match(text, /recovery\.json/);
  assert.match(text, /does not confirm task completion/);
  assert.doesNotMatch(text, /private-diff|private-path|private-content|✅ completed/);
});


test("a claimed hosted task with a missing callback dispatch fails reporting and retains its receipt", async t => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const directory = mkdtempSync(path.join(tmpdir(), "atlas-result-missing-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stub = `globalThis.fetch = async url => String(url).includes("identity.actions") ? Response.json({value:"private-oidc-token"}) : new Response("private-upstream-body", {status:404});`;
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(stub)}`, new URL("./report-result.mjs", import.meta.url).pathname], {
    cwd: directory,
    env: { ...process.env, ATLAS_TASK_ID: "2cb4e27b-536c-476b-93a2-8db3f3a3ba72", ATLAS_CLAIM_GRANTED: "true", ATLAS_OUTPUT_DIR: directory, ATLAS_RESULT_URL: "https://worker.example/api/tasks/result", ACTIONS_ID_TOKEN_REQUEST_URL: "https://identity.actions.githubusercontent.com/token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "private-request-token" },
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 1);
  const receipt = JSON.parse(readFileSync(path.join(directory, "delivery.json"), "utf8"));
  assert.equal(receipt.delivered, false);
  assert.equal(receipt.code, "DISPATCH_NOT_FOUND");
  assert.doesNotMatch(`${result.stdout}${result.stderr}${JSON.stringify(receipt)}`, /private/);
});
