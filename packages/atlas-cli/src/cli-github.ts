import type { GitHubRepositoryHost } from "./domain/github-repository-host.js";
import type { GitHubCommandOutput } from "./presentation/github-renderers.js";

export async function executeGitHubCommand(
  args: readonly string[],
  host: GitHubRepositoryHost,
): Promise<GitHubCommandOutput> {
  const action = args[0];
  const locator = parseRepository(args[1]);
  if (action === "repo") return { kind: "repository", value: await host.getRepository(locator) };
  const state = readState(args);
  const limit = readLimit(args);
  if (action === "prs") return { kind: "pull-requests", value: await host.listPullRequests(locator, { state, limit }) };
  if (action === "issues") return { kind: "issues", value: await host.listIssues(locator, { state, limit }) };
  throw new Error("GitHub command must be one of: repo, prs, issues.");
}

function parseRepository(value: string | undefined): { readonly owner: string; readonly name: string } {
  if (value === undefined || value.length === 0) throw new Error("GitHub commands require <owner>/<repository>.");
  const parts = value.split("/");
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined || parts[0].length === 0 || parts[1].length === 0) {
    throw new Error("GitHub repository must use the form <owner>/<repository>.");
  }
  return { owner: parts[0], name: parts[1] };
}

function readState(args: readonly string[]): "open" | "closed" {
  const index = args.indexOf("--state");
  const state = index < 0 ? "open" : args[index + 1];
  if (state !== "open" && state !== "closed") throw new Error("--state must be 'open' or 'closed'.");
  return state;
}

function readLimit(args: readonly string[]): number {
  const index = args.indexOf("--max-results");
  if (index < 0) return 30;
  const limit = Number(args[index + 1]);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("--max-results must be an integer between 1 and 100.");
  return limit;
}
