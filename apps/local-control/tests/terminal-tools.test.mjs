import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ToolRegistry } from "../src/agent/tool-registry.mjs";
import { registerTerminalTools } from "../src/agent/tools/terminal-tools.mjs";
import { TerminalController } from "../src/platform/terminal/terminal-controller.mjs";

test("agents run allowlisted commands in a per-session workspace; risky ones wait for approval", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atlas-terminal-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const approved = new Set();
  const asked = [];
  const controller = new TerminalController({
    rootDirectory: root,
    approve: ({ argv }) => { asked.push(argv.join(" ")); return approved.has(argv.join(" ")); },
  });
  const registry = new ToolRegistry({ policy: () => "allow" });
  registerTerminalTools(registry, { controller });
  const run = (argv, sessionId = "s1") => registry.invoke({ name: "terminal.run", rawArguments: JSON.stringify({ argv }), sessionId, context: { sessionId } });

  const hello = await run(["node", "-e", "require('fs').writeFileSync('note.txt','hi'); console.log('ok')"]);
  assert.equal(hello.status, "completed", hello.message);
  assert.match(hello.output, /exit code 0[\s\S]*stdout:\nok/u);
  assert.match((await run(["cat", "note.txt"])).output, /hi/u, "the same session keeps its workspace");
  assert.match((await run(["cat", "note.txt"], "s2")).output, /exit code [1-9]/u, "another session has a separate workspace");

  const shell = await run(["bash", "-c", "echo hi"]);
  assert.equal(shell.status, "failed");
  assert.match(shell.message, /bash/u);

  // Network tools are refused unless the command asks for network access.
  const curl = await run(["curl", "https://example.com"]);
  assert.equal(curl.status, "failed");
  assert.match(curl.message, /network access/u);

  // npx downloads and runs code: it waits for an approval bound to this exact command.
  const risky = await run(["npx", "--version"]);
  assert.equal(risky.code, "APPROVAL_REQUIRED");
  assert.match(risky.message, /npx --version.*needs your approval/u);
  assert.deepEqual(asked, ["npx --version"]);
  approved.add("npx --version");
  const allowed = await run(["npx", "--version"]);
  assert.equal(allowed.status, "completed", allowed.message);
  assert.match(allowed.output, /exit code 0/u);
});

test("a machine without a terminal says so", async () => {
  const registry = new ToolRegistry({ policy: () => "allow" });
  registerTerminalTools(registry, { controller: async () => { throw new Error("No workspace root is writable."); } });
  const result = await registry.invoke({ name: "terminal.run", rawArguments: JSON.stringify({ argv: ["ls"] }), sessionId: "s", context: {} });
  assert.equal(result.code, "NO_TERMINAL");
});
