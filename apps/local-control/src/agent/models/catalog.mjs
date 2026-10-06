/**
 * Models Atlas knows how to run locally, with what each needs and is good at,
 * and a planner that picks the best set for this machine.
 *
 * Numbers are estimates for Ollama's default 4-bit quantization (Q4_K_M,
 * about 4.85 bits per weight) and are stated as estimates in the UI:
 * - weights: parameters × bits / 8, plus ~7% runtime overhead;
 * - KV cache: kvKiBPerToken × context tokens (f16 cache), which is why a
 *   long context can cost more memory than a small model's weights;
 * - speed: generation is bound by memory bandwidth over the *active*
 *   parameters, so mixture-of-experts models (qwen3:30b, qwen3-coder:30b,
 *   gpt-oss:20b) run far faster on a CPU than their size suggests.
 *
 * Scores are relative (0–10) and exist to rank, not to promise: coding (edit
 * and repair code with tools), reasoning (review, planning), and whether the
 * model supports tool calls through Ollama at all (a coder without tool
 * calls cannot drive Atlas's agent loop).
 */

const BITS_PER_WEIGHT = 4.85;
const RUNTIME_OVERHEAD = 1.07;
/** Leave this much of usable memory free for the OS, Atlas and the browser. */
export const MEMORY_HEADROOM = 0.85;
export const CONTEXT_STEPS = Object.freeze([32_768, 16_384, 8_192]);

const model = (tag, family, parametersB, extra) => ({ tag, family, parametersB, activeB: parametersB, tools: true, vision: false,
  quantization: "Q4_K_M estimate",
  fixedWeightsGiB: extra.downloadGB / 1.074 * RUNTIME_OVERHEAD,
  ...extra });

export const CATALOG = Object.freeze([
  // ollama.com/library/qwen3:4b: Q4_K_M, 2.5 GB; 36 layers × 8 KV heads × 128 × K/V × fp16.
  model("qwen3:4b", "qwen3", 4.02, { downloadGB: 2.5, kvKiBPerToken: 144, nativeContext: 262144, coding: 4.5, reasoning: 4.5, setupContext: 8192, reasoningEffort: "none" }),
  model("qwen3:0.6b", "qwen3", 0.752, { downloadGB: 0.523, fixedWeightsGiB: 0.523 / 1.074 * 1.07, kvKiBPerToken: 56, nativeContext: 32768, coding: 1.5, reasoning: 1.5, setupContext: 8192, reasoningEffort: "none" }),
  model("qwen3:1.7b", "qwen3", 2.03, { downloadGB: 1.4, fixedWeightsGiB: 1.4 / 1.074, kvKiBPerToken: 112, nativeContext: 32768, coding: 3, reasoning: 3, setupContext: 4096, reasoningEffort: "none" }),
  model("qwen2.5-coder:1.5b", "qwen2.5", 1.5, { downloadGB: 1.0, kvKiBPerToken: 28, nativeContext: 32_768, coding: 2, reasoning: 1.5 }),
  model("qwen2.5-coder:3b", "qwen2.5", 3, { downloadGB: 1.9, kvKiBPerToken: 36, nativeContext: 32_768, coding: 3, reasoning: 2.5 }),
  model("qwen2.5-coder:7b", "qwen2.5", 7, { downloadGB: 4.7, kvKiBPerToken: 56, nativeContext: 32_768, coding: 5, reasoning: 4 }),
  model("qwen2.5-coder:14b", "qwen2.5", 14, { downloadGB: 9.0, kvKiBPerToken: 192, nativeContext: 32_768, coding: 6.5, reasoning: 5.5 }),
  model("qwen2.5-coder:32b", "qwen2.5", 32, { downloadGB: 20, kvKiBPerToken: 256, nativeContext: 32_768, coding: 8, reasoning: 7 }),
  model("qwen3:8b", "qwen3", 8, { downloadGB: 5.2, kvKiBPerToken: 144, nativeContext: 40_960, coding: 5.5, reasoning: 6 }),
  model("qwen3:14b", "qwen3", 14, { downloadGB: 9.3, kvKiBPerToken: 160, nativeContext: 40_960, coding: 6.5, reasoning: 7 }),
  model("qwen3:30b", "qwen3", 30, { activeB: 3, downloadGB: 19, kvKiBPerToken: 96, nativeContext: 40_960, coding: 7, reasoning: 7.5 }),
  model("qwen3:32b", "qwen3", 32, { downloadGB: 20, kvKiBPerToken: 256, nativeContext: 40_960, coding: 8, reasoning: 8 }),
  model("qwen3-coder:30b", "qwen3", 30, { activeB: 3.3, downloadGB: 19, kvKiBPerToken: 96, nativeContext: 65_536, coding: 8.5, reasoning: 7 }),
  model("devstral:24b", "mistral", 24, { downloadGB: 14, kvKiBPerToken: 160, nativeContext: 65_536, coding: 8, reasoning: 6.5 }),
  model("gpt-oss:20b", "gpt-oss", 21, { activeB: 3.6, downloadGB: 14, kvKiBPerToken: 48, nativeContext: 65_536, coding: 7, reasoning: 7.5, fixedWeightsGiB: 13 }),
  model("deepseek-r1:14b", "deepseek-r1", 14, { tools: false, downloadGB: 9.0, kvKiBPerToken: 192, nativeContext: 65_536, coding: 5.5, reasoning: 7 }),
  model("llama3.1:8b", "llama3", 8, { downloadGB: 4.9, kvKiBPerToken: 128, nativeContext: 131_072, coding: 4, reasoning: 4.5 }),
  model("qwen2.5vl:7b", "qwen2.5", 7, { vision: true, tools: false, downloadGB: 6.0, kvKiBPerToken: 56, nativeContext: 32_768, coding: 3, reasoning: 4 }),
]);

export function catalogEntry(tag) {
  return CATALOG.find((entry) => entry.tag === tag) ?? null;
}

/** Estimated GiB to run `entry` with a `contextTokens` window. */
export function memoryRequiredGiB(entry, contextTokens) {
  const weights = entry.fixedWeightsGiB ?? (entry.parametersB * 1e9 * BITS_PER_WEIGHT / 8 / 1024 ** 3) * RUNTIME_OVERHEAD;
  const kv = (entry.kvKiBPerToken * contextTokens) / 1024 ** 2;
  return Math.round((weights + kv) * 10) / 10;
}

/** Relative generation speed (higher is faster): bandwidth over active weight bytes. */
export function relativeSpeed(entry, hardware) {
  const bandwidth = hardware.gpus?.length ? 300 : hardware.unifiedMemory ? 120 : 40;
  return Math.round((bandwidth / (entry.activeB * BITS_PER_WEIGHT / 8)) * 10) / 10;
}

/** The largest standard context (≤ the model's own) that fits, or null when even 8k does not. */
export function fittingContext(entry, hardware) {
  const budget = Math.min(hardware.usableModelMemoryGiB * MEMORY_HEADROOM,
    hardware.gpus?.length ? Infinity : Math.max(0, hardware.totalMemoryGiB - 3));
  for (const context of CONTEXT_STEPS) {
    if (context > entry.nativeContext) continue;
    if (memoryRequiredGiB(entry, context) <= budget) return context;
  }
  return null;
}

/** Single-model onboarding choices. Runtime preflight checks free memory again. */
export function freeLocalChoices(hardware, installedTags = []) {
  const pool = assessCatalog(hardware, installedTags).filter((entry) => entry.fits && entry.tools && !entry.vision
    && (entry.installed || (Number.isFinite(hardware.freeDiskGiB) && hardware.freeDiskGiB >= entry.downloadGB * 1.2 + 1)));
  const quality = [...pool].sort((a, b) => b.coding - a.coding);
  const fast = [...pool].sort((a, b) => b.speed - a.speed);
  const compact = (entry) => {
    if (!entry) return null;
    const needed = Math.max(entry.setupContext ?? 8192, hardware.requiredContextTokens ?? 0);
    const context = [4096, 8192, 16384, 32768].find((size) => size >= needed && size <= entry.nativeContext);
    return context ? { ...entry, context, memoryGiB: memoryRequiredGiB(entry, context) } : null;
  };
  const balanced = quality.map(compact).find((entry) => entry && entry.coding >= 3 && entry.memoryGiB <= Math.max(1, hardware.usableModelMemoryGiB * (hardware.accelerator === "cpu" ? 0.35 : 0.4))) ?? null;
  return { best: compact(quality[0]), balanced: compact(balanced), lightweight: compact(fast[0]) };
}

/** Every catalog model with whether and how it fits this machine. */
export function assessCatalog(hardware, installedTags = []) {
  const installed = new Set(installedTags);
  return CATALOG.map((entry) => {
    const context = fittingContext(entry, hardware);
    return {
      ...entry,
      installed: installed.has(entry.tag),
      fits: context !== null,
      context,
      memoryGiB: memoryRequiredGiB(entry, context ?? 8_192),
      speed: relativeSpeed(entry, hardware),
    };
  });
}

const best = (items, score) => items.reduce((top, item) => (!top || score(item) > score(top) ? item : top), null);

/**
 * The model set for this machine:
 * - coder: best coding score among tool-capable models that fit (the builder);
 * - reviewer: best reasoning score, preferring a different family from the
 *   coder so it does not share the coder's blind spots;
 * - fast: the quickest tool-capable model with coding ≥ 3, for simple tasks.
 * `preferInstalled` keeps the plan to models already downloaded, so a plan
 * never silently depends on a 20 GB download.
 */
export function planModels(hardware, installedTags = [], { preferInstalled = false } = {}) {
  const assessed = assessCatalog(hardware, installedTags).filter((entry) => entry.fits && !entry.vision);
  const pool = preferInstalled ? assessed.filter((entry) => entry.installed) : assessed;
  const tools = pool.filter((entry) => entry.tools);
  const coder = best(tools, (entry) => entry.coding * 10 + entry.speed / 100);
  const others = pool.filter((entry) => entry.tag !== coder?.tag);
  const differentFamily = others.filter((entry) => entry.family !== coder?.family);
  const reviewer = best(differentFamily.length ? differentFamily : others, (entry) => entry.reasoning * 10 + entry.speed / 100) ?? coder;
  const fast = best(tools.filter((entry) => entry.coding >= 3), (entry) => entry.speed + entry.coding / 10) ?? coder;
  const describe = (entry, role) => entry ? { role, tag: entry.tag, context: entry.context, memoryGiB: entry.memoryGiB, installed: entry.installed, downloadGB: entry.downloadGB } : null;
  const plan = { coder: describe(coder, "coder"), reviewer: describe(reviewer, "reviewer"), fast: describe(fast, "fast") };
  const missing = [...new Set(Object.values(plan).filter((entry) => entry && !entry.installed).map((entry) => entry.tag))];
  return {
    ...plan,
    missing,
    summary: coder
      ? `This machine can run ${coder.tag} for coding${reviewer && reviewer.tag !== coder.tag ? `, ${reviewer.tag} to review` : ""}${fast && fast.tag !== coder.tag ? ` and ${fast.tag} for quick tasks` : ""}.`
      : "No catalog model with tool calling fits this machine's memory; use a remote OpenAI-compatible endpoint.",
  };
}
