import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const atlasRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function runLocalCoder(task, options = {}) {
  const script = resolve(atlasRoot, "scripts", "local", "run-coder.mjs");
  const args = [script, "--repository", task.repository, "--objective", task.objective, "--model", task.model];
  if (options.verifyDir) args.push("--verify-dir", options.verifyDir);
  const { signal } = options;
  if (signal?.aborted) return Promise.resolve({ ok: false, cancelled: true, message: "Cancelled before the coder started." });
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { cwd: atlasRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let summary = "";
    let cancelled = false;
    // SIGTERM rather than SIGKILL: the coder writes its audit tail on the way
    // out, and a cancelled run still owes the operator a receipt.
    const abort = () => { cancelled = true; child.kill("SIGTERM"); };
    signal?.addEventListener("abort", abort, { once: true });
    const settle = (value) => { signal?.removeEventListener("abort", abort); resolveRun(value); };
    const collect = (chunk) => { summary = `${summary}${chunk}`.slice(-8_000); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => settle({ ok: false, message: error.message }));
    child.on("close", (code) => settle(cancelled
      ? { ok: false, cancelled: true, message: summary.trim() || "The coder was cancelled." }
      : { ok: code === 0, message: summary.trim() || `Atlas exited with code ${code}.` }));
  });
}

/**
 * `runCoder` is injectable so the isolation itself — worktree creation, patch
 * capture, leaving the operator's checkout untouched — can be tested without
 * standing up a model server.
 */
export async function runIsolatedLocalCoder(task, { dataDirectory, verifyDir, signal, runCoder = runLocalCoder } = {}) {
  if (!dataDirectory) throw new Error("A local data directory is required for isolated runs.");
  const worktrees = join(dataDirectory, "worktrees");
  const patches = join(dataDirectory, "patches");
  const worktree = join(worktrees, task.id);
  await mkdir(worktrees, { recursive: true });
  await mkdir(patches, { recursive: true });

  const repository = resolve(task.repository);
  const inside = await capture("git", ["-C", repository, "rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") return { ok: false, message: "Repository is not a Git work tree." };
  const add = await capture("git", ["-C", repository, "worktree", "add", "--detach", worktree, "HEAD"]);
  if (!add.ok) return { ok: false, message: `Could not create an isolated worktree: ${add.stderr.trim()}` };

  const result = await runCoder({ ...task, repository: worktree }, { verifyDir, signal });
  // The diff is captured even for a cancelled run: partial work in the
  // worktree is still the operator's, and a patch they can read is the
  // difference between "Atlas stopped" and "Atlas stopped and lost it".
  //
  // Staged, not `git diff`: a plain diff omits untracked files, so every file
  // the coder *created* — the common case for an agent — was silently missing
  // from the patch. The index being modified here is the throwaway worktree's
  // own; the operator's checkout and index are untouched.
  await capture("git", ["-C", worktree, "add", "-A"]);
  const diff = await capture("git", ["-C", worktree, "diff", "--cached", "--binary", "--no-ext-diff"]);
  const patch = join(patches, `${task.id}.patch`);
  const wrotePatch = diff.ok && diff.stdout.length > 0;
  if (wrotePatch) await writeFile(patch, diff.stdout, { encoding: "utf8", mode: 0o600 });
  const delivery = `Isolated worktree: ${worktree}${wrotePatch ? `\nPortable patch: ${patch}` : "\nNo patch was produced."}`;
  return {
    ...result,
    worktree,
    patch: wrotePatch ? patch : null,
    patchBytes: wrotePatch ? Buffer.byteLength(diff.stdout, "utf8") : 0,
    message: `${result.message}\n\n${delivery}`.trim(),
  };
}

function capture(command, args) {
  return new Promise((resolveCapture) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-2_000_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-64_000); });
    child.on("error", (error) => resolveCapture({ ok: false, stdout, stderr: error.message }));
    child.on("close", (code) => resolveCapture({ ok: code === 0, stdout, stderr }));
  });
}
