import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { unifiedLineDiff } from "../src/infrastructure/line-diff.js";
import { SafeRepositoryFileEditor } from "../src/infrastructure/safe-repository-file-editor.js";

/** Minimal strict patch applier: every context and removed line must match. */
function applyPatch(before: string, diff: readonly string[]): string {
  const source = before === "" ? [] : before.split(/(?<=\n)/);
  const output: string[] = [];
  let consumed = 0;
  let index = 2;
  while (index < diff.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(diff[index]!);
    assert.ok(header, `hunk header expected: ${diff[index]}`);
    const oldCount = header[2] === undefined ? 1 : Number(header[2]);
    const oldStart = oldCount === 0 ? Number(header[1]) : Number(header[1]) - 1;
    assert.ok(oldStart >= consumed, "hunks must be ordered and not overlap");
    output.push(...source.slice(consumed, oldStart));
    consumed = oldStart;
    index += 1;
    let seenOld = 0;
    while (index < diff.length && !diff[index]!.startsWith("@@")) {
      const line = diff[index]!;
      const noNewline = diff[index + 1] === "\\ No newline at end of file";
      const text = line.slice(1) + (noNewline ? "" : "\n");
      if (line[0] === " " || line[0] === "-") {
        assert.equal(source[consumed], text, `line ${consumed + 1} must match`);
        consumed += 1;
        seenOld += 1;
      }
      if (line[0] === " " || line[0] === "+") output.push(text);
      index += noNewline ? 2 : 1;
    }
    assert.equal(seenOld, oldCount, "hunk old count");
  }
  output.push(...source.slice(consumed));
  return output.join("");
}

function random(seed: number): () => number {
  let state = seed;
  return () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
}

function randomText(next: () => number, lines: number): string {
  const words = ["a", "b", "c", "d", "", "e"];
  let text = "";
  for (let index = 0; index < lines; index += 1) text += `${words[Math.floor(next() * words.length)]}\n`;
  return next() < 0.3 ? text.slice(0, -1) : text;
}

test("every generated diff reproduces the new text from the old", () => {
  const next = random(7);
  for (let round = 0; round < 400; round += 1) {
    const before = randomText(next, Math.floor(next() * 25));
    const after = randomText(next, Math.floor(next() * 25));
    for (const context of [0, 1, 3]) {
      const diff = unifiedLineDiff(before, after, "a/f", "b/f", { context });
      assert.equal(applyPatch(before, diff), after, JSON.stringify({ before, after, context }));
    }
    const capped = unifiedLineDiff(before, after, "a/f", "b/f", { maxEditDistance: 2 });
    assert.equal(applyPatch(before, capped), after, "the capped fallback is still a correct patch");
  }
});

test("a one-line change shows that line with context, not the whole file", () => {
  const lines = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`);
  const before = `${lines.join("\n")}\n`;
  const after = before.replace("line 100\n", "line one hundred\n");
  assert.deepEqual(unifiedLineDiff(before, after, "a/f.ts", "b/f.ts"), [
    "--- a/f.ts", "+++ b/f.ts", "@@ -97,7 +97,7 @@",
    " line 97", " line 98", " line 99", "-line 100", "+line one hundred", " line 101", " line 102", " line 103",
  ]);
});

test("far-apart changes get separate hunks and near ones share a hunk", () => {
  const lines = Array.from({ length: 40 }, (_, index) => `${index + 1}`);
  const before = `${lines.join("\n")}\n`;
  const far = before.replace("\n5\n", "\nfive\n").replace("\n30\n", "\nthirty\n");
  assert.equal(unifiedLineDiff(before, far, "a/f", "b/f").filter((line) => line.startsWith("@@")).length, 2);
  // git's boundary: six unchanged lines between changes share a hunk, seven do not.
  const hunkCount = (other: string): number => unifiedLineDiff(before, before.replace("\n5\n", "\nfive\n").replace(`\n${other}\n`, "\nX\n"), "a/f", "b/f")
    .filter((line) => line.startsWith("@@")).length;
  assert.equal(hunkCount("12"), 1);
  assert.equal(hunkCount("13"), 2);
});

test("creates, deletes and a missing final newline use the standard markers", () => {
  assert.deepEqual(unifiedLineDiff("", "x\ny\n", null, "b/n"), ["--- /dev/null", "+++ b/n", "@@ -0,0 +1,2 @@", "+x", "+y"]);
  assert.deepEqual(unifiedLineDiff("x\n", "", "a/n", null), ["--- a/n", "+++ /dev/null", "@@ -1 +0,0 @@", "-x"]);
  assert.deepEqual(unifiedLineDiff("x\n", "x", "a/n", "b/n"), [
    "--- a/n", "+++ b/n", "@@ -1 +1 @@", "-x", "+x", "\\ No newline at end of file",
  ]);
  assert.deepEqual(unifiedLineDiff("same\n", "same\n", "a/n", "b/n"), ["--- a/n", "+++ b/n"]);
});

test("git apply accepts the editor's diffs", async (t) => {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { t.skip("git is not installed"); return; }
  const root = await mkdtemp(join(tmpdir(), "atlas-line-diff-"));
  await mkdir(join(root, "src"));
  const before = `${Array.from({ length: 60 }, (_, index) => `const v${index} = ${index};`).join("\n")}\n`;
  const after = before.replace("const v10 = 10;\n", "const v10 = 11;\nconst extra = true;\n").replace("const v50 = 50;\n", "");
  await writeFile(join(root, "src/values.ts"), before);
  execFileSync("git", ["init", "-q"], { cwd: root });

  const editor = new SafeRepositoryFileEditor();
  const plan = await editor.preview(root, {
    operation: "update", path: "src/values.ts", content: after,
    expectedSha256: createHash("sha256").update(before).digest("hex"),
  });
  assert.equal(plan.diffTruncated, false);
  assert.ok(plan.diff.split("\n").length < 25, "only the changed regions are shown");
  await writeFile(join(root, "change.patch"), `${plan.diff}\n`);
  execFileSync("git", ["apply", "change.patch"], { cwd: root });
  assert.equal(await readFile(join(root, "src/values.ts"), "utf8"), after);
});

test("a full rewrite of a 100,000-line file stays bounded and correct", () => {
  const before = `${Array.from({ length: 100_000 }, (_, index) => `a${index % 7}`).join("\n")}\n`;
  const after = `${Array.from({ length: 100_000 }, (_, index) => `a${index % 5}`).join("\n")}\n`;
  const started = Date.now();
  const diff = unifiedLineDiff(before, after, "a/f", "b/f");
  assert.ok(Date.now() - started < 10_000, "the edit-distance cap bounds the search");
  assert.equal(applyPatch(before, diff), after);
});
