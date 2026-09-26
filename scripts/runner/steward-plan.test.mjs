import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Runs steward-plan.mjs end to end against a fake GitHub API: a failed CI
 * run on an Atlas branch becomes a repair objective with the failing job's
 * log and a trusted reviewer's comment, exported for the next steps.
 */
test("a failed CI run on an Atlas branch plans a repair with the log and review feedback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "steward-"));
  const head = "a".repeat(40);
  const repo = { full_name: "cornerstonemarketingus/atlas" };
  const eventPath = path.join(dir, "event.json");
  fs.writeFileSync(eventPath, JSON.stringify({ workflow_run: { conclusion: "failure", head_branch: "atlas/task-t1", head_sha: head, head_repository: repo } }));
  const outputPath = path.join(dir, "out");
  const envPath = path.join(dir, "env");
  Object.assign(process.env, { GITHUB_REPOSITORY: "cornerstonemarketingus/atlas", GITHUB_TOKEN: "t", GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: "workflow_run", GITHUB_OUTPUT: outputPath, GITHUB_ENV: envPath });
  const posted = [];
  const pull = { number: 12, state: "open", created_at: "2026-09-26T09:00:00Z", head: { ref: "atlas/task-t1", sha: head, repo }, base: { ref: "main", repo } };
  const routes = [
    [/\/pulls\?state=open&head=/u, () => [pull]],
    [/\/issues\/12\/comments/u, (init) => { if (init?.method === "POST") { posted.push(JSON.parse(init.body).body); return {}; } return []; }],
    [/\/pulls\/12\/comments/u, () => [{ author_association: "OWNER", user: { login: "owner", type: "User" }, body: "Also handle null", path: "src/a.ts", line: 4, position: 1, created_at: "2026-09-26T10:00:00Z" }]],
    [/\/pulls\/12\/reviews/u, () => []],
    [new RegExp(`/commits/${head}/check-runs`, "u"), () => ({ check_runs: [{ id: 99, name: "apps/web", app: { slug: "github-actions" }, status: "completed", conclusion: "failure" }, { id: 98, name: "atlas-cli", app: { slug: "github-actions" }, status: "completed", conclusion: "success" }] })],
    [/\/commits\/main$/u, () => ({ sha: "b".repeat(40) })],
    [/\/commits\/b{40}\/check-runs/u, () => ({ check_runs: [{ name: "apps/web", status: "completed", conclusion: "success" }] })],
    [/\/actions\/jobs\/99\/logs/u, () => "2026-09-26T10:00:00Z not ok 1 - login redirects\n  expected: '/home'\n##[error]Process completed with exit code 1."],
  ];
  globalThis.fetch = async (url, init) => {
    const match = routes.find(([pattern]) => pattern.test(String(url)));
    if (!match) return new Response("not found", { status: 404 });
    const value = match[1](init);
    return typeof value === "string" ? new Response(value) : Response.json(value);
  };
  await import("./steward-plan.mjs");
  const out = fs.readFileSync(outputPath, "utf8");
  const env = fs.readFileSync(envPath, "utf8");
  assert.match(out, /action<<\w+\nrepair\n/u);
  assert.match(out, /pr_number<<\w+\n12\n/u);
  assert.match(out, /attempt<<\w+\n1\n/u);
  assert.match(out, new RegExp(`head_sha<<\\w+\\n${head}\\n`, "u"));
  assert.match(env, /ATLAS_TASK_ID<<\w+\nt1\n/u);
  assert.match(env, /ATLAS_BRANCH<<\w+\natlas\/task-t1\n/u);
  assert.match(env, /ATLAS_OBJECTIVE<<\w+\nRepair attempt 1 of 3 on pull request #12[\s\S]*## Failed: apps\/web\nnot ok 1 - login redirects[\s\S]*## Review by owner on src\/a\.ts:4\nAlso handle null/u);
  assert.equal(posted.length, 0, "no stop comment for a repairable failure");
});
