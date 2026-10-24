#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One command that answers "can my local model really edit a file?".
 *
 * It makes a scratch git repository with a one-line bug and a check that fails,
 * runs Atlas's isolated local coder on it exactly as the dashboard's
 * repository.coder does (same model resolution, same Ollama provider, same
 * worktree and patch), and then judges the result itself rather than trusting
 * the coder's own report: the file must have changed, the original check and a hidden
 * second case must pass when run independently, only the named file may be
 * patched, and the patch must apply to a clean checkout.
 *
 * A model that only describes a fix, or edits the wrong thing, fails here.
 * Nothing outside the scratch directory is touched.
 */
const atlasRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
if (process.argv.includes("--help")) {
  console.log(`Usage: node scripts/local/verify-local-edit.mjs [--model <tag>] [--base-url <url>] [--keep]

Defaults to ATLAS_LOCAL_CODER_MODEL, then the Models-page plan, then an installed coder model.
Exit code 0 only when the file was really changed, the check passes independently, and the patch applies.`);
  process.exit(0);
}

const { judgeEdit } = await import(pathToFileURL(join(atlasRoot, "scripts/local/verify-local-edit-judge.mjs")).href);
const { runIsolatedLocalCoder } = await import(pathToFileURL(join(atlasRoot, "apps/local-control/src/runner.mjs")).href);
const { ModelPlanStore } = await import(pathToFileURL(join(atlasRoot, "apps/local-control/src/agent/models/hosting.mjs")).href);
const { homedir } = await import("node:os");

const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
const scratch = await mkdtemp(join(tmpdir(), "atlas-verify-edit-"));
const checkout = join(scratch, "project");
let verdict = { ok: false, reasons: [] };
try {
  git(scratch, "init", "--quiet", "project");
  git(checkout, "config", "user.email", "atlas@example.invalid");
  git(checkout, "config", "user.name", "Atlas");
  const original = "export function add(a, b) {\n  return a - b;\n}\n";
  await writeFile(join(checkout, "math.mjs"), original);
  const originalCheck = 'import { add } from "./math.mjs";\nif (add(2, 3) !== 5) { console.error("add(2, 3) should be 5"); process.exit(1); }\nconsole.log("check passed");\n';
  await writeFile(join(checkout, "check.mjs"), originalCheck);
  await writeFile(join(checkout, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node check.mjs" } }));
  git(checkout, "add", "-A");
  git(checkout, "commit", "--quiet", "-m", "Initial commit");
  const before = spawnSync(process.execPath, ["check.mjs"], { cwd: checkout });
  if (before.status === 0) throw new Error("The scratch check should fail before the edit.");

  const modelPlan = new ModelPlanStore(join(process.env.ATLAS_LOCAL_DATA_DIR || join(homedir(), ".atlas"), "model-plan.json"));
  console.log("Running the local coder on a scratch repository (this can take a few minutes on a laptop)…");
  const started = Date.now();
  const result = await runIsolatedLocalCoder(
    { id: `verify-${Date.now()}`, repository: checkout, objective: "The function add in math.mjs returns the wrong result: add(2, 3) must return 5. Fix math.mjs so that running `node check.mjs` passes. Change only math.mjs.", model: option("--model", "") },
    { dataDirectory: join(scratch, "data"), modelPlan, ...(option("--base-url", "") ? { baseUrl: option("--base-url") } : {}) },
  );
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`\n--- coder output (tail) ---\n${String(result.message ?? "").slice(-1500)}\n---------------------------\n`);

  const judged = await judgeEdit({ worktree: result.worktree, patch: result.patch, originalSource: original, originalCheck });
  const reasons = [...judged.reasons];
  const edited = judged.edited;
  if (result.patch && existsSync(result.patch) && git(checkout, "apply", "--check", result.patch).status !== 0) reasons.push("The patch does not apply to a clean checkout.");
  if (git(checkout, "status", "--porcelain").stdout.trim() !== "") reasons.push("The original checkout was modified (isolation failed).");
  verdict = { ok: reasons.length === 0, reasons, seconds, patch: result.patch ?? null, worktree: result.worktree ?? null, edited };
} catch (error) {
  verdict.reasons.push(error instanceof Error ? error.message : String(error));
}

if (verdict.ok) {
  console.log(`PASS: the local model changed the file, the check passes independently, and the patch applies (${verdict.seconds}s).\n\nPatch: ${verdict.patch}\nEdited math.mjs:\n${verdict.edited}`);
} else {
  console.log(`FAIL:\n${verdict.reasons.map((reason) => `  - ${reason}`).join("\n")}`);
}
if (!process.argv.includes("--keep") && !verdict.ok) await rm(scratch, { recursive: true, force: true });
else console.log(`Scratch directory kept: ${scratch}`);
process.exit(verdict.ok ? 0 : 1);
