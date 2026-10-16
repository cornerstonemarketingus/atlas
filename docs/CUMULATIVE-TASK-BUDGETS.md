# Cumulative delegated-task budgets

The platform executor already calls `TaskBudget` before and after a tool. That same boundary now reserves and charges the task plus every ancestor reachable through its existing tenant-scoped `parentTaskId`. Siblings therefore share their parent's remaining allowance instead of each resetting it. Reservations check every scope before writing; all usage and audit writes commit in one existing SQLite transaction. An ancestor write failure rolls the child back too. Task-store and executor files owned by credential-boundary PR #235 are unchanged.

Snapshots preserve a standalone task's shape. For child tasks, remaining allowance is the minimum across the task and its ancestors; an `ancestors` list explains inherited limits and usage. Parent audit records identify the source descendant. Cycles, missing tenant-scoped parents and chains longer than 64 tasks fail before reservation writes.

Actual post-execution usage is recorded truthfully at every scope, including overruns, and later reservations are refused. The existing executor reserves tool-call counts and records monetary usage after execution. It does not reserve predicted monetary cost or settle/refund monetary reservations. Recording actual cost cannot undo the spend, so this is not a hard-dollar guarantee. Tools must report their own usage rather than re-report aggregated descendant costs.

## Review and rollout limits

This changes spending-policy semantics and requires configured review before release. It applies only to platform executor calls linked in one task hierarchy. Existing agent-runtime budgets, hosted provider ledgers, projects without parent links and independent recurring automation runs are not unified by this patch.

Historical usage has an explicit reconciliation command; it does not add work to interactive tool calls. Stop old controllers/workers and retain a database backup before rollout. Run:

`node scripts/local/reconcile-task-budgets.mjs --database "C:\path\platform.sqlite" --tenant "tenant-id"`

The default reports proposed descendant credits without changing usage or audit records. Review the report, then repeat with `--apply` and start only updated controllers. The command requires an existing platform database and an explicit tenant, refuses unrelated databases, and commits all credits and audit events atomically. It subtracts previously recorded descendant credits to recover direct usage, then adds only missing historical contributions to ancestors. Repeating it after a restart or further execution is a no-op when accounting is already complete. Historical overspend is audited and later reservations are refused.

This supports original direct-only task snapshots mixed with this version's attributed descendant credits. Manually pre-aggregated rows without attribution require operator investigation; they cannot be reliably distinguished from direct usage. Negative/inconsistent credits, broken parent chains, unsafe numbers or configured maintenance-size limits fail without partial usage changes. No live production reconciliation has been performed, and no owned store or executor implementation was changed.

## Evidence

Four regressions failed against the original implementation, then passed with cumulative enforcement: sibling limits survive restart, nested cost/token propagation, atomic rollback when the parent write fails, and the actual authorized executor refusing a sibling before its tool runs. Further tests cover eight independent SQLite worker connections competing for a three-call parent budget, and a corrupted cyclic chain. The existing platform-core suite also passes. The initial full local-control suite passed: 689 passed, 20 optional/environment skips, zero failures. Historical reconciliation adds dry-run, idempotency, rollback, tenant, executable and overspend coverage; 32 focused budget/platform-core tests pass. Fresh full-suite and cross-platform CI evidence are required for the expanded revision. No external spending occurred in these fixtures.
