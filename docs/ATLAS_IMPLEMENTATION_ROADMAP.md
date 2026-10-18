# Atlas implementation roadmap

Updated 2026-10-16. Existing PROGRAM.md safety and CODEOWNERS rules apply.
Do not overwrite files owned by pending workstreams. Claim each new issue.

## Dependency order

1. P0: reliable inference transport and truthful completion (#300, this branch).
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

First follow-up after this slice: current-main integration review of #270 and
its stack, respecting active ownership. If held for review, implement an
independent model-client cancellation/deadline regression without modifying
#230-owned routing or #240-owned hosted transport.

Open external gates: configured execution host and deployment approval,
provider/model credentials and qualification, customer-approved data routing,
physical-phone acceptance. Do not provision paid compute or transfer secrets.
