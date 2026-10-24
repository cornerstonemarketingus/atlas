import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Decides whether a coder really fixed the scratch bug, without trusting
 * anything the coder could have edited.
 *
 * - The patch may touch only the file the objective names. A model that
 *   "fixes" the check, package.json or anything else fails, even if the check
 *   then passes.
 * - The check that decides is the ORIGINAL one, written back from the contents
 *   recorded before the coder ran, plus a hidden second case. A model that
 *   special-cases the visible example (`add(2, 3)`) fails the hidden one.
 */
export const HIDDEN_CHECK = 'import { add } from "./math.mjs";\nif (add(10, -4) !== 6 || add(0, 0) !== 0) { console.error("add(10, -4) should be 6 and add(0, 0) should be 0"); process.exit(1); }\nconsole.log("hidden check passed");\n';

export function patchedFiles(patchPath) {
  const out = spawnSync("git", ["apply", "--numstat", patchPath], { encoding: "utf8" });
  if (out.status !== 0) return null;
  return out.stdout.split("\n").filter(Boolean).map((line) => line.split("\t")[2]);
}

export async function judgeEdit({ worktree, patch, originalSource, originalCheck, targetFile = "math.mjs" }) {
  const reasons = [];
  const edited = worktree && existsSync(join(worktree, targetFile)) ? readFileSync(join(worktree, targetFile), "utf8") : null;
  if (edited === null) reasons.push("No isolated worktree was produced.");
  else if (edited === originalSource) reasons.push("The file was not changed: the model described or attempted a fix but no edit landed.");

  if (!patch || !existsSync(patch)) reasons.push("No patch was produced.");
  else {
    const files = patchedFiles(patch);
    if (files === null) reasons.push("The patch could not be read.");
    else if (files.some((file) => file !== targetFile)) reasons.push(`The patch touches files other than ${targetFile}: ${files.filter((file) => file !== targetFile).join(", ")}.`);
  }

  if (worktree) {
    // Run only checks the coder did not write.
    await writeFile(join(worktree, "check.original.mjs"), originalCheck);
    await writeFile(join(worktree, "check.hidden.mjs"), HIDDEN_CHECK);
    for (const [name, label] of [["check.original.mjs", "original check"], ["check.hidden.mjs", "hidden check"]]) {
      const run = spawnSync(process.execPath, [name], { cwd: worktree, encoding: "utf8" });
      if (run.status !== 0) reasons.push(`The ${label} fails: ${(run.stderr || run.stdout || "").trim().slice(0, 200)}`);
    }
  }
  return { ok: reasons.length === 0, reasons, edited };
}
