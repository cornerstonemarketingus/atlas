import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requestExecutionClaim, checkExecutionLease, executionClaimPayload, enforceHostedExecutionLease } from "./claim-execution.mjs";

const env = { ATLAS_TASK_ID: "11111111-1111-4111-8111-111111111111", ATLAS_REPOSITORY: "cornerstonemarketingus/atlas", ATLAS_BRANCH: "feature", ATLAS_MODE: "coder", ATLAS_OBJECTIVE: "Fix package.json", ATLAS_MERGE_POLICY: "manual", ATLAS_CORRELATION_ID: `cor_${"a".repeat(32)}`, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", ACTIONS_ID_TOKEN_REQUEST_URL: "https://identity.test/token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-identity-secret", ATLAS_CLAIM_URL: "https://atlas.test/api/tasks/claim" };
const grant = () => ({ granted: true, taskId: env.ATLAS_TASK_ID, runId: 123, runAttempt: 1, expiresAt: new Date(Date.now() + 6 * 3600000).toISOString() });

test("execution refuses absent, expired, malformed or insufficient leases before any tool action", () => {
  const valid = { ...env, ATLAS_CLAIM_GRANTED: "true", ATLAS_CLAIM_EXPIRES_AT: grant().expiresAt, ATLAS_JOB_TIMEOUT_MINUTES: "330", ATLAS_CLAIM_RUN_ID: "123", ATLAS_CLAIM_RUN_ATTEMPT: "1" };
  assert.equal(checkExecutionLease(valid), true);
  for (const change of [{ ATLAS_CLAIM_GRANTED: "false" }, { GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_RUN_ID: "124" }, { ATLAS_CLAIM_EXPIRES_AT: "2000-01-01T00:00:00.000Z" }, { ATLAS_CLAIM_EXPIRES_AT: "2026-99-99T00:00:00.000Z" }, { ATLAS_JOB_TIMEOUT_MINUTES: "331" }, { ATLAS_CLAIM_EXPIRES_AT: new Date(Date.now() + 329 * 60000).toISOString() }]) {
    let actions = 0;
    assert.throws(() => { checkExecutionLease({ ...valid, ...change }); actions++; });
    assert.equal(actions, 0);
  }
});

test("the real task entry blocks cached hosted workflows before git, files or coding, while local entry remains supported", () => {
  assert.equal(enforceHostedExecutionLease({ GITHUB_ACTIONS: "false" }), true);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./run-task.mjs", import.meta.url))], {
    encoding: "utf8", timeout: 5000, windowsHide: true,
    env: { ...process.env, ...env, GITHUB_ACTIONS: "true", GITHUB_WORKFLOW: "Atlas Coder", ATLAS_CLAIM_GRANTED: "", ATLAS_OUTPUT_DIR: "" },
  });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /Execution claim does not cover/);
  assert.doesNotMatch(child.stderr, /ATLAS_OUTPUT_DIR is required|Unable to identify/);
  assert.doesNotMatch(child.stdout, /starting/);
});

test("claim identity and payload travel only over bounded HTTPS calls, with no identity token forwarded as output", async () => {
  const observed = [];
  const result = await requestExecutionClaim(env, async (url, options) => {
    observed.push({ url: String(url), options });
    return String(url).startsWith("https://identity.test") ? Response.json({ value: "fixture-oidc" }) : Response.json(grant());
  });
  assert.equal(result.granted, true); assert.equal(observed.length, 2);
  assert.match(observed[0].url, /audience=atlas-task-execution/);
  assert.equal(observed[0].options.headers.authorization, "Bearer fixture-identity-secret");
  assert.equal(observed[1].options.headers.authorization, "Bearer fixture-oidc");
  assert.deepEqual(JSON.parse(observed[1].options.body), executionClaimPayload(env));
  assert.doesNotMatch(JSON.stringify(result), /fixture-/);
  for (const request of observed) { assert.equal(request.options.redirect, "error"); assert.ok(request.options.signal); }
});

test("a real HTTP lost acknowledgement retries the same claim without issuing another ownership slot", { timeout: 5000 }, async t => {
  const slots = new Map(); const bodies = [];
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk; bodies.push(text);
    const payload = JSON.parse(text);
    if (!slots.has(payload.taskId)) slots.set(payload.taskId, grant());
    if (bodies.length === 1) response.destroy();
    else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(slots.get(payload.taskId)));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const result = await requestExecutionClaim(env, (url, options) => String(url).startsWith("https://identity.test")
    ? Promise.resolve(Response.json({ value: "fixture-oidc" })) : fetch(`http://127.0.0.1:${server.address().port}/claim`, options));
  assert.equal(result.granted, true); assert.equal(slots.size, 1); assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
});

test("explicit refusal is not retried and transient errors have a strict attempt ceiling", async () => {
  for (const [status, expected] of [[409, 1], [401, 1], [503, 3]]) {
    let claims = 0;
    await assert.rejects(requestExecutionClaim(env, async url => {
      if (String(url).startsWith("https://identity.test")) return Response.json({ value: "fixture-oidc" });
      claims++; return new Response("private-provider-text", { status });
    }), /Execution claim refused or unavailable/);
    assert.equal(claims, expected);
  }
  await assert.rejects(requestExecutionClaim({ ...env, ATLAS_CLAIM_URL: "http://untrusted.test/api/tasks/claim" }, () => assert.fail("no credentials sent")));
  await assert.rejects(requestExecutionClaim({ ...env, ATLAS_TASK_ID: "manual-task" }, () => assert.fail("no unmanaged execution")));
});

test("mismatched, expired or injected grant metadata cannot authorize execution", async () => {
  for (const change of [{ runId: 124 }, { runAttempt: 2 }, { granted: false }, { expiresAt: "2026-99-99T00:00:00.000Z" }, { expiresAt: `${grant().expiresAt}\ngranted=true` }]) {
    await assert.rejects(requestExecutionClaim(env, async url => String(url).startsWith("https://identity.test") ? Response.json({ value: "fixture-oidc" }) : Response.json({ ...grant(), ...change })), /acknowledgement invalid/);
  }
});

test("hosted workflow gates both execution and reporting while withholding OIDC from workload jobs", () => {
  for (const workflow of ["atlas-coder.yml", "atlas-runner.yml"]) {
    const text = fs.readFileSync(new URL(`../../.github/workflows/${workflow}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
    const claim = text.split("\n  claim:\n")[1].split("\n  run:\n")[0];
    const execution = text.split("\n  run:\n")[1].split("\n  report:\n")[0];
    const report = text.split("\n  report:\n")[1];
    assert.match(claim, /id-token: write/); assert.match(claim, /ref: main/); assert.doesNotMatch(claim, /npm ci|path: target|Start a self-hosted/);
    assert.match(execution, /needs: claim/); assert.match(execution, /needs\.claim\.outputs\.granted == 'true'/); assert.match(execution, /id-token: none/);
    assert.match(execution, /needs\.claim\.outputs\.run_attempt == github\.run_attempt/);
    assert.match(execution, /ATLAS_CLAIM_RUN_ATTEMPT:/);
    const guard = execution.indexOf("node scripts/runner/claim-execution.mjs check");
    assert.ok(guard >= 0 && guard < execution.indexOf("Build trusted Atlas CLI") && guard < execution.indexOf("Check out requested branch"));
    assert.match(report, /needs: \[claim, run\]/); assert.match(report, /needs\.claim\.outputs\.granted == 'true'/);
  }
});
