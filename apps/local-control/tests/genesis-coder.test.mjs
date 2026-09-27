import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GenesisService, GenesisStore } from "../src/platform/genesis/index.mjs";
import { GenesisExecutor } from "../src/platform/genesis/executor.mjs";
import { PreviewManager } from "../src/platform/genesis/preview.mjs";
import { inspectOverHttp } from "../src/platform/genesis/inspector.mjs";
import { createGenesisCoder } from "../src/platform/genesis/coder.mjs";
import { commitWorkspace, createWorkspace } from "../src/platform/genesis/workspace.mjs";
import { runCheck } from "../src/platform/self-improve/runtime.mjs";
import { startScriptedModelServer } from "./helpers/scripted-model-server.mjs";

/**
 * Genesis driving Atlas's REAL coder (packages/atlas-cli `atlas code`): the
 * CLI is built and spawned exactly as in production, it talks to a model
 * server over the OpenAI-compatible protocol, applies edits through its own
 * change-set tools and runs its own verification; Genesis then commits,
 * guards and re-verifies. Only the model's answers are scripted.
 *
 * Needs the CLI's dev dependencies (TypeScript) to build; the Genesis CI job
 * installs them. Elsewhere the test says why it is skipped.
 */

const atlasRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cliBuildable = existsSync(join(atlasRoot, "packages", "atlas-cli", "node_modules", "typescript"));
// In the Genesis CI job nothing may be skipped: a missing dependency is a failure there.
const required = process.env.GENESIS_REQUIRE_FULL === "1";
const skip = cliBuildable || required ? false : "packages/atlas-cli dependencies are not installed (the Genesis CI job installs them)";

const AUTH_MODULE = `import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Password hashing for sign-in (scrypt with a per-user salt).
export function hashPassword(password) {
  if (typeof password !== "string" || password.length < 8) throw new Error("Passwords need at least 8 characters.");
  const salt = randomBytes(16);
  return \`\${salt.toString("hex")}:\${scryptSync(password, salt, 32).toString("hex")}\`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const actual = scryptSync(String(password), Buffer.from(salt, "hex"), 32);
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
`;

const AUTH_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "../src/auth.mjs";

test("passwords verify only with the right password", () => {
  const stored = hashPassword("correct horse battery");
  assert.equal(verifyPassword("correct horse battery", stored), true);
  assert.equal(verifyPassword("wrong password", stored), false);
});

test("short passwords are refused", () => {
  assert.throws(() => hashPassword("short"), /8 characters/u);
});
`;

async function harness(decide, run) {
  const root = mkdtempSync(join(tmpdir(), "atlas-genesis-coder-"));
  const model = await startScriptedModelServer(decide);
  const store = new GenesisStore(join(root, "genesis.sqlite"));
  const genesis = new GenesisService({ store, policy: () => ({ decision: "allow" }) });
  const coder = createGenesisCoder({ atlasRoot, dataDirectory: root, environment: { ATLAS_GENESIS_BASE_URL: model.baseUrl, ATLAS_GENESIS_MODEL: "scripted-coder" } });
  const preview = new PreviewManager({ registryPath: join(root, "previews.json"), runPrepare: runCheck });
  const executor = new GenesisExecutor({ genesis, projectsRoot: join(root, "projects"), runCheck, coder, preview, inspector: (project, running) => inspectOverHttp(project, running) });
  try {
    await run({ root, genesis, executor, coder, model });
  } finally {
    await preview.stopAll();
    await model.close();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

test("a real bug is repaired by Atlas's real coder and verified again", { skip, timeout: 600_000 }, async () => {
  let original = null;
  await harness(({ objective, turn }) => {
    if (turn > 0) return { say: "Restored the number check in src/store.mjs." };
    if (/failing/u.test(objective) && original) return { edits: [{ path: "src/store.mjs", content: original }] };
    return { say: "Nothing to change." };
  }, async ({ root, genesis, executor, coder, model }) => {
    assert.equal(await coder.available(), true);
    const project = await genesis.create("Build a REST API for managing inventory items");
    // Scaffold, then plant a real bug (numbers are validated backwards) before the checks run.
    const workspace = await createWorkspace({ root: join(root, "projects"), projectId: project.id, spec: project.spec, templateId: project.plan.template });
    original = readFileSync(join(workspace.folder, "src", "store.mjs"), "utf8");
    writeFileSync(join(workspace.folder, "src", "store.mjs"), original.replace('field.type === "number" && !Number.isFinite(Number(value))', 'field.type === "number" && Number.isFinite(Number(value))'));
    await commitWorkspace(workspace.folder, "Plant a bug");

    const done = await executor.run(project.id);
    assert.equal(done.state, "ready", JSON.stringify(done.transitions.at(-1), null, 1));
    assert.equal(done.repairsUsed, 1);
    const repairing = done.transitions.find((t) => t.to === "repairing");
    assert.match(repairing.reason, /Failing test: Items/u, "the repair names the failing test");
    const result = done.transitions.find((t) => t.evidence.kind === "repair-result").evidence;
    assert.equal(result.ok, true);
    assert.equal(result.model, "scripted-coder");
    assert.match(result.commit, /^[0-9a-f]{40}$/u);
    assert.ok(model.requests.some((r) => /failing/u.test(r.objective) && r.tools.includes("repository.propose_change_set")), "the coder offered its edit tools to the model");
    assert.equal(readFileSync(join(done.workspace, "src", "store.mjs"), "utf8"), original);
  });
});

test("a coder task (sign-in) is built by the real coder, its tests count, and the app is verified", { skip, timeout: 600_000 }, async () => {
  await harness(({ objective, turn }) => {
    if (turn > 0) return { say: "Done." };
    if (/sign-in/u.test(objective)) return { edits: [{ operation: "create", path: "src/auth.mjs", content: AUTH_MODULE }, { operation: "create", path: "tests/auth.test.mjs", content: AUTH_TEST }] };
    return { say: "The interface already follows the guidelines; no changes." };
  }, async ({ genesis, executor }) => {
    const project = await genesis.create("Build a small app where my team can log in and track tasks");
    const done = await executor.run(project.id);
    assert.equal(done.state, "ready", JSON.stringify(done.transitions.at(-1), null, 1));
    const signIn = done.tasks.find((t) => /sign-in/u.test(t.title));
    assert.equal(signIn.status, "passed");
    assert.equal(signIn.evidence.at(-1).model, "scripted-coder");
    assert.ok(existsSync(join(done.workspace, "src", "auth.mjs")));
    const checks = done.transitions.findLast((t) => t.to === "previewing").evidence.results;
    assert.ok(checks.find((r) => r.name === "test").summary.pass >= 6, "the new tests ran with the app's own");
    assert.equal(done.tasks.find((t) => t.kind === "polish").status, "passed", "the polish pass ran through the real coder");
  });
});

const { loadPlaywright, createInspector } = await import("../src/platform/genesis/inspector.mjs");
const browserSkip = required ? false : await (async () => {
  if (skip) return skip;
  const playwright = await loadPlaywright();
  if (!playwright) return "Playwright is not installed (the Genesis CI job installs it)";
  try { const browser = await playwright.chromium.launch({ headless: true }); await browser.close(); return false; } catch { return "Chromium is not installed"; }
})();

test("a visual problem found in the screenshots is repaired by the real coder, then the app is checked again", { skip: browserSkip, timeout: 600_000 }, async () => {
  const { createVisionReviewer } = await import("../src/platform/genesis/vision.mjs");
  let visionCalls = 0;
  const root = mkdtempSync(join(tmpdir(), "atlas-genesis-visual-"));
  const model = await startScriptedModelServer(({ objective, messages, turn }) => {
    const images = Array.isArray(messages[0]?.content) && messages[0].content.some((part) => part.type === "image_url");
    if (images) {
      visionCalls += 1;
      return { say: visionCalls === 1
        ? '{"issues":[{"screenshot":1,"problem":"The page heading is too faint to read on a phone.","severity":"error"}]}'
        : '{"issues":[{"screenshot":1,"problem":"Cards could use a little more space between them.","severity":"warning"}]}' };
    }
    if (turn > 0) return { say: "Done." };
    if (/too faint to read/u.test(objective)) {
      const css = readFileSync(join(root, "projects", readdirOnly(join(root, "projects")), "public", "styles.css"), "utf8");
      return { edits: [{ path: "public/styles.css", content: `${css}\nh1 { color: var(--text); font-weight: 700; }\n` }] };
    }
    return { say: "No changes needed." };
  });
  const store = new GenesisStore(join(root, "genesis.sqlite"));
  const genesis = new GenesisService({ store, policy: () => ({ decision: "allow" }) });
  const environment = { ATLAS_GENESIS_BASE_URL: model.baseUrl, ATLAS_GENESIS_MODEL: "scripted-coder", ATLAS_GENESIS_VISION_MODEL: "qwen2.5vl:7b" };
  const preview = new PreviewManager({ registryPath: join(root, "previews.json"), runPrepare: runCheck });
  const executor = new GenesisExecutor({
    genesis, projectsRoot: join(root, "projects"), runCheck, preview,
    coder: createGenesisCoder({ atlasRoot, dataDirectory: root, environment }),
    inspector: createInspector({ artifactsRoot: join(root, "inspections"), vision: createVisionReviewer({ environment }) }),
  });
  try {
    const project = await genesis.create("Build a simple customer lead tracker with name, email, phone, status, notes and search");
    const done = await executor.run(project.id);
    assert.equal(done.state, "ready", JSON.stringify(done.transitions.at(-1), null, 1));
    const repairing = done.transitions.find((t) => t.to === "repairing" && t.evidence.kind === "failure");
    assert.equal(repairing.evidence.failure.check, "browser");
    assert.match(repairing.reason, /too faint to read/u);
    assert.match(readFileSync(join(done.workspace, "public", "styles.css"), "utf8"), /font-weight: 700/u, "the real coder changed the stylesheet");
    assert.equal(done.repairsUsed, 1);
    const summary = done.transitions.at(-1).evidence.summary;
    assert.equal(summary.inspection.limited, false);
    assert.equal(summary.inspection.visual.reviewed, true);
    assert.ok(summary.limitations.some((line) => /Visual suggestion/u.test(line)), "the second review's suggestion is reported, not blocking");
    assert.ok(visionCalls >= 2);
  } finally {
    await preview.stopAll();
    await model.close();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

function readdirOnly(directory) {
  const [only] = readdirSync(directory);
  return only;
}
