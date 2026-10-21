# Open PR launch triage — 2026-10-21

Snapshot: 37 open PRs returned by GitHub, newest first. Reviewed descriptions and changed-file inventories for every entry; inspected patch content for #230, #200, #417, #414 and #400. This is launch triage, not a complete line-by-line security review, fresh CI certification or merge approval. Mergeability is GitHub's snapshot and can change. No PR was merged or closed by this audit.

## Findings that determine launch order

- #230 is the existing guided local-AI implementation: measured context variants, memory/disk checks, authenticated inference gateway, coding repair qualification and packaging. Reconcile its conflicts instead of building a second setup wizard. Its launcher change invokes the supervisor; preserve that when integrating the narrow launcher/model-picker repair from this worktree.
- #200 makes local inference a first-class CLI provider and distinguishes billing exhaustion from throttling. Current run-coder still labels its wire-compatible local route `groq` and builds on demand; do not interpret that label as evidence a hosted API is required. Reconcile with #230's compiled-runner packaging.
- #414 pools free hosted providers; it still requires provider accounts/keys and quotas. It does not fulfill fully local, key-free inference. #417 is product tier selection, not measured model efficacy.
- #240/#178 are existing transport/release-verification work. Use actual streaming + non-streaming + persisted replies as the hosted release gate; provider pool and successful deploys do not replace it.
- #395 retains medium coder diagnostic traces. Its documented configured review gate remains; no diagnosis should infer identical-argument loops from tool names alone.
- #429 says quantum audit only, no implementation and no quantum advantage. #423 is a phased federated-compute plan. #422/#421 overlap on public copy. These do not block local chat and should not displace it.
- #400 requires an explicitly enabled, deployed Cloudflare Sandbox environment and Workers Paid. It is optional for this PC's local launch.
- Existing security, mission recovery, mobile, memory and UI branches overlap main and each other. A clean mergeability flag is not a readiness certificate; conflicting branches need narrow semantic reconciliation and fresh exact-head tests.

## Inventory

| PR | Title | Files | Conflict snapshot | Launch priority |
|---|---|---:|---|---|
| [#433](https://github.com/cornerstonemarketingus/atlas/pull/433) | Atlas: Created **docs/ATLAS-SMOKE-CHECK-c594d4f4-6b31-4cc1-b26b-4928d50fba64.md | 1 | No conflict reported | P2 — after core launch |
| [#429](https://github.com/cornerstonemarketingus/atlas/pull/429) | [WIP for Codex] Quantum execution layer | 1 | No conflict reported | P2 — after core launch |
| [#423](https://github.com/cornerstonemarketingus/atlas/pull/423) | Supercompute plan: federated compute fabric audit and phased additions | 1 | No conflict reported | P2 — after core launch |
| [#422](https://github.com/cornerstonemarketingus/atlas/pull/422) | Investor copy refresh; remove quantum physics references | 6 | No conflict reported | P2 — after core launch |
| [#421](https://github.com/cornerstonemarketingus/atlas/pull/421) | Clarify Atlas compute resilience and quantum research messaging | 3 | No conflict reported | P2 — after core launch |
| [#417](https://github.com/cornerstonemarketingus/atlas/pull/417) | Offer Atlas and paid Super Atlas chat modes | 5 | No conflict reported | P1 — qualify/reconcile |
| [#414](https://github.com/cornerstonemarketingus/atlas/pull/414) | Add a free-tier provider pool to hosted chat's route | 7 | Conflicts | P1 — qualify/reconcile |
| [#410](https://github.com/cornerstonemarketingus/atlas/pull/410) | Record the free compute and eval baseline work in the handoff log | 1 | Conflicts | P2 — after core launch |
| [#400](https://github.com/cornerstonemarketingus/atlas/pull/400) | Cloud environments on Cloudflare Sandboxes (off by default, needs Workers Paid + deploy) (#351) | 21 | No conflict reported | P2 — after core launch |
| [#395](https://github.com/cornerstonemarketingus/atlas/pull/395) | Support medium coder diagnostic objectives and retain traces | 6 | Conflicts | P1 — qualify/reconcile |
| [#335](https://github.com/cornerstonemarketingus/atlas/pull/335) | Observe opted-in execution claims on a bounded cloud schedule | 14 | No conflict reported | P1/P2 — inspect overlap |
| [#329](https://github.com/cornerstonemarketingus/atlas/pull/329) | Verify native storage before consuming a pairing code | 11 | Conflicts | P2 — after core launch |
| [#320](https://github.com/cornerstonemarketingus/atlas/pull/320) | Compile native mobile development apps in independent CI | 15 | Conflicts | P2 — after core launch |
| [#291](https://github.com/cornerstonemarketingus/atlas/pull/291) | Persist cloud missions and recover verified execution across reconnects | 17 | Conflicts | P1 — qualify/reconcile |
| [#289](https://github.com/cornerstonemarketingus/atlas/pull/289) | Persist verified execution outcomes and show scoped mobile receipts | 24 | No conflict reported | P1/P2 — inspect overlap |
| [#284](https://github.com/cornerstonemarketingus/atlas/pull/284) | Recover Genesis project receipts when reopening chat | 22 | Conflicts | P1/P2 — inspect overlap |
| [#282](https://github.com/cornerstonemarketingus/atlas/pull/282) | Bind hosted result callbacks to the claimed execution attempt | 10 | Conflicts | P1/P2 — inspect overlap |
| [#253](https://github.com/cornerstonemarketingus/atlas/pull/253) | Isolate hosted coder validation from the trusted runner | 10 | Conflicts | P1 — qualify/reconcile |
| [#240](https://github.com/cornerstonemarketingus/atlas/pull/240) | Fix Workers AI streaming, cancellation and multi-round diagnostics | 17 | Conflicts | P1 — qualify/reconcile |
| [#237](https://github.com/cornerstonemarketingus/atlas/pull/237) | Operator control: pause, take over, hand back and cancel, with receipts and a crash-safe journal | 12 | Conflicts | P1 — qualify/reconcile |
| [#236](https://github.com/cornerstonemarketingus/atlas/pull/236) | Replay and autonomous evaluation: run manifests, side-effect-free replay, benchmark suite, release gate | 16 | Conflicts | P1 — qualify/reconcile |
| [#233](https://github.com/cornerstonemarketingus/atlas/pull/233) | Credential Broker foundation and redaction at the tool boundary | 10 | Conflicts | P1 — qualify/reconcile |
| [#230](https://github.com/cornerstonemarketingus/atlas/pull/230) | Free Local AI: guided setup and measured coding qualification | 27 | Conflicts | P1 — qualify/reconcile |
| [#223](https://github.com/cornerstonemarketingus/atlas/pull/223) | feat(opportunities): goal-driven opportunity scout (find, normalize, rank, remember) | 15 | Conflicts | P2 — after core launch |
| [#207](https://github.com/cornerstonemarketingus/atlas/pull/207) | feat(chat): reuse immutable repository content across pages, rereads and agents | 6 | Conflicts | P1/P2 — inspect overlap |
| [#202](https://github.com/cornerstonemarketingus/atlas/pull/202) | Wrap tool log as untrusted data in team step verification | 3 | Conflicts | P1/P2 — inspect overlap |
| [#200](https://github.com/cornerstonemarketingus/atlas/pull/200) | atlas-cli: classify billing exhaustion separately from rate limiting; add local/Ollama as a first-class provider | 30 | Conflicts | P1 — qualify/reconcile |
| [#191](https://github.com/cornerstonemarketingus/atlas/pull/191) | fix(web): log and surface task-history save failures | 8 | Conflicts | P1/P2 — inspect overlap |
| [#181](https://github.com/cornerstonemarketingus/atlas/pull/181) | Genesis: select and edit static-site text through verified previews | 12 | Conflicts | P1/P2 — inspect overlap |
| [#178](https://github.com/cornerstonemarketingus/atlas/pull/178) | Verify selected chat providers in hosted release checks | 5 | Conflicts | P1 — qualify/reconcile |
| [#105](https://github.com/cornerstonemarketingus/atlas/pull/105) | [WIP] Update default browser worker for computer control | 1 | No conflict reported | P2 — after core launch |
| [#101](https://github.com/cornerstonemarketingus/atlas/pull/101) | Add Genesis repository creation from chat with seeded starter templates | 36 | Conflicts | P1/P2 — inspect overlap |
| [#98](https://github.com/cornerstonemarketingus/atlas/pull/98) | Add PR/CI-aware chat tools for task status, reviews, and failed job logs | 5 | Conflicts | P1/P2 — inspect overlap |
| [#97](https://github.com/cornerstonemarketingus/atlas/pull/97) | Add tenant-scoped durable chat memory and Memory management UI | 17 | Conflicts | P1/P2 — inspect overlap |
| [#77](https://github.com/cornerstonemarketingus/atlas/pull/77) | SEC-13: Add per-request script nonces and report-only strict CSP in web Worker | 4 | Conflicts | P1/P2 — inspect overlap |
| [#69](https://github.com/cornerstonemarketingus/atlas/pull/69) | Add D1-backed rate limiting to hosted web API routes | 16 | Conflicts | P1/P2 — inspect overlap |
| [#61](https://github.com/cornerstonemarketingus/atlas/pull/61) | Build the mobile remote companion on the Capacitor shell | 6 | Conflicts | P2 — after core launch |

## Changed-file evidence

### #433: Atlas: Created **docs/ATLAS-SMOKE-CHECK-c594d4f4-6b31-4cc1-b26b-4928d50fba64.md

- `docs/ATLAS-SMOKE-CHECK-c594d4f4-6b31-4cc1-b26b-4928d50fba64.md`

### #429: [WIP for Codex] Quantum execution layer

- `docs/research/QUANTUM-HANDOFF.md`

### #423: Supercompute plan: federated compute fabric audit and phased additions

- `docs/atlas-os/SUPERCOMPUTE-PLAN.md`

### #422: Investor copy refresh; remove quantum physics references

- `README.md`
- `TODO.md`
- `apps/web/app/about/page.tsx`
- `apps/web/app/investors/page.tsx`
- `docs/PROGRESS.md`
- `docs/audits/ATLAS-LAUNCH-READINESS.md`

### #421: Clarify Atlas compute resilience and quantum research messaging

- `README.md`
- `apps/web/app/about/page.tsx`
- `apps/web/app/investors/page.tsx`

### #417: Offer Atlas and paid Super Atlas chat modes

- `apps/web/app/api/chat/chat-tiers.mjs`
- `apps/web/app/api/chat/route.ts`
- `apps/web/app/chat/ChatSection.tsx`
- `apps/web/tests/chat-tiers.test.mjs`
- `docs/atlas-os/ATLAS-CHAT-TIERS.md`

### #414: Add a free-tier provider pool to hosted chat's route

- `.github/workflows/deploy-cloudflare.yml`
- `apps/web/app/api/chat/agent-loop.mjs`
- `apps/web/app/api/chat/model-endpoint.mjs`
- `apps/web/app/api/chat/providers.mjs`
- `apps/web/tests/free-tier-providers.test.mjs`
- `docs/FREE-TIER-PROVIDERS.md`
- `docs/PROGRESS.md`

### #410: Record the free compute and eval baseline work in the handoff log

- `docs/PROGRESS.md`

### #400: Cloud environments on Cloudflare Sandboxes (off by default, needs Workers Paid + deploy) (#351)

- `apps/local-control/src/platform/environments/cloudflare.mjs`
- `apps/local-control/src/platform/environments/environment.mjs`
- `apps/local-control/src/platform/environments/index.mjs`
- `apps/local-control/src/platform/environments/local.mjs`
- `apps/local-control/tests/cloud-environment.test.mjs`
- `apps/local-control/tests/helpers/fake-sandbox-broker.mjs`
- `apps/web/app/api/sandbox/[id]/[operation]/route.ts`
- `apps/web/app/api/sandbox/[id]/route.ts`
- `apps/web/app/api/sandbox/broker.mjs`
- `apps/web/package-lock.json`
- `apps/web/package.json`
- `apps/web/sandbox.config.json`
- `apps/web/sandbox/Dockerfile`
- `apps/web/sandbox/tree-manifest.mjs`
- `apps/web/sandbox/wrangler-sandbox.mjs`
- `apps/web/tests/sandbox-broker.test.mjs`
- `apps/web/vite.config.ts`
- `apps/web/worker/index-sandbox.ts`
- `apps/web/worker/sandbox-core.mjs`
- `apps/web/worker/sandbox-object.mjs`
- `docs/atlas-os/GENESIS.md`

### #395: Support medium coder diagnostic objectives and retain traces

- `.github/workflows/atlas-coder.yml`
- `.github/workflows/verify-hosted.yml`
- `apps/web/tests/repository-settings-privacy.test.mjs`
- `docs/PROGRESS.md`
- `scripts/runner/smoke-hosted.mjs`
- `scripts/runner/smoke-hosted.test.mjs`

### #335: Observe opted-in execution claims on a bounded cloud schedule

- `apps/web/app/api/tasks/github-app.mjs`
- `apps/web/app/api/tasks/outcome-observer.mjs`
- `apps/web/app/api/tasks/request-inspection.mjs`
- `apps/web/app/api/tasks/requests/[requestKey]/observation/route.ts`
- `apps/web/app/build/RequestHistory.tsx`
- `apps/web/app/build/request-inspection-client.mjs`
- `apps/web/drizzle/0022_task_outcome_observation.sql`
- `apps/web/drizzle/meta/_journal.json`
- `apps/web/tests/github-app.test.mjs`
- `apps/web/tests/outcome-observer.test.mjs`
- `apps/web/vite.config.ts`
- `apps/web/worker/index.ts`
- `apps/web/worker/outcome-observer.mjs`
- `docs/HOSTED-OUTCOME-OBSERVER.md`

### #329: Verify native storage before consuming a pairing code

- `docs/MOBILE-PAIRED-LAUNCH.md`
- `docs/PROGRESS.md`
- `mobile/ios/App/App/Info.plist`
- `mobile/ios/App/App/SceneDelegate.swift`
- `mobile/tests/daemon-contract.test.mjs`
- `mobile/tests/device-client.test.mjs`
- `mobile/tests/launch-browser.test.mjs`
- `mobile/tests/native-project.test.mjs`
- `mobile/www/device-client.mjs`
- `mobile/www/index.html`
- `mobile/www/launch.mjs`

### #320: Compile native mobile development apps in independent CI

- `.github/workflows/mobile-native.yml`
- `docs/MOBILE-PAIRED-LAUNCH.md`
- `docs/NATIVE-BUILD-VALIDATION.md`
- `docs/PROGRESS.md`
- `mobile/ios/App/App/Info.plist`
- `mobile/ios/App/App/SceneDelegate.swift`
- `mobile/scripts/ios-launch-smoke.mjs`
- `mobile/scripts/verify-native-assets.py`
- `mobile/tests/daemon-contract.test.mjs`
- `mobile/tests/device-client.test.mjs`
- `mobile/tests/launch-browser.test.mjs`
- `mobile/tests/native-project.test.mjs`
- `mobile/www/device-client.mjs`
- `mobile/www/index.html`
- `mobile/www/launch.mjs`

### #291: Persist cloud missions and recover verified execution across reconnects

- `apps/web/app/AtlasShell.tsx`
- `apps/web/app/api/missions/[missionId]/route.ts`
- `apps/web/app/api/missions/http.mjs`
- `apps/web/app/api/missions/route.ts`
- `apps/web/app/api/missions/runtime.ts`
- `apps/web/app/api/missions/service.mjs`
- `apps/web/app/missions/MissionsSection.tsx`
- `apps/web/app/missions/missions.css`
- `apps/web/app/missions/page.tsx`
- `apps/web/app/missions/request.mjs`
- `apps/web/drizzle/0021_cloud_missions.sql`
- `apps/web/tests/cloud-missions-browser.test.mjs`
- `apps/web/tests/cloud-missions.test.mjs`
- `apps/web/tests/mission-request.test.mjs`
- `docs/CUSTOMER-READINESS-AUDIT.md`
- `docs/HOSTED-MISSIONS.md`
- `docs/PROGRESS.md`

### #289: Persist verified execution outcomes and show scoped mobile receipts

- `apps/web/app/api/tasks/claim-reconciliation.mjs`
- `apps/web/app/api/tasks/execution-outcomes.mjs`
- `apps/web/app/api/tasks/request-inspection.mjs`
- `apps/web/app/api/tasks/requests/[requestKey]/reconcile/route.ts`
- `apps/web/app/api/tasks/result-storage.mjs`
- `apps/web/app/api/tasks/result/route.ts`
- `apps/web/app/build/RequestHistory.tsx`
- `apps/web/app/build/request-inspection-client.mjs`
- `apps/web/drizzle/0020_task_execution_outcomes.sql`
- `apps/web/drizzle/meta/_journal.json`
- `apps/web/tests/claim-reconciliation.test.mjs`
- `apps/web/tests/execution-outcomes.test.mjs`
- `apps/web/tests/request-history-browser.test.mjs`
- `apps/web/tests/request-history-screen.test.mjs`
- `apps/web/tests/result-storage.test.mjs`
- `apps/web/tests/worker-fetch-redirect.test.mjs`
- `docs/ATLAS_DEPLOYMENT.md`
- `docs/ATLAS_IMPLEMENTATION_ROADMAP.md`
- `docs/ATLAS_MASTER_AUDIT.md`
- `docs/ATLAS_PROGRESS.md`
- `docs/ATLAS_TEST_RESULTS.md`
- `docs/HOSTED-CLAIM-RECONCILIATION.md`
- `docs/HOSTED-EXECUTION-OUTCOMES.md`
- `docs/PROGRESS.md`

### #284: Recover Genesis project receipts when reopening chat

- `apps/web/app/api/chat/route.ts`
- `apps/web/app/api/genesis/bridge.mjs`
- `apps/web/app/api/genesis/hosted-site.mjs`
- `apps/web/app/api/genesis/operations/route.ts`
- `apps/web/app/api/genesis/project-backend.mjs`
- `apps/web/app/api/genesis/receipts.mjs`
- `apps/web/app/chat/ChatSection.tsx`
- `apps/web/app/chat/ProjectActivity.tsx`
- `apps/web/app/chat/project-receipts.mjs`
- `apps/web/app/chat/project-state.mjs`
- `apps/web/tests/chat-screen.test.mjs`
- `apps/web/tests/chat-scroll-browser.test.mjs`
- `apps/web/tests/project-api.test.mjs`
- `apps/web/tests/project-receipts.test.mjs`
- `apps/web/tests/project-tools.test.mjs`
- `docs/ATLAS_DEPLOYMENT.md`
- `docs/ATLAS_IMPLEMENTATION_ROADMAP.md`
- `docs/ATLAS_MASTER_AUDIT.md`
- `docs/ATLAS_PROGRESS.md`
- `docs/ATLAS_TEST_RESULTS.md`
- `docs/HOSTED-PROJECT-CREATION.md`
- `docs/PROGRESS.md`

### #282: Bind hosted result callbacks to the claimed execution attempt

- `apps/web/app/api/tasks/result-storage.mjs`
- `apps/web/app/api/tasks/result/route.ts`
- `apps/web/tests/result-storage.test.mjs`
- `docs/ATLAS_DEPLOYMENT.md`
- `docs/ATLAS_IMPLEMENTATION_ROADMAP.md`
- `docs/ATLAS_MASTER_AUDIT.md`
- `docs/ATLAS_PROGRESS.md`
- `docs/ATLAS_TEST_RESULTS.md`
- `docs/HOSTED-RESULT-OWNERSHIP.md`
- `docs/PROGRESS.md`

### #253: Isolate hosted coder validation from the trusted runner

- `.github/workflows/atlas-coder.yml`
- `.github/workflows/cloud-validation.yml`
- `docs/CLOUD-CODING-AUDIT.md`
- `packages/atlas-cli/src/cli.ts`
- `packages/atlas-cli/src/infrastructure/container-validation-runner.ts`
- `packages/atlas-cli/tests/container-coder-journey.test.ts`
- `packages/atlas-cli/tests/container-validation-runner.test.ts`
- `scripts/runner/run-task.mjs`
- `scripts/runner/validation-isolation.mjs`
- `scripts/runner/validation-isolation.test.mjs`

### #240: Fix Workers AI streaming, cancellation and multi-round diagnostics

- `LOCAL-MODEL.md`
- `apps/web/app/api/chat/agent-loop.mjs`
- `apps/web/app/api/chat/model-endpoint.mjs`
- `apps/web/app/api/chat/providers.mjs`
- `apps/web/app/api/chat/route.ts`
- `apps/web/app/api/chat/workers-ai-binding.mjs`
- `apps/web/app/chat/ChatSection.tsx`
- `apps/web/tests/chat-agent-loop.test.mjs`
- `apps/web/tests/chat-failure-metadata.test.mjs`
- `apps/web/tests/continuation-recovery.test.mjs`
- `apps/web/tests/local-chat-api.test.mjs`
- `apps/web/tests/local-chat-options.test.mjs`
- `apps/web/tests/workers-ai-binding.test.mjs`
- `docs/atlas-os/CREDENTIALS.md`
- `scripts/local/setup-chat.mjs`
- `scripts/runner/smoke-failure-metadata.test.mjs`
- `scripts/runner/smoke-hosted.mjs`

### #237: Operator control: pause, take over, hand back and cancel, with receipts and a crash-safe journal

- `apps/local-control/src/agent/operator-routes.mjs`
- `apps/local-control/src/main.mjs`
- `apps/local-control/src/platform/command-center.mjs`
- `apps/local-control/src/server.mjs`
- `apps/local-control/src/ui.mjs`
- `apps/local-control/tests/operator-control.test.mjs`
- `apps/windows-companion/package.json`
- `apps/windows-companion/src/desktop/session.mjs`
- `apps/windows-companion/src/operator/control.mjs`
- `apps/windows-companion/src/operator/session.mjs`
- `apps/windows-companion/tests/control.test.mjs`
- `docs/PROGRESS.md`

### #236: Replay and autonomous evaluation: run manifests, side-effect-free replay, benchmark suite, release gate

- `apps/local-control/benchmarks/baseline.core.v1.json`
- `apps/local-control/benchmarks/core.v1.json`
- `apps/local-control/benchmarks/release-gate.v1.json`
- `apps/local-control/package.json`
- `apps/local-control/scripts/eval.mjs`
- `apps/local-control/src/main.mjs`
- `apps/local-control/src/platform/api-routes.mjs`
- `apps/local-control/src/platform/evals/benchmark.mjs`
- `apps/local-control/src/platform/evals/compare.mjs`
- `apps/local-control/src/platform/evals/gate.mjs`
- `apps/local-control/src/platform/evals/index.mjs`
- `apps/local-control/src/platform/evals/manifest.mjs`
- `apps/local-control/src/platform/evals/replay.mjs`
- `apps/local-control/src/platform/evals/sandbox-tools.mjs`
- `apps/local-control/tests/evals.test.mjs`
- `docs/PROGRESS.md`

### #233: Credential Broker foundation and redaction at the tool boundary

- `apps/local-control/src/agent/credentials/broker.mjs`
- `apps/local-control/src/agent/credentials/routes.mjs`
- `apps/local-control/src/agent/credentials/validators.mjs`
- `apps/local-control/src/main.mjs`
- `apps/local-control/src/server.mjs`
- `apps/local-control/src/ui.mjs`
- `apps/local-control/tests/credential-broker.test.mjs`
- `apps/local-control/tests/daemon-boot.test.mjs`
- `docs/PROGRESS.md`
- `docs/atlas-os/CREDENTIALS.md`

### #230: Free Local AI: guided setup and measured coding qualification

- `apps/local-control/src/agent/conversation-executor.mjs`
- `apps/local-control/src/agent/models/catalog.mjs`
- `apps/local-control/src/agent/models/coding-probe.mjs`
- `apps/local-control/src/agent/models/free-local.mjs`
- `apps/local-control/src/agent/models/hardware.mjs`
- `apps/local-control/src/agent/models/hosting.mjs`
- `apps/local-control/src/agent/models/manager.mjs`
- `apps/local-control/src/agent/models/routed-client.mjs`
- `apps/local-control/src/main.mjs`
- `apps/local-control/src/runner.mjs`
- `apps/local-control/src/ui.mjs`
- `apps/local-control/tests/coding-probe.test.mjs`
- `apps/local-control/tests/free-local.test.mjs`
- `apps/local-control/tests/local-payload.test.mjs`
- `apps/local-control/tests/model-hosting.test.mjs`
- `docs/PROGRESS.md`
- `docs/agent-runtime.md`
- `scripts/local/dogfood-free-local.mjs`
- `scripts/local/model-gateway.mjs`
- `scripts/local/model-gateway.test.mjs`
- `scripts/local/run-coder.mjs`
- `scripts/local/verify-free-local.mjs`
- `scripts/release/stage-local.mjs`
- `scripts/windows/Build-AtlasInstaller.ps1`
- `scripts/windows/Enable-AtlasStartup.ps1`
- `scripts/windows/Install-AtlasLocal.ps1`
- `scripts/windows/Start-AtlasLocal.ps1`

### #223: feat(opportunities): goal-driven opportunity scout (find, normalize, rank, remember)

- `apps/local-control/src/agent/kernel/capabilities.mjs`
- `apps/local-control/src/agent/tools/opportunity-tools.mjs`
- `apps/local-control/src/main.mjs`
- `apps/local-control/src/opportunity/model.mjs`
- `apps/local-control/src/opportunity/routes.mjs`
- `apps/local-control/src/opportunity/scout.mjs`
- `apps/local-control/src/opportunity/service.mjs`
- `apps/local-control/src/opportunity/sources.mjs`
- `apps/local-control/src/opportunity/store.mjs`
- `apps/local-control/src/platform/command-center.mjs`
- `apps/local-control/src/server.mjs`
- `apps/local-control/src/store.mjs`
- `apps/local-control/src/ui.mjs`
- `apps/local-control/tests/opportunities.test.mjs`
- `docs/PROGRESS.md`

### #207: feat(chat): reuse immutable repository content across pages, rereads and agents

- `apps/web/app/api/chat/instant-tools.mjs`
- `apps/web/app/api/chat/repository-content-cache.mjs`
- `apps/web/app/api/tasks/github-observability.mjs`
- `apps/web/tests/chat-instant-tools.test.mjs`
- `apps/web/tests/chat-repository-reuse.test.mjs`
- `docs/PROGRESS.md`

### #202: Wrap tool log as untrusted data in team step verification

- `apps/local-control/src/agent/team/step-executor.mjs`
- `apps/local-control/tests/team-missions.test.mjs`
- `docs/PROGRESS.md`

### #200: atlas-cli: classify billing exhaustion separately from rate limiting; add local/Ollama as a first-class provider

- `docs/PROGRESS.md`
- `packages/atlas-cli/README.md`
- `packages/atlas-cli/src/agent/provider-read-only-tool-agent.ts`
- `packages/atlas-cli/src/agent/read-only-tool-agent.ts`
- `packages/atlas-cli/src/cli.ts`
- `packages/atlas-cli/src/infrastructure/anthropic-model-provider.ts`
- `packages/atlas-cli/src/infrastructure/billing-exhaustion.ts`
- `packages/atlas-cli/src/infrastructure/bounded-json-http-transport.ts`
- `packages/atlas-cli/src/infrastructure/fallback-model-provider.ts`
- `packages/atlas-cli/src/infrastructure/groq-model-provider.ts`
- `packages/atlas-cli/src/infrastructure/local-openai-compatible-model-provider.ts`
- `packages/atlas-cli/src/infrastructure/provider-health-check.ts`
- `packages/atlas-cli/src/model/coder-endpoint.ts`
- `packages/atlas-cli/src/model/coder-provider-selection.ts`
- `packages/atlas-cli/src/model/model-provider.ts`
- `packages/atlas-cli/src/presentation/chat-renderers.ts`
- `packages/atlas-cli/src/presentation/code-renderers.ts`
- `packages/atlas-cli/src/presentation/provider-status-renderers.ts`
- `packages/atlas-cli/tests/anthropic-model-provider.test.ts`
- `packages/atlas-cli/tests/chat-renderers.test.ts`
- `packages/atlas-cli/tests/cli-chat.test.ts`
- `packages/atlas-cli/tests/cli-provider-status.test.ts`
- `packages/atlas-cli/tests/code-renderers.test.ts`
- `packages/atlas-cli/tests/coder-endpoint.test.ts`
- `packages/atlas-cli/tests/coder-provider-selection.test.ts`
- `packages/atlas-cli/tests/fallback-model-provider.test.ts`
- `packages/atlas-cli/tests/groq-model-provider.test.ts`
- `packages/atlas-cli/tests/local-openai-compatible-model-provider.test.ts`
- `packages/atlas-cli/tests/provider-health-check.test.ts`
- `packages/atlas-cli/tests/provider-read-only-tool-agent.test.ts`

### #191: fix(web): log and surface task-history save failures

- `apps/web/app/api/chat/atlas-knowledge.mjs`
- `apps/web/app/api/chat/route.ts`
- `apps/web/app/api/tasks/route.ts`
- `apps/web/app/api/tasks/task-diagnostics.mjs`
- `apps/web/app/chat/ChatSection.tsx`
- `apps/web/tests/chat-atlas-knowledge.test.mjs`
- `apps/web/tests/task-diagnostics.test.mjs`
- `docs/PROGRESS.md`

### #181: Genesis: select and edit static-site text through verified previews

- `apps/local-control/src/platform/genesis/executor.mjs`
- `apps/local-control/src/platform/genesis/inspector.mjs`
- `apps/local-control/src/platform/genesis/preview.mjs`
- `apps/local-control/src/platform/genesis/routes.mjs`
- `apps/local-control/src/platform/genesis/service.mjs`
- `apps/local-control/src/platform/genesis/templates/static-site/files/scripts/build.mjs`
- `apps/local-control/src/platform/genesis/templates/static-site/files/tests/site.test.mjs`
- `apps/local-control/src/platform/genesis/visual.mjs`
- `apps/local-control/src/server.mjs`
- `apps/local-control/src/ui.mjs`
- `apps/local-control/tests/genesis-publish.test.mjs`
- `apps/local-control/tests/genesis-visual.test.mjs`

### #178: Verify selected chat providers in hosted release checks

- `.github/workflows/verify-hosted.yml`
- `docs/PROGRESS.md`
- `scripts/runner/codeowners.test.mjs`
- `scripts/runner/smoke-hosted.mjs`
- `scripts/runner/smoke-provider.test.mjs`

### #105: [WIP] Update default browser worker for computer control

- `apps/browser-worker/src/browser-worker.mjs`

### #101: Add Genesis repository creation from chat with seeded starter templates

- `README.md`
- `apps/web/app/api/chat/agent-loop.mjs`
- `apps/web/app/api/chat/atlas-knowledge.mjs`
- `apps/web/app/api/chat/create-project.mjs`
- `apps/web/app/api/chat/route.ts`
- `apps/web/app/api/github/options/route.ts`
- `apps/web/app/api/projects/genesis/route.ts`
- `apps/web/app/api/projects/genesis/service.mjs`
- `apps/web/app/api/projects/genesis/templates.mjs`
- `apps/web/app/api/tasks/github-app.mjs`
- `apps/web/app/api/tasks/route.ts`
- `apps/web/app/chat/ChatSection.tsx`
- `apps/web/db/tenancy.mjs`
- `apps/web/tests/chat-agent-loop.test.mjs`
- `apps/web/tests/chat-atlas-knowledge.test.mjs`
- `apps/web/tests/genesis.test.mjs`
- `apps/web/tests/github-app.test.mjs`
- `apps/web/tests/tenancy.test.mjs`
- `templates/genesis/static-site/README.md`
- `templates/genesis/static-site/atlas-template.json`
- `templates/genesis/static-site/index.html`
- `templates/genesis/static-site/styles.css`
- `templates/genesis/web-app/.github/workflows/ci.yml`
- `templates/genesis/web-app/README.md`
- `templates/genesis/web-app/app/globals.css`
- `templates/genesis/web-app/app/layout.tsx`
- `templates/genesis/web-app/app/page.tsx`
- `templates/genesis/web-app/atlas-template.json`
- `templates/genesis/web-app/db/schema.ts`
- `templates/genesis/web-app/package-lock.json`
- `templates/genesis/web-app/package.json`
- `templates/genesis/web-app/tests/smoke.test.mjs`
- `templates/genesis/web-app/tsconfig.json`
- `templates/genesis/web-app/vinext-env.d.ts`
- `templates/genesis/web-app/vite.config.ts`
- `templates/genesis/web-app/worker/index.ts`

### #98: Add PR/CI-aware chat tools for task status, reviews, and failed job logs

- `apps/web/app/api/chat/atlas-knowledge.mjs`
- `apps/web/app/api/chat/instant-tools.mjs`
- `apps/web/app/api/chat/route.ts`
- `apps/web/tests/chat-atlas-knowledge.test.mjs`
- `apps/web/tests/chat-instant-tools.test.mjs`

### #97: Add tenant-scoped durable chat memory and Memory management UI

- `apps/web/app/AtlasShell.tsx`
- `apps/web/app/api/chat/atlas-knowledge.mjs`
- `apps/web/app/api/chat/instant-tools.mjs`
- `apps/web/app/api/chat/memory-safety.mjs`
- `apps/web/app/api/chat/route.ts`
- `apps/web/app/api/memory/route.ts`
- `apps/web/app/atlas-shell.css`
- `apps/web/app/chat/ChatSection.tsx`
- `apps/web/app/memory/MemorySection.tsx`
- `apps/web/app/memory/page.tsx`
- `apps/web/db/schema.ts`
- `apps/web/db/tenancy.mjs`
- `apps/web/drizzle/0016_memories.sql`
- `apps/web/drizzle/meta/_journal.json`
- `apps/web/tests/chat-atlas-knowledge.test.mjs`
- `apps/web/tests/chat-instant-tools.test.mjs`
- `apps/web/tests/memory.test.mjs`

### #77: SEC-13: Add per-request script nonces and report-only strict CSP in web Worker

- `apps/web/tests/rendered-html.test.mjs`
- `apps/web/worker/index.ts`
- `apps/web/worker/security-headers.mjs`
- `docs/atlas-os/SECURITY-REVIEW.md`

### #69: Add D1-backed rate limiting to hosted web API routes

- `TODO.md`
- `apps/web/app/api/auth/github/callback/route.ts`
- `apps/web/app/api/auth/github/start/route.ts`
- `apps/web/app/api/auth/operator/route.ts`
- `apps/web/app/api/chat/route.ts`
- `apps/web/app/api/computer/approvals/[id]/route.ts`
- `apps/web/app/api/computer/companion/approval/[id]/route.ts`
- `apps/web/app/api/computer/tasks/route.ts`
- `apps/web/app/api/rate-limit.mjs`
- `apps/web/app/api/tasks/route.ts`
- `apps/web/db/schema.ts`
- `apps/web/drizzle/0018_hosted_rate_limits.sql`
- `apps/web/drizzle/meta/_journal.json`
- `apps/web/tests/rate-limit.test.mjs`
- `docs/atlas-os/CURRENT-STATE.md`
- `docs/atlas-os/SECURITY-REVIEW.md`

### #61: Build the mobile remote companion on the Capacitor shell

- `MOBILE-RELEASE.md`
- `mobile/README.md`
- `mobile/package.json`
- `mobile/src/bridge.mjs`
- `mobile/src/remote-companion.mjs`
- `mobile/tests/shell.test.mjs`


