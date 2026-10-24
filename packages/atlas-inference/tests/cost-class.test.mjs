import assert from "node:assert/strict";
import test from "node:test";
import { COST, VENDORS, costClass, describeCosts } from "../src/index.mjs";

test("OpenAI and Anthropic are paid; free tiers and local servers are not", () => {
  assert.equal(costClass("openai"), COST.PAID);
  assert.equal(costClass("anthropic"), COST.PAID);
  for (const id of ["groq", "workers-ai", "cerebras", "gemini", "openrouter", "mistral"]) assert.equal(costClass(id), COST.FREE_TIER, id);
  for (const id of ["ollama", "local", "self-hosted"]) assert.equal(costClass(id), COST.LOCAL, id);
});

test("an unknown provider is never assumed free", () => {
  assert.equal(costClass("some-new-vendor"), COST.UNKNOWN);
  assert.equal(costClass("__proto__"), COST.UNKNOWN);
  assert.equal(costClass(undefined), COST.UNKNOWN);
});

test("every catalogued vendor has a known cost class", () => {
  for (const id of Object.keys(VENDORS)) assert.notEqual(costClass(id), COST.UNKNOWN, `${id} needs a cost class`);
});

test("describeCosts renders a route list for run logs", () => {
  assert.deepEqual(describeCosts(["workers-ai", "openai"]), ["workers-ai=free-tier", "openai=paid"]);
});
