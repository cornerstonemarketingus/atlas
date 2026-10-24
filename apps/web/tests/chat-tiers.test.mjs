import assert from "node:assert/strict";
import test from "node:test";
import { normalizeChatTier, hasSuperAtlas, superAtlasAccess, resolveTierModel, atlasChoices } from "../app/api/chat/chat-tiers.mjs";
const bindings = { ai: { run() {} } };
test("only branded choices are accepted; legacy auto maps to basic", () => {
  for (const value of [undefined, "auto", "atlas"]) assert.equal(normalizeChatTier(value), "atlas");
  for (const value of ["openai", "configured", "workers-ai", "configured:premium", {}, null]) assert.equal(normalizeChatTier(value), null);
  assert.equal(normalizeChatTier("super-atlas"), "super-atlas");
});
test("only active paid subscriptions unlock Super Atlas", async () => {
  for (const tier of ["pro", "team"]) assert.equal(hasSuperAtlas({ tier, status: "active" }), true);
  for (const status of ["canceled", "past_due", "trialing", undefined]) assert.equal(hasSuperAtlas({ tier: "pro", status }), false);
  assert.equal(hasSuperAtlas({ tier: "free", status: "active" }), false);
  assert.equal(await superAtlasAccess({ dbUserId: null }, () => { throw Error(); }), false);
  assert.equal(await superAtlasAccess({ dbUserId: 1 }, () => { throw Error(); }), false);
  assert.equal(await superAtlasAccess({ dbUserId: 1 }, async () => ({ tier: "pro", status: "active" })), true);
});
test("basic Atlas uses the binding without keys and never escalates to paid providers", () => {
  const basic = resolveTierModel("atlas", { OPENAI_API_KEY: "secret", ATLAS_WORKERS_AI_MODEL: "premium" }, bindings);
  assert.equal(basic.model, "@cf/meta/llama-3.1-8b-instruct-fp8-fast");
  assert.equal(basic.apiKey, null);
  assert.equal(basic.fallbackModel, null);
  assert.equal(basic.providerFallback, undefined);
  assert.equal(resolveTierModel("atlas", { OPENAI_API_KEY: "secret" }).configured, false);
});
test("exactly two public choices, premium locked unless paid", () => {
  const choices = atlasChoices({}, bindings, false);
  assert.deepEqual(choices.map(x => x.label), ["Atlas", "Super Atlas"]);
  assert.equal(choices[1].locked, true);
  assert.equal(choices[1].available, false);
  assert.equal(atlasChoices({}, bindings, true)[1].available, true);
});
