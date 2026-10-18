import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inferSpecification } from "../src/platform/genesis/requirements.mjs";
import { templateFor } from "../src/platform/genesis/planner.mjs";
import { TEMPLATES, getTemplate, templateFiles } from "../src/platform/genesis/templates/index.mjs";
import { commitWorkspace, createWorkspace, projectFolderName } from "../src/platform/genesis/workspace.mjs";
import { runCheck } from "../src/platform/self-improve/runtime.mjs";

const withRoot = async (run) => {
  const root = mkdtempSync(join(tmpdir(), "atlas-genesis-ws-"));
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
};
const gitLog = (folder) => execFileSync("git", ["log", "--format=%an|%s"], { cwd: folder, encoding: "utf8" }).trim().split("\n");

test("every template declares versioned commands, a preview and a structure, and ships its files", () => {
  for (const template of Object.values(TEMPLATES)) {
    assert.match(template.version, /^\d+\.\d+\.\d+$/u);
    for (const name of ["check", "test", "build"]) assert.ok(Array.isArray(template.commands[name]) && template.commands[name][0] === "node", `${template.id}.${name}`);
    assert.ok(template.preview.command.length && template.preview.health.startsWith("/"), template.id);
    assert.ok(Object.keys(template.structure).length >= 3);
    const files = templateFiles(template.id).map((file) => file.target);
    assert.ok(files.includes("server.mjs") && files.includes("src/http.mjs") && files.includes("scripts/check.mjs"), template.id);
    for (const { source } of templateFiles(template.id)) assert.ok(existsSync(source), source);
  }
  assert.throws(() => getTemplate("rails"), /Unknown Genesis template/u);
});

const SCENARIOS = [
  ["Build a simple customer lead tracker with: add customer, name/email/phone, status, notes, dashboard, search", "web-app"],
  ["Build me a booking website for my landscaping company.", "web-app"],
  ["Build a website for my roofing company", "static-site"],
  ["Build a REST API for managing inventory items", "api-service"],
  // Sign-in switched on: the generated tests run as the owner and check the gate.
  ["Build a small app where my team can log in and track tasks", "web-app"],
  ["Build a REST API for managing inventory items with user accounts and login", "api-service"],
];

for (const [prompt, expected] of SCENARIOS) {
  test(`"${prompt.slice(0, 48)}…" becomes a local ${expected} project whose own checks, tests and build pass`, () => withRoot(async (root) => {
    const spec = inferSpecification(prompt);
    assert.equal(templateFor(spec), expected);
    const workspace = await createWorkspace({ root, projectId: "gen_12345678-aaaa-bbbb-cccc-1234567890ab", spec, templateId: expected });
    assert.equal(workspace.folder, join(root, projectFolderName(spec.name, "gen_12345678-aaaa-bbbb-cccc-1234567890ab")));
    assert.match(workspace.commit, /^[0-9a-f]{40}$/u);
    assert.deepEqual(gitLog(workspace.folder), [`Atlas|Create ${spec.name} from the ${expected} template (v${getTemplate(expected).version})`]);
    const meta = JSON.parse(readFileSync(join(workspace.folder, ".atlas", "genesis.json"), "utf8"));
    assert.equal(meta.template, expected);
    assert.equal(JSON.parse(readFileSync(join(workspace.folder, "package.json"), "utf8")).dependencies && Object.keys(JSON.parse(readFileSync(join(workspace.folder, "package.json"), "utf8")).dependencies).length, 0, "nothing to install");
    const template = getTemplate(expected);
    for (const name of ["check", "test", "build"]) {
      const result = await runCheck(template.commands[name], workspace.folder, { timeoutMs: 120_000 });
      assert.equal(result.exitCode, 0, `${name} failed:\n${result.stdout}\n${result.stderr}`);
      if (name === "test") assert.match(`${result.stdout}`, /# pass [1-9]/u, "tests actually ran");
    }
    assert.ok(existsSync(join(workspace.folder, "dist")), "the build produced output");
    if (expected !== "static-site") {
      const config = JSON.parse(readFileSync(join(workspace.folder, "app.config.json"), "utf8"));
      assert.deepEqual(config.entities.map((e) => e.name), spec.entities.map((e) => e.name));
      assert.equal(config.auth.required, /log ?in/u.test(prompt), "sign-in is on exactly when asked for");
      assert.deepEqual(config.jobs.map((job) => job.name), config.auth.required ? ["purge-expired-sessions"] : []);
      for (const file of ["src/auth.mjs", "src/files.mjs", "src/secrets.mjs", "src/jobs.mjs", "src/cron.mjs", "tests/backend.test.mjs"]) assert.ok(existsSync(join(workspace.folder, file)), file);
      if (/booking/u.test(prompt)) {
        assert.equal(config.booking.entity, "bookings");
        assert.ok(config.entities[0].fields.find((f) => f.key === "date").required, "a booking needs a date");
      }
    } else {
      const site = JSON.parse(readFileSync(join(workspace.folder, "site.json"), "utf8"));
      assert.deepEqual(site.pages.map((p) => p.id), spec.pages.map((p) => p.id));
      assert.match(JSON.stringify(site), /Roof repairs/u, "copy fits the trade");
    }
  }));
}

test("a workspace never overwrites an existing folder and commits later changes", () => withRoot(async (root) => {
  const spec = inferSpecification("Build a REST API for managing inventory items");
  const workspace = await createWorkspace({ root, projectId: "gen_aaaaaaaa-0000-0000-0000-000000000000", spec, templateId: "api-service" });
  await assert.rejects(createWorkspace({ root, projectId: "gen_aaaaaaaa-0000-0000-0000-000000000000", spec, templateId: "api-service" }), (error) => error.code === "EXISTS");
  assert.equal(await commitWorkspace(workspace.folder, "Nothing changed"), null);
  writeFileSync(join(workspace.folder, "NOTES.md"), "Hello\n");
  const next = await commitWorkspace(workspace.folder, "Add notes");
  assert.match(next, /^[0-9a-f]{40}$/u);
  assert.equal(gitLog(workspace.folder)[0], "Atlas|Add notes");
  // Names that try to escape are reduced to a safe folder name.
  assert.equal(projectFolderName("../../etc/passwd", "gen_bbbbbbbb-0000"), "etc-passwd-bbbbbbbb");
  mkdirSync(join(root, "busy-cccccccc"), { recursive: true });
  writeFileSync(join(root, "busy-cccccccc", "x"), "");
  await assert.rejects(createWorkspace({ root, projectId: "gen_cccccccc-0000", spec: { ...spec, name: "Busy" }, templateId: "api-service" }), /already exists/u);
}));
