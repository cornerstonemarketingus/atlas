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
    const c = (t.categories[category.get(result.taskId) ?? "unknown"] ??= { runs: 0, passed: 0, quotaRefusals: 0 });
    c.runs++; c.passed += result.passed ? 1 : 0;
    c.quotaRefusals += result.failureClass === "quota" ? 1 : 0;
  }
  return Object.fromEntries(Object.entries(byTarget).map(([target, t]) => [target, {
    // Quota refusals measure the provider, not the model: out of the rate.
    runs: t.runs, attempted: t.runs - (t.failures.quota ?? 0), passed: t.passed, verifiedRuns: t.verified,
    passRate: t.runs - (t.failures.quota ?? 0) === 0 ? null : t.passed / (t.runs - (t.failures.quota ?? 0)),
    toolCalls: t.toolCalls, toolErrors: t.toolErrors, toolAccuracy: t.toolCalls === 0 ? null : 1 - t.toolErrors / t.toolCalls,
    repairs: t.repairs, inputTokens: t.inputTokens, outputTokens: t.outputTokens,
    medianLatencyMs: median(t.latencies), medianTtftMs: median(t.ttfts), failures: t.failures,
    categories: Object.fromEntries(Object.entries(t.categories).map(([name, c]) => {
      const attempted = c.runs - c.quotaRefusals;
      return [name, { ...c, attempted, passRate: attempted === 0 ? null : c.passed / attempted }];
    })),
  }]));
}

export function toJson({ results, tasks, generatedAt, notRun = [] }) {
  return JSON.stringify({ schemaVersion: 1, generatedAt, summary: summarize(results, tasks), results, notRun }, null, 2);
}

export function toMarkdown({ results, tasks, generatedAt, notRun = [] }) {
  const summary = summarize(results, tasks);
  const lines = [`# Atlas eval report`, "", `Generated ${generatedAt}. A pass means the task's own verify command exited 0; the agent's claims are not counted.`, ""];
  lines.push("| Target | Verified pass | Tool accuracy | Repairs | Median latency | Median TTFT | Tokens in/out | Failures |", "|---|---|---|---|---|---|---|---|");
  for (const [target, s] of Object.entries(summary)) {
    lines.push(`| ${target} | ${s.passed}/${s.attempted} (${pct(s.passed, s.attempted)})${s.attempted === s.runs ? "" : `, ${s.runs - s.attempted} refused for quota`} | ${s.toolAccuracy === null ? "n/a" : pct(s.toolCalls - s.toolErrors, s.toolCalls)} | ${s.repairs} | ${s.medianLatencyMs ?? "n/a"} ms | ${s.medianTtftMs ?? "n/a"} ms | ${s.inputTokens}/${s.outputTokens} | ${Object.entries(s.failures).map(([k, v]) => `${k}:${v}`).join(", ") || "none"} |`);
  }
  lines.push("", "## By category", "", "| Target | Category | Passed |", "|---|---|---|");
  for (const [target, s] of Object.entries(summary)) for (const [name, c] of Object.entries(s.categories)) lines.push(`| ${target} | ${name} | ${c.passed}/${c.attempted} (${pct(c.passed, c.attempted)})${c.quotaRefusals === 0 ? "" : `, ${c.quotaRefusals} refused for quota`} |`);
  lines.push("", "## Runs", "", "| Task | Target | Result | Failure | Latency |", "|---|---|---|---|---|");
  for (const r of results) lines.push(`| ${r.taskId} | ${r.target} | ${r.passed ? "pass" : "fail"} | ${r.failureClass ?? ""} | ${r.latencyMs} ms |`);
  if (notRun.length > 0) {
    lines.push("", "## Not run", "", "The provider's quota ran out, so these were not attempted. They are not failures.", "", "| Task | Target |", "|---|---|");
    for (const r of notRun) lines.push(`| ${r.taskId} | ${r.target} |`);
  }
  return lines.join("\n") + "\n";
}
