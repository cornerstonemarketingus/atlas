import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalTaskStore } from "../src/store.mjs";

// Read-only workspace and browser access is allowed by default (owner decision,
// 2026-10-24): filesystem.read is confined to the configured workspace roots and
// browser.read only reads pages the agent's own browser opened. Writes, running
// commands, publishing and desktop control still ask.
test("a fresh install allows workspace and browser reads, and still asks for writes and commands", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-default-policies-"));
  const store = new LocalTaskStore(join(directory, "atlas.sqlite"));
  // Close before deleting: Windows cannot remove an open database file.
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(store.policy("filesystem.read").decision, "allow");
  assert.equal(store.policy("browser.read").decision, "allow");
  for (const capability of ["code.write", "terminal.run", "publish.remote", "deploy.remote", "desktop.control"]) {
    assert.equal(store.policy(capability).decision, "ask", capability);
  }
  assert.equal(store.policy("filesystem.write").decision, "deny", "writes outside the repository are not granted by default");
});

test("an owner's saved decision survives a restart; the new defaults never overwrite it", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-default-policies-"));
  const file = join(directory, "atlas.sqlite");
  const first = new LocalTaskStore(file);
  first.setPolicy("filesystem.read", "deny");
  first.setPolicy("browser.read", "ask");
  first.close();
  const reopened = new LocalTaskStore(file);
  t.after(() => { reopened.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(reopened.policy("filesystem.read").decision, "deny");
  assert.equal(reopened.policy("browser.read").decision, "ask");
});
