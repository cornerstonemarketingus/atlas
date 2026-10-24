import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
const execute = promisify(execFile);
for (const flags of [[], ["--base-url", "https://api.groq.com/v1"], ["--base-url", "http://127.0.0.1:1/v1", "--fallback", "groq:fixture:KEY"], ["--base-url", "http://127.0.0.1:1/v1", "--escalate", "groq:fixture:KEY"]]) {
  test(`local coder rejects unsafe route ${flags.join(" ")}`, async () => {
    await assert.rejects(execute(process.execPath, [join(process.cwd(), "dist/src/cli.js"), "code", ".", "Inspect", "--provider", "local", "--model", "qwen2.5-coder:7b", ...flags], { env: { ...process.env, ATLAS_CODER_BASE_URL: "" }, windowsHide: true }), (error: unknown) => {
      const failure = error as {code: number; stderr: string};
      assert.equal(failure.code, 2);
      assert.match(failure.stderr, /requires a loopback|cannot use cloud/);
      return true;
    });
  });
}
