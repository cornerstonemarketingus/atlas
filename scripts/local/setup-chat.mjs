import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { completionsUrl, replyText, chatRequestBody } from "../../apps/web/app/api/chat/model-endpoint.mjs";

// Uses already installed models; does not download weights or create accounts.
const baseUrl = "http://127.0.0.1:11434/v1/";
const response = await fetch(new URL("models", baseUrl), { signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error(`Ollama model discovery failed (${response.status}).`);
const installed = (await response.json()).data?.map((model) => model.id) ?? [];
const preferred = ["qwen3:0.6b", "qwen3:1.7b", "qwen2.5-coder:1.5b"];
const models = preferred.filter((model) => installed.includes(model));
if (models.length < 2) throw new Error("Install at least two of qwen3:0.6b, qwen3:1.7b, qwen2.5-coder:1.5b with ollama pull, then retry.");
for (const model of models) {
  const reply = await fetch(completionsUrl(baseUrl), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(chatRequestBody({ model, reasoningEffort: "none" }, [{ role: "user", content: "Say hello in one short sentence." }], 120)),
    signal: AbortSignal.timeout(120_000),
  });
  if (!reply.ok || !replyText(await reply.json())) throw new Error(`Chat smoke check failed for ${model} (${reply.status}).`);
  console.log(`Verified real chat reply: ${model}`);
}
if (process.argv.includes("--configure")) {
  const target = fileURLToPath(new URL("../../apps/web/.dev.vars", import.meta.url));
  let existing = "";
  try { existing = await readFile(target, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  // Preserve unrelated sign-in/dispatch secrets without displaying them.
  const kept = existing.split(/\r?\n/u).filter((line) => !/^\s*(ATLAS_CHAT_BASE_URL|ATLAS_CHAT_MODEL|ATLAS_CHAT_MODELS|ATLAS_CHAT_PROFILES|ATLAS_MODEL_API_KEY)\s*=/u.test(line));
  const profiles = models.map((model, index) => ({ id: `local-${index}`, label: model === "qwen3:0.6b" ? "Local · Fast (Qwen 0.6B)" : model === "qwen3:1.7b" ? "Local · Balanced (Qwen 1.7B)" : "Local · Coding (Qwen Coder 1.5B)", model, baseUrl, reasoningEffort: "none" }));
  await writeFile(target, `${kept.join("\n").trimEnd()}\nATLAS_CHAT_PROFILES='${JSON.stringify(profiles)}'\n`, "utf8");
  console.log("Configured apps/web/.dev.vars with verified local choices. No API key required. Restart the web dev server to load them.");
}
