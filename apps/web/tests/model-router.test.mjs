import assert from "node:assert/strict";
import test from "node:test";

import { lastServedRoute, rememberServedRoute, resolveModelRoutes } from "../app/api/chat/model-router.mjs";

test("falls back to legacy chat endpoint when ATLAS_MODEL_ROUTES is unset", () => {
  const env = { ATLAS_CHAT_BASE_URL: "https://api.example/v1", ATLAS_CHAT_MODEL: "legacy-model", ATLAS_MODEL_API_KEY: "secret" };
  const routed = resolveModelRoutes(env);
  assert.equal(routed.configured, true);
  assert.equal(routed.chatRoutes.length, 1);
  assert.equal(routed.chatRoutes[0].model, "legacy-model");
  assert.equal(routed.chatRoutes[0].baseUrl, "https://api.example/v1/");
});

test("parses chat routes from ATLAS_MODEL_ROUTES and resolves provider credentials", () => {
  const env = {
    ATLAS_MODEL_ROUTES: JSON.stringify({ chat: ["groq:openai/gpt-oss-120b", "openai:gpt-5-mini"] }),
    GROQ_API_KEY: "g",
    OPENAI_API_KEY: "o",
  };
  const routed = resolveModelRoutes(env);
  assert.equal(routed.configured, true);
  assert.deepEqual(routed.chatRoutes.map((item) => item.label), ["groq:openai/gpt-oss-120b", "openai:gpt-5-mini"]);
  assert.equal(routed.chatRoutes[0].apiKey, "g");
  assert.equal(routed.chatRoutes[1].apiKey, "o");
});

test("reports malformed route configuration as unconfigured", () => {
  const routed = resolveModelRoutes({ ATLAS_MODEL_ROUTES: "{not json}" });
  assert.equal(routed.configured, false);
  assert.match(routed.reason, /valid JSON/u);
});

test("tracks last served route label in memory", () => {
  rememberServedRoute("chat", "groq:openai/gpt-oss-20b");
  assert.equal(lastServedRoute("chat"), "groq:openai/gpt-oss-20b");
});
