# Atlas operator quality roadmap

Status date: 2026-09-21

This is the active execution queue for making Atlas a stronger autonomous
builder and computer operator. It complements the long-range `TODO.md`; it is
not marketing copy. A milestone is complete only when its acceptance tests run
in CI and the result can be demonstrated without privileged developer access.

## Product standard

Atlas should carry one durable mission across planning, code, tests, deployment,
browser work, and recovery. It should outperform fragmented agent stacks through
trustworthy execution: exact approvals, visible progress, resumability, local
model ownership, evidence, and graceful failure. Private model reasoning is
never exposed; users receive concise rationale, actions, evidence, and blockers.

## In progress — P0

### 1. One-click Windows operator activation

Owner: desktop/runtime. Target: first usable operator run in under ten minutes.

- Produce a signed MSI/MSIX that discovers Edge, Node, Ollama-compatible
  runtimes, available memory, and installed models.
- Pair through a deep link or QR code without copying a device credential.
- Download an appropriate open model only after showing size and disk impact.
- Add an end-to-end clean Windows 11 VM test covering install, pair, run,
  approval, update, rollback, and uninstall while preserving user data.
- Block release when the installer is unsigned or the SBOM/checksum/update
  manifest cannot be verified.

### 2. Live operator observability and takeover

Owner: operator experience. Target: users always know what Atlas is doing.

- Stream safe milestones, current site, current action, elapsed time, and
  approval state without exposing private chain-of-thought.
- Add pause, resume, cancel, and "take over" controls with deterministic state
  transitions and an audit receipt.
- Capture bounded screenshots locally; require explicit consent before any
  screenshot leaves the paired machine.
- Recover an interrupted browser session without repeating a consequential
  action or losing the approval binding.

### 3. Durable autonomous product missions

Owner: agent runtime. Target: replace GitHub Actions as the primary experience.

- Run multi-hour missions in the persistent runtime with leases, checkpoints,
  budgets, retries, and restart recovery.
- Break an outcome into code, validation, deployment, and operator work while
  keeping one shared mission record.
- Add concurrency limits, cancellation propagation, idempotent tool receipts,
  and baseline-aware verification to every executor.
- Keep GitHub Actions as an optional remote adapter and CI surface, not the
  product's central execution model.

### 4. Replay and autonomous evaluation

Owner: trust/evals. Target: every important claim is reproducible.

- Reconstruct a mission from its event log without executing side effects.
- Re-run safe steps against fixtures and compare actions, cost, latency,
  regressions, and policy decisions.
- Ship benchmark suites for repository repair, app creation, job research,
  ethical one-to-one sales preparation, and marketing operations.
- Prevent promotion of a model or skill when it regresses safety or task
  completion beyond an explicit threshold.

## In progress — P1

### 5. Recordable, portable operator skills

- Let a user demonstrate a browser workflow, then turn the recording into a
  parameterized skill with editable inputs and policy boundaries.
- Store skills locally in a documented, versioned format; support signed import
  and export without a proprietary marketplace dependency.
- Detect site drift before execution and fall back to accessible semantic
  controls instead of brittle coordinates.
- Require a preview and one-action approval for every externally visible step.

### 6. Multi-agent product team

- Add planner, builder, reviewer, tester, and operator roles sharing the same
  evidence graph and budgets.
- Run independent work in isolated worktrees, then reconcile conflicts through
  a deterministic integration agent.
- Show role status and evidence to the user, not hidden internal reasoning.
- Prove that parallelism improves completion time without increasing regression
  rate or unbounded token use.

### 7. Local-model quality router

- Benchmark discovered local models before granting tool access.
- Route planning, coding, vision, and summarization by measured capability,
  context fit, latency, privacy policy, and available hardware.
- Quantize or choose smaller models only when the evaluation predicts the task
  remains within the configured quality threshold.
- Make hosted models optional, replaceable adapters with a visible cost ceiling.

### 8. Visual autonomous app builder

- Generate and run a live preview inside the workspace while Atlas edits the
  real repository—not a disconnected prototype.
- Support visual selection, natural-language edits, data/schema generation,
  deployment preview, rollback, and device-size testing.
- Turn the approved preview into tested source, migrations, infrastructure
  plans, and an evidence-backed release candidate.

## In progress — P2

### 9. Managed browser fleet

- Provide isolated per-tenant hosted browsers with encrypted profiles, regional
  controls, quotas, idle shutdown, and verifiable destruction.
- Apply the same policy and approval contract as the local companion.
- Meter compute honestly and keep the local Windows operator fully useful on
  the free tier.

### 10. Mobile approval and mission control

- Finish native iOS and Android shells with secure storage, deep links,
  biometric high-risk approval, push revocation, offline truth states, and
  accessibility validation.
- Never put credentials or sensitive action details into push payloads.
- Validate on physical devices before store submission.

## Quality work promoted from the legacy backlog

These older TODOs affect overall quality and are now part of the milestones
above rather than optional cleanup:

- complete mutation capability enforcement and policy simulation;
- isolate command execution from the control plane;
- preserve complete audit records for external actions;
- distinguish pre-existing failures from regressions;
- enforce persistent money, token, time, and compute budgets;
- add monorepo, dependency, import, configuration, and test/source graphs;
- add compiler-backed language intelligence and incremental indexing;
- add safe filesystem mutations, conflict recovery, and generated-file guards;
- widen secret detection with false-positive regression fixtures;
- exercise real setup flows against disposable GitHub/Cloudflare fixtures.

## Release scorecard

Every milestone reports these numbers before release:

1. task completion rate on versioned fixtures;
2. regression and unsafe-action rate;
3. median and p95 time to first useful action and completion;
4. recovery success after forced process/network interruption;
5. local and hosted model cost, token, memory, and compute consumption;
6. accessibility and keyboard-only completion rate;
7. percentage of consequential actions with a valid, exact audit receipt.
