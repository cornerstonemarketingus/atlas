import assert from "node:assert/strict";
import test from "node:test";
import { executeGitHubCommand } from "../src/cli-github.js";
import type { GitHubRepositoryHost } from "../src/domain/github-repository-host.js";
import { renderGitHubText } from "../src/presentation/github-renderers.js";

const host: GitHubRepositoryHost = {
  async getRepository() { return { fullName: "atlas/atlas", htmlUrl: "https://github.com/atlas/atlas", isPrivate: true, defaultBranch: "main" }; },
  async listPullRequests() { return [{ number: 1, title: "Safe work", state: "open", isDraft: true, htmlUrl: "https://github.com/atlas/atlas/pull/1", headRef: "agent/work", baseRef: "main" }]; },
  async listIssues() { return [{ number: 2, title: "Follow up", state: "closed", htmlUrl: "https://github.com/atlas/atlas/issues/2" }]; },
};

test("executes read-only GitHub repository commands with bounded options", async () => {
  const repository = await executeGitHubCommand(["repo", "atlas/atlas"], host);
  const pulls = await executeGitHubCommand(["prs", "atlas/atlas", "--state", "open", "--max-results", "1"], host);
  const issues = await executeGitHubCommand(["issues", "atlas/atlas"], host);
  assert.equal(repository.kind, "repository");
  assert.equal(pulls.kind, "pull-requests");
  assert.equal(issues.kind, "issues");
  assert.match(renderGitHubText(pulls), /\[draft\]/u);
});

test("rejects malformed GitHub command input before the host is called", async () => {
  await assert.rejects(executeGitHubCommand(["repo", "atlas"], host));
  await assert.rejects(executeGitHubCommand(["prs", "atlas/atlas", "--max-results", "101"], host));
  await assert.rejects(executeGitHubCommand(["unknown", "atlas/atlas"], host));
});
