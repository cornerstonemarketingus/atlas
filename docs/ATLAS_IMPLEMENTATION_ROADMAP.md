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
Fresh web validation is pending: npm ci stalled without an error, then was stopped;
matching-lockfile dependencies are being copied from the verified parent checkout.
Initial build/lint attempts before dependency completion failed to find binaries.
No production migration/deployment, live OIDC, paid infrastructure or secret
transfer occurred. Migration 0019 and protected owner review remain required.
Next: finish #282 web validation and fresh CI; then #289 trusted outcome receipts.
