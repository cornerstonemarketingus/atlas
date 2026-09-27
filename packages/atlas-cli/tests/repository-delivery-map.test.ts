import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { RepositoryDeliveryMap, summarizeWorkflow } from "../src/infrastructure/repository-delivery-map.js";

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atlas-delivery-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const DEPLOY = [
  "name: Deploy",
  "on:",
  "  push:",
  "    branches:",
  "      - main",
  "      - 'release/**'",
  "  workflow_dispatch:",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: npm test",
  "  deploy:",
  "    name: Ship it",
  "    needs: test",
  "    steps:",
  "      - uses: cloudflare/wrangler-action@v3",
  "      # - run: npx vercel deploy --prod   (commented out: not a target)",
  "      - run: npx wrangler d1 migrations apply DB --remote",
  "      - run: npm publish --provenance",
  "      - uses: docker/build-push-action@v6",
].join("\n");

test("summarizes a workflow's triggers, branches, jobs and deploy steps with lines", () => {
  const workflow = summarizeWorkflow(".github/workflows/deploy.yml", DEPLOY);
  assert.equal(workflow.name, "Deploy");
  assert.deepEqual(workflow.triggers, ["push", "workflow_dispatch"]);
  assert.deepEqual(workflow.branches, ["main", "release/**"]);
  assert.deepEqual(workflow.jobs, [{ id: "test", name: null, line: 9 }, { id: "deploy", name: "Ship it", line: 13 }]);
  assert.deepEqual(workflow.deploys.map((step) => [step.target, step.job, step.evidence.line]), [
    ["Cloudflare Workers", "deploy", 17],
    ["Cloudflare D1 (remote database changes)", "deploy", 19],
    ["npm registry", "deploy", 20],
    ["Container registry (if push: true)", "deploy", 21],
  ]);
  assert.ok(!workflow.deploys.some((step) => step.target === "Vercel"), "commented-out steps are not targets");
});

test("reads inline and list trigger forms", () => {
  assert.deepEqual(summarizeWorkflow("w.yml", "on: [push, pull_request]\njobs:\n  a:\n    steps: []\n").triggers, ["push", "pull_request"]);
  assert.deepEqual(summarizeWorkflow("w.yml", "on: workflow_dispatch\n").triggers, ["workflow_dispatch"]);
  const flow = summarizeWorkflow("w.yml", "on:\n  pull_request:\n    branches: [main, 'next']\n  schedule:\n    - cron: '0 0 * * *'\n");
  assert.deepEqual([flow.triggers, flow.branches], [["pull_request", "schedule"], ["main", "next"]]);
});

test("maps CI systems and platform config files to targets across the repository", async () => {
  const root = await repository({
    ".github/workflows/deploy.yml": DEPLOY,
    ".github/workflows/ci.yml": "name: CI\non: pull_request\njobs:\n  test:\n    steps:\n      - run: npm test\n",
    ".gitlab-ci.yml": "stages: [test]\n",
    "apps/web/wrangler.toml": "name = \"web\"\n",
    "services/api/Dockerfile": "FROM node:22\n",
    "fly.toml": "app = \"x\"\n",
    "vercel.json": "{}\n",
    "node_modules/pkg/vercel.json": "{}\n",
  });
  try {
    const map = await new RepositoryDeliveryMap().build(root);
    assert.deepEqual(map.ci, [{ system: "GitHub Actions", file: ".github/workflows/ci.yml" }, { system: "GitLab CI", file: ".gitlab-ci.yml" }]);
    assert.deepEqual(map.workflows.map((workflow) => [workflow.file, workflow.deploys.length]), [[".github/workflows/ci.yml", 0], [".github/workflows/deploy.yml", 4]]);
    assert.deepEqual(map.targets.map((target) => [target.target, target.evidence.map((item) => `${item.file}:${item.line}`)]), [
      ["Cloudflare D1 (remote database changes)", [".github/workflows/deploy.yml:19"]],
      ["Cloudflare Workers", [".github/workflows/deploy.yml:17", "apps/web/wrangler.toml:1"]],
      ["Container image (Dockerfile)", ["services/api/Dockerfile:1"]],
      ["Container registry (if push: true)", [".github/workflows/deploy.yml:21"]],
      ["Fly.io", ["fly.toml:1"]],
      ["npm registry", [".github/workflows/deploy.yml:20"]],
      ["Vercel", ["vercel.json:1"]],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
