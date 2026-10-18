# Cloud coder shutdown recovery

The trusted cloud task runner uses `scripts/runner/run-coder-process.mjs` for the native coder subprocess. This helper is already wired into `run-task.mjs`; no new executor, credential, storage migration or workflow is introduced here.

## Failure and repair

Previously, timeout or output overflow sent SIGTERM and scheduled SIGKILL, but the coder's close event immediately cancelled escalation. A coder that exited before a resistant descendant could leave that descendant running. A descendant that escaped the process group while retaining inherited output pipes could also prevent close from arriving indefinitely. An exception thrown by the metadata progress observer escaped the lifecycle entirely.

Recovery now has a single stop transition. It retains forced group cleanup even after the leader exits, then destroys captured pipes and settles the failed result after a bounded cleanup grace period. The default grace period is one second; tests may select a positive interval up to five seconds. Timeout and output overflow remain failures even when the leader exits zero or has already printed valid JSON. Progress observer exceptions and rejected promises do not abandon running work or expose their messages.

On Linux the existing detached process group receives SIGTERM followed by SIGKILL. On Windows the existing fixed-path taskkill command terminates the tree; each invocation retains its five-second command timeout. Recovery completion can therefore include up to two Windows taskkill timeouts in addition to the grace period. Numeric timer/output bounds are validated before spawning.

## Evidence and limits

Two new real-process regressions failed before the repair: inherited pipes held timeout recovery open until the fixture self-expired, and an observer exception became uncaught asynchronous activity. They pass with the repair. A Linux-only real-process test additionally starts a SIGTERM-resistant descendant and verifies forced cleanup after the leader exits. Windows exercises inherited pipes, timeout, overflow, spawn failure and observer errors; Linux process groups require Linux CI.

A process that deliberately leaves the managed process group or an already-orphaned Windows process tree is not guaranteed to be terminated by this helper. Closing capture streams bounds the trusted runner's wait; it is not a replacement for container/cgroup isolation. The pending isolated-validation work remains required. This repair does not create persistent cloud workspaces, resume prior tool mutations, grant retries, apply D1 migrations, deploy a Worker or provision infrastructure.

Issue: #331. Existing task-persistence and mission PRs retain their independent schema/review/deployment gates.

Local verification (Windows): complete runner/local suite 81 total, 80 passed, one Linux-only process-group skip. Final process-focused run: eight total, seven passed, one Linux-only skip. The initial two added regressions both failed on unchanged source before the repair. Linux process-group acceptance is required from CI before merge. No workflow, credential, production database or infrastructure configuration changed.
