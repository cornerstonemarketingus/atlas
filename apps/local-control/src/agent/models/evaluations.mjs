export const EVALUATIONS = [
  { id: "tool-call", prompt: "Read the file README.md using the available tool.", expect: "tool" },
  { id: "tool-call-restraint", prompt: "What is 2 + 2? Answer without tools.", expect: "text" },
  { id: "structured-output", prompt: "Return JSON describing Oslo with city, country, and population_millions.", expect: "json" },
  { id: "instruction", prompt: "Reply with exactly READY.", expect: "ready" },
];

export async function evaluateModel({ client, model }) {
  const results = [];
  for (const evaluation of EVALUATIONS) {
    const events = [];
    try {
      for await (const event of client.stream({ model, messages: [{ role: "user", content: evaluation.prompt }], tools: [{ type: "function", function: { name: "repository.read", parameters: { type: "object" } } }] })) events.push(event);
      results.push(score(evaluation, events));
    } catch (error) { results.push({ id: evaluation.id, passed: false, detail: error.message }); }
  }
  return {
    model,
    passed: results.filter((result) => result.passed).length,
    results,
    toolCallingUsable: results.find((result) => result.id === "tool-call")?.passed === true && results.find((result) => result.id === "tool-call-restraint")?.passed === true,
    structuredOutputUsable: results.find((result) => result.id === "structured-output")?.passed === true,
  };
}

function score(evaluation, events) {
  const calls = events.filter((event) => event.type === "tool_call");
  const text = events.filter((event) => event.type === "text").map((event) => event.delta).join("");
  if (evaluation.expect === "tool") return { id: evaluation.id, passed: calls.some((call) => call.name === "repository.read"), detail: calls.length ? "Called the requested tool." : "The model answered in prose instead of calling the tool." };
  if (calls.length) return { id: evaluation.id, passed: false, detail: "The model called a tool for a question that needed none." };
  if (evaluation.expect === "text") return { id: evaluation.id, passed: /four|4/iu.test(text), detail: text };
  if (evaluation.expect === "ready") return { id: evaluation.id, passed: text.trim() === "READY", detail: text };
  const candidate = text.replace(/```(?:json)?|```/giu, "").trim();
  try { const parsed = JSON.parse(candidate); return { id: evaluation.id, passed: parsed.city === "Oslo" && parsed.country === "Norway", detail: text }; }
  catch { return { id: evaluation.id, passed: false, detail: "The response was not valid structured output." }; }
}
