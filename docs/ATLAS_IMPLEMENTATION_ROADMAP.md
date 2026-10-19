# Atlas implementation roadmap

Updated 2026-10-16. Existing PROGRAM.md safety and CODEOWNERS rules apply.
Do not overwrite files owned by pending workstreams. Claim each new issue.

## Dependency order

1. P0: reliable inference transport and truthful completion (#300, #307 merged
   as af500709 after all 13 exact-head CI jobs passed).
   Reject missing completion/empty responses and retain durable retry state.
2. P0: reconcile existing provider repair #240 and credential/isolation work
   #233/#235/#253 through required reviews and CI. No protected auto-merge.
3. P1: integrate durable task stack in order:
   #270 (main) → #274 (base codex/durable-dispatch) → #276
   → #278 (base codex/task-request-inspection) → #282
   (base codex/execution-claims). #266 cancellation, #284 Genesis receipts,
   #289 outcomes and #291 missions need explicit integration tests against it.
4. P1: reconcile inference #129–133 → #158 → #160 with current source;
   migrate remaining callers instead of introducing a second governor.
   Verify rate-limit/date reset, billing/auth stop, compatible authorized fallback,
   cancellation, durable capacity wait, and resource accounting.
5. P1: native Linux execution adapter using existing task/runtime/worker registry.
   Keep control plane separate from disposable execution containers. Establish
   fenced claims, heartbeats, checkpoints, artifacts and result ownership first.
   Run a controlled repository task, kill and replace the worker, then verify
   one accepted artifact and no repeated side effect with the desktop offline.
6. P2: wire existing remote worker telemetry, cloud browser and agent scheduling
   after the execution boundary is proven. Reuse worker trust/tenant policy.
7. P2: Genesis real contractor acceptance: specification → implementation →
   tests → phone/desktop preview → approved publish → live form/health checks.
8. P3: configured mobile approval journey, onboarding, integrations, performance.

Current follow-up: #270 is integrated with main and adds an enforced dispatch
deadline, with 505 web tests passing and two optional skips. #274 has received
the updated parent and passes its full web suite (515 pass, two optional skips),
build and typecheck. Main's atomic billing/account changes are now propagated
through #276. Recovery #276 passes its final build/full web suite (537 pass,
four optional skips), nine race cases and actual desktop/mobile browser acceptance.
The updated parent is now integrated into #278: build/typecheck, full web suite
(545 pass, four optional skips), 83 runner/local checks and all ten workflow
checks and full web lint pass. #276 at 5a9ba04 has all 13 CI jobs green.
Finish fresh claims CI/protected review, then propagate to
#282 result ownership, respecting ownership.
If held for review, implement an
independent model-client cancellation/deadline regression without modifying
#230-owned routing or #240-owned hosted transport.

Open external gates: configured execution host and deployment approval,
provider/model credentials and qualification, customer-approved data routing,
physical-phone acceptance. Do not provision paid compute or transfer secrets.

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

