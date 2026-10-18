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
