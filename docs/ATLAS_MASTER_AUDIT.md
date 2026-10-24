# Atlas implementation inventory

Initially reviewed 2026-10-16 against main `1c3be5b`; integration checkpoint
2026-10-17 includes main `1e0909f` and the existing dispatch/request recovery
stack through #278. This is an incremental inventory,
not a certification that every source line or deployed integration was tested.
Resume from ATLAS_PROGRESS.md and docs/PROGRESS.md. The owner's older checkout
and unrelated changes were preserved in place; implementation uses an isolated worktree.

Truth order: source and executed boundary tests, current CI, progress documents,
historical audit. Historical failures are not automatically current failures.
Previously verified main CI run 38991786626 passed all 13 jobs, including
Windows; it is historical evidence, not the current-main release gate.

| Area | Classification | Source/evidence | Remaining acceptance |
|---|---|---|---|
| Local inference SSE transport | COMPLETE at protocol boundary | `apps/local-control/src/agent/model-client.mjs`; `tests/model-stream.test.mjs`: original eight regressions failed; #307 merged with all 13 CI jobs passing | Configured real-model quality/reliability remains unverified |
| Local conversations and restart persistence | PARTIAL | `agent/{runtime,session-store,conversation-executor}.mjs`; new actual SQLite restart regression plus existing conversation suite | Automatic capacity-wait recovery across all executors; no universal side-effect replay guarantee |
| Shared inference contracts, quota and circuit logic | PARTIAL | `packages/atlas-inference/src`; hosted `api/inference/governor-client.mjs`, `worker/inference-governor*.mjs` | All CLI/local/cloud callers must share authorized budgets; durable waiting/resumption needs live outage acceptance |
| Hosted cloud dispatch | PARTIAL | `apps/web/app/api/tasks`, `scripts/runner`, Actions workflow; open #270/#274/#276/#278/#282 | Integrate stacked changes, migrate and verify lost acknowledgements/stale attempts |
| Saved-request discovery/reconnect | PARTIAL | #276 scoped list/detail API and RequestHistory; 537 web tests pass plus nine race guards and actual desktop/mobile browser acceptance | Fresh CI/review and deployed tenant/physical-phone acceptance; inspection never retries execution |
| Hosted execution claims | PARTIAL | #278 claim API, trusted workflow gate and runner lease checks; 545 web and 83 runner/local tests pass; ten workflow checks pass | Fresh protected review/CI, result ownership #282, migration and real GitHub OIDC journey; expiry never permits automatic replay |
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

## 2026-10-19 — Genesis receipt integration checkpoint (#281 / #284)

Integrated current main afdee04, preserving hosted website creation, scoped
preview reads, project-stage UI, bounded bridge deadlines, and existing approvals.
Node dispatch reserves its original operation id before calling the node. Hosted
creation reserves its actual gen_ operation id before returning an existing row
or writing a site. Missing/foreign/archived history prevents creation. Reopening
history restores only bounded operation ids; status checks never create projects.
Retained main's preview UI while restoring bounded polling, cancellation, explicit
read-only retry and truthful not-found diagnostics. Added a real SQLite hosted
fallback recovery/refusal regression. Twenty focused project cases pass. All
11 workflow checks pass. Build/full web tests, typecheck, lint and fresh CI are
pending; no live node, external repository creation, publish or deployment claimed.

Separate #289 CI at 6ac1336 failed Windows: 828 pass, two failures, 20 skips.
Main already repairs the Genesis acceptance fixture. Updated daemon/Genesis
reproduction passes all 11 cases in a serial Windows run; full parallel Windows
CI remains a gate. Earlier all-green source heads do not replace this evidence.
No production migration, credential transfer, data change or paid provisioning.
Next: complete current-head CI and protected persistence review before rollout;
configure a trusted Genesis node only with the required owner authorization.

## 2026-10-19 — Genesis receipt verification follow-through

Integrated build and typecheck pass. Full web acceptance: 624 total, 619 passed,
five optional browser skips, zero failures. Separate Edge desktop/mobile chat
acceptance passes: reopen/reload restores the receipt, offline status retry is
read-only, no project creation POST occurs, and scroll position is preserved.
Twenty-six focused chat/project cases pass. Full ESLint passes after removing
an unused default callback argument. CI b02ca55 failed at that lint error; it did
not reach the incomplete chat test host. The host now imports the real receipt
helper. Final history-refusal diagnostics and no-write assertions pass 16 focused
cases; final head CI remains required. No assertion or authorization was removed.

#289's current-main integration exposed an unsupported Worker redirect mode in
three verification calls; the separate outcome branch now uses manual redirects
and rejects non-success responses. Its source scanner is corrected to inspect
real files on Windows. Both fixes retain original ownership and approval gates.
No live node, physical phone, production write, migration or deployment claimed.
Next: finish exact-head CI/protected review for #284 and #289, then a configured,
explicitly authorized Genesis-node acceptance run without publishing by default.
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
