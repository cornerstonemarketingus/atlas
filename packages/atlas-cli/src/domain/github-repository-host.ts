export interface GitHubRepositoryLocator {
  readonly owner: string;
  readonly name: string;
}

export interface GitHubRepositorySummary {
  readonly fullName: string;
  readonly htmlUrl: string;
  readonly isPrivate: boolean;
  readonly defaultBranch: string;
}

export interface GitHubPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly isDraft: boolean;
  readonly htmlUrl: string;
  readonly headRef: string;
  readonly baseRef: string;
}

export interface GitHubIssueSummary {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly htmlUrl: string;
}

/** A read-only boundary for a GitHub installation or authenticated CLI session. */
export interface GitHubRepositoryHost {
  getRepository(locator: GitHubRepositoryLocator, signal?: AbortSignal): Promise<GitHubRepositorySummary>;
  listPullRequests(
    locator: GitHubRepositoryLocator,
    options?: { readonly state?: "open" | "closed"; readonly limit?: number; readonly signal?: AbortSignal },
  ): Promise<readonly GitHubPullRequestSummary[]>;
  listIssues(
    locator: GitHubRepositoryLocator,
    options?: { readonly state?: "open" | "closed"; readonly limit?: number; readonly signal?: AbortSignal },
  ): Promise<readonly GitHubIssueSummary[]>;
}

export type GitHubRepositoryHostErrorCode =
  | "authentication"
  | "cancelled"
  | "invalid-response"
  | "not-found"
  | "rate-limit"
  | "request-failed";

export class GitHubRepositoryHostError extends Error {
  public constructor(
    public readonly code: GitHubRepositoryHostErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GitHubRepositoryHostError";
  }
}
