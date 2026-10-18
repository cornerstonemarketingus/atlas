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
