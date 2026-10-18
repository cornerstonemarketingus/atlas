import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendEntry, draftTask, readLog, recurringFailures, validateEntry } from "../src/index.mjs";
import { loadTasks } from "../src/index.mjs";

const entry = (over = {}) => ({ task: "PR #350 add retry", outcome: "failed", failureClass: "empty-model-response", model: "llama-3.3-70b", tokens: { input: 900, output: 40 }, humanIntervention: true, ...over });
const logFile = async () => join(await mkdtemp(join(tmpdir(), "dogfood-")), "log.jsonl");

test("entries need a failure class unless they succeeded, and refuse anything credential-shaped", () => {
  assert.deepEqual(validateEntry(entry()), []);
  assert.deepEqual(validateEntry(entry({ outcome: "success", failureClass: null })), []);
  assert.match(validateEntry(entry({ failureClass: null })).join(), /failureClass/u);
  assert.match(validateEntry(entry({ outcome: "success", failureClass: "x-y" })).join(), /failureClass/u);
  assert.match(validateEntry(entry({ notes: "key was gsk_abcdefghijklmnopqrstuvwx" })).join(), /credential/u);
  assert.match(validateEntry(entry({ notes: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123" })).join(), /credential/u);
  assert.match(validateEntry(entry({ humanIntervention: "yes" })).join(), /humanIntervention/u);
  assert.match(validateEntry(entry({ tokens: { input: -1, output: 0 } })).join(), /tokens/u);
});

test("the log is append-only: editing, deleting or reordering a line is detected", async () => {
  const file = await logFile();
  for (let i = 0; i < 3; i++) await appendEntry(file, entry({ task: `task ${i}` }));
  assert.equal((await readLog(file)).length, 3);
  const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
  await writeFile(file, [lines[0], lines[1].replace("task 1", "task X"), lines[2]].join("\n") + "\n");
  await assert.rejects(readLog(file), /edited/u);
  await writeFile(file, [lines[0], lines[2]].join("\n") + "\n");
  await assert.rejects(readLog(file), /out of sequence/u);
  await writeFile(file, lines.join("\n") + "\n");
  assert.equal((await readLog(file)).length, 3);
  await assert.rejects(appendEntry(file, entry({ outcome: "nope" })), /invalid dogfood entry/u);
  assert.equal((await readLog(file)).length, 3);
});

test("a failure class that recurs becomes a draft that is not a runnable task", async () => {
  const file = await logFile();
  for (const task of ["a", "b", "c"]) await appendEntry(file, entry({ task: `task ${task}` }));
  await appendEntry(file, entry({ task: "once", failureClass: "wrong-path" }));
  await appendEntry(file, entry({ task: "fine", outcome: "success", failureClass: null, humanIntervention: false }));
  const groups = recurringFailures(await readLog(file));
  assert.deepEqual(groups.map((g) => [g.failureClass, g.count, g.interventions]), [["empty-model-response", 3, 3]]);
  const draft = draftTask(groups[0]);
  assert.equal(draft.draft, true);
  assert.equal(draft.evidence.occurrences, 3);
  const dir = await mkdtemp(join(tmpdir(), "drafts-"));
  await writeFile(join(dir, "dogfood-empty-model-response.json"), JSON.stringify(draft));
  await assert.rejects(loadTasks(dir), /baseCommit|category|objective/u);
});
