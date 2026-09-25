/**
 * Platform core (blueprint Phase 1): durable task state, audit events,
 * authorization, budgets and the authorized tool executor. Subsystems in
 * sibling folders (terminal, family, mcp, memory) export from their own
 * modules.
 */
export { PlatformTaskStore, PlatformStoreError } from "./task-store.mjs";
export { PolicyEngine, PolicyError, matchesPermission } from "./policy.mjs";
export { TaskBudget, TaskBudgetExceededError } from "./budget.mjs";
export { AuthorizedToolExecutor, ExecutorError, sanitizeToolError, verifyArtifact } from "./executor.mjs";
export { adaptRegistryTool, repositoryPlatformTools } from "./adapters.mjs";
