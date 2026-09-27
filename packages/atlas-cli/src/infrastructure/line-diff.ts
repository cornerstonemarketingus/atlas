/**
 * Unified line diffs for coder edits: only the changed lines, with context,
 * in the format `git apply` and `patch` accept. A one-line change in a large
 * file costs a few lines in the model's context and the reviewer's view, not
 * the whole file twice.
 *
 * Myers' O(ND) algorithm runs on the region between the common prefix and
 * suffix. Past `maxEditDistance` it stops searching and reports that region
 * as one replacement: still a correct patch, only less minimal, so memory
 * and time stay bounded for any file the editor accepts.
 */

export interface LineDiffOptions {
  /** Unchanged lines shown around each change (git's default is 3). */
  readonly context?: number;
  /** Edit distance past which the middle region is reported as one replacement. */
  readonly maxEditDistance?: number;
}

interface Line {
  readonly text: string;
  /** False only for a final line with no trailing newline. */
  readonly newline: boolean;
}

type Operation = { readonly kind: " " | "-" | "+"; readonly line: Line };

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_EDIT_DISTANCE = 2_000;
const NO_NEWLINE = "\\ No newline at end of file";

/**
 * Returns the diff as lines, headers first. `null` labels mean the side does
 * not exist (`/dev/null`). Carriage returns before a newline are not shown:
 * the editor keeps a file's newline style, so they never differ.
 */
export function unifiedLineDiff(
  before: string,
  after: string,
  oldLabel: string | null,
  newLabel: string | null,
  options: LineDiffOptions = {},
): string[] {
  const context = nonNegative(options.context ?? DEFAULT_CONTEXT, "context");
  const maxEditDistance = nonNegative(options.maxEditDistance ?? DEFAULT_MAX_EDIT_DISTANCE, "maxEditDistance");
  const header = [`--- ${oldLabel ?? "/dev/null"}`, `+++ ${newLabel ?? "/dev/null"}`];
  const operations = diffLines(splitLines(before), splitLines(after), maxEditDistance);
  appendHunks(header, operations, context);
  return header;
}

function splitLines(text: string): Line[] {
  if (text === "") return [];
  const parts = text.replace(/\r\n/g, "\n").split("\n");
  const last = parts.pop()!;
  const lines: Line[] = parts.map((part) => ({ text: part, newline: true }));
  if (last !== "") lines.push({ text: last, newline: false });
  return lines;
}

function same(left: Line, right: Line): boolean {
  return left.text === right.text && left.newline === right.newline;
}

function diffLines(before: readonly Line[], after: readonly Line[], maxEditDistance: number): Operation[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && same(before[prefix]!, after[prefix]!)) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && same(before[before.length - 1 - suffix]!, after[after.length - 1 - suffix]!)) suffix += 1;

  const oldMiddle = before.slice(prefix, before.length - suffix);
  const newMiddle = after.slice(prefix, after.length - suffix);
  // Loops rather than spreads: a spread of a 100,000-line file overflows the stack.
  const operations: Operation[] = [];
  for (let index = 0; index < prefix; index += 1) operations.push({ kind: " ", line: before[index]! });
  const middle = myers(oldMiddle, newMiddle, maxEditDistance) ?? replacement(oldMiddle, newMiddle);
  for (const operation of middle) operations.push(operation);
  for (let index = before.length - suffix; index < before.length; index += 1) operations.push({ kind: " ", line: before[index]! });
  return operations;
}

function replacement(before: readonly Line[], after: readonly Line[]): Operation[] {
  const operations: Operation[] = [];
  for (const line of before) operations.push({ kind: "-", line });
  for (const line of after) operations.push({ kind: "+", line });
  return operations;
}

/** Shortest edit script, or null when it is longer than `limit`. */
function myers(before: readonly Line[], after: readonly Line[], limit: number): Operation[] | null {
  const n = before.length;
  const m = after.length;
  if (n === 0 || m === 0) return replacement(before, after);
  const maxD = Math.min(n + m, limit);
  // Row d holds the furthest x on diagonals -d..d (index k + d), so the whole
  // trace is O(D²) rather than O((N+M)·D).
  const trace: Int32Array[] = [];
  let previous = new Int32Array(1);
  for (let d = 0; d <= maxD; d += 1) {
    const row = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && at(previous, d - 1, k - 1) < at(previous, d - 1, k + 1));
      let x = d === 0 ? 0 : down ? at(previous, d - 1, k + 1) : at(previous, d - 1, k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && same(before[x]!, after[y]!)) { x += 1; y += 1; }
      row[k + d] = x;
      if (x >= n && y >= m) {
        trace.push(row);
        return backtrack(trace, before, after);
      }
    }
    trace.push(row);
    previous = row;
  }
  return null;
}

function at(row: Int32Array, d: number, k: number): number {
  return row[k + d]!;
}

function backtrack(trace: readonly Int32Array[], before: readonly Line[], after: readonly Line[]): Operation[] {
  const operations: Operation[] = [];
  let x = before.length;
  let y = after.length;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const previous = trace[d - 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(previous, d - 1, k - 1) < at(previous, d - 1, k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = at(previous, d - 1, previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) { x -= 1; y -= 1; operations.push({ kind: " ", line: before[x]! }); }
    if (down) { y -= 1; operations.push({ kind: "+", line: after[y]! }); }
    else { x -= 1; operations.push({ kind: "-", line: before[x]! }); }
  }
  while (x > 0 && y > 0) { x -= 1; y -= 1; operations.push({ kind: " ", line: before[x]! }); }
  return operations.reverse();
}

function appendHunks(output: string[], operations: readonly Operation[], context: number): void {
  const changed: number[] = [];
  operations.forEach((operation, index) => { if (operation.kind !== " ") changed.push(index); });
  // Line numbers before `scanned`, advanced once across all hunks.
  let scanned = 0;
  let oldStart = 1;
  let newStart = 1;
  let cursor = 0;
  while (cursor < changed.length) {
    let last = cursor;
    // Changes closer than twice the context share a hunk, as in git.
    while (last + 1 < changed.length && changed[last + 1]! - changed[last]! <= 2 * context + 1) last += 1;
    const start = Math.max(0, changed[cursor]! - context);
    const end = Math.min(operations.length, changed[last]! + context + 1);
    for (; scanned < start; scanned += 1) {
      if (operations[scanned]!.kind !== "+") oldStart += 1;
      if (operations[scanned]!.kind !== "-") newStart += 1;
    }
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let index = start; index < end; index += 1) {
      const operation = operations[index]!;
      if (operation.kind !== "+") oldCount += 1;
      if (operation.kind !== "-") newCount += 1;
      body.push(`${operation.kind}${operation.line.text}`);
      if (!operation.line.newline) body.push(NO_NEWLINE);
    }
    output.push(`@@ -${range(oldCount === 0 ? oldStart - 1 : oldStart, oldCount)} +${range(newCount === 0 ? newStart - 1 : newStart, newCount)} @@`);
    for (const line of body) output.push(line);
    cursor = last + 1;
  }
}

function range(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

function nonNegative(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer.`);
  return value;
}
