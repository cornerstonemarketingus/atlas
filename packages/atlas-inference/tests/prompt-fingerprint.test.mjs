import assert from "node:assert/strict";
import test from "node:test";
import { cacheReport, canonicalJson, prefixChanges, promptFingerprint, usageFrom, withCachedTokens } from "../src/index.mjs";

const tools = [{ type: "function", function: { name: "read_web_page", parameters: { type: "object", properties: { url: { type: "string" } } } } }];
const system = { role: "system", content: "You are Atlas." };

test("canonical JSON: key order does not change the bytes", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }), canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }));
});

test("rounds of one task share a prefix hash; only the dynamic part grows", async () => {
  const round1 = await promptFingerprint({ model: "m", tools, messages: [system, { role: "user", content: "hi" }] });
  const round2 = await promptFingerprint({ model: "m", tools, messages: [system, { role: "user", content: "hi" }, { role: "assistant", content: null, tool_calls: [] }, { role: "tool", content: "x".repeat(3000) }] });
  assert.equal(round1.prefixHash, round2.prefixHash);
  assert.equal(round1.prefixTokens, round2.prefixTokens);
  assert.ok(round2.dynamicTokens > round1.dynamicTokens);
  assert.match(round1.prefixHash, /^[0-9a-f]{64}$/u);
  assert.equal(round1.cachedTokens, null);
});

test("reordering tool schema keys keeps the hash; changing the system prompt or tools does not", async () => {
  const base = await promptFingerprint({ model: "m", tools, messages: [system] });
  const reordered = await promptFingerprint({ model: "m", tools: [{ function: { parameters: { properties: { url: { type: "string" } }, type: "object" }, name: "read_web_page" }, type: "function" }], messages: [system] });
  assert.equal(base.prefixHash, reordered.prefixHash);
  assert.notEqual(base.prefixHash, (await promptFingerprint({ model: "m", tools, messages: [{ role: "system", content: "You are Atlas. Today is Monday." }] })).prefixHash);
  assert.notEqual(base.prefixHash, (await promptFingerprint({ model: "m", tools: [], messages: [system] })).prefixHash);
});

test("a prefix rewritten mid-task is caught; a model change is not a rewrite", async () => {
  const a = await promptFingerprint({ model: "m", tools, messages: [system, { role: "user", content: "1" }] });
  const b = await promptFingerprint({ model: "m", tools, messages: [system, { role: "user", content: "2" }] });
  const rewritten = await promptFingerprint({ model: "m", tools, messages: [{ role: "system", content: "You are Atlas (round 3)." }, { role: "user", content: "3" }] });
  const other = await promptFingerprint({ model: "fallback", tools, messages: [system] });
  assert.deepEqual(prefixChanges([a, b, other, rewritten]), [{ round: 3, model: "m" }]);
  assert.deepEqual(prefixChanges([a, b, other]), []);
});

test("the cache report uses the provider's cached tokens and never counts unreported calls as misses", async () => {
  const fingerprint = await promptFingerprint({ model: "m", tools, messages: [system, { role: "user", content: "q" }] });
  const calls = [
    withCachedTokens(fingerprint, usageFrom({ usage: { prompt_tokens: 4000, prompt_tokens_details: { cached_tokens: 0 } } })),
    withCachedTokens(fingerprint, usageFrom({ usage: { prompt_tokens: 4200, prompt_tokens_details: { cached_tokens: 3600 } } })),
    withCachedTokens(fingerprint, usageFrom({ usage: { prompt_tokens: 4400 } })),
  ];
  const report = cacheReport(calls);
  assert.equal(report.calls, 3);
  assert.equal(report.reportedCalls, 2);
  assert.equal(report.distinctPrefixes, 1);
  assert.equal(report.cacheHitRatio, 3600 / 8200);
  assert.equal(cacheReport([]).cacheHitRatio, null);
});
