import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Smoke test for the `mcp-server` npm script, written the way an external MCP
 * client (Claude Code, Claude Desktop) talks to it: a bare child process and
 * newline-delimited JSON-RPC on stdio, with no Atlas client code in between.
 * It checks the script still points at a runnable entry, that the initialize
 * handshake completes, that the `notifications/initialized` notification gets
 * no reply, and that tools/list returns the four documented tools. Every byte
 * on stdout must be a JSON-RPC message, or a real client would fail to parse.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

test("mcp-server npm script: initialize handshake and tools/list over raw stdio", async (t) => {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const command = pkg.scripts?.["mcp-server"];
  assert.equal(command, "node src/platform/mcp-server/main-stdio.mjs");
  const entry = join(packageRoot, command.split(" ")[1]);

  const dir = mkdtempSync(join(tmpdir(), "atlas-mcp-smoke-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const child = spawn(process.execPath, ["--no-warnings", entry], {
    cwd: packageRoot,
    env: {
      // Inherited so the child starts on every OS (Windows needs SystemRoot);
      // any ATLAS_MCP_* already set in the caller's shell is dropped.
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ATLAS_MCP_"))),
      ATLAS_MCP_DB: join(dir, "platform.sqlite"),
      ATLAS_MCP_CREATE_DB: "1", // a fresh store; without this a missing file is refused
      ATLAS_MCP_TENANT: "local",
      ATLAS_MCP_USER: "owner",
      ATLAS_MCP_PERMISSIONS: "atlas.status_lookup,atlas.list_tasks",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));

  const lines = [];
  const waiters = [];
  let buffered = "";
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      lines.push(line);
      waiters.shift()?.();
    }
  });
  const nextMessage = async () => {
    if (lines.length === 0) {
      await Promise.race([
        new Promise((resolve) => waiters.push(resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`no reply from the MCP server; stderr: ${stderr}`)), 10_000).unref()),
      ]);
    }
    const line = lines.shift();
    return JSON.parse(line); // throws if anything but JSON reached stdout
  };
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
    const init = await nextMessage();
    assert.equal(init.id, 1);
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    assert.equal(init.result.serverInfo.name, "atlas");

    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await nextMessage();
    assert.equal(list.id, 2, "the notification must not produce a reply");
    assert.deepEqual(
      list.result.tools.map((tool) => tool.name).sort(),
      ["atlas.create_task", "atlas.list_artifacts", "atlas.list_tasks", "atlas.status_lookup"],
    );
    for (const tool of list.result.tools) {
      assert.equal(tool.inputSchema.type, "object", `${tool.name} has an input schema`);
      assert.equal(tool.outputSchema.type, "object", `${tool.name} has an output schema`);
    }

    // Granted: list_tasks. Not granted: create_task (default deny).
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "atlas.list_tasks", arguments: {} } });
    const listed = await nextMessage();
    assert.deepEqual(listed.result.structuredContent, { tasks: [] });
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "atlas.create_task", arguments: { objective: "x", successCriteria: ["y"] } } });
    const denied = await nextMessage();
    assert.equal(denied.result.isError, true);
    assert.equal(denied.result.structuredContent.error.code, "UNAUTHORIZED");
  } finally {
    child.stdin.end();
  }
  assert.equal(await exited, 0, `server should exit cleanly when stdin closes; stderr: ${stderr}`);
  assert.equal(buffered, "", "no partial line left on stdout");
  assert.equal(lines.length, 0, "no unexpected extra messages on stdout");
});

test("mcp-server refuses a database path that does not exist unless ATLAS_MCP_CREATE_DB=1", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-mcp-missing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entry = join(packageRoot, "src/platform/mcp-server/main-stdio.mjs");
  const missing = join(dir, "platfrom.sqlite"); // a typo, as a user would make it
  const child = spawn(process.execPath, ["--no-warnings", entry], {
    cwd: packageRoot,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ATLAS_MCP_"))),
      ATLAS_MCP_DB: missing,
      ATLAS_MCP_TENANT: "local",
      ATLAS_MCP_USER: "owner",
      ATLAS_MCP_PERMISSIONS: "atlas.*",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 2);
  assert.match(stderr, /ATLAS_MCP_DB does not exist: .*platfrom\.sqlite/u);
  assert.match(stderr, /ATLAS_MCP_CREATE_DB=1/u);
  assert.equal(stdout, "", "nothing on the protocol channel");
  assert.equal(existsSync(missing), false, "no empty database was created");
});
