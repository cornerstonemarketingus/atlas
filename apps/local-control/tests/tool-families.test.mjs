import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ToolRegistry } from "../src/agent/tool-registry.mjs";
import { registerRepositoryTools } from "../src/agent/tools/repository-tools.mjs";
import { registerRepositoryWriteTools, APPROVED_TEST_COMMANDS } from "../src/agent/tools/repository-write-tools.mjs";
import { registerFilesystemTools, confineToRoots } from "../src/agent/tools/filesystem-tools.mjs";
import { registerBrowserTools, assertNavigableUrl } from "../src/agent/tools/browser-tools.mjs";
import { registerCommunicationsTools, messageDigest } from "../src/agent/tools/communications-tools.mjs";
import { registerWorkflowTools } from "../src/agent/tools/workflow-tools.mjs";
import { createZipArchive, sanitizeEntryName } from "../src/agent/tools/archive.mjs";
import { runCommand, safeEnvironment } from "../src/agent/tools/process.mjs";
import { createPlaywrightPage, createLocalScreenshotStore, BrowserUnavailableError } from "../src/agent/browser/playwright-page.mjs";
import { confineRealPath } from "../src/agent/tools/path-confinement.mjs";
import { normalizeAttachment, loadAttachment } from "../src/agent/attachments.mjs";
import { symlink } from "node:fs/promises";

const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

async function repository(t) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-tool-repo-"));
  git(directory, "init", "--quiet", ".");
  git(directory, "config", "user.email", "atlas@example.invalid");
  git(directory, "config", "user.name", "Atlas");
  await writeFile(join(directory, "README.md"), "# Project\n", "utf8");
  git(directory, "add", "README.md");
  git(directory, "commit", "--quiet", "-m", "init");
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return directory;
}

function registryFor(approved = new Set()) {
  const registry = new ToolRegistry({ policy: () => "allow" });
  const approvals = { check: async (digest) => approved.has(digest) };
  return { registry, approvals, approved };
}

const call = (registry, approvals, context) => (name, args) =>
  registry.invoke({ name, rawArguments: JSON.stringify(args), sessionId: "s1", approvals, context });

test("repository write, rename, diff, branch, and commit work against a real repository", async (t) => {
  const root = await repository(t);
  const { registry, approvals } = registryFor();
  registerRepositoryTools(registry);
  registerRepositoryWriteTools(registry);
  const run = call(registry, approvals, { repository: root });

  assert.equal((await run("repository.write", { path: "src/app.js", content: "export const x = 1;\n" })).status, "completed");
  assert.ok(existsSync(join(root, "src", "app.js")));

  const diff = await run("repository.diff", {});
  assert.equal(diff.status, "completed");
  assert.match(diff.output, /src\/app\.js/u, "a newly created file appears in the diff");

  assert.equal((await run("repository.rename", { from: "src/app.js", to: "src/main.js" })).status, "completed");
  assert.ok(existsSync(join(root, "src", "main.js")));

  assert.match((await run("repository.branch", { name: "atlas/feature" })).output, /On branch atlas\/feature/u);
  const commit = await run("repository.commit", { message: "Add main.js" });
  assert.match(commit.output, /Committed [0-9a-f]+ with 1 file/u);
  assert.equal(git(root, "status", "--porcelain").trim(), "");

  const clean = await run("repository.commit", { message: "Nothing here" });
  assert.match(clean.output, /Nothing to commit/u);
});

test("repository write tools cannot escape the repository, and delete needs approval", async (t) => {
  const root = await repository(t);
  const { registry, approvals, approved } = registryFor();
  registerRepositoryTools(registry);
  registerRepositoryWriteTools(registry);
  const run = call(registry, approvals, { repository: root });

  for (const path of ["../escape.txt", "/etc/atlas-escape", "src/../../escape.txt"]) {
    const result = await run("repository.write", { path, content: "x" });
    assert.equal(result.code, "PATH_ESCAPES_REPOSITORY", `${path} must be refused`);
  }
  assert.equal((await run("repository.rename", { from: "README.md", to: "../stolen.md" })).code, "PATH_ESCAPES_REPOSITORY");

  await run("repository.write", { path: "doomed.txt", content: "bye" });
  const blocked = await run("repository.delete", { path: "doomed.txt" });
  assert.equal(blocked.status, "approval-required");
  assert.ok(existsSync(join(root, "doomed.txt")), "nothing was deleted without approval");

  approved.add(blocked.digest);
  assert.equal((await run("repository.delete", { path: "doomed.txt" })).status, "completed");
  assert.equal(existsSync(join(root, "doomed.txt")), false);
});

test("a branch name cannot smuggle a command-line option", async (t) => {
  const root = await repository(t);
  const { registry, approvals } = registryFor();
  registerRepositoryWriteTools(registry);
  const run = call(registry, approvals, { repository: root });
  for (const name of ["--upload-pack=touch /tmp/pwned", "-x", "a b", "../evil"]) {
    assert.equal((await run("repository.branch", { name })).code, "INVALID_INPUT", `'${name}' must be refused`);
  }
});

test("test commands come from a fixed list and need approval", async (t) => {
  const root = await repository(t);
  const { registry, approvals, approved } = registryFor();
  let ran = null;
  registerRepositoryWriteTools(registry, { runCommandImpl: async (command, args, options) => { ran = { command, args, cwd: options.cwd }; return { ok: true, status: 0, stdout: "2 passing", stderr: "" }; } });
  const run = call(registry, approvals, { repository: root });

  assert.equal((await run("repository.run_tests", { command: "rm -rf /" })).code, "INVALID_INPUT");
  const blocked = await run("repository.run_tests", { command: "npm-test" });
  assert.equal(blocked.status, "approval-required");
  assert.equal(ran, null, "no command ran without approval");

  approved.add(blocked.digest);
  const allowed = await run("repository.run_tests", { command: "npm-test" });
  assert.match(allowed.output, /npm-test passed/u);
  assert.deepEqual(ran.args, APPROVED_TEST_COMMANDS.get("npm-test")[1]);
  assert.equal(ran.cwd, root);
});

test("commands run without a shell and with an allow-listed environment", async () => {
  const result = await runCommand(process.execPath, ["-e", "console.log(process.env.ATLAS_TEST_SECRET ?? 'absent')"], { timeoutMs: 10_000 });
  assert.equal(result.ok, true);
  // The daemon's own environment is not inherited, so a credential exported
  // beside Atlas is not visible to a tool.
  process.env.ATLAS_TEST_SECRET = "leaked";
  const again = await runCommand(process.execPath, ["-e", "console.log(process.env.ATLAS_TEST_SECRET ?? 'absent')"], { timeoutMs: 10_000 });
  delete process.env.ATLAS_TEST_SECRET;
  assert.match(again.stdout, /absent/u);
  assert.equal("ATLAS_TEST_SECRET" in safeEnvironment(), false);

  const slow = await runCommand(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { timeoutMs: 150 });
  assert.equal(slow.timedOut, true);
  assert.equal(slow.ok, false);
});

test("filesystem tools stay in the workspace and archive real files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-fs-tools-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const workspace = join(directory, "workspace");
  await mkdir(join(workspace, "reports"), { recursive: true });

  const artifacts = [];
  const { registry, approvals } = registryFor();
  registerFilesystemTools(registry, { roots: [workspace] });
  const run = call(registry, approvals, { recordArtifact: (artifact) => artifacts.push(artifact) });

  assert.equal((await run("filesystem.write", { path: "reports/summary.md", content: "# Summary\n" })).status, "completed");
  assert.match((await run("filesystem.read", { path: "reports/summary.md" })).output, /# Summary/u);

  for (const path of ["../outside.txt", "/etc/passwd"]) {
    assert.equal((await run("filesystem.write", { path, content: "x" })).code, "PATH_OUTSIDE_WORKSPACE");
  }

  const archived = await run("filesystem.archive", { source: "reports", archivePath: "bundle.zip" });
  assert.match(archived.output, /Archived 1 file/u);
  const bytes = await readFile(join(workspace, "bundle.zip"));
  assert.equal(bytes.subarray(0, 2).toString("latin1"), "PK", "a real ZIP was written");

  const exported = await run("filesystem.export_artifact", { path: "bundle.zip", name: "report bundle" });
  assert.match(exported.output, /Recorded artifact 'report bundle'/u);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].name, "report bundle");

  assert.equal((await run("filesystem.archive", { source: "reports/missing", archivePath: "x.zip" })).status, "failed");
  assert.throws(() => confineToRoots([], "x"), /No filesystem workspace/u);
});

test("archive entry names cannot write outside the extraction directory", () => {
  assert.equal(sanitizeEntryName("../../etc/passwd"), "etc/passwd");
  assert.equal(sanitizeEntryName("/absolute/path.txt"), "absolute/path.txt");
  assert.equal(sanitizeEntryName("a\\b\\c.txt"), "a/b/c.txt");
  assert.throws(() => sanitizeEntryName("../.."), /not usable/u);
  const zip = createZipArchive([{ name: "ok.txt", content: "data" }]);
  assert.equal(zip.subarray(0, 2).toString("latin1"), "PK");
});

test("browser tools only open http(s) and gate sends and uploads behind approval", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-browser-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, "cv.pdf"), "pdf bytes", "utf8");

  const actions = [];
  const session = {
    navigate: async ({ url }) => { actions.push(["navigate", url]); return { url, title: "Example" }; },
    snapshot: async () => { actions.push(["snapshot"]); return "button ref=b1 'Apply now'"; },
    click: async ({ ref, submit }) => { actions.push(["click", ref, submit === true]); return { summary: `Clicked ${ref}.` }; },
    type: async ({ ref, text }) => { actions.push(["type", ref, text]); return { summary: `Typed into ${ref}.` }; },
    upload: async ({ ref, path }) => { actions.push(["upload", ref, path]); return { summary: `Attached ${path}.` }; },
    download: async () => ({ summary: "Downloaded.", path: "file.pdf" }),
    extract: async ({ fields }) => Object.fromEntries(fields.map((field) => [field.name, "value"])),
  };

  const { registry, approvals, approved } = registryFor();
  registerBrowserTools(registry, { session, uploadRoot: directory });
  const run = call(registry, approvals, {});

  assert.match((await run("browser.navigate", { url: "https://example.invalid/jobs" })).output, /Opened https:\/\/example\.invalid\/jobs/u);
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "not a url"]) {
    assert.equal((await run("browser.navigate", { url })).status, "failed", `${url} must be refused`);
  }
  assert.throws(() => assertNavigableUrl("ftp://example.invalid"), /only opens http and https/u);

  assert.match((await run("browser.snapshot", {})).output, /Apply now/u);
  assert.equal((await run("browser.click", { ref: "b1" })).status, "completed");
  assert.equal((await run("browser.type", { ref: "f1", text: "Alex" })).status, "completed");

  // Typing with submit must not quietly send the form.
  const sneaky = await run("browser.type", { ref: "f1", text: "Alex", submit: true });
  assert.equal(sneaky.status, "failed");
  assert.match(sneaky.message, /browser\.submit/u);

  const blockedSubmit = await run("browser.submit", { ref: "b1", intent: "Submit the job application" });
  assert.equal(blockedSubmit.status, "approval-required");
  assert.equal(actions.some(([kind, , submit]) => kind === "click" && submit === true), false, "nothing was submitted without approval");
  approved.add(blockedSubmit.digest);
  assert.equal((await run("browser.submit", { ref: "b1", intent: "Submit the job application" })).status, "completed");

  const blockedUpload = await run("browser.upload", { ref: "file", path: "cv.pdf" });
  assert.equal(blockedUpload.status, "approval-required");
  approved.add(blockedUpload.digest);
  assert.equal((await run("browser.upload", { ref: "file", path: "cv.pdf" })).status, "completed");
  approved.clear();
  const outside = await run("browser.upload", { ref: "file", path: "../../etc/passwd" });
  assert.equal(outside.status, "approval-required", "a new path needs its own approval");

  const extracted = await run("browser.extract", { fields: [{ name: "salary" }] });
  assert.deepEqual(JSON.parse(extracted.output), { salary: "value" });
});

test("a browser tool fails closed when no browser is available", async () => {
  const { registry, approvals } = registryFor();
  registerBrowserTools(registry, { session: null });
  const result = await call(registry, approvals, {})("browser.snapshot", {});
  assert.equal(result.status, "failed");
  assert.equal(result.code, "NO_BROWSER");
});

test("a message must be drafted, then approved with its exact content, before it sends", async () => {
  const sent = [];
  const { registry, approvals, approved } = registryFor();
  registerCommunicationsTools(registry, { send: async (message) => { sent.push(message); return { id: "receipt-1" }; } });
  const run = call(registry, approvals, { sessionId: "s1" });

  const message = { channel: "email", recipients: ["lead@example.invalid"], subject: "Hello", body: "Original body." };
  const draft = await run("communications.draft", message);
  assert.match(draft.output, /has not been sent/u);
  assert.equal(sent.length, 0);

  const blocked = await run("communications.send", message);
  assert.equal(blocked.status, "approval-required");
  assert.equal(sent.length, 0);

  approved.add(blocked.digest);
  assert.match((await run("communications.send", message)).output, /Sent to 1 recipient/u);
  assert.equal(sent.length, 1);

  // The approval is spent, and a changed body is a different action entirely.
  approved.clear();
  const edited = await run("communications.send", { ...message, body: "Edited after approval." });
  assert.equal(edited.status, "approval-required");
  assert.equal(sent.length, 1);

  // An approval obtained for content that was never drafted still cannot send.
  const undrafted = { channel: "email", recipients: ["other@example.invalid"], subject: "", body: "Never drafted." };
  const undraftedResult = await registry.invoke({
    name: "communications.send",
    rawArguments: JSON.stringify(undrafted),
    sessionId: "s1",
    approvals: { check: async () => true },
    context: {},
  });
  assert.equal(undraftedResult.status, "failed");
  assert.equal(undraftedResult.code, "NOT_DRAFTED");
  assert.equal(sent.length, 1);

  assert.equal(messageDigest(message), messageDigest({ ...message, recipients: [...message.recipients] }));
});

test("bulk outreach is refused rather than gated", async () => {
  const { registry, approvals } = registryFor();
  registerCommunicationsTools(registry, { send: async () => ({ id: "x" }) });
  const many = Array.from({ length: 9 }, (_, index) => `person${index}@example.invalid`);
  const result = await call(registry, approvals, {})("communications.draft", { channel: "email", recipients: many, body: "Buy our thing." });
  assert.equal(result.code, "INVALID_INPUT");
  assert.match(result.message, /at most 5 items/u);
});

test("workflow briefs are prepared, sourced, and never submitted", async () => {
  const briefs = [];
  const { registry, approvals } = registryFor();
  registerWorkflowTools(registry);
  const run = call(registry, approvals, { recordBrief: (brief) => briefs.push(brief) });

  const result = await run("workflow.job_application", {
    subject: "Backend engineer at Example Co",
    findings: [
      { section: "Role and employer", content: "Backend engineer, Example Co.", source: "https://example.invalid/jobs/1" },
      { section: "Draft cover letter", content: "Dear hiring team, …" },
    ],
  });

  assert.equal(result.status, "completed");
  assert.match(result.output, /# Job Application: Backend engineer at Example Co/u);
  assert.match(result.output, /Source: https:\/\/example\.invalid\/jobs\/1/u);
  assert.match(result.output, /Source: none supplied — verify before relying on this/u, "an unsourced claim is marked as such");
  assert.match(result.output, /## Not covered/u, "sections with no findings are listed rather than faked");
  assert.match(result.output, /Prepared, not sent/u);
  assert.equal(briefs.length, 1);

  for (const kind of ["crm_research", "sales_prospect", "marketing_campaign"]) {
    const brief = await run(`workflow.${kind}`, { subject: "Example Co", findings: [{ section: "Organization", content: "A company.", source: "https://example.invalid" }] });
    assert.equal(brief.status, "completed");
    assert.match(brief.output, /Prepared, not sent/u);
  }
});

test("every registered tool declares a complete, model-safe contract", () => {
  const { registry } = registryFor();
  registerRepositoryTools(registry);
  registerRepositoryWriteTools(registry);
  registerFilesystemTools(registry, { roots: ["/tmp"] });
  registerBrowserTools(registry, { session: null });
  registerCommunicationsTools(registry, { send: async () => ({ id: "x" }) });
  registerWorkflowTools(registry);

  const tools = registry.list();
  assert.ok(tools.length >= 20, `expected the full families to register, saw ${tools.length}`);
  for (const tool of tools) {
    assert.match(tool.name, /^[a-z]+\.[a-z_]+$/u);
    assert.ok(tool.capability.length > 0);
    assert.ok(["low", "moderate", "high", "critical"].includes(tool.risk));
  }
  // Anything that sends, submits, uploads, deletes, or executes needs approval.
  const consequential = tools.filter((tool) => /submit|upload|send|delete|run_tests/u.test(tool.name));
  assert.ok(consequential.length >= 5);
  for (const tool of consequential) {
    assert.equal(tool.requiresApproval, true, `${tool.name} must require approval`);
  }
  // The model-facing definitions must carry schemas and no credential names.
  const offered = registry.toModelTools();
  assert.equal(offered.length, tools.length);
  for (const definition of offered) {
    assert.equal(definition.function.parameters.type, "object");
  }
});


test("a lazy browser session is built once and only when a browser tool is used", async () => {
  let built = 0;
  const session = { snapshot: async () => "page", click: async () => ({ summary: "clicked" }) };
  const { registry, approvals } = registryFor();
  registerBrowserTools(registry, { session: async () => { built += 1; return session; } });

  assert.equal(built, 0, "registering does not launch a browser");
  const run = call(registry, approvals, {});
  await run("browser.snapshot", {});
  await run("browser.snapshot", {});
  assert.equal(built, 1, "the session is built once and reused");
});

test("a missing browser is reported as a missing browser, not a crash", async () => {
  await assert.rejects(
    () => createPlaywrightPage({ profileDirectory: "/tmp/atlas-none", importPlaywright: () => { throw new Error("Cannot find module"); } }),
    (error) => error instanceof BrowserUnavailableError && error.code === "NO_BROWSER",
  );

  const { registry, approvals } = registryFor();
  registerBrowserTools(registry, { session: async () => { throw new BrowserUnavailableError("Playwright is not installed on this machine."); } });
  const result = await call(registry, approvals, {})("browser.snapshot", {});
  assert.equal(result.status, "failed");
  assert.equal(result.code, "NO_BROWSER");
  assert.match(result.message, /not installed on this machine/u);
});

test("screenshots are written to the operator's disk with restrictive permissions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-shots-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const store = createLocalScreenshotStore(join(directory, "screenshots"));
  const path = await store.store({ bytes: Buffer.from("png bytes"), url: "https://example.invalid", takenAtMs: Date.parse("2026-01-01T12:00:00Z") });

  assert.match(path, /screenshots/u);
  assert.equal(await readFile(path, "utf8"), "png bytes");
  assert.equal(store.uploadsRequireApproval, true, "storing a screenshot never implies permission to send it");
});


test("a symlink inside a root cannot be used to read or write outside it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-symlink-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });

  const repo = join(directory, "repo");
  const outside = join(directory, "outside");
  await mkdir(join(repo, "sub"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "TOP SECRET", "utf8");
  await writeFile(join(repo, "sub", "ok.txt"), "ordinary file", "utf8");
  // A symlink pointing out of the repository, and one to an absolute system
  // path. Both are things a cloned repository can legitimately contain.
  await symlink(outside, join(repo, "escape"));
  await symlink("/etc/passwd", join(repo, "passwd-link"));

  const { registry, approvals } = registryFor();
  registerRepositoryTools(registry);
  registerRepositoryWriteTools(registry);
  const run = call(registry, approvals, { repository: repo });

  // path.resolve() only normalizes lexically, so before this was fixed every
  // one of these succeeded.
  for (const path of ["escape/secret.txt", "passwd-link"]) {
    const result = await run("repository.read", { path });
    assert.equal(result.status, "failed", `${path} must not be readable`);
    assert.equal(result.code, "PATH_ESCAPES_REPOSITORY");
  }

  const written = await run("repository.write", { path: "escape/planted.txt", content: "x" });
  assert.equal(written.status, "failed");
  assert.equal(existsSync(join(outside, "planted.txt")), false, "nothing was written outside the repository");

  // Ordinary paths, and a new file in a directory that does not exist yet,
  // must still work — the fix must not break writing.
  assert.equal((await run("repository.read", { path: "sub/ok.txt" })).status, "completed");
  assert.equal((await run("repository.write", { path: "new/deep/file.txt", content: "hi" })).status, "completed");
  assert.ok(existsSync(join(repo, "new", "deep", "file.txt")));
});

test("the workspace and attachment boundaries resist the same symlink escape", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-symlink-ws-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });

  const workspace = join(directory, "workspace");
  const outside = join(directory, "outside");
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "OUTSIDE DATA", "utf8");
  await symlink(outside, join(workspace, "link"));

  const { registry, approvals } = registryFor();
  registerFilesystemTools(registry, { roots: [workspace] });
  const run = call(registry, approvals, {});

  assert.equal((await run("filesystem.read", { path: "link/secret.txt" })).code, "PATH_OUTSIDE_WORKSPACE");
  assert.equal((await run("filesystem.write", { path: "link/planted.txt", content: "x" })).status, "failed");
  assert.equal(existsSync(join(outside, "planted.txt")), false);

  // Refused at normalize time, before the file is ever opened.
  assert.throws(
    () => normalizeAttachment({ kind: "text", name: "s", path: join(workspace, "link", "secret.txt") }, { root: workspace }),
    (error) => error.code === "PATH_ESCAPES_ROOT",
    "an attachment cannot be read through a symlink out of the root",
  );
  // And a legitimate attachment inside the workspace still loads.
  await writeFile(join(workspace, "inside.txt"), "fine", "utf8");
  const ok = await loadAttachment(normalizeAttachment({ kind: "text", name: "inside", path: join(workspace, "inside.txt") }, { root: workspace }));
  assert.equal(ok.bytes.toString("utf8"), "fine");
});

test("a root that is itself a symlink still accepts its own contents", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-symlink-root-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });

  const real = join(directory, "real-repo");
  const linked = join(directory, "linked-repo");
  await mkdir(real, { recursive: true });
  await writeFile(join(real, "file.txt"), "content", "utf8");
  await symlink(real, linked);

  // The root is reached through a symlink — a profile under a symlinked home,
  // for instance. Resolving the root too is what stops every path under it
  // looking like an escape.
  const confined = confineRealPath(linked, "file.txt", (code, message) => new Error(`${code}: ${message}`));
  assert.equal(confined, join(await import("node:fs/promises").then((fs) => fs.realpath(real)), "file.txt"));

  const { registry, approvals } = registryFor();
  registerRepositoryTools(registry);
  assert.equal((await call(registry, approvals, { repository: linked })("repository.read", { path: "file.txt" })).status, "completed");
});
