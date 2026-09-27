import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { chatReadiness } from "../app/api/chat/model-endpoint.mjs";

// A Worker can read only what `wrangler secret put` uploaded. The chat runtime
// read ATLAS_CHAT_FALLBACK_MODEL for weeks while the deploy never uploaded it,
// so production stopped on every 429 a fallback would have absorbed. These
// tests fail the moment chat code reads a variable the deploy does not supply.

const root = new URL("../../../", import.meta.url).pathname;
const workflow = readFileSync(join(root, ".github/workflows/deploy-cloudflare.yml"), "utf8");
const chatDirectory = join(root, "apps/web/app/api/chat");

/** Variables the upload step maps from secrets into its environment. */
function uploadStepEnvironment() {
  const step = workflow.slice(workflow.indexOf("- name: Upload Worker runtime secrets"));
  const envBlock = step.slice(0, step.indexOf("run: |"));
  return new Set([...envBlock.matchAll(/^\s+([A-Z][A-Z0-9_]+):\s*\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/gmu)].map(([, name, secret]) => {
    assert.equal(name, secret, `${name} must come from the secret of the same name`);
    return name;
  }));
}

/** Variables the upload loop actually sends to the Worker. */
function uploadedNames() {
  const loop = /for name in \\\n([\s\S]*?)\n\s+do\n/u.exec(workflow);
  assert.ok(loop, "the upload loop must be present");
  return new Set(loop[1].split(/\\\n/u).map((line) => line.trim()).filter(Boolean));
}

/** Runtime variables the chat code reads. */
function chatRuntimeVariables() {
  const names = new Set();
  for (const file of readdirSync(chatDirectory)) {
    if (!/\.(mjs|ts)$/u.test(file)) continue;
    const source = readFileSync(join(chatDirectory, file), "utf8");
    for (const [, name] of source.matchAll(/(?:environment|env|process\.env)\??\.([A-Z][A-Z0-9_]+)/gu)) names.add(name);
  }
  return names;
}

// Read by chat but supplied some other way, each for a stated reason.
const SUPPLIED_ELSEWHERE = new Map([
  // Mapped into ATLAS_MODEL_API_KEY by the upload step for the Groq origin only.
  ["GROQ_API_KEY", "mapped to ATLAS_MODEL_API_KEY"],
  // A fallback alias for self-hosted deployments that already use this name.
  ["TAVILY_API_KEY", "alias of ATLAS_TAVILY_API_KEY"],
]);

test("every variable chat reads is uploaded to the Worker", () => {
  const uploaded = uploadedNames();
  const missing = [...chatRuntimeVariables()].filter((name) => !uploaded.has(name) && !SUPPLIED_ELSEWHERE.has(name));
  assert.deepEqual(missing, [], `Chat reads these, but deploy-cloudflare.yml never uploads them: ${missing.join(", ")}`);
});

test("the model variables are mapped and uploaded, the fallback included", () => {
  const environment = uploadStepEnvironment();
  const uploaded = uploadedNames();
  for (const name of ["ATLAS_CHAT_BASE_URL", "ATLAS_CHAT_MODEL", "ATLAS_MODEL_API_KEY", "ATLAS_CHAT_FALLBACK_MODEL", "ATLAS_TAVILY_API_KEY"]) {
    assert.ok(environment.has(name), `${name} is not mapped from secrets`);
    assert.ok(uploaded.has(name), `${name} is not uploaded`);
  }
});

test("everything uploaded is mapped from a secret, so no upload is silently empty", () => {
  const environment = uploadStepEnvironment();
  const unmapped = [...uploadedNames()].filter((name) => !environment.has(name));
  assert.deepEqual(unmapped, []);
});

test("setup status reports chat readiness as flags, never values", () => {
  const readiness = chatReadiness({
    ATLAS_CHAT_BASE_URL: "https://api.groq.com/openai/v1",
    ATLAS_CHAT_MODEL: "openai/gpt-oss-120b",
    GROQ_API_KEY: "gsk_secret_value",
  });
  assert.deepEqual(readiness, { configured: true, fallbackModelConfigured: true, webSearchConfigured: false });
  assert.doesNotMatch(JSON.stringify(readiness), /gsk_|groq\.com|gpt-oss/u);
  assert.equal(chatReadiness({ ATLAS_CHAT_BASE_URL: "https://api.groq.com/openai/v1", ATLAS_CHAT_MODEL: "m", ATLAS_CHAT_FALLBACK_MODEL: "none" }).fallbackModelConfigured, false);
  assert.equal(chatReadiness({}).configured, false);
});
