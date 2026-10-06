import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { runLocalCoder } from "../../runner.mjs";
import { runCommand } from "../tools/process.mjs";

/** Exercise the production coding loop against a disposable repository.
 * Never execute model-authored JavaScript in the daemon. Verification uses a
 * bounded child with Node filesystem/process permissions and no model key.
 * A prose answer or an exit code alone is not success.
 */
export async function probeCodingAgent(configuration, { runCoder = runLocalCoder } = {}) {
  const root = resolve(tmpdir());
  const repository = await mkdtemp(join(root, "atlas-coding-probe-"));
  try {
    await writeFile(join(repository, "sum.js"), "export function add(a, b) { return a - b; }\n");
    for (const args of [["init", repository], ["-C", repository, "add", "sum.js"],
      ["-C", repository, "-c", "user.name=Atlas Test", "-c", "user.email=atlas-test@example.invalid", "commit", "-m", "test fixture"]]) {
      const result = await runCommand("git", args, { timeoutMs: 10000 });
      if (!result.ok) return { passed: false, reason: "Could not create the coding verification repository." };
    }
    const result = await runCoder({ repository, model: configuration.model,
      objective: "Fix sum.js: add(a,b) must return a + b. Read the file and edit it. Do not change other files." },
    { modelConfiguration: configuration, signal: AbortSignal.timeout(180000) });
    const permissionFlag = process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : process.allowedNodeEnvironmentFlags.has("--experimental-permission") ? "--experimental-permission" : null;
    if (!permissionFlag) return { passed: false, reason: "Coding verification requires a Node runtime with filesystem permissions." };
    const check = await runCommand(process.execPath, [permissionFlag, `--allow-fs-read=${repository}`, "--input-type=module", "-e",
      "const {add}=await import('./sum.js'); if(typeof add!=='function'||add(2,3)!==5||add(-1,1)!==0||add(0,0)!==0||add(2.5,1.5)!==4)process.exit(1); console.log('PATCH_OK');"],
    { cwd: repository, timeoutMs: 5000, maxBytes: 1000 });
    const patchVerified = check.ok && check.stdout.trim() === "PATCH_OK";
    return { passed: result.ok && patchVerified, completed: result.ok, patchVerified, cancelled: result.cancelled === true };
  } finally {
    if (dirname(resolve(repository)) === root && basename(repository).startsWith("atlas-coding-probe-")) await rm(repository, { recursive: true, force: true });
  }
}
