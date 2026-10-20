# Atlas deployment status

Updated 2026-10-16. This branch is not deployed. No infrastructure provisioned,
production database migrated, credentials transferred or live business actions
performed. The existing Cloudflare web app and GitHub Actions execution adapter
remain the integration targets. Cloudflare Workers coordinate tasks; full Linux
coding/container workloads require an execution host.

For this transport slice: pass focused and full local tests, required branch CI,
then follow normal review/merge policy. Verify a configured OpenAI-compatible
server using actual text/tool/usage responses and an interrupted stream. Existing
hosted chat release checks remain necessary for changes to hosted transport.

For independent cloud workers: first integrate the durable dispatch/claim/result
stack and existing mission persistence. Then deploy a Linux service with scoped
identity, outbound control-plane connection, private artifact storage and isolated
containers. Register capabilities in the existing worker registry. Acceptance
requires a task initiated remotely while the owner's PC is offline, worker kill
and replacement, preserved checkpoints, bounded spending and one verified artifact.

Request recovery checkpoint (2026-10-17): current main is propagated through
existing #270/#274/#276. #276's final Worker build, full web suite (537 pass,
four optional skips) and separately executed desktop/mobile browser fixture
pass. Prior migrations 0017/0018 still precede deployment; this UI fix adds no
migration or secret. Fresh integrated PR CI/review and configured live reads
remain required. No production migration or deployment was performed here.

Claims integration checkpoint: #278 contains the validated recovery parent and
passes build/typecheck, 545 web tests (four optional skips), 83 runner/local
tests and all ten workflow checks. Protected workflow/identity review and fresh
CI remain required. Apply migration 0019 only after authorized 0017/0018 rollout,
deploy the reviewed claim endpoint before enabling its reviewed workflow gate,
and quiesce old cached runs. No such rollout or live identity journey occurred.

Unresolved external dependencies: owner-selected execution host, authorized
provider configuration, TLS/identity and artifact storage configuration, approved
deployment and physical mobile acceptance. Never expose a Docker socket or host
credentials to an untrusted repository. Protected changes require CODEOWNERS review.

## Cost status

This change adds no dependency or hosted service and incurred no provisioned
infrastructure cost. Ongoing cloud estimates have not been priced against a
selected current vendor/region, so no unverified monthly figure is asserted.
Track CPU-hours, storage, egress and model input/output tokens against configured
caps before rollout. User-owned local inference has hardware/electricity costs;
hosted free allocations are finite; GPU serving adds rental and storage costs.
Vendor pricing comparison remains a deployment-planning task once candidates are
selected. Do not rent compute or increase API budgets automatically.

## 2026-10-17 — result ownership integration checkpoint (#282)

Integrated main 482948b through #270/#274/#276/#278 into the existing result
ownership implementation. Added a built-Worker callback regression that changes
the saved objective during GitHub verification and requires 409, no result writes,
and no run linkage. Existing transaction ownership checks remain authoritative.
Reports are executor-authored summaries, not verified successful outcomes.

All ten workflow checks pass. Runner/local suite: 86 pass, one failure, one
Linux-only skip (88 total); isolated process suite: five pass, two fail, one
Linux-only skip. Windows inherited-pipe deadline and observer timing remain
unresolved. Do not relabel these failures as a passing acceptance run.
Fresh validation: production Worker build and typecheck pass; complete web suite
551 pass, four optional browser skips (555 total), including all six result tests
and the callback race. Dependencies were copied from the verified parent after a
stalled npm ci; lockfile SHA-256 values match. Initial incomplete-install checks
failed to find binaries. Corrected regression preserves the run linkage already
established by the claim. CI at 39cadb3 passes web build/tests/lint and eleven other
jobs; Windows local-control remains pending at this checkpoint. Local full lint
is still running. No live-provider or physical-phone acceptance is inferred.
No production migration/deployment, live OIDC, paid infrastructure or secret
transfer occurred. Migration 0019 and protected owner review remain required.
Next: finish #282 web validation and fresh CI; then #289 trusted outcome receipts.

## 2026-10-18 — trusted execution outcomes integration (#286 / #289)

GitHub confirms #270/#274/#276/#278 are merged. #282 at 593fad5 passed all
13 CI jobs before this session. Current main e604174 also contains inference
foundations #129–133, quota wiring #158 and model-pool routing #160. Prior open
status inventories are historical. Main is now integrated through #282 into
#289; no second inference governor or execution backend was introduced.

Reused the existing attempt-specific GitHub job verifier, migration 0020,
immutable outcome receipt, transactional ownership guards and scoped mobile
reads. Improved callback diagnostics when outcome evidence is unavailable:
retry result delivery, never rerun the task. Retained the parent task-mutation
race and now require zero outcome receipts on refusal. Added a real-component
GET-only pending-to-verified-failure UI test with explicit validation/retry limits.
Sixteen verifier and request-history cases pass. Build/full web suite, typecheck,
lint and refreshed CI are pending at this checkpoint; no live OIDC or phone
acceptance is inferred. Migration 0020 follows 0019 and remains undeployed.
No production data, billing, credentials or paid infrastructure were changed.
Next: finish current-head verification/security review; then integrate existing
#284 Genesis receipt recovery; never infer permission for retry/takeover.

Concurrent integration: remote #289 advanced to 3ed8310 when #312 merged into
it. Merged that work without force-pushing. Reconciliation retains server-selected
claim identity and cannot start or bill tasks. Its UI now shares cancellation,
single-flight and response fencing with detail reads. Three new regressions cover
late success/failure after reopen and late completion after unmount. An earlier
build overlapped the UI merge conflict and failed; the resolved tree is rebuilding.
## 2026-10-19 — verification follow-through (#289, includes merged #312)

Resolved-tree production Worker build and typecheck pass. Complete local web
suite: 604 total, 599 passed, five optional browser skips, zero failures. Separate
real Edge acceptance passed at 1280x800 and 390x844, including explicit receipt
reconciliation, one POST with no client-selected run, a verified failure display,
44px controls and no page errors. This uses controlled GitHub/API fixtures; it
is not a physical-phone or live-provider acceptance result.

The new deadline test failed before the fix and passed after combining the
navigation signal with the existing 30-second timeout. Navigation fencing does
not cancel committed evidence or authorize execution. Eleven workflow checks
pass. Parent #282 at fc2d324 has all thirteen CI jobs green; #289 source d820c47
has twelve green jobs and Windows local-control still running at this checkpoint.
Fresh CI is required for the final documentation/browser-test commit. Local lint
is still pending; CI web lint passes. Historical failed overlapping-merge build
and the initial deadline regression remain recorded as failed evidence.

No migration, production deployment, credentials, paid compute or production data
changed. Owner/security review remains required for the receipt and tenant
boundary. Migration 0020 must follow reviewed 0019. Next: finish fresh #289 CI and
review; then inspect existing #284 Genesis receipt recovery (still open on main)
without overwriting its active worktree. No retry/takeover authority is implied.


Local verification completion (2026-10-19): full web ESLint finished with exit 0,
build/typecheck and all 599 executed web tests pass. The five browser skips were
optional configuration skips; separately configured desktop/mobile Edge acceptance
passed. Latest PR CI and protected review remain independent gates.



2026-10-19 CI recovery: 6ac1336 failed Windows daemon startup and concurrent
Genesis completion (828 pass, two failures, 20 skips). Integrated current main
afdee04 through #282, including the existing Genesis fixture correction. All 11
serial daemon/Genesis tests pass locally. Fresh parallel Windows CI is required;
no deadline was weakened and the previous failure was not discarded. #284 now
contains current-main hosted receipt recovery integration for separate review.



2026-10-19 Worker compatibility follow-through: CI found three redirect error
modes incompatible with Workers. Verification now uses manual redirects and
refuses non-success responses; a 302 regression confirms no second credential
request. The scan now uses fileURLToPath and requires a nonempty source scan,
so Windows cannot silently pass without inspecting files. Four focused verifier
checks pass. Current-main build passes; fresh full web suite and CI are running.

