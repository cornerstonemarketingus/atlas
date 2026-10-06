import fs from "node:fs";
// Overridable only to exercise this script against a local stand-in; the workflow never sets it.
const base = process.env.ATLAS_SMOKE_BASE_URL || "https://atlas-web.cornerstonemarketingus.workers.dev";
const headers = { authorization: `Bearer ${process.env.ATLAS_OPERATOR_TOKEN}`, "content-type": "application/json" };
async function api(route, body) {
  const response = await fetch(`${base}${route}`, { method: body ? "POST" : "GET", headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(190000) });
  if (!response.ok) {
    // A repository-settings error carries a schema diagnostic, not model or
    // user content. Preserve only that bounded message for setup diagnosis.
    // Task creation answers with a fixed, user-content-free diagnosis
    // (e.g. "GitHub rejected Atlas's credential"), which is what an operator
    // needs to fix a failed run; print it with the status.
    // Chat's error names the providers that refused and why, in fixed words.
    const detail = route === "/api/settings/repositories" || route === "/api/tasks" || route === "/api/chat" ? await response.json().catch(() => ({})) : {};
    throw new Error(`${route}: HTTP ${response.status}${typeof detail.message === "string" ? ` (${detail.message.slice(0, 500)})` : ""}${typeof detail.unblock === "string" ? ` — ${detail.unblock.slice(0, 300)}` : ""}`);
  }
  return response.json();
}
/**
 * Sends one chat turn with stream:true and reads Atlas's server-sent events
 * to the end: `done` carries the stored reply, `error` a message for the
 * person. Anything else (thinking, deltas, tool and agent steps) is progress.
 */
async function streamChat(message) {
  const response = await fetch(`${base}/api/chat`, { method: "POST", headers, body: JSON.stringify({ message, stream: true }), signal: AbortSignal.timeout(190000) });
  if (!response.ok || !response.body) throw new Error(`/api/chat (stream): HTTP ${response.status}`);
  const decoder = new TextDecoder();
  let buffer = "";
  let outcome = null;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const type = /^event: (.+)$/mu.exec(block)?.[1]?.trim();
      const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
      if (type === "done") outcome = JSON.parse(data);
      if (type === "error") outcome = { error: String(JSON.parse(data)?.message ?? "unknown error").slice(0, 300) };
    }
  }
  return outcome ?? { error: "the stream ended without a reply or an error" };
}

const mode = process.env.ATLAS_SMOKE_MODE || "inspect";
const status = await api("/api/setup/status");
console.log(`Setup: ${status.overall} (${status.completedSteps}/${status.totalSteps})`);
// Provider kinds only (self-hosted, groq, openai): never addresses or keys.
const route = Array.isArray(status.optional?.chat?.route) ? status.optional.chat.route.map(String) : [];
if (route.length) console.log(`Chat route: ${route.join(" → ")}`);
// An unauthenticated identity header must not grant access on workers.dev.
const forged = await fetch(`${base}/api/tasks`, { headers: { "oai-authenticated-user-id": "operator" } });
if (forged.status !== 401) throw new Error("Untrusted identity header was accepted");
if (mode === "chat") {
  // Release gate: the conversation that failed in production must now get a
  // real, stored answer both ways the product asks for one. A reply that is
  // only the saved-work notice (no model could write the answer), a
  // "Stopped early" note, or an error event fails the gate.
  const message = (process.env.ATLAS_SMOKE_CHAT_MESSAGE || "").trim()
    || "Read https://example.com and tell me in two sentences what the page is for, then name one thing it does not say.";
  const evidence = { mode: "chat", messageChars: message.length, route };
  const judge = (label, outcome) => {
    const content = outcome.reply?.content ?? "";
    const problems = [];
    if (!content.trim()) problems.push("empty reply");
    if (!outcome.stored) problems.push("reply not persisted");
    if (outcome.finalization) problems.push(`no model wrote the answer (${outcome.finalization.reason})`);
    if (/_Stopped early:/u.test(content)) problems.push("stopped early");
    evidence[label] = {
      conversationId: outcome.conversationId, replyChars: content.length, stored: Boolean(outcome.stored),
      steps: (outcome.steps ?? []).map((step) => ({ label: String(step.label).slice(0, 120), ok: Boolean(step.ok) })),
      ...(outcome.finalization ? { finalization: outcome.finalization } : {}), ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.servedBy ? { servedBy: { provider: String(outcome.servedBy.provider), model: String(outcome.servedBy.model).slice(0, 120) } } : {}),
      passed: problems.length === 0 && !outcome.error,
    };
    const verdict = outcome.error ? `error: ${outcome.error}` : problems.length ? problems.join("; ") : "answered and stored";
    const served = evidence[label].servedBy ? `, written by ${evidence[label].servedBy.provider} ${evidence[label].servedBy.model}` : "";
    console.log(`${label}: ${verdict} (${content.length} chars, ${evidence[label].steps.length} tool steps${served})`);
  };

  judge("nonStreaming", await api("/api/chat", { message }));
  judge("streaming", await streamChat(message));
  fs.writeFileSync("smoke-result.json", JSON.stringify(evidence, null, 2));
  const failed = ["nonStreaming", "streaming"].filter((label) => !evidence[label].passed);
  if (failed.length) throw new Error(`Chat release gate failed: ${failed.join(", ")}`);
  console.log("Chat release gate passed in streaming and non-streaming modes.");
} else {
  if (mode === "coder") {
    const settings = await api("/api/settings/repositories");
    const repository = settings.repositories.find(item => item.owner === "cornerstonemarketingus" && item.name === "atlas");
    if (repository && repository.mergePolicy !== "manual") throw new Error("Coding smoke check requires manual PR review policy");
  }
  const objective = mode === "coder"
    ? "Create docs/ATLAS-SMOKE-CHECK.md containing exactly one line: Atlas coding smoke check. Do not modify any other file. Use the repository write tools to create it, then finish."
    : "Inspect Atlas and report its detected languages, frameworks, and manifests.";
  const task = await api("/api/tasks", { repository: "cornerstonemarketingus/atlas", branch: "main", mode, objective });
  if (!task.recorded) throw new Error("Task dispatched but history was not stored");
  console.log(`Dispatched ${mode} task ${task.taskId}; conversation ${task.conversationId}.`);
  const deadline = Date.now() + 20 * 60000;
  let complete = false;
  while (Date.now() < deadline) {
    const listing = await api("/api/tasks");
    const current = listing.tasks.find(item => item.taskId === task.taskId);
    const detail = await api(`/api/conversations/${task.conversationId}`);
    const result = detail.events?.find(item => item.taskId === task.taskId && item.kind === "result");
    if (result && current && ["succeeded", "failed", "cancelled", "timed_out"].includes(current.status)) {
      if (current.status !== "succeeded") throw new Error(`Runner ended ${current.status}; see ${current.run?.url}`);
      if (mode === "coder" && !current.pullRequest?.url) throw new Error("Coder finished without a reviewable pull request");
      if (mode === "coder" && !/\*\*verified\*\*/.test(result.detail)) throw new Error("Coder returned no verified baseline/post-change evidence");
      if (!detail.messages?.some(item => item.role === "assistant" && item.content === result.detail)) throw new Error("Result is not present in the conversation");
      const evidence = { taskId: task.taskId, conversationId: task.conversationId, run: current.run?.url, pullRequest: current.pullRequest?.url ?? null, summary: result.detail };
      fs.writeFileSync("smoke-result.json", JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify({ ...evidence, summary: "Received and persisted" }));
      complete = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 15000));
  }
  if (!complete) throw new Error("Timed out waiting for the runner and delivered findings");
}
