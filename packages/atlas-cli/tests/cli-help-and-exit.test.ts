import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * The CLI as a person runs it: a real subprocess, both by path and through a
 * symlinked `atlas` bin (what `npm link` and `npx` install). Help is per
 * command, and every refusal exits non-zero so a script can tell.
 */
const CLI = join(process.cwd(), "dist/src/cli.js");

function run(args: readonly string[], entry = CLI) {
  const result = spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", input: "", timeout: 30_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const COMMANDS = [
  "inspect", "search", "symbols", "references", "read", "tree", "tests-for", "packages", "ci", "map", "surfaces", "schemas", "env",
  "redact", "replay", "github", "chat", "code", "undo",
] as const;

test("`atlas <command> --help` prints that command's usage, not the global list, and exits 0", () => {
  for (const command of COMMANDS) {
    for (const flag of ["--help", "-h"]) {
      const result = run([command, flag]);
      assert.equal(result.status, 0, `${command} ${flag}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`^Usage:\\n  atlas ${command} `, "u"), `${command} ${flag} prints its own usage`);
      for (const other of COMMANDS.filter((name) => name !== command)) {
        assert.doesNotMatch(result.stdout, new RegExp(`\\n  atlas ${other} `, "u"), `${command} ${flag} does not list '${other}'`);
      }
    }
  }
  const code = run(["code", "--help"]).stdout;
  assert.match(code, /--model <name>/u);
  assert.match(code, /--verify-timeout-ms N/u, "continuation lines of `code` are kept");
  const global = run(["--help"]);
  assert.equal(global.status, 0);
  for (const command of COMMANDS) assert.match(global.stdout, new RegExp(`\\n  atlas ${command} `, "u"));
});

test("a missing required value exits non-zero for every subcommand that takes one", () => {
  const cases: Array<[readonly string[], RegExp]> = [
    [["code", ".", "noop"], /--model requires a value/u],
    [["code", ".", "noop", "--model"], /--model requires a value/u],
    [["code", ".", "noop", "--model", "m", "--provider"], /--provider requires a value/u],
    [["chat", ".", "noop", "--endpoint", "http://127.0.0.1:1"], /--model requires a value/u],
    [["chat", ".", "noop", "--model", "m", "--endpoint"], /--endpoint requires a value/u],
    [["undo", ".", "--session"], /--session requires a value/u],
    [["env", ".", "--name"], /--name option requires a value/u],
    [["symbols", ".", "--query"], /--query option requires a value/u],
    [["search", ".", "q", "--scope"], /Scope must be/u],
    [["read", ".", "f", "--max-lines"], /--max-lines must be an integer/u],
    [["replay", "x.jsonl", "--session"], /--session requires/u],
    [["inspect", ".", "--format"], /Format must be/u],
    [["code"], /Usage:/u],
    [["nonsense"], /Usage:/u],
  ];
  for (const [args, message] of cases) {
    const result = run(args);
    assert.notEqual(result.status, 0, `atlas ${args.join(" ")} must fail`);
    assert.match(result.stderr, message, `atlas ${args.join(" ")}`);
  }
});

test("the symlinked `atlas` bin runs the CLI instead of exiting 0 silently", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-bin-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, "atlas");
  symlinkSync(CLI, bin);
  const missing = run(["code", ".", "noop"], bin);
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /--model requires a value/u);
  const help = run(["code", "--help"], bin);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage:\n  atlas code /u);
});
