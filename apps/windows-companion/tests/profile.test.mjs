import assert from "node:assert/strict";
import test from "node:test";
import { parseLocalProfile, profileForPrompt } from "../src/profile.mjs";

test("accepts bounded user facts for local reuse", () => {
  const profile = parseLocalProfile('{"identity":{"name":"Ada"},"skills":["TypeScript"]}');
  assert.equal(profile.identity.name, "Ada");
  assert.match(profileForPrompt(profile), /facts only/u);
});

test("rejects credentials and oversized profile values", () => {
  assert.throws(() => parseLocalProfile('{"password":"nope"}'), /not allowed/u);
  assert.throws(() => parseLocalProfile(JSON.stringify({ bio: "x".repeat(4001) })), /too long/u);
});
