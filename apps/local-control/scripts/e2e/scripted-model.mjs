// A scripted OpenAI-compatible model for the end-to-end journey (scripts/e2e/journey.mjs).
// It plans, acts and verifies by recognizing the request, so the runtime around it can be tested.
import { createServer } from "node:http";
const port = Number(process.argv[2] || 4556);
const delayMs = Number(process.env.FAKE_STEP_DELAY_MS || 0);
const sse = (res, deltas, finish = "stop") => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const d of deltas) res.write(`data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 120, completion_tokens: 40 } })}\n\n`);
  res.end("data: [DONE]\n\n");
};
createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  if (req.url.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "fake-team" }] })); }
  const r = JSON.parse(body || "{}");
  const system = String(r.messages?.[0]?.content ?? "");
  const last = r.messages?.at(-1) ?? {};
  const text = (t) => sse(res, [{ content: t }]);
  if (system.startsWith("You are the planning lead")) {
    const lines = String(last.content).split("\n").filter((l) => l.startsWith("- "));
    const agents = lines.map((l) => ({ name: l.slice(2, l.indexOf(" (")), reader: l.includes("filesystem.read") }));
    const reader = agents.find((a) => a.reader) ?? agents[0];
    const writer = agents.find((a) => a.name !== reader.name && /Product|Marketing|Analytics|Finance/u.test(a.name)) ?? agents.find((a) => a.name !== reader.name);
    return text(JSON.stringify({ summary: "Read the brief, then summarize it.", successCriteria: ["A summary grounded in the brief exists."], steps: [
      { title: "Read the project brief", agent: reader.name, instructions: "Read brief.md in the workspace and extract the key facts.", doneWhen: "The report quotes the brief's key facts.", dependsOn: [] },
      { title: "Write the summary", agent: writer.name, instructions: "Summarize the facts from the previous step for the owner.", doneWhen: "A short summary exists.", dependsOn: [1] },
    ] }));
  }
  if (system.startsWith("You verify")) { const passed = !String(last.content).includes("Not done"); return text(JSON.stringify({ passed, reason: passed ? "The report shows the requested result." : "The report says the action was not done." })); }
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const tools = (r.tools ?? []).map((t) => t.function.name);
  if (last.role === "tool") return text(`Report: I read brief.md. It says: ${String(last.content).replace(/<\/?data[^>]*>/gu, "").trim().slice(0, 300)}`);
  if (tools.includes("filesystem.read")) return sse(res, [{ tool_calls: [{ index: 0, id: "call_read", function: { name: "filesystem.read", arguments: JSON.stringify({ path: "brief.md" }) } }] }], "tool_calls");
  if (system.startsWith("You are")) return text("Report: Summary — the brief asks for a launch page by Friday with pricing at $29/month.");
  return text("Hello from the scripted model.");
}).listen(port, "127.0.0.1", () => console.log(`fake team model on ${port}`));
