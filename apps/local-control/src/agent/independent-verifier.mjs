import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { npmInvocation, runCommand } from "./tools/process.mjs";

/**
 * Atlas's own verifier for a coder's work.
 *
 * The coder runs the repository's checks itself, but it compares them against
 * a baseline: on a repository that was already red, "no new failures" is what
 * it calls verified, and its exit code reports whether the agent finished, not
 * whether the tests pass. Neither is a receipt for "the tests pass now".
 *
 * This re-runs the repository's own test command in the worktree the coder
 * left behind, after it has exited, and reports exactly what happened: the
 * command, where it ran, its exit code and the tail of its output. Only exit
 * code 0 is "verified". No test command means "unverified", never verified.
 *
 * The command comes from the repository's package.json `test` script and is
 * run through the package manager, without a shell and with the same filtered
 * environment as every other tool (tools/process.mjs), so a repository script
 * cannot read the daemon's credentials.
 */
export const VERIFIER_PROFILE_ID = "atlas-verifier";
const NPM_PLACEHOLDER_TEST = /no test specified/iu;
const EXCERPT_CHARACTERS = 3_000;

export async function detectTestCommand(directory, { readFileImpl = readFile } = {}) {
  let manifest;
  try {
    manifest = JSON.parse(await readFileImpl(join(directory, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const script = manifest?.scripts?.test;
  if (typeof script !== "string" || !script.trim() || NPM_PLACEHOLDER_TEST.test(script)) return null;
  return { ...npmInvocation(["test"]), display: "npm test" };
}

export { npmInvocation };

/**
 * Holds an isolated coder run's result to the verifier: `ok` stays true only
 * when the repository's tests pass in its worktree. The receipt is attached as
 * `verification`, and the message says what ran and what it returned.
 */
export async function verifyCoderResult(result, verify, { verifyDir = "", signal } = {}) {
  if (!result?.ok || !result.worktree) return result;
  const receipt = await verify({ worktree: result.worktree, verifyDir, signal });
  if (receipt.status === "verified") return { ...result, verification: receipt, message: `${result.message ?? ""}\n\nVerified by Atlas: ${receipt.reason}`.trim() };
  const label = receipt.status === "unverified" ? "Unverified" : "Verification failed";
  return { ...result, ok: false, verification: receipt, message: `${label}: ${receipt.reason} The coder's report is not accepted as proof.\n${receipt.outputExcerpt.slice(-1_500)}\n\n${result.message ?? ""}`.trim() };
}

export function createIndependentVerifier({ runCommandImpl = runCommand, detect = detectTestCommand, timeoutMs = 10 * 60_000, now = () => Date.now() } = {}) {
  return async function verify({ worktree, verifyDir = "", signal } = {}) {
    const cwd = verifyDir ? join(worktree, verifyDir) : worktree;
    const base = { verifier: VERIFIER_PROFILE_ID, cwd, verifiedAt: new Date(now()).toISOString() };
    const command = await detect(cwd);
    if (!command) {
      return { ...base, status: "unverified", command: null, exitCode: null, outputExcerpt: "", durationMs: 0, reason: "The repository declares no test command (package.json scripts.test), so Atlas could not verify this change." };
    }
    const startedAt = now();
    const result = await runCommandImpl(command.program, command.args, { cwd, signal, timeoutMs, maxBytes: 400_000, env: { CI: "1", npm_config_update_notifier: "false" } });
    const durationMs = now() - startedAt;
    const output = `${result.stdout ?? ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    const outputExcerpt = output.length > EXCERPT_CHARACTERS ? `…${output.slice(-EXCERPT_CHARACTERS)}` : output;
    const exitCode = typeof result.status === "number" ? result.status : null;
    if (result.cancelled) return { ...base, status: "cancelled", command: command.display, exitCode, outputExcerpt, durationMs, reason: "The verification run was cancelled." };
    if (result.timedOut) return { ...base, status: "failed", command: command.display, exitCode, outputExcerpt, durationMs, reason: `\`${command.display}\` timed out after ${Math.round(timeoutMs / 1000)}s.` };
    if (result.code === "SPAWN_FAILED") return { ...base, status: "unverified", command: command.display, exitCode, outputExcerpt, durationMs, reason: `\`${command.display}\` could not be started: ${String(result.stderr ?? "").slice(0, 300)}` };
    return exitCode === 0
      ? { ...base, status: "verified", command: command.display, exitCode, outputExcerpt, durationMs, reason: `\`${command.display}\` passed (exit 0).` }
      : { ...base, status: "failed", command: command.display, exitCode, outputExcerpt, durationMs, reason: `\`${command.display}\` failed (exit ${exitCode ?? "none"}).` };
  };
}
