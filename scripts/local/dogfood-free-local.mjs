import { homedir } from "node:os";
import { join } from "node:path";
import { createCredentialVault } from "../../apps/local-control/src/agent/credential-vault.mjs";
import { probeCodingAgent } from "../../apps/local-control/src/agent/models/coding-probe.mjs";
import { OWNER_TOKEN_NAME } from "../../apps/local-control/src/identity/owner.mjs";

const directory = process.env.ATLAS_LOCAL_DATA_DIR ?? join(homedir(), ".atlas");
const vault = createCredentialVault({ filePath: join(directory, "credentials.vault.json") });
const token = await vault.get(OWNER_TOKEN_NAME);
if (!token) throw new Error("Start Atlas locally first. No owner credential was found in the OS vault.");
const base = "http://127.0.0.1:4317";
async function api(path, body) {
  const response = await fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Atlas verification request returned ${response.status}`);
  return response.json();
}
if (process.argv.includes("--setup")) await api("/v1/models/hosting/setup", { choice: process.argv.includes("--lightweight") ? "lightweight" : "balanced" });
let status;
for (let attempt = 0; attempt < 420; attempt += 1) {
  status = (await api("/v1/models/hosting")).freeLocal;
  if (status.job.state !== "running") break;
  if (attempt % 10 === 0) console.log(JSON.stringify({ state: status.job.state, step: status.job.step }));
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
console.log(JSON.stringify({ online: status.online, selected: status.selected, job: status.job, cloudFallback: status.cloudFallback }));
if (status.job.state !== "ready") process.exitCode = 2;
if (process.argv.includes("--coder") && status.online) {
  const coding = await probeCodingAgent({ model: status.selected.runtimeTag ?? status.selected.tag, context: status.selected.context, baseUrl: "http://127.0.0.1:11435/v1/", apiKey: await vault.get("FREE_LOCAL_GATEWAY_KEY") });
  console.log(JSON.stringify({ test: "atlas-coding-loop", model: status.selected.tag, ...coding }));
  if (!coding.passed) process.exitCode = 2;
}
if (process.argv.includes("--chat") && status.online) {
  const { session } = await api("/v1/sessions", { title: "Free Local AI dogfood", model: status.selected.tag, executor: "conversation" });
  await api(`/v1/sessions/${session.id}/turns`, { text: "Write a JavaScript function add(a,b) that returns their sum. No tools are needed for this question." });
  let result;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    result = (await api(`/v1/sessions/${session.id}`)).session;
    if (["completed", "failed", "awaiting_approval", "cancelled"].includes(result.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log(JSON.stringify({ test: "atlas-chat-runtime", sessionId: session.id, status: result.status, summary: result.summary, model: result.model, usage: result.usage }));
  if (result.status !== "completed") process.exitCode = 2;
}
