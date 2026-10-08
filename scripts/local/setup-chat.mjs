import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { completionsUrl, replyText } from "../../apps/web/app/api/chat/model-endpoint.mjs";

// Check existing models only: no downloads, cloud accounts, or invented keys.
const baseUrl = "http://127.0.0.1:11434/v1/";
const response = await fetch(new URL("models", baseUrl), { signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error(`Ollama model discovery failed (${response.status}).`);
const installed = (await response.json()).data?.map((model) => model.id) ?? [];
const models = ["qwen3:0.6b", "qwen3:1.7b", "qwen2.5-coder:1.5b"].filter((model) => installed.includes(model));
if (models.length < 2) throw new Error("Install at least two of qwen3:0.6b, qwen3:1.7b, qwen2.5-coder:1.5b with ollama pull, then retry.");
for (const model of models) {
  const reply = await fetch(completionsUrl(baseUrl), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Say hello in one short sentence." }], stream: false, temperature: 0.2, max_tokens: 120,
      ...(model.startsWith("qwen3:") ? { reasoning_effort: "none" } : {}) }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!reply.ok || !replyText(await reply.json())) throw new Error(`Chat smoke check failed for ${model} (${reply.status}).`);
  console.log(`Verified real chat reply: ${model}`);
}
if (process.argv.includes("--configure")) {
  const target = fileURLToPath(new URL("../../apps/web/.dev.vars", import.meta.url));
  let existing = "";
  try { existing = await readFile(target, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  // Preserve unrelated sign-in and dispatch secrets without displaying them.
  const kept = existing.split(/\r?\n/u).filter((line) => !/^\s*(ATLAS_CHAT_BASE_URL|ATLAS_CHAT_MODEL|ATLAS_CHAT_MODELS|ATLAS_CHAT_PROFILES|ATLAS_MODEL_API_KEY)\s*=/u.test(line));
  await writeFile(target, `${kept.join("\n").trimEnd()}\nATLAS_CHAT_BASE_URL=${baseUrl}\nATLAS_CHAT_MODEL=${models[0]}\nATLAS_CHAT_MODELS=${models.slice(1).join(",")}\n`, "utf8");
  console.log("Configured apps/web/.dev.vars with verified local choices. No API key required. Restart the web dev server to load them.");
}
