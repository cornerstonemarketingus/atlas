import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ToolRegistry } from "../src/agent/tool-registry.mjs";
import { createDaemonSkills, createSkillRoutes, registerSkillTools } from "../src/platform/skills/daemon.mjs";
import { signSkillPackage } from "../src/platform/skills/index.mjs";

const T = "local";
const FIXTURE = new URL("./fixtures/skills/echo/", import.meta.url);
const read = (path) => readFileSync(new URL(path, FIXTURE), "utf8");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KEY = { publicKeyPem: publicKey.export({ type: "spki", format: "pem" }), privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) };

function signedEcho(overrides = {}) {
  return signSkillPackage({
    manifest: {
      name: "echo", version: "1.0.0", publisher: "acme", description: "Upper-cases text.",
      tools: [{ name: "echo.say", description: "Echo text back in upper case.", risk: "read", consequential: false,
        inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", maxLength: 100 } } }, entry: "tools/echo.mjs" }],
      permissions: ["echo.*"], tests: [{ name: "echo", argv: ["node", "tests/echo.test.mjs"] }], ...overrides,
    },
    files: { "tools/echo.mjs": read("tools/echo.mjs"), "tests/echo.test.mjs": read("tests/echo.test.mjs") },
    privateKeyPem: KEY.privateKeyPem,
  });
}

async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-daemon-skills-"));
  const skills = createDaemonSkills({ dataDirectory: directory });
  const registry = new ToolRegistry({ policy: () => "allow" });
  const parseBody = async (request) => { let text = ""; for await (const chunk of request) text += chunk; return JSON.parse(text || "{}"); };
  const send = (response, status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); return true; };
  const routes = createSkillRoutes({ skills, tenantId: T, owner: "alice", parseBody, send, mount: () => registerSkillTools(registry, skills, T) });
  let role = "admin";
  const server = createServer(async (request, response) => { if (!(await routes(request, response, { role }))) send(response, 404, {}); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.close(); skills.close(); await rm(directory, { recursive: true, force: true }); });
  const call = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { call, registry, skills, setRole: (value) => { role = value; } };
}

test("an approved skill installs over the API, mounts its tool, runs, is audited, and stops when deactivated", async (t) => {
  const { call, registry, skills } = await harness(t);
  const pkg = signedEcho();
  assert.equal((await call("POST", "/v1/skills/publishers", { publisher: "acme", publicKeyPem: KEY.publicKeyPem })).status, 200);
  assert.equal((await call("POST", "/v1/skills/ceiling", { permissions: ["echo.*"] })).status, 200);

  // Installing without an approval is refused.
  const early = await call("POST", "/v1/skills/install", { package: pkg, approvalId: "nope" });
  assert.equal(early.status, 403);
  assert.equal(registry.has("echo.say"), false);

  const request = await call("POST", "/v1/skills/install-requests", { package: pkg });
  assert.equal(request.status, 202);
  assert.equal(request.body.status, "pending");
  const approved = await call("POST", `/v1/skills/approvals/${request.body.id}/approve`, {});
  assert.equal(approved.body.status, "approved");
  const installed = await call("POST", "/v1/skills/install", { package: pkg, approvalId: request.body.id });
  assert.equal(installed.status, 201, JSON.stringify(installed.body));
  assert.deepEqual(installed.body.mounted.mounted, ["echo.say"]);

  const ran = await registry.invoke({ name: "echo.say", rawArguments: { text: "hi" }, sessionId: "s1" });
  assert.equal(ran.status, "completed", JSON.stringify(ran));
  assert.match(JSON.stringify(ran), /HI/u);

  const listed = await call("GET", "/v1/skills");
  assert.deepEqual(listed.body.active.map((s) => s.name), ["echo"]);
  assert.ok(listed.body.audit.some((e) => e.action === "install" && e.outcome === "ok"));

  assert.equal((await call("POST", "/v1/skills/echo/deactivate", {})).status, 200);
  const after = await registry.invoke({ name: "echo.say", rawArguments: { text: "hi" }, sessionId: "s1" });
  assert.notEqual(after.status, "completed", "a deactivated skill must not run");
  assert.equal(skills.activeVersion(T, "echo"), null);
});

test("writes need the owner, an untrusted publisher is refused, and tampered files never install", async (t) => {
  const { call, registry, setRole } = await harness(t);
  const pkg = signedEcho();
  assert.equal((await call("POST", "/v1/skills/install-requests", { package: pkg })).body.code, "UNTRUSTED_PUBLISHER");
  setRole("device");
  assert.equal((await call("POST", "/v1/skills/publishers", { publisher: "acme", publicKeyPem: KEY.publicKeyPem })).status, 403);
  setRole("admin");
  await call("POST", "/v1/skills/publishers", { publisher: "acme", publicKeyPem: KEY.publicKeyPem });
  await call("POST", "/v1/skills/ceiling", { permissions: ["echo.*"] });
  const tampered = { ...pkg, files: { ...pkg.files, "tools/echo.mjs": "export async function execute() { return { output: 'owned' }; }" } };
  assert.equal((await call("POST", "/v1/skills/install-requests", { package: tampered })).body.code, "DIGEST_MISMATCH");
  assert.equal(registry.has("echo.say"), false);
});
