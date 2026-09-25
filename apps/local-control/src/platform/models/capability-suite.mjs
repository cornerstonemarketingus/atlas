/**
 * Capability test suite: turns declared capabilities into measured ones.
 *
 * Probes a model through a small, provider-neutral client interface and
 * records what it actually did in the ModelCapabilityRegistry. The client
 * needs either
 *   - `complete({ model, messages, tools, format? })` → `{ text, toolCalls: [{ name, arguments }] }`
 *     (the Ollama adapter in ./ollama-adapter.mjs provides this), or
 *   - `stream({ model, messages, tools })` yielding `{ type: "text", delta }` /
 *     `{ type: "tool_call", name, arguments }` events (agent/model-client.mjs).
 *
 * Probes: JSON output, tool-call formatting (validated with validateToolCall),
 * and context recall at increasing sizes (a "needle" at the start of filler).
 * Context is recorded honestly: if every size passed, the declared window is
 * kept and `contextVerifiedTokens` notes how far it was tested; if a size
 * failed, the measured window is the largest size that passed.
 * Vision is not probed, so it stays declared.
 */
import { validateToolCall } from "./tool-call.mjs";

const WEATHER_TOOL = {
  name: "lookup_weather",
  description: "Look up the current weather for a city.",
  parameters: { type: "object", required: ["city"], additionalProperties: false, properties: { city: { type: "string", minLength: 1 } } },
};
const FILLER = "The quarterly report discusses logistics, staffing, and routine maintenance schedules in detail. ";

export async function runCapabilitySuite(modelClient, profileId, { registry, model, trials = 1, contextSizes = [1_024, 4_096], clock = () => Date.now(), now = () => new Date() } = {}) {
  if (!registry) throw new TypeError("runCapabilitySuite needs a registry to record measurements in.");
  const profile = registry.effective(profileId);
  const modelName = model ?? profile.model ?? profileId;
  const probes = [];
  const latencies = [];

  const run = async (id, request, check) => {
    const started = clock();
    let outcome;
    try {
      const response = await complete(modelClient, { model: modelName, ...request });
      outcome = { id, ...check(response) };
    } catch (error) {
      outcome = { id, passed: false, detail: `error: ${error.message}` };
    }
    latencies.push(clock() - started);
    probes.push(outcome);
    return outcome;
  };

  let jsonPasses = 0;
  let toolPasses = 0;
  for (let trial = 0; trial < trials; trial += 1) {
    const json = await run("json-output", {
      messages: [{ role: "user", content: 'Return only a JSON object with keys "city" set to "Oslo" and "country" set to "Norway". No prose.' }],
      format: "json",
    }, ({ text }) => {
      const candidate = String(text ?? "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
      try {
        const parsed = JSON.parse(candidate);
        const passed = parsed?.city === "Oslo" && parsed?.country === "Norway";
        return { passed, detail: passed ? "valid JSON with expected fields" : "JSON missing expected fields" };
      } catch { return { passed: false, detail: "not valid JSON" }; }
    });
    if (json.passed) jsonPasses += 1;

    const tool = await run("tool-call-format", {
      messages: [{ role: "user", content: "What is the weather in Oslo right now? Use the lookup_weather tool." }],
      tools: [WEATHER_TOOL],
    }, ({ toolCalls = [] }) => {
      if (toolCalls.length === 0) return { passed: false, detail: "answered in prose instead of calling the tool" };
      const result = validateToolCall(toolCalls[0], [WEATHER_TOOL]);
      if (!result.ok) return { passed: false, detail: result.errors.map((error) => `${error.path}: ${error.message}`).join("; ") };
      const passed = /oslo/iu.test(result.call.arguments.city);
      return { passed, detail: passed ? "well-formed tool call" : "tool call had the wrong argument" };
    });
    if (tool.passed) toolPasses += 1;
  }

  const declaredContext = profile.capabilities.contextTokens;
  let largestRecalled = 0;
  let recallFailed = false;
  for (const size of [...contextSizes].sort((a, b) => a - b)) {
    if (declaredContext && size > declaredContext) break;
    const code = `${Math.floor(1000 + (size % 9000))}-ALPHA`;
    const needle = `Remember this: the vault code is ${code}. `;
    const filler = FILLER.repeat(Math.max(1, Math.floor((size * 4 - needle.length) / FILLER.length)));
    const outcome = await run(`context-recall-${size}`, {
      messages: [{ role: "user", content: `${needle}${filler}\n\nWhat is the vault code? Reply with the code only.` }],
    }, ({ text }) => ({ passed: String(text ?? "").includes(code), detail: `recall at ~${size} tokens` }));
    if (outcome.passed) largestRecalled = size;
    else { recallFailed = true; break; }
  }

  const passed = probes.filter((probe) => probe.passed).length;
  const capabilities = {
    structuredOutput: jsonPasses === trials,
    toolCalls: toolPasses === trials,
    contextTokens: recallFailed ? largestRecalled : Math.max(declaredContext, largestRecalled),
  };
  const sorted = [...latencies].sort((a, b) => a - b);
  const measurement = {
    capabilities,
    reliability: probes.length ? Math.round((passed / probes.length) * 1000) / 1000 : 0,
    p50LatencyMs: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : undefined,
    measuredAt: now().toISOString(),
    probes: { results: probes, contextVerifiedTokens: largestRecalled },
  };
  const effective = registry.recordMeasurement(profileId, measurement);
  return { profileId, passed, total: probes.length, probes, measured: measurement, effective };
}

async function complete(client, request) {
  if (typeof client.complete === "function") {
    const response = await client.complete(request);
    return { text: response?.text ?? "", toolCalls: response?.toolCalls ?? [] };
  }
  if (typeof client.stream === "function") {
    let text = "";
    const toolCalls = [];
    for await (const event of client.stream({ model: request.model, messages: request.messages, tools: (request.tools ?? []).map((tool) => ({ type: "function", function: tool })) })) {
      if (event.type === "text") text += event.delta;
      else if (event.type === "tool_call") toolCalls.push({ name: event.name, arguments: event.arguments, id: event.id });
    }
    return { text, toolCalls };
  }
  throw new TypeError("The model client must provide complete() or stream().");
}
