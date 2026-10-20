import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

export async function git(cwd, args, { input, buffer = false } = {}) {
  const child = run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: buffer ? "buffer" : "utf8", windowsHide: true });
  if (input !== undefined) child.child.stdin.end(input);
  const { stdout } = await child;
  return stdout;
}
