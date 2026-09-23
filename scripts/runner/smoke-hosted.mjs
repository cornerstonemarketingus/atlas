import fs from "node:fs";
const base = "https://atlas-web.cornerstonemarketingus.workers.dev";
const headers = { authorization: `Bearer ${process.env.ATLAS_OPERATOR_TOKEN}`, "content-type": "application/json" };
async function api(route, body) {
  const response = await fetch(`${base}${route}`, { method: body ? "POST" : "GET", headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(190000) });
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
  return response.json();
}
const mode = process.env.ATLAS_SMOKE_MODE || "inspect";
const status = await api("/api/setup/status");
console.log(`Setup: ${status.overall} (${status.completedSteps}/${status.totalSteps})`);
// An unauthenticated identity header must not grant access on workers.dev.
const forged = await fetch(`${base}/api/tasks`, { headers: { "oai-authenticated-user-id": "operator" } });
if (forged.status !== 401) throw new Error("Untrusted identity header was accepted");
if (mode === "chat") {
  const reply = await api("/api/chat", { message: "Reply with exactly: Atlas connection works" });
  if (!reply.reply?.content?.trim() || !reply.stored) throw new Error("Chat did not return and persist a reply");
  console.log(`Chat replied and persisted conversation ${reply.conversationId}.`);
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
