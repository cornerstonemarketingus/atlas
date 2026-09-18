import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const atlasRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function runLocalCoder(task, options = {}) {
  const script = resolve(atlasRoot, "scripts", "local", "run-coder.mjs");
  const args = [script, "--repository", task.repository, "--objective", task.objective, "--model", task.model];
  if (options.verifyDir) args.push("--verify-dir", options.verifyDir);
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { cwd: atlasRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let summary = "";
    let settled = false;
    const collect = (stream) => (chunk) => {
      const text = chunk.toString();
      summary = `${summary}${text}`.slice(-8_000);
      options.onEvent?.({ type: "runner.output", payload: { stream, text: text.slice(-16_000) } });
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    const abort = () => { if (!settled) child.kill(); };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => resolveRun({ ok: false, message: error.message }));
    child.on("close", (code) => {
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      resolveRun({ ok: code === 0 && !options.signal?.aborted, cancelled: options.signal?.aborted === true, message: options.signal?.aborted ? "Cancelled by the operator." : summary.trim() || `Atlas exited with code ${code}.` });
    });
  });
}

export async function runIsolatedLocalCoder(task, options = {}) {
  const { dataDirectory, verifyDir, signal, onEvent } = options;
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

  const result = await runLocalCoder({ ...task, repository: worktree }, { verifyDir, signal, onEvent });
  const diff = await capture("git", ["-C", worktree, "diff", "--binary", "--no-ext-diff"]);
  const patch = join(patches, `${task.id}.patch`);
  if (diff.ok && diff.stdout.length > 0) await writeFile(patch, diff.stdout, { encoding: "utf8", mode: 0o600 });
  const delivery = `Isolated worktree: ${worktree}${diff.stdout.length > 0 ? `\nPortable patch: ${patch}` : "\nNo patch was produced."}`;
  return { ...result, message: `${result.message}\n\n${delivery}`.trim() };
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
