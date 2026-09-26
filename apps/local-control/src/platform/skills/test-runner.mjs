import { TerminalController } from "../terminal/terminal-controller.mjs";

/**
 * Default skill test runner: materializes the package's files into a fresh
 * TerminalController workspace and runs each declared test argv there, with
 * only `node` allowlisted and no approval callback — so a test that asks for
 * anything the command policy classes `high` (network, installs) is not run
 * and counts as failed. A test passes only on exit code 0 without timeout.
 *
 * Runner contract (for injected runners):
 *   async ({ tenantId, manifest, files }) => ({ ok, results: [{ name, ok, exitCode, durationMs }] })
 */
export function createTerminalTestRunner({ rootDirectory, timeoutMs = 30_000, controller = undefined } = {}) {
  let terminal = controller;
  return async ({ tenantId, manifest, files }) => {
    terminal ??= new TerminalController({ rootDirectory, allowedExecutables: ["node"], timeoutMs, maxTimeoutMs: Math.max(timeoutMs, 60_000) });
    const workspace = terminal.createWorkspace({ tenantId, taskId: `skill-test-${manifest.name}-${manifest.version}`, template: { files } });
    const results = [];
    try {
      for (const test of manifest.tests) {
        let outcome;
        try {
          const handle = await terminal.runCommand(workspace.id, { argv: test.argv, timeoutMs });
          if (handle.status !== "running") {
            outcome = { name: test.name, ok: false, exitCode: null, reason: `requires approval: ${handle.reasons.join("; ")}` };
          } else {
            const result = await handle.result;
            outcome = {
              name: test.name, ok: result.exitCode === 0 && !result.timedOut, exitCode: result.exitCode, durationMs: result.durationMs,
              output: `${result.stdout}${result.stderr}`.slice(-2000),
            };
          }
        } catch (error) {
          outcome = { name: test.name, ok: false, exitCode: null, reason: String(error?.message ?? error).slice(0, 500) };
        }
        results.push(outcome);
      }
    } finally {
      await terminal.destroyWorkspace(workspace.id).catch(() => {});
    }
    return { ok: results.length > 0 && results.every((r) => r.ok), results };
  };
}
