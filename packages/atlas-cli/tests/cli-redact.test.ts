import assert from "node:assert/strict";
import test from "node:test";

import { executeRedactCommand } from "../src/cli-redact.js";

const SECRET = "ghp_0123456789abcdefghijABCDEFGHIJ0123";
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

function harness(input: string) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    dependencies: {
      readInput: async () => input,
      write: (text: string) => out.push(text),
      writeError: (text: string) => err.push(text),
    },
  };
}

test("scrubs credentials from stdin and writes the result to stdout", async () => {
  const harnessed = harness(`token ${SECRET} and key ${AWS_KEY}`);
  assert.equal(await executeRedactCommand(["redact"], harnessed.dependencies), 0);
  assert.equal(harnessed.stdout().includes(SECRET), false);
  assert.equal(harnessed.stdout().includes(AWS_KEY), false);
  assert.match(harnessed.stdout(), /\[redacted:github-token:[0-9a-f]+\]/u);
  assert.match(harnessed.stdout(), /\[redacted:aws-access-key-id:[0-9a-f]+\]/u);
});

test("keeps a serialized JSON document parseable", async () => {
  // This is the runner's actual use: a whole artifact is piped through, so a
  // placeholder that broke JSON would corrupt every debug artifact.
  const document = JSON.stringify({ steps: [{ stdout: `expected "${SECRET}" to equal "x"` }] });
  const harnessed = harness(document);
  assert.equal(await executeRedactCommand(["redact"], harnessed.dependencies), 0);

  const parsed = JSON.parse(harnessed.stdout()) as { steps: { stdout: string }[] };
  assert.equal(parsed.steps[0]?.stdout.includes(SECRET), false);
  assert.match(parsed.steps[0]?.stdout ?? "", /\[redacted:github-token:/u);
});

test("leaves text with nothing to redact byte-identical", async () => {
  const input = "no credentials here, just a sha e81a9327c1f4b8a0d6e5c3b2a1908f7e6d5c4b3a\n";
  const harnessed = harness(input);
  assert.equal(await executeRedactCommand(["redact"], harnessed.dependencies), 0);
  assert.equal(harnessed.stdout(), input);
});

test("handles empty input without error", async () => {
  const harnessed = harness("");
  assert.equal(await executeRedactCommand(["redact"], harnessed.dependencies), 0);
  assert.equal(harnessed.stdout(), "");
});

test("writes the summary to stderr, never to stdout", async () => {
  // stdout is piped into a file by callers; a summary line landing there would
  // corrupt the artifact it is describing.
  const harnessed = harness(`token ${SECRET}`);
  assert.equal(await executeRedactCommand(["redact", "--summary"], harnessed.dependencies), 0);
  assert.equal(harnessed.stdout().includes("redactions="), false);
  assert.match(harnessed.stderr(), /redactions=1/u);
  assert.match(harnessed.stderr(), /github-token=1/u);
  assert.match(harnessed.stderr(), /truncated=false/u);
});

test("omits the summary unless it is asked for", async () => {
  const harnessed = harness(`token ${SECRET}`);
  assert.equal(await executeRedactCommand(["redact"], harnessed.dependencies), 0);
  assert.equal(harnessed.stderr(), "");
});

test("reports truncation honestly when input exceeds the scan bound", async () => {
  // A summary that under-reported truncation would claim coverage the scan did
  // not have, which is the one lie this tool must not tell.
  const harnessed = harness("x".repeat(500));
  assert.equal(await executeRedactCommand(["redact", "--max-characters", "100", "--summary"], harnessed.dependencies), 0);
  assert.match(harnessed.stderr(), /truncated=true/u);
});

test("rejects a nonsensical bound instead of silently using a default", async () => {
  for (const value of ["0", "-1", "1.5", "abc", "999999999"]) {
    const harnessed = harness("x");
    assert.equal(
      await executeRedactCommand(["redact", "--max-characters", value], harnessed.dependencies),
      2,
      value,
    );
    assert.equal(harnessed.stdout(), "", `${value} should produce no output`);
    assert.match(harnessed.stderr(), /--max-characters must be an integer/u);
  }
});

test("fails closed when redaction throws: no output, non-zero exit", async () => {
  // A caller redirecting stdout into a file must get an empty file and a
  // failing exit code, never the unredacted original.
  const harnessed = harness(SECRET);
  const failing = {
    ...harnessed.dependencies,
    readInput: async () => {
      throw new Error("stdin exploded");
    },
  };
  await assert.rejects(executeRedactCommand(["redact"], failing), /stdin exploded/u);
  assert.equal(harnessed.stdout(), "");
});
