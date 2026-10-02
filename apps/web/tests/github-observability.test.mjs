import assert from "node:assert/strict";
import test from "node:test";
import { fetchGitHubJson } from "../app/api/tasks/github-runs.mjs";

const request = { url: "https://api.github.com/repos/private/secret/actions/runs/42?token=PRIVATE_SENTINEL", init: { headers: { authorization: "Bearer PRIVATE_SENTINEL" } } };

test("the production GitHub read boundary emits one safe quota observation", async t => {
  const logs = [];
  t.mock.method(console, "info", value => logs.push(JSON.parse(value)));
  const result = await fetchGitHubJson(request, async () => Response.json({ private: "PRIVATE_SENTINEL" }, { headers: { "x-ratelimit-limit": "5000", "x-ratelimit-used": "1842", "x-ratelimit-remaining": "3158", "x-ratelimit-reset": "1790970000", "x-ratelimit-resource": "core" } }));
  assert.equal(result.private, "PRIVATE_SENTINEL");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].category, "actions");
  assert.equal(logs[0].outcome, "success");
  assert.deepEqual(logs[0].rateLimit, { resource: "core", limit: 5000, used: 1842, remaining: 3158, resetEpochSeconds: 1790970000, retryAfterMs: null });
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_SENTINEL|private|secret|Bearer|api.github.com/);
});

for (const [status, headers, expected] of [
  [403, { "x-ratelimit-remaining": "0" }, "primary_rate_limit"],
  [429, { "x-ratelimit-remaining": "0", "retry-after": "60" }, "primary_rate_limit"],
  [403, { "retry-after": "60" }, "secondary_rate_limit"],
  [429, { "retry-after": "60" }, "secondary_rate_limit"],
  [429, {}, "rate_limit_unknown"], [401, {}, "authentication"],
  [403, {}, "permission_or_secondary_limit"], [404, {}, "not_found"],
]) test(`GitHub ${status} is classified as ${expected} without retrying`, async () => {
  const events = []; let calls = 0;
  const result = await fetchGitHubJson(request, async () => { calls++; return new Response("PRIVATE_SENTINEL", { status, headers }); }, 8000, { observe: event => events.push(event) });
  assert.equal(result, null);
  assert.equal(calls, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, expected);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_SENTINEL/);
});

test("malformed quota headers and unknown resource names cannot leak into logs", async () => {
  const events = [];
  await fetchGitHubJson(request, async () => Response.json({}, { headers: { "x-ratelimit-resource": "PRIVATE_SENTINEL", "x-ratelimit-remaining": "PRIVATE_SENTINEL", "x-ratelimit-limit": "999999999999999999999", "retry-after": "PRIVATE_SENTINEL" } }), 8000, { observe: event => events.push(event) });
  assert.equal(events[0].rateLimit.resource, "other");
  assert.equal(events[0].rateLimit.remaining, null);
  assert.equal(events[0].rateLimit.limit, null);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_SENTINEL/);
});

test("observer failure does not alter a successful GitHub read", async () => {
  assert.deepEqual(await fetchGitHubJson(request, async () => Response.json({ ok: true }), 8000, { observe: () => { throw new Error("offline logging"); } }), { ok: true });
});

test("a negative retry-after is malformed, not a secondary-limit signal", async () => {
  const events = [];
  await fetchGitHubJson(request, async () => new Response(null, { status: 403, headers: { "retry-after": "-1" } }), 8000, { observe: event => events.push(event) });
  assert.equal(events[0].rateLimit.retryAfterMs, null);
  assert.equal(events[0].outcome, "permission_or_secondary_limit");
});

test("network failures are observed without recording exception text", async () => {
  const events = [];
  assert.equal(await fetchGitHubJson(request, async () => { throw new Error("PRIVATE_SENTINEL"); }, 8000, { observe: event => events.push(event) }), null);
  assert.equal(events[0].outcome, "network_failure");
  assert.equal(events[0].status, null);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_SENTINEL/);
});

for (const brokenStream of [false, true]) test(`HTTP 200 distinguishes body transfer failure from invalid JSON (brokenStream=${brokenStream})`, async () => {
  const events = [];
  const body = brokenStream ? new ReadableStream({ start(controller) { controller.error(new Error("PRIVATE_SENTINEL")); } }) : "PRIVATE_SENTINEL";
  const result = await fetchGitHubJson(request, async () => new Response(body, { status: 200 }), 8000, { observe: event => events.push(event) });
  assert.equal(result, null);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 200);
  assert.equal(events[0].outcome, brokenStream ? "network_failure" : "invalid_response");
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_SENTINEL/);
});

test("HTTP-date retry guidance and timeout are recorded at the actual request boundary", async () => {
  const events = [];
  const now = Date.parse("2026-10-02T20:00:00Z");
  await fetchGitHubJson(request, async () => new Response(null, { status: 429, headers: { "retry-after": "Fri, 02 Oct 2026 20:01:00 GMT" } }), 8000, { clock: () => now, observe: event => events.push(event) });
  assert.equal(events[0].rateLimit.retryAfterMs, 60000);
  assert.equal(events[0].outcome, "secondary_rate_limit");
  await fetchGitHubJson(request, (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("PRIVATE_SENTINEL")), { once: true });
  }), 5, { observe: event => events.push(event) });
  assert.equal(events[1].outcome, "timeout");
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_SENTINEL/);
});

for (const [path, category] of [["pulls/12/files", "pulls_issues"], ["contents/private.txt", "contents"], ["issues", "pulls_issues"]]) {
  test(`request category ${category} exposes no repository or path`, async () => {
    const events = [];
    await fetchGitHubJson({ ...request, url: `https://api.github.com/repos/PRIVATE_SENTINEL/PRIVATE_SENTINEL/${path}` }, async () => Response.json({}), 8000, { observe: event => events.push(event) });
    assert.equal(events[0].category, category);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_SENTINEL|private.txt/);
  });
}
