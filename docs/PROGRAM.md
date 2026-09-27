# ATLAS — CLAUDE CODE MASTER PROGRAM

Repo: cornerstonemarketingus/atlas. Referenced from `CLAUDE.md`. This is the
governing program for autonomous work on Atlas; `docs/PROGRESS.md` is its
handoff log and `docs/TODO-MAP.md` maps the long-range `TODO.md` onto it.

## MISSION
Drive Atlas to a commercially usable, local-first autonomous software/computer
agent. Claude Code owns this program, including Project Genesis
(apps/local-control/src/platform/genesis/). Optimize for verified autonomous
capability, not checked boxes.

## 1. OPERATING LOOP
Per PR:
  git pull main -> read docs/PROGRESS.md -> pick next unblocked item in the
  current phase -> claim it -> branch claude/<area>-<slug> -> capture baseline
  -> implement -> focused tests -> affected suite -> repo checks -> push
  -> open PR (template §9) -> gh pr merge --auto --squash (if eligible §3)
  -> watch CI -> repair (max 3 attempts, then escalate) -> merged
  -> append to docs/PROGRESS.md -> next item.

Do not wait for the owner between ordinary PRs.
Workflow changes: run python3 .github/atlas/check-workflows.py before push.
Never force-push. Never merge before required checks pass.

## 2. SOURCE OF TRUTH & SESSION HANDOFF
Truth order: runtime code + tests + live verification > CURRENT-STATE.md
> BACKLOG.md > TODO.md (long-range wishlist, often stale).
Before each workstream, audit what exists. Extend, don't duplicate.

docs/PROGRESS.md is the handoff log. After every PR append:
  date | PR# | phase/item | what shipped | evidence | open issues | next item
A new session must be able to resume from PROGRESS.md alone.

"IMPLEMENTED" = wired + reachable + tested at its real boundary + documented.
Interfaces alone are not implemented.

## 3. MERGE POLICY & PROTECTED CHANGES
Ordinary PRs: CI-gated auto-merge when all required checks green, no new
regression, mergeable, no secrets, no blocking review.

Protected paths (enforced by GitHub, not agent judgment):
  PR 0 (owner action, do first): add CODEOWNERS entries + branch ruleset
  requiring owner review for: auth/credentials, secret redaction, approval
  system, merge/auto-merge logic, .github/workflows/**, CI config,
  self-improvement policy, sandbox controls, tenant isolation, security policy.
Agent opens these PRs normally but NEVER attempts to bypass required review,
edit rulesets, or weaken tests to get green.

## 4. MULTI-AGENT COORDINATION
One GitHub issue per workstream. Claim with label claimed:<agent>
(claimed:claude-1, claimed:codex, ...). Branch prefix = agent name.
Do not touch files in another agent's open PR; if blocked, comment on the
issue and pick other work. Stale claim (>48h, no commits) may be taken over
with a comment.

## 5. PHASES (do in order; each has an exit gate)

### PHASE 0: LIVE RESCUE
0.1 GitHub dispatch credential.
   Owner supplies GitHub App (Actions: write, Contents: write,
   Pull requests: write, Workflows as needed) or fine-grained PAT with same.
   Atlas: detect active credential type, safely probe required permissions,
   report exact missing permission via github-diagnosis.mjs, never claim a
   run started when dispatch failed, resume automatically once fixed.
   Never try to bypass authorization.

0.2 EMPTY_MODEL_RESPONSE (apps/web/app/api/chat/agent-loop.mjs).
   HTTP 200 is success only with non-whitespace text or >=1 valid tool call.
   Otherwise {ok:false, error:"EMPTY_MODEL_RESPONSE", finishReason,
   hadReasoning}. Log finish_reason + usage + reasoning presence (no content).
   Likely root cause: GPT-OSS reasoning exhausts max_completion_tokens
   (finish_reason "length", content empty, message.reasoning present).
   Handle Groq tool_use_failed 400 (parse failed_generation, one corrective
   retry, then INVALID_RESPONSE).

0.3 Guaranteed final synthesis.
   empty final -> FinalizationState {objective, plan, completedSteps,
   relevantToolResults (bounded), changedFiles, validation, failures,
   unresolvedItems} -> one clean tool-free synthesis with
   reasoning_effort:"low" + larger output cap -> fallback target ->
   persist checkpoint + explicit recoverable error.
   converse() may never return success with reply "".

0.4 Fallback deploy parity.
   Ship ATLAS_CHAT_FALLBACK_MODEL to the Worker. Test:
   SUPPORTED_RUNTIME_MODEL_VARIABLES == DEPLOYED_RUNTIME_MODEL_VARIABLES.

0.5 429 preflight: if reset > remaining budget, route to fallback now.

Tests: empty choices, null, "", whitespace, empty stream (streaming and
non-streaming), finish_reason=length+reasoning, tool call on last round,
synthesis recovery, fallback synthesis, 429 routing, no infinite retry,
no secrets in logs. Guard tests must fail when the guard is broken.

EXIT GATE: deploy, reproduce original failures, confirm zero empty replies
and no user-visible 429s over a real usage session.

### PHASE 1: INFERENCE CONTROL PLANE
1.1 packages/atlas-inference — contracts used by prod immediately:
   InferenceRequest/Result/Error/Target/Checkpoint/Usage/Event,
   ProviderCapacityState (parsed from x-ratelimit-* on EVERY response).
   Error taxonomy: RATE_LIMIT, CAPACITY_EXCEEDED, AUTHENTICATION,
   PERMISSION, BILLING, MODEL_NOT_FOUND, CONTEXT_TOO_LARGE, TIMEOUT,
   SERVER_ERROR, NETWORK, EMPTY_MODEL_RESPONSE, INVALID_RESPONSE, UNKNOWN.
   Wire existing Groq/OpenAI-compatible calls through it; no behavior change.

1.2 Governor + durable queue.
   Quota state + queue in a Durable Object per (provider, model); atomic
   token reservations with expiry, idempotency keys, reconciliation against
   provider usage. Never isolate memory.
   States: QUEUED, WAITING_FOR_CAPACITY, RUNNING, STREAMING, RETRYING,
   WAITING_FOR_TARGET, COMPLETED, FAILED, CANCELLED.
   Eligibility preflight: target ineligible if estInput+maxOutput exceeds
   its per-minute token limit -> route elsewhere.
   latencyClass: INTERACTIVE > TASK_CRITICAL > BACKGROUND > BATCH;
   final synthesis highest.
   Chat returns a task ID + resumable stream (SSE reconnect/poll) so waits
   survive disconnects. UX copy: "Waiting for capacity — work saved."
   Logical concurrency (agents, reviewers, verification) is NEVER reduced;
   only physical concurrency is scheduled.
   All callers migrate: chat, planner, agent team, child agents, reviewer,
   coder, self-improvement, Genesis, final synthesis.

1.3 Target pool + circuit breakers.
   HEALTHY/DEGRADED/OPEN/PROBING. Per-error recovery (401/403 no retry;
   404 disable model; 429 reset-aware; 498/5xx jittered bounded retry +
   switch; context overflow -> state retrieval; empty -> finalization).
   Checkpoint at each consequential call so any target can continue.
   Probe model availability; no hardcoded model names outside the registry.
   At least one non-free-tier or non-Groq target configured.

1.4 Prompt/prefix caching + structured context.
   Byte-stable prefix (policy, role, tool schemas, repo instructions);
   volatile data in suffix only. PromptFingerprint {model, prefixHash,
   prefixTokens, dynamicTokens, cachedTokens}.
   Context engine selects ranked, deduped, provenance-tracked evidence
   (repo map, symbols, tests, plan, failures, KnowledgeArtifacts) with
   reserved budget for tools/repair/synthesis. Verified facts only.

EXIT GATE: dashboard shows queue waits instead of failures under load;
cache hit ratio measured; all model calls go through the governor.

### PHASE 2: MEASURE & CORE ENGINEERING QUALITY
2.1 Eval harness (gates everything after).
   30–50 real tasks from Atlas's own repos; pass = tests pass.
   Categories: navigation, bug localization, multi-file edit, test repair,
   tool args, structured output, review, final synthesis, browser reasoning.
   Metrics: verified success, tool accuracy, repairs, latency, TTFT, tokens,
   cost. Background runs via Groq Batch (never interactive).
   Run on every inference/routing change; results in PR description.

2.2 Dogfood log: every Atlas-on-Atlas task records outcome, failure
   class, model, tokens, human intervention. Recurring failures -> eval
   case or issue.

2.3 Repository intelligence: package graph, import graph, env/config refs,
   test↔source map, entrypoints, CI/deploy targets, schemas.
   Language adapters: TS/JS first, Python second (definitions, references,
   incremental index). Every conclusion evidence-linked.

2.4 Validation + repair engine: format, lint, typecheck, targeted/full
   tests, build, security scan. Classify NEW/PREEXISTING/FIXED/FLAKY/
   INFRA/UNKNOWN against baseline. Bounded repair loop with FailureContext;
   escalate model after 2 failed repairs from the checkpoint (no restart).

2.5 Safe tool runtime: contained FS ops, encoding/line-ending/mode
   preservation, undo checkpoints. Terminal: cwd confinement, env allowlist,
   timeouts, output caps, process-tree cleanup, container isolation.
   Never silently fall back from requested sandbox to host.

2.6 PR steward + auto-merge hardening (protected path — owner review).

EXIT GATE: eval baseline published; Atlas completes a
request→edit→test→PR→CI→auto-merge journey on its own repo.

### PHASE 3: OPERATOR PRODUCT
3.1 Observability: activity view (agent, step, tool, inference target,
   queue state, tokens/cost, files, tests, approvals) with pause/resume/
   cancel/takeover/retry/redirect. Structured observe→plan→act→verify
   records; never store hidden reasoning.
3.2 Approvals + audit: approval bound to operation, args, digest, repo,
   base commit, principal, expiry; atomic replay-safe consumption.
   Audit every external action (no secrets).
3.3 Browser: audit browser-worker; navigate/click/type/upload/screenshot/
   a11y tree/console/network, session isolation, SSRF policy re-checked
   after each redirect/DNS resolution.
3.4 Computer control: audit Windows/X11 drivers; unified action vocabulary,
   state verification after each action, human takeover with state
   reconciliation, auditable timeline.
3.5 Visual verification (shared by Genesis and coding): launch, navigate,
   screenshot, a11y/console checks vs expected state, repair, retest.
3.6 Automations: triggers (cron, webhook, GitHub, file, manual) invoking
   the normal runtime; durable state, idempotency, dedupe, dead-letter,
   budgets, pause/resume, history. "Automate this?" after repeatable
   success; user approves activation.
3.7 Unified chat: one entry point that routes to answer/code/Genesis/
   browser/computer/automation. Typed, bounded attachments.
3.8 Budgets: tokens, money, time, tool calls per task/automation/project;
   hard limits enforced.
3.9 Genesis: continue on existing implementation; consume governor,
   visual verification, validation engine via stable interfaces.

EXIT GATE: live acceptance journeys pass — chat, coding→merge, browser,
computer, automation create→trigger→history, Genesis prompt→preview.

### PHASE 4: NATIVE INFERENCE
Architecture: native inference runs in an "Atlas Node" daemon (local or GPU
host), never in the Worker. Node dials OUT with device identity, mutual
auth, encrypted transport, revocation, tenant isolation. Not publicly exposed.

Atlas owns NativeBackend: load/tokenize/prefill/decodeStep/sample/cancel/
stats, plus loader, registry, checksums, memory preflight, tokenizer
accounting, scheduler, cache policy. First implementation wraps an
in-process library (llama.cpp/ggml bindings or mistral.rs/candle). No
external inference server = requirement met. Replace internals only where
the eval harness proves a gain.

4.1 Hardware discovery (AtlasHardwareProfile) + model registry +
    explicit-consent installs (size, disk, RAM/VRAM shown first)
4.2 AtlasTokenizer (shared with governor token estimates)
4.3 PROOF 1: "Hello Atlas" generated on-device, zero external inference
4.4 Streaming, cancellation, sampling, stop sequences
4.5 PROOF 2: native tool loop (objective→tool→result→synthesis)
4.6 Run eval harness on native; route by measured results
    (native for routing/drafting/indexing/background; hard tasks to the
    strongest eligible target). Policies: LOCAL_ONLY, SELF_HOSTED_FIRST,
    FREE_FIRST, BALANCED, BEST_AVAILABLE.
4.7 Agent-aware scheduling: group same-prefix requests for cache reuse,
    model affinity, deadline/latencyClass priority.
    PROOF 3: many agents on one node saturate into WAITING, not errors.
4.8 Speculative decoding interface; enable only with measured speedup.
4.9 Remote nodes. PROOF 4: app on A, inference on B.

EXIT GATE: offline (internet disconnected) task completes local tool loop.

### MILESTONE: FIRST EXTERNAL USER (gates commercial work)
Tenancy (tenant-scoped repos/tasks/memory/artifacts/automations; no
cross-tenant cache/KV reuse), revocable sessions + paired devices, Windows
installer + updates + diagnostics, onboarding, model manager UI, billing/
usage if SaaS, notifications, deployment adapters with health-verified
success + rollback, deterministic run manifests/replay.

### DEFERRED (metrics-gated)
Own paged-KV/continuous-batching internals, chunked-prefill tuning,
quantization matrix, custom kernels, distributed KV, disaggregated
prefill/decode (latency control, not throughput), multi-GPU, hosted GPU
fleet, languages beyond TS/Python.

## 6. SELF-IMPROVEMENT
Allowed: find improvement → isolated worktree → implement → verify
→ review → PR → CI repair → auto-merge if ordinary.
Protected paths (§3) always require owner review. Never weaken tests,
CI, guardrails or credential controls to pass.

## 7. TESTING RULES
Unit, integration, security, failure injection, restart/recovery, tenant
isolation, provider failover, queue recovery, approval replay, secret
leakage. Mutation-check guards: break the guarded behavior, confirm the
test fails.

## 8. NEVER
Reduce Atlas capability to fit a provider limit. Hide failures. Put secrets
in prompts/logs/source. Bypass GitHub/provider auth. Force-push. Merge a
regression. Silently exceed budgets. Fall back from sandbox to host.
Build fake interfaces with no vertical slice. Write custom kernels before
native generation works. Train a model from scratch. Rewrite working
systems for purity. Edit rulesets or CODEOWNERS to unblock yourself.

## 9. PR TEMPLATE
What changed / Why / Systems touched / Security impact / Tests run +
results / Eval delta (if inference/routing) / Known limitations /
Follow-ups / Auto-merge eligible: yes|no (protected path?)

## 10. DONE-ENOUGH-TO-SELL
A new user can install, sign in, pick local or hosted AI, chat naturally,
hand Atlas a software task, watch it work across terminal/browser/computer
safely, get a verified PR that auto-merges when green, automate repeatable
work, leave it running, return and inspect exactly what happened, survive
provider outages without losing work, run without a mandatory paid
provider, and control approvals, budgets, connections and data — without
learning Atlas's internals.

START HERE: PR 0 (CODEOWNERS + ruleset, owner merges) → Phase 0.
