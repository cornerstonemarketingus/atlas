# Atlas Intelligence Layer: audited implementation roadmap

Audited against `main` at `91820a6` (2026-09-26), including merges #107,
#108, #109 and #110. This is a source audit, not a claim that every deployed
surface uses every library. Historical TODOs are not an implementation inventory.

## Existing, partial, and absent

Paths below are relative to the repository. `local/` means
`apps/local-control/src/`; `cli/` means `packages/atlas-cli/src/`.

| Requested phase | Evidence on main | Remaining work |
| --- | --- | --- |
| 1. Capability registry | `local/platform/models/capabilities.mjs` has provider/model identity, locality checks, declared/measured tools, JSON, vision and context, costs, latency and reliability. `capability-suite.mjs` executes probes; `ollama-adapter.mjs` supplies native inference. `cli/model/model-registry.ts` has deterministic capability routing. `local/agent/models/manager.mjs` discovers/manages local models. | Maximum output, provenance-aware runtime metadata, RAM/VRAM requirements, throughput, durable per-category benchmark history, and a shared consumer contract are incomplete. Costs omitted by callers currently default to zero; remote route profiles also claim zero. Fix this before enabling automatic paid escalation. |
| 2. Router | `local/platform/models/router.mjs` filters capabilities, privacy, providers and cost, orders by reliability, and constrains fallbacks. `local/agent/models/difficulty.mjs` classifies tasks heuristically. `routed-client.mjs` handles conversation failover before streaming begins. | Platform selection is not the daemon's unified routing policy. Four requested policy modes, empirical category selection, context/risk classification and paid permission gates need integration. `modelForDifficulty` maps both standard and hard to the coder: retry classification alone does not guarantee a stronger model. |
| 3. Planning | `local/agent/team/planner.mjs` validates a bounded DAG with success criteria and agent assignments; `local/platform/orchestrator/dag.mjs` manages execution dependencies. CLI read-only planners inspect repositories. | Connect repository-aware planning and plan revision to complex conversational objectives; attach required capabilities, files and verification artifacts to nodes. |
| 4. Context | `cli/infrastructure/repository-symbol-indexer.ts`, reference finder, text search, repository summary, command detector, ownership resolver; `cli/model/bounded-coder-context.ts`; daemon `agent/models/context-fit.mjs`. | Index is bounded lexical scanning, not a persistent incremental dependency graph. Add change invalidation, test/source relations, step-specific retrieval and a provider-neutral semantic interface. |
| 5. Agent loop | `local/platform/orchestrator/agent-loop.mjs` validates tool calls, enforces policy/budgets, verifies success criteria, records evidence and escalates bounded failures. `local/agent/conversation-executor.mjs` provides streamed tool execution and context fitting. | Reconcile consumers and persist concise plan revisions/reflections. Preserve private reasoning separation. |
| 6. Failure intelligence | `cli/agent/verification-planning.ts` and `verified-coder-session.ts` compare baseline diagnostics and perform bounded repairs. | Unified FailureContext, equivalent-failure/patch detection, attempted-fix history and strategy change are missing as a shared subsystem. |
| 7. Roles | `local/platform/family/default-families.mjs`, family permissions/delegation and `local/agent/team/step-executor.mjs` already implement specialized agents and structured execution. | Map engineering roles to capability requirements; trigger security review for sensitive changes; avoid another team implementation. |
| 8. Escalation | Platform AgentLoop bounds invalid output, tool errors and failed verification and records escalation. Conversation routes fail over; self-improvement supplies attempt count to difficulty classification. | One explicit, policy-constrained strategy/model/human state machine with equivalent-failure signals is incomplete. |
| 9. Benchmarks | Model capability probes and `local/agent/models/evaluations.mjs`; `local/platform/planning/performance.mjs` stores tenant-scoped verified agent/role outcomes by task kind. | Real repository model benchmarks and per-model category histories are absent. Do not treat the probe aggregate reliability as a coding/reasoning score. |
| 10. Memory | `local/platform/memory/memory-store.mjs` has scoped provenance, observation/hypothesis/verified-fact distinctions, versioning, redaction, deletion and retention. `local/agent/knowledge-routes.mjs` exposes inspection; team steps consume memory. | Add explicit user-decision semantics and repository evidence invalidation/retrieval; measure usefulness. Reuse this store. |
| 11. Genesis | `apps/web/app/api/genesis/projects/route.ts`, `apps/web/db/schema.ts`, migration `0016_project_genesis.sql`: authenticated tenant-scoped idea/requirements/evidence/status records. | Requirements are a generic handoff, not an executed product plan. Local workspace creation through scaffold/build/repair/preview/review and approved publish remains missing end-to-end. |
| 12. Visual verification | `local/agent/browser/`, browser tools, desktop controller and browser worker infrastructure exist. | Wire preview lifecycle and acceptance-path DOM/console/network/screenshot evidence into engineering verification and debugging. |
| 13. Dogfood | `local/platform/self-improve/loop.mjs`, `runtime.mjs`, `policy.mjs`, `reviewer.mjs`, `service.mjs`, `scripts/local/self-improve.mjs`: isolated worktrees, real coder, baseline/post checks, independent review, retained branch/patch, ledger and explicit approval. | Feed capability routing and normalized repair evidence into these existing seams. A 20-task comparative measured campaign remains unrun. |
| 14. Quality gates | Existing unit/integration tests, verifier evidence, usage budgets and self-improvement ledger provide ingredients. | No demonstrated before/after engineering completion improvement. Add versioned task fixtures, task-level metrics and safety/cost regression thresholds. |
| 15. UX | Conversation executor streams understandable status/tool/approval events; self-improvement service exposes activity. | Unify objective dispatch and optional routing inspection without displaying internal transcripts. |

## Sequence and review boundaries

1. **PR 1a (this slice): trustworthy capability evidence.** Extend the existing
   registry/probe suite; preserve evidence across snapshots and metadata refresh,
   invalidate it on identity changes, reject empty/unbounded probes, distinguish
   advertised context from tested recall, and expose latest-batch health and
   tool/JSON success rates. No new inference calls or routing decisions.
2. **PR 1b: complete capability metadata and durable observations.** Use existing
   discovery/catalog/runtime and SQLite ownership boundaries. Keep unknown prices
   unknown, attach source/time to metadata, distinguish local runtime from
   OpenAI-compatible protocol, and connect registry reads to the daemon. Health
   needs expiry and opt-in bounded probes before it influences routing.
3. **Evaluation foundation before routing changes.** Move the original PR 8's
   reproducible fixture runner and baseline recording here. Execute real harness
   repository-navigation, localization, patch, debugging, review and planning
   tasks with configured local models; reuse performance/usage evidence. Record
   model/runtime/prompt/fixture revisions and unavailable metrics as null.
4. **PR 2: classify and route.** Reconcile existing route paths behind one policy
   contract, add LOCAL_ONLY/PREFER_LOCAL/BALANCED/BEST_AVAILABLE, explicit paid
   permission and estimated cost. Every fallback must retain all constraints.
5. **PR 3: repository-aware structured planning.** Extend existing team DAGs and
   success verifiers; avoid planning trivial requests.
6. **PR 4: incremental context.** Extend CLI indexes behind shared retrieval
   interfaces; add freshness, relationships and relevance/context budgets.
7. **PR 5: failure intelligence**, then **PR 6: role orchestration**, then
   **PR 7: escalation**, extending existing repair loops and team permissions.
   Re-run category benchmarks after each change.
8. **PR 8 follow-through: benchmark coverage and rolling per-category scores.**
   Do not collapse engineering competence into a global score.
9. **PR 9: project memory integration**, extending the existing store.
10. **PR 10+: local Genesis execution**, in bounded steps: approved specification
    and DAG; workspace/scaffold; verified implementation/repair; preview and
    browser verification; independent review; separately approved publishing.
    GitHub remains optional. Integrate conversational activity along the way.
11. **Dogfood acceptance gate:** at least 20 bounded tasks on baseline and changed
    harness with comparable fixtures/models/budgets. Record accepted/rejected,
    interventions, escalations, regressions, model usage and cost. Preserve
    self-modification policy, worktree isolation and human merge approval.

## Baseline and first-slice verification

Environment: Windows, Node v24.14.0. No paid inference was invoked.

Before production edits, on audited main:

```sh
cd apps/local-control
node --test tests/platform-models.test.mjs tests/models.test.mjs tests/model-hosting.test.mjs
# 35 passed, 0 failed; 1628.8279 ms on this machine
node --test tests/capability-evidence.test.mjs
# Newly added deterministic regression fixtures: 0 passed, 6 failed
```

The six cases run the existing registry and real capability-suite harness with
scripted model replies: invalid probe configuration, context provenance,
snapshot/evidence integrity, identity invalidation, health vs answer correctness,
and untested/duplicate context sizes. They are **contract regression fixtures**,
not a real-model intelligence benchmark. After the first slice, all six pass
alongside the original 35 (41/41; 1647.1821 ms). Two additional tests cover
cross-model evidence rejection and mixed outcomes/atomic validation. The final
targeted run passes 43/43. Planning, platform agent orchestration and both
self-improvement suites also pass 35/35. Timings are test-run durations,
not model latency comparisons.

Task completion, first-pass/eventual success, repair cycles, tool failure rate,
context overflow, invalid model output, tokens/cost per task, median completion
time and regression rate remain **unmeasured for real models**. No improvement
in autonomous engineering completion is claimed by this PR. The later 20-task
dogfood gate remains open.

## First-slice limitations

- Snapshots now round-trip evidence but this registry remains in memory; it does
  not introduce a parallel persistence service.
- `health` describes inference responsiveness during the latest probe batch,
  not continuous service health. Incorrect answers can come from an available
  service. Mixed transport outcomes are degraded. Health is timestamped and
  does not yet filter routes.
- `recentFailureRate` is failed assertions/requests divided by probes in the
  latest suite, not a rolling production failure metric. Tool and structured
  output rates are per category within that batch.
- Recall uses approximate character-based token sizing. A passed short probe
  leaves a larger window declared, rather than relabeling it measured. A failed
  larger probe conservatively records the largest successful tested size.
- Probe limits cap calls and allocation, not total inference duration or cost;
  callers must retain existing provider timeout, budget and authorization paths.
- Phase 1 as a whole is not complete, and the platform router is not newly
  connected to conversation/self-improvement in this slice.
