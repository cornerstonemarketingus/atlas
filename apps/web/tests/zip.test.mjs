import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32, writeZip } from "../app/api/genesis/zip.mjs";

/** An independent reader: parses the central directory and checks every CRC. */
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files = {};
  for (let i = 0; i < count; i += 1) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const flags = view.getUint16(at + 8, true);
    assert.equal(view.getUint16(at + 10, true), 0, "STORE");
    assert.ok(flags & 0x800, "UTF-8 names");
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    assert.equal(crc32(data), crc, `crc of ${name}`);
    files[name] = Buffer.from(data).toString("utf8");
    at += 46 + nameLength;
  }
  return files;
}

test("crc32 matches the standard check values", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
});

test("entries round-trip with correct CRCs, UTF-8 names and empty files", () => {
  const zip = writeZip([{ name: "a.txt", data: "hello" }, { name: "dir/café ✓.txt", data: "ünï" }, { name: "empty", data: new Uint8Array() }]);
  assert.deepEqual(readZip(zip), { "a.txt": "hello", "dir/café ✓.txt": "ünï", empty: "" });
});

test("the same input is the same bytes (fixed timestamp)", () => {
  const entries = [{ name: "x", data: "1" }, { name: "y/z", data: "2" }];
  assert.deepEqual(writeZip(entries), writeZip(entries));
});

test("unsafe or duplicate names are refused", () => {
  for (const name of ["", "/abs", "a/../b", "..", "a//b", "a\\b", "dir/", "a\u0000b", "./a"]) assert.throws(() => writeZip([{ name, data: "x" }]), TypeError, JSON.stringify(name));
  assert.throws(() => writeZip([{ name: "a", data: "1" }, { name: "a", data: "2" }]), /Duplicate/u);
  assert.throws(() => writeZip([{ name: "a", data: 5 }]), TypeError);
});

test("python's zipfile and unzip accept the archive and agree on contents and CRC", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "zip-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const body = Buffer.alloc(100_000, "abc\n");
  const zip = writeZip([{ name: "p/one.txt", data: "one" }, { name: "p/big.bin", data: body }, { name: "p/ü.txt", data: "u" }]);
  const file = join(directory, "t.zip");
  writeFileSync(file, zip);
  const python = spawnSync("python3", ["-I", "-c", "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(sorted(z.namelist()))\nprint(z.read('p/one.txt').decode())", file], { encoding: "utf8" });
  if (python.error) t.diagnostic("python3 not available");
  else { assert.equal(python.status, 0, python.stderr); assert.match(python.stdout, /p\/ü\.txt/u); assert.match(python.stdout, /one/u); }
  const unzip = spawnSync("unzip", ["-tq", file], { encoding: "utf8" });
  if (unzip.error) t.diagnostic("unzip not available");
  else assert.equal(unzip.status, 0, unzip.stdout + unzip.stderr);
  assert.equal(readFileSync(file).length, zip.length);
});
