const GIB = 1024 ** 3;

export function parseOllamaModels(output) {
  return String(output ?? "").split(/\r?\n/u).slice(1).map((line) => line.trim().split(/\s+/u)[0]).filter(Boolean);
}

export function recommendModel(totalMemoryBytes, installedModels = []) {
  const memoryGiB = Math.max(0, Number(totalMemoryBytes) / GIB);
  const preferred = memoryGiB >= 30
    ? ["qwen2.5-coder:14b", "qwen2.5-coder:7b", "qwen2.5-coder:3b"]
    : memoryGiB >= 14
      ? ["qwen2.5-coder:7b", "qwen2.5-coder:3b"]
      : ["qwen2.5-coder:3b", "qwen2.5-coder:1.5b"];
  const installed = new Map(installedModels.map((name) => [name.toLowerCase(), name]));
  const selected = preferred.map((name) => installed.get(name)).find(Boolean) ?? null;
  return { selected, recommended: preferred[0], memoryGiB: Math.round(memoryGiB * 10) / 10 };
}

export function retryDelay(attempt, baseMs = 2_000, maximumMs = 60_000) {
  return Math.min(maximumMs, baseMs * (2 ** Math.max(0, attempt)));
}
