const pct = (n, d) => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);
const median = (values) => {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.floor((sorted.length - 1) / 2)];
};

/** Per-target and per-category verified pass rates plus medians. */
export function summarize(results, tasks = []) {
  const category = new Map(tasks.map((task) => [task.id, task.category]));
  const byTarget = {};
  for (const result of results) {
    const t = (byTarget[result.target] ??= { runs: 0, passed: 0, verified: 0, toolCalls: 0, toolErrors: 0, repairs: 0, inputTokens: 0, outputTokens: 0, latencies: [], ttfts: [], failures: {}, categories: {} });
    t.runs++; t.passed += result.passed ? 1 : 0; t.verified += result.verified ? 1 : 0;
    t.toolCalls += result.toolCalls; t.toolErrors += result.toolErrors; t.repairs += result.repairs;
    t.inputTokens += result.tokens.input; t.outputTokens += result.tokens.output;
    t.latencies.push(result.latencyMs); t.ttfts.push(result.ttftMs);
    if (result.failureClass) t.failures[result.failureClass] = (t.failures[result.failureClass] ?? 0) + 1;
    const c = (t.categories[category.get(result.taskId) ?? "unknown"] ??= { runs: 0, passed: 0 });
    c.runs++; c.passed += result.passed ? 1 : 0;
  }
  return Object.fromEntries(Object.entries(byTarget).map(([target, t]) => [target, {
    runs: t.runs, passed: t.passed, verifiedRuns: t.verified, passRate: t.runs === 0 ? null : t.passed / t.runs,
    toolCalls: t.toolCalls, toolErrors: t.toolErrors, toolAccuracy: t.toolCalls === 0 ? null : 1 - t.toolErrors / t.toolCalls,
    repairs: t.repairs, inputTokens: t.inputTokens, outputTokens: t.outputTokens,
    medianLatencyMs: median(t.latencies), medianTtftMs: median(t.ttfts), failures: t.failures, categories: t.categories,
  }]));
}

export function toJson({ results, tasks, generatedAt }) {
  return JSON.stringify({ schemaVersion: 1, generatedAt, summary: summarize(results, tasks), results }, null, 2);
}

export function toMarkdown({ results, tasks, generatedAt }) {
  const summary = summarize(results, tasks);
  const lines = [`# Atlas eval report`, "", `Generated ${generatedAt}. A pass means the task's own verify command exited 0; the agent's claims are not counted.`, ""];
  lines.push("| Target | Verified pass | Tool accuracy | Repairs | Median latency | Median TTFT | Tokens in/out | Failures |", "|---|---|---|---|---|---|---|---|");
  for (const [target, s] of Object.entries(summary)) {
    lines.push(`| ${target} | ${s.passed}/${s.runs} (${pct(s.passed, s.runs)}) | ${s.toolAccuracy === null ? "n/a" : pct(s.toolCalls - s.toolErrors, s.toolCalls)} | ${s.repairs} | ${s.medianLatencyMs ?? "n/a"} ms | ${s.medianTtftMs ?? "n/a"} ms | ${s.inputTokens}/${s.outputTokens} | ${Object.entries(s.failures).map(([k, v]) => `${k}:${v}`).join(", ") || "none"} |`);
  }
  lines.push("", "## By category", "", "| Target | Category | Passed |", "|---|---|---|");
  for (const [target, s] of Object.entries(summary)) for (const [name, c] of Object.entries(s.categories)) lines.push(`| ${target} | ${name} | ${c.passed}/${c.runs} |`);
  lines.push("", "## Runs", "", "| Task | Target | Result | Failure | Latency |", "|---|---|---|---|---|");
  for (const r of results) lines.push(`| ${r.taskId} | ${r.target} | ${r.passed ? "pass" : "fail"} | ${r.failureClass ?? ""} | ${r.latencyMs} ms |`);
  return lines.join("\n") + "\n";
}
