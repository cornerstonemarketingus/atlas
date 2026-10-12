# Native hosted execution claims

This slice adds executor-side admission to the existing Atlas coding workflow.
It reuses D1 task intent, run events, GitHub run verification, the OIDC verifier,
trusted runner scripts and mobile request history. There is no external coding
agent framework, second inference router or code execution in the Worker.

## Execution boundary

Both `atlas-coder.yml` and `atlas-runner.yml` begin with a separate trusted claim
job. It checks out Atlas policy from main, validates inputs and requests a short
lived GitHub identity for the `atlas-task-execution` audience. It never checks
out the target branch, installs target dependencies or starts a model.

`POST /api/tasks/claim` verifies issuer, RS256 signature, issue/expiry time, main
branch, workflow_dispatch, trusted workflow, immutable executor repository ID and
positive run/attempt identity. It compares repository, branch, mode, objective,
merge policy and correlation ID with the saved managed task, then verifies the
exact live GitHub run title, path, branch, repository and attempt. Tenant and
principal are derived from the task; callers cannot choose them.

One D1 transaction reserves immutable task ownership, pins the run and saves an
audit event. The claim is bound to one task, run and attempt. A lost acknowledgement
can replay that exact claim; it does not extend expiry or create another audit
event. A competing run, new attempt, changed task snapshot or expired claim is
refused. Storage/audit failure rolls the transaction back before authorization.

The workload needs a successful grant from its own attempt. Its first policy
checks also compare the current run/attempt and require enough lease time for the
entire configured job timeout plus one minute. This stops GitHub's failed-job
reruns from reusing successful preflight outputs from an earlier attempt. Reporting
is gated to that claimed attempt too. The workload job explicitly has no OIDC
permission; authentication remains in separate trusted jobs.

The native `run-task.mjs` entry repeats the hosted lease check before filesystem,
Git or coding actions. Cached older workflow definitions that check out current
main therefore fail closed before coding, rather than bypassing the new gate.
Local/direct CLI entry remains supported. Quiesce older hosted runs during rollout:
their cached setup/model-start steps cannot be retroactively gated by this change.

## Lease semantics

The lease is six hours. Existing job ceilings remain ten minutes for review/debug
and 25 or 330 minutes for coding. A queued job without sufficient remaining time
stops before target checkout, package installation, model startup or coding tools.
Claim transport retries have a maximum of three ten-second attempts and two short
waits; explicit refusals are not retried. HTTPS endpoints refuse redirects.

Expiry never releases ownership or proves execution stopped. There is no lease
stealing, automatic restart, heartbeat renewal or checkpoint restoration here.
The immutable slot remains for investigation until a separately reviewed outcome
and resolution policy exists. A GitHub rerun with a new attempt cannot execute
this task again. Begin a new authorized Atlas task only after investigating the
old run; do not infer retry safety from missing acknowledgements or elapsed time.

Saved request inspection exposes the scoped run, attempt, claim time and expiry.
The existing Build view displays this evidence and links to activity. It does not
describe a claim as completed coding or successful validation.

## Identity and scope

The existing hosted runner supports only `cornerstonemarketingus/atlas`. Its
immutable repository ID, `1337761549`, was verified through the GitHub repository
API. Claims preserve that restriction; multi-repository executor registration is
future work. Manual workflow inputs without a saved managed task and correlation
ID are refused. Direct CLI/local workflows are unchanged.

GitHub documents custom audiences, immutable repository IDs and signed workflow
run claims in its [OIDC reference](https://docs.github.com/en/actions/reference/security/oidc).
Workflow expressions follow its [context availability rules](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts).
No OIDC token or platform GitHub credential is stored in a claim or forwarded as
workload output. Output contains only grant metadata. Provider failure bodies are
not printed by the runner; the receiver returns fixed failure messages.

## Rollout and dependencies

This branch is stacked on PR #276 and its #274/#270 dependencies. Apply migration
`0019_task_execution_claims.sql` after 0017/0018, deploy the reviewed Worker endpoint,
then enable the reviewed workflow gate on main. `ATLAS_CLAIM_URL` optionally selects
an HTTPS `/api/tasks/claim` endpoint; otherwise it uses the existing result URL's
origin, or the existing hosted Worker default. Missing service/schema fails closed.

No production migration, merge, deployment or live OIDC/workload journey is
performed by this implementation. Workflow, identity and tenant changes require
owner review and main's required checks. PR #253's container validation isolation
remains separate; its CLI/install/validation changes were not overwritten and
must be incorporated before production untrusted validation. Claims do not replace
sandboxing, secret isolation, billing caps or cancellation policy.

## Validation and next slice

Tests exercise real signed JWTs, migrated SQLite, competing claims, exact payload
and live-run binding, transaction rollback, replay and expiry refusal, scoped
mobile metadata, real HTTP acknowledgement loss, bounded retries, stale-attempt
outputs and workflow gates. GitHub signing keys/run metadata are simulated at the
built Worker boundary; live GitHub identity issuance remains to be verified.

Local checks passed: production build, TypeScript, ESLint, all 498 web tests,
all 69 runner tests, and all ten workflow files. On Windows the unchanged workflow
checker used an explicit Git Bash adapter because the default WSL shell was absent.
Lease lifetime, immutable repository and scoped admission guard mutations failed
their tests; source was restored and regressions passed again.

Next add authenticated outcome attestation and audited claim resolution before
automating recovery, then worker heartbeats/checkpoints. Billing settlement stays
with the existing billing workstream. No new TODO file is introduced. This doc
and issue #277 carry the handoff while active PRs own the shared progress log.
