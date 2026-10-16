# Cumulative delegated-task budgets

The platform executor already calls `TaskBudget` before and after a tool. That same boundary now reserves and charges the task plus every ancestor reachable through its existing tenant-scoped `parentTaskId`. Siblings therefore share their parent's remaining allowance instead of each resetting it. Reservations check every scope before writing; all usage and audit writes commit in one existing SQLite transaction. An ancestor write failure rolls the child back too. Task-store and executor files owned by credential-boundary PR #235 are unchanged.

Snapshots preserve a standalone task's shape. For child tasks, remaining allowance is the minimum across the task and its ancestors; an `ancestors` list explains inherited limits and usage. Parent audit records identify the source descendant. Cycles, missing tenant-scoped parents and chains longer than 64 tasks fail before reservation writes.

Actual post-execution usage is recorded truthfully at every scope, including overruns, and later reservations are refused. Reserving a known expected monetary amount before execution can prevent that reservation from exceeding an ancestor limit. Reporting an unexpected actual cost after execution cannot undo the spend, so this is not a universal hard-dollar guarantee. Tools must report their own usage rather than re-report aggregated descendant costs.

## Review and rollout limits

This changes spending-policy semantics and requires configured review before release. It applies only to platform executor calls linked in one task hierarchy. Existing agent-runtime budgets, hosted provider ledgers, projects without parent links and independent recurring automation runs are not unified by this patch.

Existing descendant usage recorded before this change is not backfilled into parents. Production rollout must use fresh task trees or reconcile historical direct usage and descendant attribution first. Do not claim old parent totals are complete, enable this blindly on historical trees, or sum already-aggregated descendant rows again. No migration/store ownership was bypassed to implement a partial backfill.

## Evidence

Four regressions failed against the original implementation, then passed with cumulative enforcement: sibling limits survive restart, nested cost/token propagation, atomic rollback when the parent write fails, and the actual authorized executor refusing a sibling before its tool runs. Further tests cover eight independent SQLite worker connections competing for a three-call parent budget, and a corrupted cyclic chain. The existing platform-core suite also passes. Full local and cross-platform checks remain required before release. No external spending occurred in these fixtures.
