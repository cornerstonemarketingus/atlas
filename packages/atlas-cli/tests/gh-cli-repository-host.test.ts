import assert from "node:assert/strict";
import test from "node:test";
import { GhCliRepositoryHost } from "../src/infrastructure/gh-cli-repository-host.js";
import type { SafeCommandRequest, SafeCommandResult, SafeCommandRunner } from "../src/domain/safe-command-runner.js";

class FakeRunner implements SafeCommandRunner {
  public readonly requests: SafeCommandRequest[] = [];
  private readonly results: SafeCommandResult[];
  public constructor(results: readonly SafeCommandResult[]) { this.results = [...results]; }
  public async run(request: SafeCommandRequest): Promise<SafeCommandResult> {
    this.requests.push(request);
    const result = this.results.shift();
    if (result === undefined) throw new Error("No fake response configured.");
    return result;
  }
}

function result(stdout: string, exitCode = 0): SafeCommandResult {
  return { exitCode, signal: null, stdout, stderr: exitCode === 0 ? "" : stdout, timedOut: false, cancelled: false, truncated: false, durationMs: 1 };
}

test("reads bounded repository, pull request, and issue metadata through gh api", async () => {
  const runner = new FakeRunner([
    result(JSON.stringify({ full_name: "owner/repo", html_url: "https://github.com/owner/repo", private: true, default_branch: "main" })),
    result(JSON.stringify([{ number: 7, title: "Improve safety", state: "open", draft: true, html_url: "https://github.com/owner/repo/pull/7", head: { ref: "agent/safety" }, base: { ref: "main" } }])),
    result(JSON.stringify([{ number: 2, title: "Issue", state: "open", html_url: "https://github.com/owner/repo/issues/2" }, { number: 3, title: "PR duplicate", state: "open", html_url: "https://github.com/owner/repo/pull/3", pull_request: {} }])),
  ]);
  const host = new GhCliRepositoryHost(runner);
  const locator = { owner: "owner", name: "repo" };
  assert.equal((await host.getRepository(locator)).defaultBranch, "main");
  assert.equal((await host.listPullRequests(locator, { limit: 1 }))[0]?.headRef, "agent/safety");
  assert.equal((await host.listIssues(locator))[0]?.number, 2);
  assert.deepEqual(runner.requests.map((request) => request.args), [
    ["api", "repos/owner/repo"], ["api", "repos/owner/repo/pulls?state=open&per_page=1"], ["api", "repos/owner/repo/issues?state=open&per_page=30"],
  ]);
});

test("rejects unsafe locators, limits, malformed output, and command errors", async () => {
  const host = new GhCliRepositoryHost(new FakeRunner([result("not found", 1), result("{}") ]));
  await assert.rejects(host.getRepository({ owner: "owner/escape", name: "repo" }), { code: "request-failed" });
  await assert.rejects(host.listIssues({ owner: "owner", name: "repo" }, { limit: 101 }), { code: "request-failed" });
  await assert.rejects(host.getRepository({ owner: "owner", name: "repo" }), { code: "not-found" });
  await assert.rejects(host.getRepository({ owner: "owner", name: "repo" }), { code: "invalid-response" });
});
