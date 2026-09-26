import assert from "node:assert/strict";
import test from "node:test";
import { platformGitHubToken } from "../app/api/tasks/github-token.mjs";

test("a pasted token is cleaned of the usual copy-paste damage", () => {
  const token = "github_pat_ABC123";
  for (const saved of [token, `${token}\n`, `  ${token}  `, `"${token}"`, `Bearer ${token}`, `token ${token}\r\n`]) {
    assert.equal(platformGitHubToken({ ATLAS_GITHUB_TOKEN: saved }), token, JSON.stringify(saved));
  }
});

test("an unset or blank token reads as unset", () => {
  assert.equal(platformGitHubToken({}), undefined);
  assert.equal(platformGitHubToken({ ATLAS_GITHUB_TOKEN: "  \n" }), undefined);
});
