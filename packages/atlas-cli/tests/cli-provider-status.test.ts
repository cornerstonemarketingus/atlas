import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const CLI_PATH = `${process.cwd()}\\dist\\src\\cli.js`;

test("provider-status reports a reachable local server with its model count", async (t) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/v1/models");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "llama3.1" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address !== null && typeof address === "object");

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    CLI_PATH,
    "provider-status",
    "--provider",
    "local",
    "--endpoint",
    `http://127.0.0.1:${address.port}/v1`,
    "--format",
    "json",
  ], { timeout: 10_000, windowsHide: true });

  assert.equal(stderr, "");
  const output = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(output["providerId"], "local");
  assert.equal(output["ready"], true);
  assert.match(output["message"] as string, /1 model available/u);
});

test("provider-status defaults to Ollama's loopback address when no endpoint is given", async () => {
  // Nothing is listening on the default port in this environment, so the
  // request must fail — but the failure message proves the default endpoint
  // (not some other default) is the one that was tried.
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    CLI_PATH,
    "provider-status",
    "--provider",
    "local",
    "--format",
    "json",
    "--timeout-ms",
    "200",
  ], { timeout: 10_000, windowsHide: true }).catch((error: { stdout: string; stderr: string }) => error);

  assert.equal(stderr, "");
  const output = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(output["providerId"], "local");
  assert.equal(output["ready"], false);
  assert.equal(output["endpoint"], "http://127.0.0.1:11434/v1/models");
});

test("provider-status for a cloud provider checks only for the API key, never the network", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    CLI_PATH,
    "provider-status",
    "--provider",
    "groq",
    "--format",
    "json",
  ], {
    timeout: 10_000,
    windowsHide: true,
    env: { ...process.env, GROQ_API_KEY: "" },
  }).catch((error: { stdout: string; stderr: string }) => error);

  assert.equal(stderr, "");
  const output = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(output["providerId"], "groq");
  assert.equal(output["ready"], false);
  assert.match(output["message"] as string, /GROQ_API_KEY is not set/u);
});

test("provider-status reports text format by default", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    CLI_PATH,
    "provider-status",
    "--provider",
    "groq",
    "--api-key-env",
    "ATLAS_TEST_NONEXISTENT_KEY",
  ], { timeout: 10_000, windowsHide: true }).catch((error: { stdout: string; stderr: string }) => error);

  assert.match(stdout, /Provider: groq/u);
  assert.match(stdout, /Status: not ready/u);
});

test("provider-status rejects an unknown provider", async () => {
  const result = await execFileAsync(process.execPath, [
    CLI_PATH,
    "provider-status",
    "--provider",
    "openai",
  ], { timeout: 10_000, windowsHide: true }).catch((error: { stderr: string; code: number }) => error);

  assert.match(result.stderr, /Unknown --provider 'openai'/u);
});
