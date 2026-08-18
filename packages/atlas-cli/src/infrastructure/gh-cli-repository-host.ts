import type { SafeCommandRunner } from "../domain/safe-command-runner.js";
import {
  GitHubRepositoryHostError,
  type GitHubIssueSummary,
  type GitHubPullRequestSummary,
  type GitHubRepositoryHost,
  type GitHubRepositoryLocator,
  type GitHubRepositorySummary,
} from "../domain/github-repository-host.js";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u;

/**
 * Read-only GitHub adapter that deliberately delegates process and environment
 * policy to a supplied SafeCommandRunner. It never receives or logs tokens.
 */
export class GhCliRepositoryHost implements GitHubRepositoryHost {
  public constructor(private readonly commands: SafeCommandRunner) {}

  public async getRepository(locator: GitHubRepositoryLocator, signal?: AbortSignal): Promise<GitHubRepositorySummary> {
    const value = await this.api(locator, `repos/${path(locator)}`, signal);
    return repositorySummary(value);
  }

  public async listPullRequests(
    locator: GitHubRepositoryLocator,
    options: { readonly state?: "open" | "closed"; readonly limit?: number; readonly signal?: AbortSignal } = {},
  ): Promise<readonly GitHubPullRequestSummary[]> {
    const limit = validateLimit(options.limit);
    const state = options.state ?? "open";
    const value = await this.api(locator, `repos/${path(locator)}/pulls?state=${state}&per_page=${limit}`, options.signal);
    if (!Array.isArray(value)) throw invalidResponse("GitHub pull request response must be an array.");
    return value.slice(0, limit).map(pullRequestSummary);
  }

  public async listIssues(
    locator: GitHubRepositoryLocator,
    options: { readonly state?: "open" | "closed"; readonly limit?: number; readonly signal?: AbortSignal } = {},
  ): Promise<readonly GitHubIssueSummary[]> {
    const limit = validateLimit(options.limit);
    const state = options.state ?? "open";
    const value = await this.api(locator, `repos/${path(locator)}/issues?state=${state}&per_page=${limit}`, options.signal);
    if (!Array.isArray(value)) throw invalidResponse("GitHub issue response must be an array.");
    return value.filter((entry) => !hasProperty(entry, "pull_request")).slice(0, limit).map(issueSummary);
  }

  private async api(locator: GitHubRepositoryLocator, endpoint: string, signal?: AbortSignal): Promise<unknown> {
    validateLocator(locator);
    const request = signal === undefined
      ? { executable: "gh", args: ["api", endpoint] }
      : { executable: "gh", args: ["api", endpoint], signal };
    const result = await this.commands.run(request);
    if (result.cancelled) throw new GitHubRepositoryHostError("cancelled", "GitHub request was cancelled.");
    if (result.timedOut || result.truncated) throw new GitHubRepositoryHostError("request-failed", "GitHub request did not complete safely.");
    if (result.exitCode !== 0) throw commandError(result.stderr);
    try { return JSON.parse(result.stdout) as unknown; }
    catch (cause) { throw invalidResponse("GitHub returned invalid JSON.", cause); }
  }
}

function path(locator: GitHubRepositoryLocator): string { return `${locator.owner}/${locator.name}`; }

function validateLocator(locator: GitHubRepositoryLocator): void {
  if (!SAFE_SEGMENT.test(locator.owner) || !SAFE_SEGMENT.test(locator.name)) {
    throw new GitHubRepositoryHostError("request-failed", "GitHub owner and repository name must be safe path segments.");
  }
}

function validateLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new GitHubRepositoryHostError("request-failed", `GitHub result limit must be between 1 and ${MAX_LIMIT}.`);
  }
  return limit;
}

function commandError(stderr: string): GitHubRepositoryHostError {
  const message = stderr.slice(0, 500).toLowerCase();
  if (message.includes("authentication") || message.includes("bad credentials")) return new GitHubRepositoryHostError("authentication", "GitHub authentication failed.");
  if (message.includes("not found")) return new GitHubRepositoryHostError("not-found", "GitHub repository was not found.");
  if (message.includes("rate limit")) return new GitHubRepositoryHostError("rate-limit", "GitHub rate limit was reached.");
  return new GitHubRepositoryHostError("request-failed", "GitHub API request failed.");
}

function repositorySummary(value: unknown): GitHubRepositorySummary {
  return {
    fullName: stringField(value, "full_name"),
    htmlUrl: stringField(value, "html_url"),
    isPrivate: booleanField(value, "private"),
    defaultBranch: stringField(value, "default_branch"),
  };
}

function pullRequestSummary(value: unknown): GitHubPullRequestSummary {
  return {
    number: positiveIntegerField(value, "number"), title: stringField(value, "title"), state: stateField(value),
    isDraft: booleanField(value, "draft"), htmlUrl: stringField(value, "html_url"),
    headRef: nestedStringField(value, "head", "ref"), baseRef: nestedStringField(value, "base", "ref"),
  };
}

function issueSummary(value: unknown): GitHubIssueSummary {
  return { number: positiveIntegerField(value, "number"), title: stringField(value, "title"), state: stateField(value), htmlUrl: stringField(value, "html_url") };
}

function stateField(value: unknown): "open" | "closed" {
  const state = stringField(value, "state");
  if (state !== "open" && state !== "closed") throw invalidResponse("GitHub response contains an unsupported state.");
  return state;
}

function stringField(value: unknown, field: string): string {
  if (!hasProperty(value, field) || typeof value[field] !== "string" || value[field].length === 0) throw invalidResponse(`GitHub response field '${field}' must be a non-empty string.`);
  return value[field];
}

function booleanField(value: unknown, field: string): boolean {
  if (!hasProperty(value, field) || typeof value[field] !== "boolean") throw invalidResponse(`GitHub response field '${field}' must be a boolean.`);
  return value[field];
}

function positiveIntegerField(value: unknown, field: string): number {
  if (!hasProperty(value, field) || !Number.isSafeInteger(value[field]) || (value[field] as number) <= 0) throw invalidResponse(`GitHub response field '${field}' must be a positive integer.`);
  return value[field] as number;
}

function nestedStringField(value: unknown, parent: string, field: string): string {
  if (!hasProperty(value, parent)) throw invalidResponse(`GitHub response field '${parent}' is missing.`);
  return stringField(value[parent], field);
}

function hasProperty(value: unknown, field: string): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.hasOwn(value, field);
}

function invalidResponse(message: string, cause?: unknown): GitHubRepositoryHostError {
  return new GitHubRepositoryHostError("invalid-response", message, cause === undefined ? undefined : { cause });
}
