import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { RepositorySecuritySurfaces } from "../src/infrastructure/repository-security-surfaces.js";

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atlas-surfaces-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

test("finds HTTP entry points and whether a guard is called in the same file", async () => {
  const root = await repository({
    "web/app/api/tasks/[id]/route.ts": "import { requireOperator } from \"../auth\";\nexport async function GET(request: Request) {\n  const account = await requireOperator(request);\n}\nexport const DELETE = async () => {};\n",
    "web/app/(marketing)/api/public/route.ts": "export async function POST() { return new Response(\"ok\"); }\n",
    "web/app/api/helpers.ts": "export async function GET() {}\n",
    "server/index.mjs": "app.get(\"/health\", ok);\nrouter.post('/items', create);\n// app.get(\"/commented\", x);\nif (url.pathname === \"/v1/stats\" && request.method === \"GET\") {}\nif (url.pathname.startsWith(\"/v1/files/\")) {}\n",
    "server/runner.mjs": "const identity = await verifyRunnerIdentity(token);\nif (url.pathname === \"/v1/result\") {}\n",
    "web/app/api/tasks/route.test.ts": "export async function GET() {}\n",
  });
  try {
    const surfaces = await new RepositorySecuritySurfaces().find(root);
    const entries = surfaces.entryPoints.map((entry) => [entry.style, entry.methods.join(","), entry.route, `${entry.evidence.file}:${entry.evidence.line}`, entry.guard ? `${entry.guard.file}:${entry.guard.line}` : null]);
    assert.deepEqual(entries, [
      ["express", "GET", "/health", "server/index.mjs:1", null],
      ["express", "POST", "/items", "server/index.mjs:2", null],
      ["node-pathname", "GET", "/v1/stats", "server/index.mjs:4", null],
      ["node-pathname", "", "/v1/files/*", "server/index.mjs:5", null],
      ["node-pathname", "", "/v1/result", "server/runner.mjs:2", "server/runner.mjs:1"],
      ["file-route", "POST", "/api/public", "web/app/(marketing)/api/public/route.ts:1", null],
      ["file-route", "GET,DELETE", "/api/tasks/[id]", "web/app/api/tasks/[id]/route.ts:2", "web/app/api/tasks/[id]/route.ts:3"],
    ], "only route files are file routes; route groups are dropped; comments, imports and tests are ignored");
    assert.equal(surfaces.summary.withoutGuard, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finds sinks by kind, without mistaking RegExp exec or literal URLs for them", async () => {
  const root = await repository({
    "src/run.mjs": [
      "import { spawn } from \"node:child_process\";",
      "const child = spawn(command, args);",
      "const match = /x/.exec(line);",
      "child_process.execSync(cmd, { shell: true });",
      "const value = eval(input);",
      "await db.run(`DELETE FROM t WHERE id = ${id}`);",
      "await db.run(\"SELECT 1\");",
      "await fetch(\"https://api.example.com/x\");",
      "await fetch(`https://api.example.com/x`);",
      "await fetch(target);",
      "const key = process.env.STRIPE_SECRET_KEY;",
      "const port = process.env.PORT;",
    ].join("\n"),
    "tool/app.py": "import os, subprocess\nsubprocess.run(argv)\ncursor.execute(f\"SELECT * FROM t WHERE id = {i}\")\ncursor.execute(\"SELECT 1\", (i,))\ntoken = os.environ[\"GITHUB_TOKEN\"]\nrequests.get(url)\n",
    "src/run.test.mjs": "spawn(x);\n",
  });
  try {
    const surfaces = await new RepositorySecuritySurfaces().find(root);
    assert.deepEqual(surfaces.sinks.map((sink) => [sink.kind, `${sink.evidence.file}:${sink.evidence.line}`]), [
      ["command-execution", "src/run.mjs:2"],
      ["command-execution", "src/run.mjs:4"],
      ["dynamic-code", "src/run.mjs:5"],
      ["raw-sql", "src/run.mjs:6"],
      ["computed-url-request", "src/run.mjs:10"],
      ["sensitive-env", "src/run.mjs:11"],
      ["command-execution", "tool/app.py:2"],
      ["raw-sql", "tool/app.py:3"],
      ["sensitive-env", "tool/app.py:5"],
      ["computed-url-request", "tool/app.py:6"],
    ]);
    assert.deepEqual(surfaces.summary.sinks, { "command-execution": 3, "dynamic-code": 1, "raw-sql": 2, "computed-url-request": 2, "sensitive-env": 2 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
