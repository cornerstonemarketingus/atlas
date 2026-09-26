/**
 * Engineering family platform (blueprint §7): per-agent worktrees, file
 * ownership with reviewed merges, and the EngineeringWorkflow that prepares a
 * pull request for human review. Nothing exported here merges.
 */
export { GitError } from "./git.mjs";
export { WorktreeManager, WorktreeError, agentBranchName, isProtectedBranch, assertAgentBranch } from "./worktrees.mjs";
export {
  ENGINEERING_ROLES, OwnershipError, createOwnershipPlan, topologicalOrder, matchesGlob, globsIntersect,
  ownersOf, checkChangeSet, detectChangeSetConflicts, reconcileChangeSets,
} from "./ownership.mjs";
export { DEFAULT_FORBIDDEN_PATHS, SECURITY_PATTERNS, forbiddenPathChanges, scanSecrets, scanSecurityPatterns } from "./review.mjs";
export { HUMAN_REVIEW_REQUIRED, PullRequestError, buildPullRequestPayload, evaluateMergePolicy, submitPullRequest } from "./pull-request.mjs";
export {
  STAGES, EngineeringWorkflow, EngineeringWorkflowError, createTerminalCommandRunner,
  detectRepositoryCommands, judgeCheck, parseTestCounts,
} from "./pipeline.mjs";
