import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLaneApplier } from "../src/agent/lane-apply.mjs";
import { buildCommandCenter } from "../src/platform/command-center.mjs";
import { LocalTaskStore } from "../src/store.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

/** A repository, a patch Atlas "produced" for it, and a mission whose finished lane points at that patch. */
async function fixture(t, { policy = "ask", patchInside = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atlas-lane-apply-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repo");
  const dataDirectory = join(root, "data");
  await mkdir(repository);
  await mkdir(join(dataDirectory, "patches"), { recursive: true });
  git(repository, "init", "-q");
  git(repository, "config", "user.email", "t@example.com");
  git(repository, "config", "user.name", "t");
  await writeFile(join(repository, "page.html"), "<h1>Pricing</h1>\n");
  git(repository, "add", "-A");
  git(repository, "commit", "-qm", "init");
  // The version's change, captured the way the isolated runner captures it.
  await writeFile(join(repository, "page.html"), "<h1>Pricing, redesigned</h1>\n");
  const diff = git(repository, "diff");
  git(repository, "checkout", "--", "page.html");
  const patch = join(patchInside ? join(dataDirectory, "patches") : root, "version-2.patch");
  await writeFile(patch, diff);

  const store = new LocalTaskStore(join(root, "atlas.sqlite"));
  t.after(() => store.close());
  store.setPolicy("code.write", policy);
  const mission = {
    id: "m1", title: "3 versions: Redesign pricing", status: "completed",
    children: [{ id: "version-2", objective: "Redesign pricing", state: "completed", attempts: 1,
      metadata: { repository, model: "m", variant: 2, variants: 3 },
      result: { summary: "done", handoff: { patch, worktree: join(root, "wt") } } }],
  };
  const missionService = { get: (id) => (id === "m1" ? mission : null) };
  return { repository, store, mission, applier: createLaneApplier({ missionService, store, dataDirectory }) };
}

const page = (repository) => readFile(join(repository, "page.html"), "utf8");

test("with code.write on ask, applying waits for approval and lands only after it", async (t) => {
  const { applier, store, repository } = await fixture(t);
  const requested = await applier.request("m1", "version-2");
  assert.equal(requested.status, "awaiting-approval");
  assert.match(requested.approval.summary, /Apply version 2 of 3 of "3 versions: Redesign pricing"/);
  assert.equal(await page(repository), "<h1>Pricing</h1>\n", "nothing changes before approval");

  const approval = store.decideApproval(requested.approval.id, "approved");
  const result = await applier.onApprovalDecided(approval);
  assert.equal(result.status, "applied");
  assert.equal(await page(repository), "<h1>Pricing, redesigned</h1>\n");
  assert.equal(git(repository, "log", "--oneline").trim().split("\n").length, 1, "applied to the working tree, not committed");
  assert.ok(store.auditEvents().some((event) => event.category === "lane.applied"));
});

test("a denied approval applies nothing, and an approval for a changed repository is stale", async (t) => {
  const { applier, store, repository } = await fixture(t);
  const denied = await applier.request("m1", "version-2");
  assert.deepEqual(await applier.onApprovalDecided(store.decideApproval(denied.approval.id, "denied")), { status: "denied" });
  assert.equal(await page(repository), "<h1>Pricing</h1>\n");

  const asked = await applier.request("m1", "version-2");
  await writeFile(join(repository, "other.txt"), "x\n");
  git(repository, "add", "-A");
  git(repository, "commit", "-qm", "someone else committed");
  const stale = await applier.onApprovalDecided(store.decideApproval(asked.approval.id, "approved"));
  assert.equal(stale.status, "stale");
  assert.equal(await page(repository), "<h1>Pricing</h1>\n");
});

test("allow applies at once, deny refuses, and a patch that no longer fits is refused whole", async (t) => {
  const allowed = await fixture(t, { policy: "allow" });
  assert.equal((await allowed.applier.request("m1", "version-2")).status, "applied");
  assert.equal(await page(allowed.repository), "<h1>Pricing, redesigned</h1>\n");

  const denied = await fixture(t, { policy: "deny" });
  await assert.rejects(denied.applier.request("m1", "version-2"), { code: "DENIED_BY_POLICY" });

  const conflicted = await fixture(t, { policy: "allow" });
  await writeFile(join(conflicted.repository, "page.html"), "<h1>Edited by a person</h1>\n");
  const result = await conflicted.applier.request("m1", "version-2");
  assert.equal(result.status, "conflict");
  assert.equal(await page(conflicted.repository), "<h1>Edited by a person</h1>\n", "the person's edit is untouched");
});

test("only patches Atlas produced, for finished lanes, can be applied", async (t) => {
  const outside = await fixture(t, { policy: "allow", patchInside: false });
  await assert.rejects(outside.applier.request("m1", "version-2"), { code: "NO_PATCH" });

  const running = await fixture(t, { policy: "allow" });
  running.mission.children[0].state = "running";
  await assert.rejects(running.applier.request("m1", "version-2"), { code: "NOT_FINISHED" });
  await assert.rejects(running.applier.request("m1", "nope"), { code: "UNKNOWN_LANE" });
  await assert.rejects(running.applier.request("missing", "version-2"), { code: "UNKNOWN_MISSION" });
});

test("the command center offers 'Use this version' on a finished version lane with a patch", async (t) => {
  const { mission } = await fixture(t);
  const lane = buildCommandCenter({ missions: [mission] }).items[0].lanes[0];
  const use = lane.actions.find((a) => a.name === "apply");
  assert.equal(use.label, "Use this version");
  assert.equal(use.path, "/v1/missions/m1/lanes/version-2/apply");
});
