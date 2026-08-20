import type {
  GitHubIssueSummary,
  GitHubPullRequestSummary,
  GitHubRepositorySummary,
} from "../domain/github-repository-host.js";

export type GitHubCommandOutput =
  | { readonly kind: "repository"; readonly value: GitHubRepositorySummary }
  | { readonly kind: "pull-requests"; readonly value: readonly GitHubPullRequestSummary[] }
  | { readonly kind: "issues"; readonly value: readonly GitHubIssueSummary[] };

export function renderGitHubJson(output: GitHubCommandOutput): string {
  return JSON.stringify(output, null, 2);
}

export function renderGitHubText(output: GitHubCommandOutput): string {
  if (output.kind === "repository") {
    return [
      `Repository: ${output.value.fullName}`,
      `URL: ${output.value.htmlUrl}`,
      `Visibility: ${output.value.isPrivate ? "private" : "public"}`,
      `Default branch: ${output.value.defaultBranch}`,
    ].join("\n");
  }
  const label = output.kind === "issues" ? "Issues" : "Pull requests";
  const lines = [`${label}: ${output.value.length}`];
  for (const item of output.value) {
    const draft = "isDraft" in item && item.isDraft ? " [draft]" : "";
    lines.push(`#${item.number} [${item.state}]${draft} ${item.title} — ${item.htmlUrl}`);
  }
  return lines.join("\n");
}
