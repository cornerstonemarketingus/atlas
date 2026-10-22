import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOfferedToolName } from "../src/agent/tool-name-resolution.js";
import { JsonLinesSessionAuditStore } from "../src/infrastructure/json-lines-session-audit-store.js";

test("exact names win while normalized collisions and unknown verbs never guess", () => {
  const names = ["repository.search", "repository_search"];
  assert.equal(resolveOfferedToolName("repository.search", names, names), "repository.search");
  assert.equal(resolveOfferedToolName("repo.search", names, names), undefined);
  for (const name of ["search", "repo.delete", "repo.searc", "../repository.search", "repo.search()", "repo.search\n", "r".repeat(129)]) {
    assert.equal(resolveOfferedToolName(name, names, names), undefined);
  }
  assert.equal(resolveOfferedToolName("repo.search", ["repository.search"], []), undefined);
  assert.equal(resolveOfferedToolName("repo.search", ["repository.search"], ["repo.search", "repository.search"]), undefined);
});

test("canonicalization handles namespaces, separators and acronym word boundaries", () => {
  const names = ["repository.search", "repository.read_source", "repository.propose_change_set"];
  for (const alias of ["repos.search", "repositories.search", "REPOSITORYSearch", "repo-browser.search", "repository__search"]) {
    assert.equal(resolveOfferedToolName(alias, names, names), "repository.search", alias);
  }
  for (const alias of ["repositoryReadFile", "REPOSITORYReadSource", "repository-browser.read-file"]) {
    assert.equal(resolveOfferedToolName(alias, names, names), "repository.read_source", alias);
  }
  assert.equal(resolveOfferedToolName("repoBrowser.proposeChangeSet", names, names), "repository.propose_change_set");
});

test("a unique single namespace typo is repairable while operation typos never are", () => {
  const names = ["repository.search", "repository.read_source", "repository.propose_change_set", "workspace.search"];
  for (const alias of ["repositroy.search", "repositor.search", "repossitory.search", "repositorx.search", "workspcae.search"]) {
    assert.equal(resolveOfferedToolName(alias, names, names), alias.startsWith("work") ? "workspace.search" : "repository.search", alias);
  }
  for (const alias of ["repo.searc", "repository.serach", "repository.read_sourc", "repository.propose_change_sets", "repositryy.search", "reop.search", "foo.search"]) {
    assert.equal(resolveOfferedToolName(alias, names, names), undefined, alias);
  }
  assert.equal(resolveOfferedToolName("repositroy.propose_change_set", names, names), "repository.propose_change_set");
});

test("hidden normalized or fuzzy candidates cannot disambiguate an alias", () => {
  assert.equal(resolveOfferedToolName("repo.search", ["repository.search"], ["repository.search", "repository_search"]), undefined);
  assert.equal(resolveOfferedToolName("repositorz.search", ["repository.search"], ["repository.search", "repositorx.search"]), undefined);
  assert.equal(resolveOfferedToolName("repositroy.search", [], ["repository.search"]), undefined);
  assert.equal(resolveOfferedToolName("repository_search", ["repository.search"], ["repository.search", "repository_search"]), undefined);
});

test("repair audit survives disk reload and rejects incomplete metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-alias-audit-"));
  try {
    const filePath = join(root, "events.jsonl");
    const store = new JsonLinesSessionAuditStore({ filePath });
    const payload = { requestId: "turn", toolCallId: "call", toolId: "repository.search", argumentCount: 1 };
    await store.append("tool.requested", payload);
    await store.append("tool.requested", { ...payload, requestedToolId: "repo_browser.search", repair: "automatic" });
    const loaded = await new JsonLinesSessionAuditStore({ filePath }).load();
    assert.deepEqual(loaded[1]?.payload, { ...payload, requestedToolId: "repo_browser.search", repair: "automatic" });
    assert.deepEqual(loaded[0]?.payload, payload);
    await assert.rejects(store.append("tool.requested", { ...payload, repair: "automatic" }), { code: "AUDIT_INVALID_EVENT" });
    await assert.rejects(store.append("tool.requested", { ...payload, requestedToolId: "repo.search" }), { code: "AUDIT_INVALID_EVENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
