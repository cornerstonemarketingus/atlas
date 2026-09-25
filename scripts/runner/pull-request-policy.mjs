/** Manual review policies produce drafts; automatic policies need an active PR. */
export function isDraftPullRequest(mergePolicy) {
  return mergePolicy === "manual";
}