import assert from "node:assert/strict";
import test from "node:test";
import { resolveCoderRoutes } from "./coder-routes.mjs";
const environment = { GROQ_API_KEY: "groq", OPENAI_API_KEY: "openai", ATLAS_WORKERS_AI_TOKEN: "cloud", CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) };
test("automatic cloud coder prefers configured Workers AI and includes independent providers", () => {
  const plan = resolveCoderRoutes(environment);
  assert.equal(plan.provider, "workers-ai"); assert.equal(plan.apiKeyVariable, "ATLAS_WORKERS_AI_TOKEN");
  assert.deepEqual(plan.fallbacks, ["openai:gpt-5.4-mini:OPENAI_API_KEY", "groq:openai/gpt-oss-120b:GROQ_API_KEY"]);
  assert.doesNotMatch(JSON.stringify(plan), /Bearer/);
});
test("explicit Groq gains available cross-vendor fallbacks without changing the selected primary", () => {
  const plan = resolveCoderRoutes({ ...environment, ATLAS_CODER_PROVIDER: "groq", ATLAS_CODER_FALLBACKS: "groq:openai/gpt-oss-20b:GROQ_API_KEY" });
  assert.equal(plan.provider, "groq"); assert.equal(plan.fallbacks.length, 3); assert.match(plan.fallbacks[1], /^workers-ai:/); assert.match(plan.fallbacks[2], /^openai:/);
});
test("private endpoints and explicit none never gain public cloud fallbacks", () => {
  assert.deepEqual(resolveCoderRoutes({ ...environment, ATLAS_CODER_BASE_URL: "https://private.example/v1" }).fallbacks, []);
  assert.deepEqual(resolveCoderRoutes({ ...environment, ATLAS_CODER_FALLBACKS: "none" }).fallbacks, []);
});
test("provider credential names cannot be crossed or unknown routes accepted", () => {
  for (const route of ["openai:fixture:GROQ_API_KEY", "workers-ai:fixture:ATLAS_GITHUB_TOKEN", "unknown:model:SECRET"]) assert.throws(() => resolveCoderRoutes({ ...environment, ATLAS_CODER_FALLBACKS: route }), /Invalid coder fallback/);
  assert.throws(() => resolveCoderRoutes({ ATLAS_CODER_PROVIDER: "unknown" }), /must be/);
  assert.equal(resolveCoderRoutes({ OPENAI_API_KEY: "key" }).provider, "openai");
  assert.equal(resolveCoderRoutes({ ...environment, CLOUDFLARE_ACCOUNT_ID: "invalid" }).provider, "openai");
});

test("coder and automatic repair workflows provide matching cloud execution routes", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const workflow of ["atlas-coder.yml", "atlas-pr-steward.yml"]) {
    const text = await readFile(new URL("../../.github/workflows/" + workflow, import.meta.url), "utf8");
    const start = text.indexOf(workflow === "atlas-coder.yml" ? "      - name: Run Atlas task" : "      - name: Run Atlas coder on the branch");
    assert.ok(start >= 0);
    const step = text.slice(start).split("\n      - name:")[0];
    for (const key of ["OPENAI_API_KEY", "ATLAS_WORKERS_AI_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) assert.ok(step.includes(key + ": ${{ secrets." + key + " }}"), workflow + " lacks " + key);
    assert.ok(step.includes("ATLAS_CODER_FALLBACKS:"));
  }
});

test("free vendors join the coder's fallbacks; training tiers only with ATLAS_ALLOW_TRAINING_PROVIDERS=all", () => {
  const free = { GROQ_API_KEY: "g", CEREBRAS_API_KEY: "c", GEMINI_API_KEY: "ge", OPENROUTER_API_KEY: "o", MISTRAL_API_KEY: "m" };
  assert.deepEqual(resolveCoderRoutes(free).fallbacks, ["cerebras:gpt-oss-120b:CEREBRAS_API_KEY"]);
  assert.deepEqual(resolveCoderRoutes({ ...free, ATLAS_ALLOW_TRAINING_PROVIDERS: "1" }).fallbacks, ["cerebras:gpt-oss-120b:CEREBRAS_API_KEY"], "chat's opt-in does not extend to code");
  assert.deepEqual(resolveCoderRoutes({ ...free, ATLAS_ALLOW_TRAINING_PROVIDERS: "all" }).fallbacks, [
    "cerebras:gpt-oss-120b:CEREBRAS_API_KEY", "gemini:gemini-2.5-flash:GEMINI_API_KEY", "openrouter:openai/gpt-oss-20b:free:OPENROUTER_API_KEY", "mistral:devstral-small-latest:MISTRAL_API_KEY",
  ]);
  assert.deepEqual(resolveCoderRoutes({ ...free, ATLAS_GEMINI_TIER: "paid" }).fallbacks.map((route) => route.split(":")[0]), ["cerebras", "gemini"]);
  assert.equal(resolveCoderRoutes({ GEMINI_API_KEY: "ge", ATLAS_ALLOW_TRAINING_PROVIDERS: "all" }).provider, "gemini");
});

test("route specifications accept models containing colons and still pin each key to its vendor", async () => {
  const { isValidRoute } = await import("./coder-routes.mjs");
  assert.equal(isValidRoute("openrouter:openai/gpt-oss-20b:free:OPENROUTER_API_KEY"), true);
  assert.equal(isValidRoute("openrouter:openai/gpt-oss-20b:free:GROQ_API_KEY"), false);
  assert.equal(isValidRoute("gemini::GEMINI_API_KEY"), false);
});

test("the coder workflows pass every free vendor's key", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const workflow of ["atlas-coder.yml", "atlas-pr-steward.yml"]) {
    const text = await readFile(new URL("../../.github/workflows/" + workflow, import.meta.url), "utf8");
    for (const key of ["CEREBRAS_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "MISTRAL_API_KEY"]) assert.ok(text.includes(key + ": ${{ secrets." + key + " }}"), workflow + " lacks " + key);
    assert.ok(text.includes("ATLAS_ALLOW_TRAINING_PROVIDERS: ${{ vars.ATLAS_ALLOW_TRAINING_PROVIDERS }}"));
  }
});
