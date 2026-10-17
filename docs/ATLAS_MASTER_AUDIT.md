# Atlas implementation inventory

Reviewed 2026-10-16 against main `1c3be5b`. This is an incremental inventory,
not a certification that every source line or deployed integration was tested.
Resume from ATLAS_PROGRESS.md and docs/PROGRESS.md. The owner's older checkout
and unrelated changes were preserved in place; implementation uses an isolated worktree.

Truth order: source and executed boundary tests, current CI, progress documents,
historical audit. Historical failures are not automatically current failures.
Current main CI run 38991786626 passed all 13 jobs, including Windows.

| Area | Classification | Source/evidence | Remaining acceptance |
|---|---|---|---|
| Local inference SSE transport | BROKEN on baseline; fixed in this branch | `apps/local-control/src/agent/model-client.mjs`; `tests/model-stream.test.mjs`: original eight regressions failed, fixed transport passes | Required PR CI; configured real model acceptance |
| Local conversations and restart persistence | PARTIAL | `agent/{runtime,session-store,conversation-executor}.mjs`; new actual SQLite restart regression plus existing conversation suite | Automatic capacity-wait recovery across all executors; no universal side-effect replay guarantee |
| Shared inference contracts, quota and circuit logic | PARTIAL | `packages/atlas-inference/src`; hosted `api/inference/governor-client.mjs`, `worker/inference-governor*.mjs` | All CLI/local/cloud callers must share authorized budgets; durable waiting/resumption needs live outage acceptance |
| Hosted cloud dispatch | PARTIAL | `apps/web/app/api/tasks`, `scripts/runner`, Actions workflow; open #270/#274/#276/#278/#282 | Integrate stacked changes, migrate and verify lost acknowledgements/stale attempts |
| Durable hosted mission state | PARTIAL | Open #291; do not replace its implementation | Persistence integration and configured recovery acceptance |
| Coding execution | PARTIAL | `packages/atlas-cli/src/agent/verified-coder-session.ts`, Actions runner | Real-model edit/test/repair/PR journey; isolated validation #253 remains open |
| Native cloud execution worker | MISSING end-to-end service | Existing local runtime, worker registry and Actions adapter are reusable foundations | Linux container worker plus durable authenticated claims/artifacts, replacement-worker acceptance with PC offline |
| Compute registry | PARTIAL | `apps/local-control/src/platform/workers/{registry,observability}.mjs` already provide tenant/trust/capability/heartbeat selection | Actual remote enrollment and CPU/RAM/GPU/cost telemetry; do not build duplicate registry |
| Multi-agent execution and budgets | PARTIAL | `agent/{mission-scheduler,team,kernel}`, platform TaskBudget; #299 merged | Global inference/spend reconciliation, independent reviewer quality and cross-worker recovery |
| Browser/desktop/mobile | PARTIAL | `apps/browser-worker`, `apps/windows-companion`, mobile shell, approval routes | Configured browser/device and physical-phone acceptance; cloud browser consumer unavailable |
| Genesis | PARTIAL | `platform/genesis`, hosted project bridge; #284 open | Business website live form/preview/publish health acceptance; trusted execution node required |
| Credentials, approvals, isolation | PARTIAL | Existing vault, tool registry/executor, terminal and tenant policy; #233/#235 open | Protected review and deployed tenant/secret/isolation tests; no policy weakening |
| GitHub/Cloudflare/CRM integrations | PARTIAL | Existing Actions/GitHub App, infrastructure adapters, #297 CRM merged | Configured credential/account acceptance; no live writes performed here |
| Onboarding/local inference options | PARTIAL | Existing model discovery, router, manager; open #200/#230 | Merge/reconcile existing guided setup; qualify chosen models, not assumed capabilities |
| Production deployment | UNVERIFIED in this session | Existing Cloudflare deployment workflows, D1 migrations, hosted verification | No deploy, database migration, secret sync or production data change performed |

Open PR does not mean its whole implementation is absent from main: foundation
code already exists. Conversely, open PR source is not evidence of integration.
#129–133, #158, #160, #200, #230 and #240 remain open as observed through GitHub.
The cloud stack #253/#266/#270/#274/#276/#278/#282/#284 also remains open.
Existing audit `docs/atlas-os/FULL-AUDIT-2026-10-15.md` in the owner checkout
contains broader historical evidence; it must not be relabeled fresh results.

COMPLETE is reserved for a bounded feature with actual boundary evidence;
none of the broad production capabilities above meets that standard yet.
