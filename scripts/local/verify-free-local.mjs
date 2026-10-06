/** Opt-in dogfood: real Ollama → authenticated gateway → Atlas streaming client.
 * No model downloads, external calls, credential output or paid fallback.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createGateway } from "./model-gateway.mjs";
import { createModelClient } from "../../apps/local-control/src/agent/model-client.mjs";
import { ModelCapabilityRegistry } from "../../apps/local-control/src/platform/models/capabilities.mjs";
import { runCapabilitySuite } from "../../apps/local-control/src/platform/models/capability-suite.mjs";
import { assertModelTag } from "../../apps/local-control/src/agent/models/manager.mjs";
import { catalogEntry } from "../../apps/local-control/src/agent/models/catalog.mjs";
import { probeCodingAgent } from "../../apps/local-control/src/agent/models/coding-probe.mjs";

if (!process.argv[2]) throw new Error("Specify the installed model to verify: node scripts/local/verify-free-local.mjs <model>");
const model = assertModelTag(process.argv[2]);
const token = randomBytes(32).toString("base64url");
const gateway = createGateway({ token, model, generationTimeoutMs: 120000, defaultReasoningEffort: catalogEntry(model)?.reasoningEffort });
gateway.listen(0, "127.0.0.1");
await once(gateway, "listening");
const url = `http://127.0.0.1:${gateway.address().port}/v1/`;
const headers = { authorization: `Bearer ${token}` };
try {
  assert.equal((await fetch(`${url}health`)).status, 401);
  assert.equal((await fetch(`${url}health`, { headers: { authorization: `Bearer ${"x".repeat(token.length)}` } })).status, 401);
  assert.equal((await fetch(`${url}health`, { headers })).status, 200);
  const client = createModelClient({ baseUrl: url, apiKey: token });
  const bounded = { stream: (request) => client.stream({ ...request, maxOutputTokens: 128, signal: AbortSignal.timeout(120000) }) };
  for (const [id, prompt, check] of [
    ["chat", "Reply with READY only.", (text) => /READY/.test(text)],
    ["coding", "Write only a JavaScript function add(a,b) returning their sum.", (text) => /return\s+a\s*\+\s*b/.test(text)],
    ["error-reasoning", "JavaScript: const x=null; x.name throws. Why? Answer in one sentence.", (text) => /null/i.test(text)],
  ]) {
    const started = Date.now();
    let text = "";
    for await (const event of bounded.stream({ model, messages: [{ role: "user", content: prompt }] })) if (event.type === "text") text += event.delta;
    assert.ok(check(text), `${id} response failed validation`);
    console.log(JSON.stringify({ test: id, provider: "local", model, passed: true, latencyMs: Date.now() - started, streaming: true }));
  }
  const registry = new ModelCapabilityRegistry();
  registry.register({ id: `ollama:${model}`, provider: "ollama", model, endpoint: "http://127.0.0.1:11434", local: true,
    capabilities: { contextTokens: 2048, toolCalls: false, structuredOutput: false, vision: false }, costPerMTokIn: 0, costPerMTokOut: 0 });
  const result = await runCapabilitySuite(bounded, `ollama:${model}`, { registry, model, contextSizes: [1024] });
  console.log(JSON.stringify({ test: "agent-capabilities", provider: "local", model, probes: result.probes, capabilities: result.measured.capabilities }));
  if (!result.measured.capabilities.toolCalls) process.exitCode = 2;
  if (process.argv.includes("--coder")) {
    const coding = await probeCodingAgent({ model, context: 4096, baseUrl: url, apiKey: token });
    console.log(JSON.stringify({ test: "atlas-coding-loop", provider: "local", model, ...coding }));
    if (!coding.passed) process.exitCode = 2;
  }
} finally {
  gateway.closeAllConnections();
  await new Promise((resolve) => gateway.close(resolve));
}
