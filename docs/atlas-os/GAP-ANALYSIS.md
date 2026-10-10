# Atlas — gap analysis against the Create / Operate / Automate mission

## Repository reconciliation — 2026-10-10

This section supersedes the historical branch assessment below. Evidence is
source inspection, fresh local tests where stated, and identified GitHub runs;
PR descriptions alone are not proof of delivered behavior. No overall
completion percentage is assigned. No new TODO list or framework is introduced.

### A. Inspected repository state

- Initial main: `17570ff348baef91a7637153df93538d56629762` (#241). Final refreshed
  main: `4f89f197888d1b5e5e3241aad78f21d9982c54d4` (#246). The intervening diff
  touches product docs/About and callback sender/tests, not this recovery slice.
- Audit timestamp: 2026-10-10 10:44 UTC. GitHub inventory was captured earlier
  in this run; counts describe that snapshot, before this run's issue/PR.
- 29 open PRs; 39 open issues. This run claims #248 for automation recovery.
- Main CI [37858362489](https://github.com/cornerstonemarketingus/atlas/actions/runs/37858362489)
  and deployment [37858362540](https://github.com/cornerstonemarketingus/atlas/actions/runs/37858362540)
  succeeded. Hosted chat gate [37858630572](https://github.com/cornerstonemarketingus/atlas/actions/runs/37858630572)
  answered and stored streaming/non-streaming turns through Workers AI
  `@cf/openai/gpt-oss-120b`, with one tool step in each. This is historical
  deployed evidence, not a fresh phone-to-code acceptance test.
- Final main CI [38020005457](https://github.com/cornerstonemarketingus/atlas/actions/runs/38020005457),
  hosted verification [38020602251](https://github.com/cornerstonemarketingus/atlas/actions/runs/38020602251),
  and read-only Atlas Runner [38020619428](https://github.com/cornerstonemarketingus/atlas/actions/runs/38020619428)
  succeeded. Latest observed deploy [38013846712](https://github.com/cornerstonemarketingus/atlas/actions/runs/38013846712)
  is at `d42d7d0`, before the callback-only #246. No deployment equivalence assumed.
  Latest observed Atlas Coder runs (37062375957, 37061184413) failed; older
  successful runs do not establish present autonomous coding readiness.
- During this run #247 reconciled README/TODO and archived the earlier TODO;
  #249 updated About copy. #246 merged callback recovery and closed #244.
  The final open inventory remains 29 PRs and 39 issues, including #248.
- Recent merged work: #241 continuation recovery, #239 model selection and
  unsaved replies, #232 credential diagnosis, #231 provider errors, #229 Workers
  AI, #228 provider attribution, #225 mission cooldown recovery, #224 inference
  control plane, #221 self-hosted gateway, #217 immediate coder dispatch, #215
  world graph, #214 autonomy, #213 economics, #212 persistent goals, #211 Genesis
  kernel integration. These supersede several older documentation statements.
- Original checkout: `copilot/aaa-saas-ui-rebuild` at `6da0282`, with pre-existing
  uncommitted path-confinement, terminal controller/tests, web tsconfig, and
  review/worktree directories. Preserved. Implementation uses isolated
  `codex/comprehensive-audit` based on main.
- Existing worktrees/branches include `codex/cloud-result-recovery` (#244),
  `codex/cloud-validation` (#245), `codex/credential-runtime` (#235),
  `codex/free-local-ai` (#230), `codex/production-audit` (#243),
  `codex/provider-repair` (#240), `fix/chat-free-options-deploy`, older Copilot
  chat/Genesis/terminal branches and detached review/test worktrees.
- Governing program exists at `docs/PROGRAM.md`; no tracked AGENTS.md was found
  in main's tree. ROADMAP, TODO-MAP, PROGRESS, TODO and CODEOWNERS were inspected.
  ROADMAP sets product order; PROGRAM governs safety/ownership. PROGRESS's early
  phase status and the old audit below lag delivered code.
- Claims #127/#128, #227/#230, #234/#235, #238/#240, #242/#243, #244 and #245
  are preserved. Shared main/server/UI/PROGRESS files are owned across open PRs.
  This change touches only automation service/tests and this previously
  unclaimed document. No merges, closures, deployments or credential changes.

### B. Capability inventory and runtime evidence

Path prefixes: **LC** = `apps/local-control/src/`, **WEB** = `apps/web/`,
**CLI** = `packages/atlas-cli/src/`. Tests under the corresponding package's
`tests/` directory unless otherwise specified. Operational means demonstrated
at the stated boundary; fixture success does not imply unrestricted live success.

| Subsystem | Delivered / connected | Partial, disconnected, missing or unreliable | Source / test evidence and existing PR work |
|---|---|---|---|
| Hosted chat and intelligence | Authenticated tenant-scoped persisted conversations; JSON/SSE, bounded tool loop, final synthesis recovery, model selection/provider attribution, Workers AI/Groq/OpenAI/custom endpoint routing; short-reset waits, context compaction and conditional global governor | Hosted loop does not use LC kernel/world store. Governor unavailable/missing permits direct calls. Long waits lack durable reconnectable execution. Configured fallback is not proof of paid capacity. Native Workers AI binding is unmerged. Local multimodal attachments do not establish hosted PDF/audio/vision parity | WEB `app/api/chat/{route.ts,agent-loop.mjs,model-endpoint.mjs,providers.mjs,atlas-knowledge.mjs}`, `api/inference/governor-client.mjs`; `chat-agent-loop`, `chat-governed-send`, `inference-chaos` tests; #233/#240/#178 |
| Native autonomous coding | CLI repository inspection/search/symbol/reference/import/package/test maps; transactional edits, baseline/post verification, bounded repair/escalation, budgets/redaction/audit/checkpoints. Local isolated worktree coder and cloud runner create patches/PRs with policy and CI checks | Worktree separation is not OS isolation. Hosted validation runs target scripts on trusted runner; #245 owns isolation. CLI quota pacing is separate from Worker ledger. Checkpoints do not establish replay-safe continuation of every tool. Runner validation hardcodes Atlas repository. Independent review not universal | CLI `agent/verified-coder-session.ts`, `infrastructure/{transactional-repository-change-set-editor.ts,validation-profile-runner.ts,bounded-command-runner.ts,session-checkpoint.ts}`; LC `runner.mjs`; `scripts/runner/{run-task,create-coder-pull-request,merge-decision,steward}.mjs`; matching CLI/runner tests; #200, #244, #245 |
| Cloud execution | Phone/browser request → WEB `api/tasks/route.ts` → `dispatch.mjs` → `atlas-coder.yml` → trusted CLI + separate target checkout → `run-task.mjs` → PR creator → OIDC result callback and Actions artifacts. Does not require local computer for hosted API inference. Callback transport recovery landed via #246 during this run | Ephemeral workspace, not persistent machine. No portable Local/Cloud/Hybrid execution contract or checkpoint migration. No cloud Genesis/browser worker service. Validation isolation #245 remains active. No fresh offline-phone end-to-end run was dispatched in this audit | `.github/workflows/{atlas-coder,atlas-runner}.yml`; `scripts/runner/{validate-inputs,report-result,run-task}.mjs`; WEB `api/tasks/{runner-result.mjs,result/route.ts,run-status.mjs}`; runner tests, hosted smoke tests |
| Agent kernel / orchestration | LC main wires kernel into team steps, coder harness, local chat and Genesis. Durable DAG missions, lane controls, team roles/delegation, scoped platform tasks/outbox, world traces, branching/economics | `run`, `runHarness`, `begin` guarantee different things. `run` can leave world status running on thrown inference/checkpoint/verification. Harness default verifier only checks artifact presence. Hosted chat/coder do not share this kernel's persistence. Team reviewer uses same model with separate prompt, not assured independence | LC `main.mjs`, `agent/kernel/{kernel,world-state,capabilities,branching,economics}.mjs`, `agent/mission-*`, `agent/team/*`, `platform/{task-store,executor,outbox-dispatcher}.mjs`; `agent-kernel`, `mission-*`, `team-missions`, `platform-*` tests; #202/#236 |
| Browser and desktop | Browser worker, Playwright page adapter, browser/desktop/terminal tool families wired in LC main; request egress policy, classification, approvals, screenshots and bounded downloads; companion polls authenticated hosted tasks | Cloud browser is explicitly unavailable (`HOSTED_BROWSER_EXECUTOR_AVAILABLE=false`), preventing silent queueing. Complete takeover/crash-safe consequential action journal is #237. Adapter snapshot/download patch #105 is broken. No real phone/native-desktop takeover validation during this run. CAPTCHA/MFA need human handoff | `apps/browser-worker/src/{browser-worker,egress-proxy}.mjs`, LC `agent/tools/{browser,desktop,terminal}-tools.mjs`, `agent/browser/*`; `apps/windows-companion/src/{operator,desktop}/*`; `tool-families`, companion tests; WEB `api/computer/{browser-plan,computer-policy}.mjs`; #105/#237/#61 |
| Genesis | Local requirements/planner/template scaffold, dependency-ordered coder tasks, backend auth/files/secrets/database/jobs/queue, preview lifecycle, checks and bounded repair, browser/vision inspection, kernel trace; approved git-host repository/push and static Vercel deploy adapters | Arbitrary generated server app provisioning/deployment is incomplete; static deployment is narrower. Visual selection/source mapping is #181, only static text. Hosted chat repo creation is #101, distinct from local publisher. Cloud Genesis execution, visual restyle/move/delete and general live app editing missing | LC `platform/genesis/{service,planner,executor,coder,preview,inspector,vision,publish}.mjs`, `templates/shared/src/*`; `genesis-{lifecycle,executor,templates,coder,publish,template-races}` tests; #181/#101; issues #73/#94–96 |
| Memory/world state | LC scoped SQLite memory with provenance/ACL/redaction, retention/delete/lineage; team recall/write; kernel typed entities/relations; repository graph and impact API. Hosted tenant conversation/task recall | Hosted durable user facts/management remains #97; conversation recall is not equivalent. Memory not uniformly supplied to coder/chat/Genesis. Team writes observations, not automatically independently verified facts. No complete cross-repository organization graph | LC `platform/memory/memory-store.mjs`, `agent/team/step-executor.mjs`, `agent/kernel/{world-state,repo-graph}.mjs`; WEB `db/tenancy.mjs`; `platform-memory`, `world-graph`, `mcp-memory-runtime` tests; #97 |
| Automations/persistent goals | Durable local schedule/webhook/signed GitHub/file/manual triggers, history/dedupe/daily/overlap guards, catch-up and failure pause; normal mission execution; sleeping PR goals with bounded wakes/expiry | Runs only while daemon infrastructure is alive. No independent hosted scheduler. Main orphan `starting` runs block forever; fixed in this change. Goal cancel/expiry saves terminal goal without cancelling working mission. Goal completion uses events rather than live reconciliation | LC `platform/automations/{service,cron,routes}.mjs`, `agent/goals.mjs`, main timers; `automations`, `goals` tests; #248, issues #41/#75 |
| Command Center/mobile | Shared LC aggregation of missions/lanes/team/Genesis/local tasks/self-improve/automations/goals; evidence links, controls, paired-device auth and mobile shell | Hosted views and LC Command Center are not one distributed cloud session view; cloud machine inventory/costs missing. Native remote companion integration #61 and takeover #237 pending. Paired watch permissions differ from owner mutation permissions by design | LC `platform/command-center.mjs`, `ui.mjs`, `remote/access.mjs`; `mobile/src/*`; `command-center`, `mobile`, shell tests; #61/#237 |
| Universal inference | Dependency-free `atlas-inference` contracts/error taxonomy, atomic scope ledger/circuits/model pool/registry/fingerprints, Worker DO and governed hosted route; CLI Groq/Anthropic/compatible provider wrappers; LC routed model client and discovery/context fit | Registry existence does not imply every caller probes it; fingerprints do not prove measured caching. CLI/local/Genesis calls not all globally coordinated. No qualified interchangeable Atlas-managed GPU fleet/native inference engine. Local model health must prove tool loop, not endpoint configuration | `packages/atlas-inference/src/*`, WEB `worker/inference-governor*.mjs`, LC `agent/models/*`, CLI `infrastructure/*model-provider.ts`; package and model/governor tests; #200/#230/#178; old stack superseded by #224 |
| MCP/skills/capability ecosystem | LC `connectMcpServers` imports configured tools into existing registry/policy; platform MCP gateway/server and signed skills/approval packaging exist | Installed skills not uniformly mounted in agent runtime. Hosted connector catalogue/read-write approval integration incomplete. Gap → Genesis package → independent security checks → owner install → reusable skill is not end-to-end | LC `platform/mcp/daemon-bridge.mjs`, `platform/mcp/*`, `platform/skills/*`, `agent/kernel/capabilities.mjs`; `platform-mcp`, `mcp-memory-runtime`, skills tests; issue #93 |
| Security/commercial reliability | Tenant-scoped hosted intake/allowlists and repository access check; vault refs, policy/schema gates, budgets, audit/redaction, digest approvals, OIDC callbacks, sandbox controllers and release tooling | Platform approved-expiry and credential-resolution gaps owned by #235; stale self-improve merge revision #243. Billing cap read/write race #203. Hosted API limiter #69 absent; provider governor is not abuse limiting. Script CSP enforcement incomplete (#77 report-only). Isolation/consent and tenant migration coverage need fresh release acceptance | WEB `api/tasks/{route,repository-access,runner-result}.mjs/ts`, `db/{schema.ts,tenancy.mjs}`, `api/billing/plan.mjs`, `worker/security-headers.mjs`; LC `platform/{executor,task-store}.mjs`; security/tenant/approval/redaction tests; CODEOWNERS + PROGRAM owner review |
| Independent verification/evaluation | CLI baseline comparator/repair and read-only trace replay; local capability suite, Genesis checks/browser QA, self-improve review, mission verification and fixture journey | Same-model review is not independent evidence. Cross-runtime result manifests/tool outcomes not uniform. #236 provides real platform replay/gate but fixture baseline isn't live benchmark success. #128 evaluation work remains claimed. No comprehensive cost-per-verified-success baseline | CLI `agent/session-replay.ts`, `domain/validation-comparator.ts`; LC `agent/models/evaluations.mjs`, `platform/models/capability-suite.mjs`; `scripts/local/genesis-bench.mjs`; #236/#128 |

### C. All open PRs reconciled

GitHub merge state below comes from `gh pr view/list`, not a search-result
boolean. CLEAN alone does not establish approval or production readiness.
Changed filenames and latest-head checks were inspected for every PR;
independent review compared inference helpers and older patches with main.
Other branches' complete test suites were not rerun locally. Historical green
checks do not establish a green result after resolving current conflicts.

| PR | Snapshot state | Disposition / dependencies / review |
|---|---|---|
| #243 | CLEAN | Necessary immutable self-improve head/base integrity fix; main merges branch. Required checks passed at snapshot; protected owner review. Changes AUDIT.md, intentionally untouched here. |
| #240 | CLEAN against #233 branch | Necessary native Workers AI streaming/cancel/diagnostics; first reconcile #233 with main. Not independently merge-ready on main. |
| #237 | BLOCKED | Necessary operator journal/takeover; Windows local-control check failed. Repair/revalidate, coordinate main/server/UI overlaps; real desktop/phone acceptance absent. |
| #236 | CLEAN | Evaluation/replay fixture foundation; green snapshot, candidate for review, not proof of model-backed benchmarks. Reconcile shared main wiring as peers land. |
| #235 | CLEAN, draft | Necessary credential/expiry/approval boundaries. Green snapshot, protected owner review; draft is not merge-ready. Complement #233. |
| #233 | DIRTY | Needed broker and Workers AI binding; conflicts with newer hosted/runtime work. Rebase preserving #240 and #235; credential/binding review even where CODEOWNERS coverage is incomplete. |
| #230 | DIRTY, draft | Needed local onboarding/coding qualification; broad owned runtime/UI files. Reconcile and obtain current CI + measured live local acceptance. |
| #223 | DIRTY | Distinct opportunity scout; optional, lower priority. Reconcile capability/main/UI/Command Center overlaps. |
| #207 | DIRTY | Needed SHA-addressed repository caching/coalescing; main lacks cache module. Reconcile #98/#97 shared tools and access scope; #208 snapshot claim preserved. |
| #203 | DIRTY | Needed atomic monthly usage cap; main read-then-write loses concurrent increments. Narrow high-priority rebase, rerun concurrent D1 regression. |
| #202 | DIRTY | Needed untrusted tool-log wrapper at team verifier; port narrow guard and regression, preserve current verification logic. |
| #200 | UNKNOWN / MERGEABLE | Distinct CLI billing/local provider work, not replaced by hosted ledger. CLI CI failed. Fix model tags with colons, billing error taxonomy, deterministic health/qualification tests before review. |
| #191 | DIRTY | Main preserves unsaved chat replies (#239), but post-dispatch task-history logging/warning still missing. Port only residual gap; avoid restoring obsolete ChatSection preview code. |
| #181 | DIRTY | Needed limited static-site text editing, not arbitrary visual IDE. Reconcile shared UI/Genesis files, verify current preview/proxy and owner security review. |
| #178 | DIRTY | Needed selected-provider release gate, distinct from automatic-route success. Protected verification workflow; reconcile smoke runner with #240. |
| #160 | CLEAN against #158 branch | Superseded by #224 model pools/latency classes/deployment. Recommend closure after owner confirms; protected old workflow must not be merged. |
| #158 | CLEAN against #133 branch | Superseded by #224 governed send/reservation lifetime. Main includes later reliability fixes; do not merge older loop. |
| #133 | UNSTABLE against #132 branch | Superseded: fingerprint helper byte-identical on main. Runtime cache measurement still a separate gap. |
| #132 | UNSTABLE against #131 branch | Superseded: compatible adapter byte-identical; target registry on main. Broader caller qualification still incomplete. |
| #131 | UNSTABLE against #130 branch | Superseded: circuit helper byte-identical; quota integration on main. |
| #130 | CLEAN against #129 branch | Superseded: Worker DO/client/ledger/bindings shipped through #224. |
| #129 | DIRTY | Superseded: package contracts/taxonomy/capacity/CI shipped via #224; protected CI change, no stale merge. |
| #105 | BLOCKED, draft | Necessary adapter gaps but patch has invalid nested download method syntax and out-of-scope helper; no added tests. Rewrite narrow adapter change with real browser boundary coverage. |
| #101 | DIRTY, draft | Needed hosted Genesis repo creation; local publisher does not supersede it. Protected GitHub App changes; reconcile chat/tool/schema and multi-repo runner constraint. |
| #98 | DIRTY, draft | Needed hosted PR/review/CI-log tools; main instant tool set lacks them. Reconcile cache/memory tools, bounded output/redaction/redirects and tenant access. |
| #97 | DIRTY, draft | Needed durable explicit hosted facts/CRUD/Memory UI. Existing conversation recall not substitute. Reconcile tenant isolation and migration numbering, owner review. |
| #77 | BLOCKED, draft | Needed nonce/report-only CSP rollout; not script enforcement. Protected Worker headers/security review; preserve current DO exports. |
| #69 | DIRTY, draft | Needed D1 HTTP rate limiter distinct from inference/billing. Protected auth/approval changes and migration conflicts; rebase and revalidate. |
| #61 | BLOCKED, draft | Needed native shell remote-companion integration; historical shell tests not phone release proof. Coordinate takeover contracts with #237. |

No PR is declared unconditionally merge-ready. #236 is an ordinary review
candidate on snapshot evidence; #243 is a protected owner-review candidate.
Seven inference-stack PRs are superseded, not seven missing capabilities.
No PR was closed or merged. Rebase old stacks only to inspect/port residual
work, not to overwrite the current loop. New PRs may appear during this run.

### D/F. Dependency-aware backlog and next ten slices

The order includes already-owned work rather than issuing duplicate assignments.
Complexity: S = bounded change, M = several boundaries, L = distributed/runtime
work. Each row is the smallest useful slice; it is not a claim of completion.

| Priority | Capability / missing slice | Dependencies / reuse | Relevant files | Acceptance | Complexity |
|---|---|---|---|---|---|
| 1 | Finish expiry/credential enforcement and stale self-improve review binding | #235 + #243; existing executor/vault/task approvals | LC `platform/{executor,task-store}.mjs`, `platform/self-improve/service.mjs` | Expired/stale exact action never executes; concurrent consume once; secrets absent from model/durable receipts; owner review | M |
| 2 | Isolate native cloud coder validation | Claimed #245; reuse SafeCommandRunner/verification profile | CLI runner infrastructure, `run-task.mjs`, `atlas-coder.yml` | Baseline/edit/repair checks inside required container, no host fallback or secret exposure, trusted PR path retained | M |
| 3 | Reconcile atomic billing and hosted request limiting | #203 then #69; existing D1 schema | WEB billing plan, rate-limit/routes/migrations | Concurrent cap exact; bounded identity-scoped API requests; tenant separation; owner review where protected | M |
| 4 | Recover uncertain automation starts; stop active mission on goal cancellation | This change #248 first; GoalService/MissionService next | LC automation service, `agent/goals.mjs` | Restart never replays original trigger; uncertain work visible and paused; cancelling working goal stops its owned mission | S |
| 5 | Persist cloud dispatch intent and reconcile lost storage/acknowledgment | #191 residual history diagnostics; callback recovery now delivered #246; reuse exact task/run IDs | WEB task intake/history, `dispatch.mjs`, `run-status.mjs` | Dispatch started but history write fails still produces recoverable task identity; no falsely claimed failure/no-work and no duplicate dispatch | M |
| 6 | Prove one native cloud coding outcome offline | 1–5, working model/Actions/Contents/PR permissions; #200 if local route used | hosted intake/workflow/runner/smoke | Authenticated phone submits controlled fixture, computer offline, edits + validation + draft PR + durable outcome; no automatic merge/deploy | M |
| 7 | Complete hosted provider and CLI quota compatibility | #233→#240, #178, #200; #224 ledger | provider adapters, governor client/DO and CLI wrappers | Actual text + tool + SSE/cancel per eligible route; billing distinguished, bounded fallback; authenticated CLI reserve/release, zero leaks | L |
| 8 | Strengthen kernel finalization/evidence and release evaluation | #236 + #128 ownership; existing kernel/CLI validation | LC kernel and evaluation modules, CLI verdicts | Thrown calls always terminal; verification uses actual check evidence; safe replay never reaches real external tools; meaningful regression gate | M |
| 9 | Complete safe operator handback and mobile observation | #237 repair + #105 adapter repair + #61; policy/approval gates | companion/browser worker/operator routes/mobile | Phone watch→hold→human MFA→handback invalidates stale state; crash refuses uncertain consequential repeat | L |
| 10 | Finish Genesis select→edit→validate→preview slice | #181 reconcile, then #101 hosted creation; existing executor/templates | LC Genesis visual/preview/executor; hosted project tools | Source-mapped static text selection from isolated preview; edit validated before publishing; expand to app components only after this passes | M |

After these: durable hosted scheduling/checkpoint migration (reuse Actions plus
existing task state/artifacts before a VM fleet); verified skill installation
through existing policy/MCP registry; broad memory wiring and cross-repository
graph; backend provisioning/rollback for generated server apps. Dependencies
are isolation, execution identity, evidence, quotas and owner approval, not new
independent agent frameworks. Estimated cost-per-verified-outcome must come
from evaluation receipts; no fabricated dollar/time/quality baseline is given.

### E. Production readiness by surface

| Surface | Assessment and release condition |
|---|---|
| Hosted chat | Deployed tested basic/tool-step conversation; current Workers AI route historically verified. Production-limited until overload/resume and selected-provider gates pass; not all adapters equally qualified. |
| Autonomous coding | Substantial native harness with test/repair/PR plumbing; conditional production use on approved repos. Require sandboxed validation, independent review and representative task-success baseline. |
| Cloud coding | Ephemeral Actions architecture exists and can work without local PC with hosted inference. Offline-phone acceptance not rerun/proven here; isolation and credential acceptance remain active; callback retry is delivered #246. |
| Multi-agent missions | Fixture-backed durable local execution, permissions/delegation, pause/cancel/restart proven by fresh journey. Universal independent review and distributed cloud scheduling incomplete. |
| Computer control | Local browser/desktop tools and approvals exist; reliable takeover/session uncertainty journal pending #237. Native device handback not verified here. |
| Browser automation | Local worker/tool tests exist; hosted browser deliberately unavailable; adapter completeness #105 unresolved. |
| Genesis | Local template/build/check/preview/static publish foundations. Arbitrary app visual editing and server deployment not ready; #181/#101 distinct pending slices. |
| Automations | Local durable runtime with genuine triggers; new interrupted-start recovery tested. Needs daemon/server uptime; cloud scheduling and active-goal cancellation remain gaps. |
| Mobile access | Responsive hosted intake and paired daemon controls exist; native remote shell #61 and takeover #237 unverified. No standalone cloud machine supervision yet. |
| Model infrastructure | Hosted ledger/circuits/fallback real; CLI/local coordination and model qualification uneven. Universal provider independence is partial, not one shared governed execution plane. |
| Security | Real boundary controls and tests; protected expiry/credential/revision fixes pending; hosted rate limiting/CSP and cloud validation isolation block broadening trust. |
| Commercial deployment | Hosted service deployed, but race-free commercial caps, consistent tenant/API abuse controls, recovery/SLOs and independent acceptance need closure. Not established ready for unrestricted customers. |

### G. Implementation and validation during this run

- Root cause: `AutomationStore.claimRun` persists `starting`; crash before
  awaited start acknowledgment saves `mission_id` leaves a run that settlement
  skips forever and overlap guards retain forever. Unknown linkage does not
  prove no mission started.
- Small fix: existing service constructor performs transactional startup
  reconciliation before main starts watchers/HTTP/catch-up. Unlinked starting
  runs become failed with a fixed uncertainty receipt; affected automation is
  paused and retains a durable `recovery_required` flag. Both webhook and manual
  runs are held until owner resume. Trigger keys remain intact. No automatic
  repeat, inferred mission cancellation, replacement runtime or schema reset.
- Existing databases add one default-false column; owner resume clears it.
  Command Center already shows paused automation with >0 failures under
  attention and offers resume, so its owned file is unchanged. Ordinary
  owner-paused manual-run semantics remain unchanged.
- Changed: `apps/local-control/src/platform/automations/service.mjs`,
  `apps/local-control/tests/automations.test.mjs`, this existing gap analysis.
- Baseline: 13 automation tests passed. New restart regression failed on
  unchanged main (`starting` vs `failed`). Three added tests cover real
  file-backed close/reopen and original-key dedupe/unknown mission preservation,
  legacy migration + injected transaction rollback, and delayed live team start.
  Known linked missions, manual hold, repeated restart, explicit resume, next
  unique trigger and actual Command Center attention are checked.
- Final focused suite: 46/46 (automations, Command Center, goals, kernel).
  Full local-control: 677 tests, 657 passed, 20 environment skips, zero failures.
  Real authenticated daemon journey: all steps passed, including authorized
  tool execution, exact-action approval/deny, one-use consumption, pause/resume,
  cancel, real store reopen and mission continuation. Journey uses deterministic
  model fixtures; local model discovery is not a live coding qualification.
- `git diff --check` and service syntax check passed. Cross-branch PR suites
  were not rerun; main's other packages use historical CI evidence. No live
  costly mission, merge or deployment was attempted.
- Mutation check: disabling the startup recovery invocation makes both restart
  and rollback regressions fail; source restored in `finally`. Independent
  agent reviewed the design and supplied validation evidence, with no blocking
  finding under the single-daemon assumption; it did not independently rerun
  tests or read the final local diff.
- Limits: startup reconciliation assumes the existing one-daemon owner of this
  local database; it does not add a distributed lease. It cannot discover the
  identity of a mission started just before acknowledgment was lost. The owner
  must inspect and resolve that uncertainty before resuming. Failure history is
  retained; this is recovery with human inspection, not exactly-once dispatch.
- Work tracked by #248; focused PR is the deliverable. PROGRESS.md and AUDIT.md
  are actively owned by peer PRs and left unchanged. Recommended next independent
  slice: active-goal cancellation propagation, while #245's owner completes
  the shortest safe path to the phone-to-cloud coding gate.

## Historical branch assessment (retained for provenance)

Compares the mission brief (sections 1–28) with what exists on this branch.
"Foundation" names the code that should be extended rather than replaced.

| Mission area | Today | Gap | Foundation to build on |
|---|---|---|---|
| §1 Restore Atlas | Operational; see `CURRENT-STATE.md` | Vague-objective intake (RECOVERY §1) | `apps/web/app/api/tasks/route.ts` |
| §2 One canonical task lifecycle | `PlatformTaskStore` + contracts FSM; innovation builds use it | Coder tasks (`tasks` D1 rows, `local_tasks`) and missions still use their own lifecycles; outbox undelivered; no dead-letter consumer | `platform/task-store.mjs`, `agent/mission-service.mjs` |
| §2 One policy path | Live daemon `ToolRegistry` decisions now call the deterministic `PolicyEngine` bridge; digest approvals remain in the legacy registry. Platform family permissions also gate team calls. `AuthorizedToolExecutor` is not yet the sole dispatcher. | Consolidate all execution through `AuthorizedToolExecutor` with one durable approval, budget, idempotency and audit path; preserve tool credential vaulting and digest-bound approvals. | `platform/legacy-policy-bridge.mjs`, `platform/executor.mjs`, `agent/tool-registry.mjs` |
| §3 Create / Project Genesis | Missing | Persisted, versioned product brief → requirements → architecture → plan → missions | Innovation pipeline's brief/proposal/packet artifacts are the same shape one level up; reuse its validation + versioned events |
| §4 Instant backend | Missing (adapters exist for deploy only) | Provider-neutral provisioning adapters (DB, auth, storage, jobs, secrets) | `agent/infrastructure/adapter.mjs` |
| §5–6 Visual builder, design loop | Missing | Live preview with source mapping; render→screenshot→critique→repair | `apps/browser-worker` (screenshots), Design family (Visual QA / Accessibility agents) |
| §7 IDE workspace | CLI read tools + web chat | File tree/editor/diff/terminal over the same worktree agents use | `packages/atlas-cli` repository tools, `platform/terminal` |
| §8 Agent company | **Done on this branch**: BDE → Product Executive → 7 specialists; Engineering, Design, Computer Operations, Research peers; oversight | Agents are not yet bound to model sessions — they hold identity, permissions, budget and tasks, but executing an agent step is still a caller's job | `platform/family/*`, `platform/innovation/*` |
| §9 Model router | Two routers, neither drives execution | Conversation executor obtains its client from the platform router with fallback; record the model per step | `platform/models/router.mjs` |
| §10 Multi-agent review | **Council on this branch** (independent opinions, dissent preserved, digest-bound decision) | Extend councils to code review with deterministic evidence (tests, visual diffs) | `InnovationPipeline.convene/finalizeDecisionPacket` |
| §11 Computer control | Browser (companion + worker); terminal library | Desktop control missing; terminal controller not wired | `apps/windows-companion`, `platform/terminal` |
| §12 Human-behavior QA | Browser vertical slice | Scripted sign-up/CRUD/permissions missions with evidence | `apps/browser-worker`, Visual QA agent |
| §13 Deployment | Cloudflare deploy workflow; local plan/apply adapters | Preview/staging/production model with smoke test + rollback | `agent/infrastructure/*` |
| §14 Self-healing | Missing | Signals → repair missions with attempt caps | Pipeline's bounded repair loop (`maxRepairAttempts` → ITERATE) is the pattern |
| §15–16 Autonomous development / Atlas develops Atlas | Daily self-improve workflow (manual merge); **BDE pipeline on this branch** gives it evidence-backed direction | Connect the pipeline's commissioned build to the verified coder loop in an isolated worktree; the signal collector found **zero** inline TODO/FIXME markers in Atlas, so Atlas's own evidence must come from CI history, failed runs, docs backlogs and usage — not code markers | `collectRepositorySignals`, `lc/runner.mjs` worktrees, `atlas-self-improve.yml` |
| §17 Operate UI | Local UI + companion | Unified sessions view (who/what/where/permission/budget/evidence, pause/cancel) | `lc/ui.mjs`, platform dashboard |
| §18 Automate | GitHub cron only | Durable local scheduler + triggers that create platform tasks | `platform/task-store.mjs`, mission scheduler |
| §19–20 Business center, business missions | **BDE/Product org + Innovation Backlog + structured `BLOCKED_BY_*` reasons on this branch** | Revenue/usage/feedback data sources feeding evidence; budgets in dollars per mission | `platform/budget.mjs`, `apps/web` billing tables |
| §21–24 UX, copy, redesign, error experience | Web shell rebuilt in PR #58 | Create/Operate/Automate IA, error translation across web | `apps/web/app/AtlasShell.tsx` |
| §25 Security | SEC-4/5/6/14 fixed | SEC-1/2 (tenancy, revocable sessions) are prerequisites for widening access; SEC-3 SSRF in daemon tools | `SECURITY-REVIEW.md` |
