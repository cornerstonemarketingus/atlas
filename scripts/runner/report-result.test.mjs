import test from "node:test";
import assert from "node:assert/strict";
import { renderResult, deliverResult, deliveryMessage, buildResultPayload } from "./report-result.mjs";

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
  }), /^Error: Result delivery failed: request could not be sent\.$/);
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
  await assert.rejects(deliverResult({ endpoint, token: "fixture-token", payload: {} }), /^Error: Result delivery failed: request could not be sent\.$/);
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