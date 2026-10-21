import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateTask } from "./task.mjs";

/** Loads every `*.json` task in a directory; throws on the first invalid or duplicate one. */
export async function loadTasks(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const tasks = [];
  const seen = new Set();
  for (const name of names) {
    const task = JSON.parse(await readFile(join(dir, name), "utf8"));
    const problems = validateTask(task);
    if (problems.length > 0) throw new Error(`${name}: ${problems.join("; ")}`);
    if (task.id !== name.replace(/\.json$/u, "")) throw new Error(`${name}: id must match the file name`);
    if (seen.has(task.id)) throw new Error(`${name}: duplicate id`);
    seen.add(task.id);
    tasks.push(task);
  }
  return tasks;
}

const DAY_MS = 86_400_000;

/**
 * One slice of the suite, for running it across days on a free daily quota.
 * `spec` is `k/n` (slice k of n, 1-based) or `day/n` (the slice for the UTC
 * day of `nowMs`, so a daily schedule walks every slice in n days). Tasks
 * are dealt round-robin by id. Adding or removing tasks can change slices.
 */
export function selectShard(tasks, spec, nowMs = Date.now()) {
  const match = /^(day|[1-9]\d*)\/([1-9]\d*)$/u.exec(String(spec));
  if (!match) throw new Error(`--shard must be k/n or day/n, not ${spec}`);
  const count = Number(match[2]);
  const index = match[1] === "day" ? Math.floor(nowMs / DAY_MS) % count : Number(match[1]) - 1;
  if (index >= count) throw new Error(`--shard ${spec}: slice is past ${count}`);
  const sorted = [...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { index: index + 1, count, tasks: sorted.filter((_, i) => i % count === index) };
}
