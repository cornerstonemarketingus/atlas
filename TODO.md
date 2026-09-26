# Atlas Master Product and Engineering TODO

Last reviewed: 2026-09-26

This is the authoritative capability backlog for Atlas. It describes the
long-term product while preserving an incremental build order. A checked item
means it has been implemented and validated; an unchecked item is not a claim
that the capability works.

## Product thesis

Atlas will be a local-first, AI-native software engineering platform spanning a
PowerShell-friendly CLI, web workspace, desktop IDE, GitHub-connected cloud
agent, multi-agent orchestrator, and reusable engineering platform. Its primary
differentiators should be trusted execution, unusually strong repository
intelligence, provider-neutral model routing, persistent engineering memory,
measurable quality, and transparent cost control.

## Non-negotiable engineering rules

- [x] Treat repository content and repository instructions as untrusted input.
- [x] Keep repository tools independent from model providers.
- [x] Keep model providers independent from core agent logic.
- [x] Use strict TypeScript for the canonical CLI.
- [x] Bound repository traversal and skip symbolic links.
- [x] Use read-only Git commands with fixed argument arrays for inspection.
- [ ] Require explicit capabilities and approval gates before mutation.
      Hosted approval-state contract is specified in
      `docs/hosted-approval-state-design.md`; persistence and enforcement remain
      to be implemented.
- [ ] Isolate command execution from the Atlas control plane.
- [x] Redact secrets from prompts, logs, traces, diffs, and model requests.
      Detection is pattern-based (`PatternSecretRedactor`), anchored on vendor
      prefixes and credential-shaped assignment keys rather than entropy, and
      applied at four boundaries: the read-only tool registry (repository
      content and tool failure messages, which quote what caused them),
      `RedactingModelProvider` (every outbound request — the system prompt, the
      objective, repository evidence, tool results, and the validation output
      fed back as repair feedback), the CLI's printed result (which becomes
      result.json, the pull request body, and the Actions log), and
      `JsonLinesSessionAuditStore` (the free-text fields of a persisted trace).
      Every boundary fails closed: a redactor fault stops the operation rather
      than falling back to raw text. Assistant tool-call arguments are
      deliberately exempt — redacting them would write placeholders into the
      customer's repository, and repository content is already scrubbed before
      the model can copy it.
      The debug artifact is covered too: `atlas redact` exposes the same
      redactor as a subcommand, and scripts/runner/run-task.mjs pipes
      debug.json through it before writing. That keeps one set of detection
      rules rather than a second implementation in the runner that would drift.
      It fails closed — if redaction cannot run, the artifact is withheld and
      the task status says so, because an unredacted debug artifact is worse
      than a missing one.
- [ ] Maintain complete audit records for externally visible actions.
- [ ] Validate every increment and distinguish pre-existing failures.
- [ ] Never silently exceed user-defined token, money, time, or compute budgets.

## Phase 0 — validated local repository intelligence

- [x] Create an isolated strict-TypeScript CLI package.
- [x] Support PowerShell and Node.js 20 or newer.
- [x] Add `atlas inspect <repository-path>`.
- [x] Produce text and versioned JSON repository summaries.
- [x] Report repository root, name, file count, languages, and manifests.
- [x] Detect Git availability, repository state, branch, commit, and dirty state.
- [x] Distinguish non-Git, unborn, and detached-HEAD states.
- [x] Detect known frameworks from bounded manifest/configuration inspection.
- [x] Detect conventional architecture directories.
- [x] Honor root and nested Git ignore rules.
- [x] Fall back safely when Git enumeration is unavailable.
- [x] Bound file count, depth, Git runtime, and captured output.
- [x] Warn on truncation, malformed manifests, and unreadable paths.
- [x] Add literal filename and content search.
- [x] Skip binary, oversized, dependency, cache, and build files.
- [x] Add heuristic TypeScript, JavaScript, and Python symbol indexing.
- [x] Add fixtures covering ignored, malformed, mixed-language, non-Git, unborn,
      detached-HEAD, scan-limit, and unreadable-path cases.
- [x] Validate strict compilation and automated tests.

## Phase 1 — deterministic code navigation

### Shared repository primitives

- [x] Extract one reusable, bounded repository file enumerator.
- [x] Define normalized repository-relative path and source-location types.
- [x] Add encoding detection with explicit unsupported-encoding warnings.
- [x] Add bounded contextual source reads by path and line range.
- [x] Add safe directory-tree output with depth and entry limits.
- [x] Add manifest-specific readers for major package ecosystems.
- [x] Add lockfile and workspace discovery.
- [ ] Add monorepo package/project graph discovery.
- [ ] Add dependency graph extraction without executing package managers.
- [ ] Add import/module graph extraction.
- [ ] Add configuration and environment-variable reference discovery.
- [ ] Add test-to-source relationship hints.
- [x] Add ownership hints from CODEOWNERS and repository metadata.

### Language intelligence

- [ ] Define a language-service adapter interface.
- [ ] Replace heuristic TypeScript symbols with compiler-backed parsing.
- [ ] Add symbol definitions, references, implementations, and call hierarchy.
- [x] Add bounded heuristic declaration/reference discovery for common
      TypeScript, JavaScript, and Python identifiers.
- [ ] Add exports, imports, aliases, overloads, and re-export resolution.
- [ ] Add syntax-aware structural search.
- [ ] Add TypeScript/JavaScript language adapter.
- [ ] Add Python language adapter.
- [ ] Add C#/.NET language adapter.
- [ ] Add Java/Kotlin language adapter.
- [ ] Add Go language adapter.
- [ ] Add Rust language adapter.
- [ ] Add C/C++ language adapter.
- [ ] Add Ruby and PHP adapters as demand requires.
- [ ] Add HTML/CSS/SQL/YAML/JSON/configuration-aware navigation.
- [ ] Cache indexes incrementally and invalidate them deterministically.
- [ ] Measure indexing latency, accuracy, memory use, and cache hit rate.

### Repository understanding

- [ ] Generate deterministic architecture maps from repository evidence.
- [ ] Identify entrypoints, runtime boundaries, data stores, APIs, and queues.
- [x] Detect build, test, lint, format, type-check, and development commands.
- [ ] Detect CI/CD workflows and deployment targets.
- [ ] Detect database schemas and migration systems.
- [ ] Detect API schemas such as OpenAPI, GraphQL, protobuf, and AsyncAPI.
- [ ] Detect security-sensitive surfaces and trust boundaries.
- [ ] Produce evidence-linked repository summaries with confidence levels.

## Phase 2 — safe tool runtime

### Capability and policy model

- [x] Define typed tool contracts with input/output schemas.
- [x] Classify tools as read, write, execute, network, credential, and external.
- [x] Define allow, ask, and deny decisions per capability.
- [ ] Support per-session, per-repository, per-user, and organization policies.
- [ ] Require previews for mutations and externally visible actions.
- [ ] Add approval expiration and scope-limited reusable approvals.
      Hosted mutations must use digest-bound, single-use approvals; reusable
      mutation approvals are intentionally out of scope.
- [x] Add bounded, expiring, one-time approval-resume tokens bound to session,
      repository, tool, and tool-call identifiers.
- [ ] Prevent repository instructions from modifying platform policy.
- [ ] Add policy simulation and explain-why-denied output.
- [x] Add a capability-enforced read-only tool registry that does not invoke
      handlers when policy asks or denies.
- [x] Bind repository inspection, search, symbols, references, and source reads
      into repository-fixed read-only tool adapters.

### Filesystem and editing tools

- [ ] Add safe file reads with path containment and size limits.
- [x] Add bounded single-file create/update planning and application with
      optimistic SHA-256 concurrency checks.
- [ ] Add create, move, rename, and delete operations behind approvals.
- [ ] Reject edits outside the selected workspace.
- [ ] Preserve line endings, encodings, executable bits, and file modes.
- [ ] Add generated-file and vendored-file protections.
- [ ] Add patch conflict detection and recovery.
- [ ] Add diff rendering in text, JSON, web, and IDE formats.
- [x] Add deterministic bounded text diff previews tied to exact plan digests.
- [ ] Add undo checkpoints and session rollback without rewriting Git history.

### Command runtime

- [x] Execute commands without shell interpolation by default.
- [x] Add working-directory containment and environment allowlists.
- [ ] Add time, CPU, memory, process, and output limits.
- [ ] Stream stdout/stderr with truncation markers.
- [x] Add bounded timeout, output capture, cancellation, and child-process cleanup.
- [ ] Detect interactive commands and request explicit handling.
- [ ] Add sandbox adapters for local, container, VM, and hosted execution.
- [ ] Add network-disabled and domain-allowlisted execution modes.
- [x] Detect secrets before command output enters model context.
      Command output reaches the model as repair feedback (a failing test
      prints what it compared), which never passes through the tool registry.
      `RedactingModelProvider` covers it because it sits at the outbound
      request boundary, where every path converges.
- [ ] Classify destructive commands and require elevated approval.

### Validation tools

- [ ] Run formatter checks.
- [ ] Run linting.
- [ ] Run static type checks.
- [ ] Run targeted and full test suites.
- [ ] Run builds and packaging checks.
- [ ] Run security and dependency scans.
- [x] Compare supplied validation results with the pre-change baseline while
      distinguishing new, fixed, persistent, flaky, and infrastructure failures.
- [ ] Identify flaky tests and avoid treating them as deterministic repairs.
- [ ] Apply bounded repair attempts with explicit attempt limits.
- [ ] Produce a validation evidence report for every change set.

## Phase 3 — provider-neutral intelligence layer

### Core provider contract

- [x] Define provider-independent messages, content parts, tools, and responses.
- [ ] Define streaming, structured-output, tool-call, and reasoning interfaces.
- [x] Normalize token usage, finish reasons, errors, and retry metadata.
- [ ] Describe model capabilities instead of hard-coding model names.
- [ ] Support text, image, audio, and future multimodal inputs.
- [ ] Add cancellation, timeout, backoff, retry, and circuit-breaker policies.
- [ ] Add provider health checks and graceful degradation.
- [x] Add bounded runtime validation for provider requests, responses, tool
      calls, usage, and provider metadata.
- [x] Add an immutable model registry with deterministic capability routing.
- [x] Add provider configuration contracts using credential references rather
      than raw secret values.

### Model providers

- [x] Add a loopback-only OpenAI-compatible provider adapter with bounded HTTP
      transport and no credentials.
- [ ] Add additional hosted-provider adapters based on customer demand.
- [ ] Add local inference adapters for common local model servers.
- [ ] Add bring-your-own-key credentials with encrypted storage.
- [ ] Add Atlas-managed provider accounts for metered SaaS usage.
- [ ] Add organization-level provider allow/deny policy.
- [ ] Add per-task model selection and manual model pinning.
- [ ] Add automatic routing by quality, latency, privacy, context, and cost.
- [ ] Add fallback chains that preserve tool and output compatibility.
- [ ] Add ensemble, critic, and judge patterns where they measurably improve work.

### Atlas free/trial model

- [ ] Select a license-compatible open-weight coding model baseline.
- [ ] Define hardware, quantization, context, and latency support tiers.
- [ ] Package a local inference onboarding experience.
- [ ] Add a hosted trial inference tier with abuse controls and quotas.
- [ ] Build Atlas-specific tool-use and repository-context evaluations.
- [ ] Collect only explicitly opted-in, privacy-reviewed improvement data.
- [ ] Fine-tune or distill only after an evaluation-backed business case.
- [ ] Version model, prompt, tokenizer, tool protocol, and evaluation results.
- [ ] Never represent a configured third-party/open model as trained from scratch.

### Context engineering

- [ ] Build a deterministic context-selection pipeline.
- [ ] Rank files, symbols, references, tests, history, and memory by relevance.
- [ ] Track provenance for every context fragment.
- [ ] Deduplicate and compress context without losing critical constraints.
- [ ] Reserve context space for tools, user intent, and final validation.
- [ ] Detect prompt injection and suspicious repository instructions.
- [ ] Support long-context models without making them a correctness dependency.
- [ ] Cache reusable prompt/context components safely.

## Phase 4 — single-agent coding loop

### Hosted control plane foundation

- [x] Add a responsive hosted task-intake and build-progression dashboard.
- [x] Require authenticated identity for autonomous task submission.
- [x] Add a bounded server-side agent-dispatch contract with no client secrets.
- [x] Add GitHub App authentication with short-lived installation tokens.
- [x] Add an authenticated GitHub connection-status and installation surface.
- [x] Add Sites and Vercel deployment manifests.
- [x] Add a bounded read-only GitHub Actions inspect runner and dispatch adapter.
- [x] Deploy and configure the production task-runner endpoint and secret.
      Live on Cloudflare Workers via GitHub Actions dispatch
      (atlas-runner.yml, atlas-coder.yml); apps/web/README.md documents
      every required secret.
- [ ] Add approval UI bound to exact change-set digests, base commit, policy,
      immutable artifact manifest, expiry, and authenticated approver identity.
      Coder-opened PRs are reviewed on GitHub itself, not through a
      digest-bound Atlas approval UI — this item is about the latter,
      still undone.
- [ ] Persist atomic approval decision/consume state and immutable execution
      receipts with replay detection and artifact provenance verification.
- [x] Add GitHub write/commit adapter behind approval and repository policy.
      create-coder-pull-request.mjs pushes a branch and opens a PR, then
      enforces the repository's mergePolicy (manual/ci-gated/none) via
      scripts/runner/merge-decision.mjs — tested, documented in
      apps/web/README.md's "Repository settings" section.

- [x] Add guarded `atlas chat <repository-path> <objective>` for explicitly
      configured local compatible model endpoints.
- [ ] Add inspect, ask, plan, implement, validate, review, and explain modes.
- [ ] Define explicit agent state and event types.
- [ ] Separate planning from tool execution.
- [ ] Require evidence and source locations for repository claims.
- [ ] Add tool-call validation and malformed-call recovery.
- [ ] Add task decomposition with bounded step counts.
- [ ] Add progress events, cancellation, pause, and resume.
- [ ] Add user steering without losing completed state.
- [ ] Add limited self-review before presenting changes.
- [ ] Add explicit completion and blocker criteria.
- [ ] Add deterministic maximum turns, retries, and repair attempts.
- [ ] Add conversation export and reproducible run manifests.
- [x] Add a bounded read-only planning loop using caller-supplied evidence and
      the deterministic mock provider.
- [x] Add a bounded read-only tool-calling orchestrator with runtime response
      validation, policy enforcement, approval stops, and audit events.
- [ ] Add code explanation, debugging, refactoring, migration, and test generation.
- [ ] Add documentation and changelog generation with evidence links.

## Phase 5 — Git engineering workflows

- [ ] Show repository status and proposed Git scope before mutation.
- [ ] Create branches with naming policy and collision handling.
- [ ] Stage only approved files or hunks.
- [ ] Detect secrets, generated directories, and oversized files before staging.
- [ ] Generate commit messages from the approved diff.
- [ ] Commit only with explicit authorization.
- [x] Never force-push or rewrite history by default.
      create-coder-pull-request.mjs always pushes a fresh atlas/task-<id>
      branch with a plain `git push`, never `--force`, and never touches
      an existing branch's history.
- [ ] Push only with explicit authorization and remote verification.
- [x] Connect GitHub repositories and installations.
      GitHub App installation tokens (github-app.mjs,
      createInstallationToken) with a fine-grained-PAT fallback
      (ATLAS_GITHUB_TOKEN); connection status surfaced at
      /api/github/status.
- [ ] Read issues, pull requests, reviews, checks, and Actions logs.
      create-coder-pull-request.mjs now reads check-runs on a PR's head
      commit to enforce ci-gated merge policy — issues, PR reviews, and
      Actions logs still aren't read.
- [ ] Create draft pull requests with summaries and validation evidence.
- [ ] Address review comments and track thread resolution.
- [ ] Diagnose CI failures and separate infrastructure from code failures.
- [ ] Add GitLab, Bitbucket, and Azure DevOps adapters as demand requires.

## Phase 6 — development and browser workflows

- [ ] Detect and launch development servers with explicit approval.
- [ ] Track server lifecycle, health, ports, logs, and shutdown.
- [ ] Support browser navigation, screenshots, and accessibility-tree inspection.
- [ ] Add deterministic browser tests and visual regression baselines.
- [ ] Capture console, network, runtime, and accessibility failures.
- [ ] Connect UI failures to likely source files and symbols.
- [ ] Support responsive viewport and cross-browser test matrices.
- [ ] Add mobile simulator/device adapters as demand requires.
- [ ] Keep browser credentials and user sessions isolated and auditable.

## Phase 7 — persistent repository memory

- [ ] Define repository, project, user, organization, and session memory scopes.
- [ ] Store decisions, conventions, commands, architecture, and known failures.
- [ ] Attach evidence, author, timestamp, confidence, and expiration to memories.
- [ ] Separate observed facts from inferred or user-provided preferences.
- [ ] Revalidate memories when repository evidence changes.
- [ ] Add user inspection, correction, deletion, and export.
- [ ] Add retention, residency, encryption, and privacy policies.
- [ ] Prevent secrets and sensitive source from entering inappropriate memory.
- [ ] Add vector, lexical, graph, and structured retrieval behind one interface.
- [ ] Measure whether memory improves task outcomes rather than prompt volume.

## Phase 8 — multi-agent engineering orchestration

- [ ] Define specialist roles such as planner, implementer, tester, reviewer,
      security reviewer, documentation writer, and release engineer.
- [ ] Define an agent-task protocol with inputs, outputs, budgets, and ownership.
- [ ] Build a dependency-aware task graph scheduler.
- [ ] Allow parallel work only on safely separable scopes.
- [ ] Add file, symbol, branch, and environment leases to prevent collisions.
- [ ] Add shared evidence and artifact exchange without hidden prompt coupling.
- [ ] Add supervisor policies for delegation, interruption, retry, and escalation.
- [ ] Add independent review for high-risk changes.
- [ ] Detect redundant work, deadlocks, loops, and conflicting patches.
- [ ] Merge agent outputs through deterministic conflict handling.
- [ ] Attribute cost, tokens, time, tools, and outcomes per agent.
- [ ] Visualize agent state, dependencies, progress, and blockers.

## Phase 9 — local CLI product

- [ ] Add repository-level workspace configuration when multiple TS packages exist.
- [ ] Add stable configuration precedence: flags, project, user, environment.
- [ ] Add interactive and non-interactive modes.
- [ ] Add shell completion for PowerShell, Bash, and Zsh.
- [ ] Add rich progress, diffs, Markdown, and diagnostics with accessible fallback.
- [ ] Add machine-readable JSON and event-stream modes.
- [ ] Add resumable sessions and local encrypted state.
- [ ] Add update checks, signed releases, and rollback support.
- [ ] Add Windows, macOS, and Linux release artifacts.
- [ ] Add telemetry as explicit opt-in with local inspection and disable controls.

## Phase 10 — web coding workspace

- [ ] Add authentication, organizations, teams, projects, and role-based access.
- [ ] Add repository connection and workspace provisioning.
- [ ] Add file tree, editor, search, symbols, terminal, preview, and Git panels.
- [ ] Add chat, plans, tasks, approvals, diffs, tests, and agent activity views.
- [ ] Add collaborative presence, comments, and handoff.
- [ ] Add accessible keyboard navigation and responsive layouts.
- [ ] Add real-time event streaming with reconnect and replay.
- [ ] Add secure uploads, artifacts, logs, and downloadable patches.
- [ ] Add workspace sleep, resume, snapshot, reset, and retention controls.
- [ ] Add user-controlled model and budget selection.
- [ ] Add admin dashboards for usage, policy, security, and audit.

## Phase 11 — desktop IDE

- [ ] Choose a desktop shell only after the web workspace architecture stabilizes.
- [ ] Reuse the web UI and shared domain packages where practical.
- [ ] Add native filesystem, terminal, Git, credential, and notification bridges.
- [ ] Add local model discovery, download, health, and resource management.
- [ ] Add editor protocol integration and extension APIs.
- [ ] Add offline mode and local-only privacy mode.
- [ ] Add signed installers, automatic updates, rollback, and crash recovery.
- [ ] Add OS keychain storage and enterprise device policy support.

## Phase 12 — cloud agent platform

- [ ] Build isolated ephemeral workspaces with immutable base images.
- [ ] Add queueing, scheduling, concurrency, quotas, and backpressure.
- [ ] Add workspace snapshots, caches, artifacts, and reproducibility metadata.
- [ ] Add egress controls, private networking, and customer network connectors.
- [ ] Add encrypted secrets injection without exposing secrets to models.
- [ ] Add webhook and scheduled task execution.
- [ ] Add issue-to-PR, review-to-fix, CI-repair, dependency-update, migration, and
      maintenance workflows.
- [ ] Add human approval checkpoints through web, email, and supported chat tools.
- [ ] Add regional deployment, residency, backup, recovery, and disaster testing.

## Phase 13 — reusable Atlas platform and ecosystem

- [ ] Publish a stable agent SDK.
- [ ] Publish a stable tool SDK and schema format.
- [ ] Publish provider, repository-host, language, memory, and sandbox interfaces.
- [ ] Add signed plugins with permissions, provenance, and compatibility metadata.
- [ ] Add an extension registry with review, trust, and revocation workflows.
- [ ] Add reusable workflow templates and organization playbooks.
- [ ] Add APIs, webhooks, event streams, and service accounts.
- [ ] Add an MCP-compatible interoperability layer where appropriate.
- [ ] Add policy-as-code and organization governance packs.
- [ ] Allow Atlas to scaffold, operate, maintain, migrate, and retire products.

## Phase 14 — enterprise security, privacy, and compliance

- [ ] Perform a formal threat model for local and hosted architectures.
- [ ] Add tenant isolation tests and adversarial prompt-injection evaluations.
- [ ] Add encryption in transit and at rest with managed key rotation.
- [ ] Add customer-managed keys where justified.
- [ ] Add SSO, SCIM, MFA, session policy, and just-in-time access.
- [ ] Add least-privilege RBAC/ABAC and separation of duties.
- [ ] Add immutable audit export and security-event integration.
- [ ] Add dependency provenance, SBOMs, signed builds, and release attestations.
- [ ] Add vulnerability management and responsible disclosure processes.
- [ ] Add data classification, DLP, retention, deletion, export, and legal holds.
- [ ] Add configurable zero-retention model-provider paths.
- [ ] Prepare evidence for applicable security and privacy certifications.
- [ ] Add secure development lifecycle and incident-response exercises.

## Phase 15 — budgets, billing, and commercial controls

- [x] Add an atomic in-memory ledger for token, cost, elapsed-time, and tool-call
      accounting with hard limits.
- [x] Add a model-provider budget wrapper that caps output-token requests and
      records provider-reported token and monetary usage.
- [ ] Track input, output, cached, reasoning, embedding, and tool usage.
- [ ] Track model, compute, storage, network, and third-party costs.
- [ ] Add per-task, session, user, project, organization, and billing-period budgets.
- [ ] Estimate cost and time before expensive tasks.
- [ ] Add soft warnings, hard stops, approvals, and budget reservations.
- [ ] Attribute usage to agents, workflows, models, repositories, and outcomes.
- [ ] Add free, trial, individual, team, enterprise, and API plans.
- [ ] Add quotas, credits, subscriptions, invoices, taxes, refunds, and alerts.
- [ ] Add abuse detection without obscuring legitimate user usage.
- [ ] Show transparent cost/quality/latency comparisons during model selection.

## Phase 16 — quality, evaluation, and observability

- [ ] Define offline benchmarks for inspection, retrieval, planning, editing,
      debugging, testing, security, and pull-request quality.
- [ ] Build versioned real-repository and synthetic evaluation suites.
- [ ] Measure task success, regression rate, test pass rate, review acceptance,
      latency, cost, user intervention, and rollback rate.
- [ ] Add model/provider/prompt/tool regression gates.
- [ ] Add replayable traces with privacy-aware redaction.
      Traces are now persisted and redacted: `atlas code --audit-log <path>`
      flushes the session's events to a JSON-lines store, scrubbed by the same
      redactor, with each event keeping its original timestamp so ordering and
      durations survive. The coder workflow passes it, so every task uploads
      one. Persistence never fails a run — a correct change is not undone by a
      log that could not be written — and reports how many events landed.
      STILL MISSING: replay itself. Reconstructing or re-executing a session
      from its trace is not built; today the file is an audit record to read,
      not something to replay.
- [ ] Add structured logs, metrics, traces, alerts, and service-level objectives.
- [ ] Add canary releases, feature flags, experiments, and automatic rollback.
- [ ] Add user feedback tied to precise run artifacts.
- [ ] Test adversarial repositories, malformed files, huge monorepos, and outages.
- [ ] Publish honest capability and reliability boundaries.

## Phase 17 — advanced and differentiating capabilities

- [ ] Build a living repository knowledge graph.
- [ ] Add cross-repository and organization-wide code intelligence.
- [ ] Add specification-to-implementation traceability.
- [ ] Add architectural rule enforcement and drift detection.
- [ ] Add change-impact, blast-radius, and regression-risk prediction.
- [ ] Add automatic test-selection and minimal validation planning.
- [ ] Add continuous technical-debt and maintainability analysis.
- [ ] Add dependency migration and framework-upgrade factories.
- [ ] Add production-incident investigation from approved observability data.
- [ ] Add performance profiling and optimization workflows.
- [ ] Add security remediation with exploitability and reachability evidence.
- [ ] Add API compatibility, schema migration, and rollout planning.
- [ ] Add natural-language product specification and acceptance-test workflows.
- [ ] Add design-to-code and UI-validation integrations.
- [ ] Add voice, image, diagram, and multimodal engineering collaboration.
- [ ] Add organization-specific engineering standards and reusable expert agents.
- [ ] Add autonomous maintenance windows with strict policies and rollback gates.

## Product foundations required across all phases

### Data and API contracts

- [ ] Version all persisted schemas, events, tool contracts, and public APIs.
- [ ] Use explicit interfaces instead of loosely typed records.
- [ ] Add migration, backward-compatibility, and deprecation policies.
- [ ] Generate API documentation and typed clients from authoritative schemas.

### Reliability

- [ ] Make long-running operations idempotent and resumable.
- [ ] Add cancellation, deadlines, retries, circuit breakers, and backpressure.
- [ ] Preserve evidence and partial progress after recoverable failures.
- [ ] Define recovery behavior for every external dependency.

### Session evidence and audit

- [x] Define versioned metadata-only session events for lifecycle, models,
      tools, policies, budgets, approvals, blockers, completion, and failures.
- [x] Add a bounded append-only in-memory audit log with monotonic sequences,
      immutable snapshots, and explicit overflow failure.
- [x] Add bounded append-only JSON Lines audit persistence with strict event
      validation, sequence checking, and explicit truncated-tail policy.

### Accessibility and internationalization

- [ ] Meet applicable accessibility standards in CLI, web, and desktop surfaces.
- [ ] Support keyboard-only and assistive-technology workflows.
- [ ] Externalize user-facing text and prepare locale-safe formatting.
- [ ] Support repository content in multiple human languages and encodings.

### Documentation and developer experience

- [ ] Maintain architecture decision records.
- [ ] Maintain contributor, security, release, and support documentation.
- [ ] Add reproducible local development and test environments.
- [ ] Add examples for providers, tools, workflows, and extensions.
- [ ] Keep capability documentation aligned with validated behavior.

## Remaining limitations (reviewed 2026-09-26)

What still stops Atlas from doing a job end to end, with who owns each item.
"Copilot" items are the scope of work in the GitHub issue titled
"Copilot scope: hosted rate limiting, audit trail and accessibility";
"Claude" items are being built on `claude/atlas-implementation-eah694`;
"Owner" items need a person with repository or account settings access.

### Owner (settings only; no code)

- [ ] Coder model: set `GROQ_API_KEY` (paid tier), `ATLAS_CODER_PROVIDER=groq`,
      `ATLAS_CODER_MODEL=openai/gpt-oss-120b`, `ATLAS_MAX_TURNS=32`,
      `ATLAS_TOKEN_BUDGET=200000`, `ATLAS_OUTPUT_TOKENS_PER_TURN=8192`; delete
      `ATLAS_CODER_FALLBACKS` if it names a provider without a key.
- [ ] Apply D1 migration 0014 (session revocation) in production.
- [ ] Enable branch protection on `main` requiring the CI checks, so no
      automation can merge around them.
- [ ] Review the About page bio.

### Copilot (hosted web app)

- [ ] Rate limiting on hosted API routes (SEC-6, P1-5): sign-in, owner
      sign-in, task creation, chat and approval decisions return 429 with
      `Retry-After` past a per-account/per-IP budget.
- [ ] Append-only hosted audit trail (SEC-9, P1-2): `audit_events` table and
      migration; owner sign-ins, sign-outs, repository policy edits, device
      pairing and approval decisions write a metadata-only row; owner-only
      read API and a page listing them.
- [ ] Accessibility pass on the hosted app: keyboard-only use of chat, tasks,
      projects and approvals; labelled controls; visible focus; WCAG AA
      contrast; an automated check in the web test suite.

### Claude (local daemon and agent runtime)

- [x] Prompt-injection provenance (SEC-11, P7-4): tool output, memory and
      earlier-step reports enter daemon model turns as a labelled
      `<data source>` block they cannot close; instruction-shaped text is
      flagged; `tests/fixtures/injection-corpus.json` guards regressions.
      Still open: the Windows companion and hosted chat.
- [ ] `AuthorizedToolExecutor` as the only execution path for daemon tools,
      with durable budgets and idempotency keys. Team steps route through it
      since #66; the conversation loop does not yet.
- [ ] Connect the platform capability router so tasks, not only chat turns,
      use `ATLAS_MODEL_ROUTES` fallback.
- [ ] Browser worker as the daemon's default browser, keeping the origin
      allowlist.
- [ ] Memory page in the local dashboard: search, inspect history and
      delete scoped memory through the existing `GET/DELETE /v1/knowledge`.
- [ ] Actions-minutes visibility (SEC-15, P7-5): report the budget guard's
      state, including when it failed open, with the task result.
- [ ] Finish the six in-progress workstreams (orchestrator, terminal
      sessions, desktop control, tenancy, MCP over HTTP, planning) and land
      them on top of main.

### Queued (larger product work, one GitHub issue each)

- [ ] Tenant model (SEC-1, P9-1) beyond the per-user GitHub permission
      check — #71.
- [ ] Container or VM runner so terminal commands are isolated from the
      operator's account — #72.
- [ ] Project Genesis: prompt → requirements → plan → new repository →
      deployed preview — #73.
- [ ] Visual builder: live preview with click-to-edit mapped to source — #74.
- [ ] Scheduled and event-driven automations — #75.
- [ ] Script-src CSP with renderer nonces (SEC-13) — #76.

## Immediate next assignments

Complete these as separate, reviewable changes in this order:

1. [x] Extract a shared bounded repository file enumerator used by search and
       symbol indexing, preserving current behavior and tests.
2. [x] Add safe contextual source reads with path containment, line/byte limits,
       text/binary detection, and tests.
3. [x] Add symbol-reference primitives and evidence-linked source locations.
4. [x] Define the typed tool capability and approval-policy interfaces without
       adding mutation yet.
5. [x] Define the provider-neutral model contract and mock provider tests.
6. [x] Add a read-only planning/explanation loop using the mock provider.
7. [ ] Add one explicitly selected real provider adapter after credential and
       privacy behavior is documented.
   - [x] First adapter: credential-free, loopback-only compatible local server.

## Explicitly deferred decisions

- [ ] Select the web framework only when the web milestone begins.
- [ ] Select the desktop shell only after shared web/domain boundaries exist.
- [ ] Select cloud infrastructure only after workload and isolation requirements
      are measured.
- [ ] Select hosted model vendors based on current capability, policy, and cost.
- [ ] Select the Atlas trial model after license and evaluation review.
- [ ] Train a proprietary foundation model only if data, compute, talent, safety,
      evaluation, and business economics justify it.

## Definition of done for any checked item

- [ ] Scope and interfaces are documented.
- [ ] Security and trust boundaries are identified.
- [ ] Important logic has automated tests.
- [ ] Strict TypeScript and relevant validation pass.
- [ ] Existing failures are distinguished from introduced failures.
- [ ] User documentation describes actual behavior and limitations.
- [ ] No secret, generated dependency directory, or unrelated change is included.
- [ ] The item has been validated before being marked complete.
