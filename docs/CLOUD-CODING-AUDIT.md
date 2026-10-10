# Native cloud coding: audit and first isolation slice

Audited from `origin/main` at `17570ff` (2026-10-08); implementation and
validation continued through 2026-10-10. This document records code evidence,
not a declaration that the full autonomous platform is complete.

## Planning and ownership

Read `docs/{ROADMAP,TODO-MAP,PROGRESS,PROGRAM}.md`, `CLAUDE.md`, `TODO.md`,
`HANDOFF-TODO.md`, and the operator/parallel-workstream roadmaps. `PROGRAM.md`
is under `docs`, not the repository root. The owner's new cloud-native mission
prioritizes the coding vertical slice; existing safety and claim rules apply.
No new TODO file or competing runtime/router/scheduler was created.

The original checkout was an older UI branch with uncommitted terminal and
path-confinement work. It was preserved. Implementation uses the isolated
`codex/cloud-validation` worktree and claim issue #245.

Relevant open work at audit time: #243 self-improvement approvals, #240 hosted
provider repair, #237 operator control, #236 replay/evals, #235 credential and
approval enforcement, #233 credential broker, #230 local model setup, #207
repository content reuse, #203 billing, #200 CLI provider handling, #178 hosted
provider smoke, #160/#158 chat inference wiring, #129–#133 inference package
stack, #98 PR/CI tools, #97 memory, #69 rate limiting and #61 mobile. A PR being
open does not mean its functionality is absent: portions of older stacks are
already present on main. Active issue claims include #127 (claude-1 inference),
#128 (claude-2 evals), and Codex #242/#238/#234/#227/#208/#182/#173/#170/#165/#74.
This slice avoids their runtime, provider, credential, UI and terminal files.

## Findings from main

| Area | Existing implementation and boundary | Remaining gap |
|---|---|---|
| Native coding loop | `atlas-cli` read tools, provider contracts, bounded context, transactional edits, checkpoints, `VerifiedCoderSession` baseline comparison, repair/escalation and redaction. `scripts/runner/run-task.mjs` invokes the trusted built CLI. | CLI validation was a host process; an environment allowlist alone cannot isolate malicious test code. |
| Local native runtime | `AgentRuntime`, session store, kernel/world state, mission scheduler/service, tool registry and executor are mounted by `apps/local-control/src/main.mjs`. Leases, events, budget checks and restart recovery exist. | These processes stop when their host stops. Restart recovery is not proof that every interrupted consequential tool can resume without replay. |
| Hosted control plane | Cloudflare Worker, tenant-scoped D1 tasks/conversations/events, authenticated `/api/tasks`, repository authorization, GitHub App/token dispatch, exact task/run correlation, activity and change routes. | Dispatch precedes best-effort persistence; no general durable hosted mission queue or persistent cloud worker consumer was found in this task route. Ambiguous dispatch/retry needs an outbox/idempotency design. |
| Inference | `atlas-inference` contracts, quota ledger, target registry and circuits; Worker governor; hosted chat provider selection; CLI Groq/Anthropic/OpenAI-compatible endpoints and fallback; local model routing/discovery. | Callers use multiple existing integration paths. Universal governor coverage and live provider reliability cannot be inferred from the presence of modules. Do not add a competing router. |
| GitHub workflow | Authorized task → Actions checkout → native coder → trusted PR creation → result callback/artifacts → task activity/PR changes in web UI. Credentials are not persisted by checkout; reporting uses a separate job. | Git operations and PR publishing are trusted-host operations. Actions is a bounded remote adapter, not a persistent Atlas cloud computer. |
| Isolation | Existing local terminal container/namespace adapters enforce offline defaults, CPU/memory/PID limits, filesystem mounts and fail-closed construction. | The hosted CLI did not use them. No provisioned general-purpose VM fleet, domain-restricted coding egress or workspace migration was verified. |
| Memory and teams | Scoped memory, identities/family graph, dependency-aware missions, isolated coder lanes, worktree helpers and team step verification exist locally. | Persistent identity is not persistent compute; generic hosted worker replacement and integration/conflict handling are incomplete. Some roadmap-listed orchestration modules are not the hosted dispatch consumer. |
| Browser/computer | Browser worker, SSRF/egress checks, Playwright adapters and paired companion/desktop tools exist; local main registers the capabilities. | A complete managed per-tenant browser/desktop fleet and remote-assisted authentication were not verified. Do not equate a browser package with a hosted service. |
| Mobile/approvals | Web task monitoring/PR changes, computer approval routes and mobile shell/security helpers exist. | General cloud coding pause/resume/cancel, exact approvals spanning arbitrary coding tools, push and physical-device validation remain incomplete. |
| Credentials/security | Tenant repository policy, session revocation, credential references/vault, redaction, approval contracts and protected PR paths exist. Workflow secrets are step-scoped and deployed Worker variables are explicit. | Open credential/approval PRs address gaps; untrusted host execution could bypass any application-level policy. No secret values were inspected during this audit. |

## Implemented slice

`atlas code --verify-container /absolute/path/to/docker` mounts the existing
Atlas container policy behind the existing validation contract. Docker is
probed before any model call. There is no fallback to host execution, and
`--no-verify` cannot disable requested isolation.

For each baseline, post-change or repair pass, Atlas copies the current
repository into a private temporary workspace. Git metadata, Atlas checkpoints,
outside symlinks and special files are excluded. Internal dependency symlinks
are preserved. Snapshot creation has file, byte and time limits. The original
working tree is never mounted, and validation output files are never copied
back or committed.

CLI orchestration installs locked npm dependencies with fixed
`npm ci --ignore-scripts --no-audit --no-fund` arguments inside a container.
Only that provisioning command enables bridge networking. Validation commands
run with no network, a read-only image root, dropped capabilities,
no-new-privileges and the existing CPU/memory/PID limits. Atlas/GitHub/model
credentials and the host Docker socket are not mounted or injected.

The existing bounded process transport retains cancellation, time and output
limits. Container removal follows every command, including timeout and failure.
Unconfirmed cleanup stops validation and blocks further passes. Temporary
storage is deleted afterward. Infrastructure failures do not yield verified
success. Hard process/host crashes still require execution-plane cleanup.

`atlas-coder.yml` now requires this path and no longer installs target
dependencies on the trusted host. `run-task.mjs` also rejects missing hosted
isolation configuration before inference. File tools, model routing, repair,
audit, PR publishing, result reporting and mobile-accessible activity reuse
their existing paths. No merge/deployment authorization is added.

## Validation and operating instructions

Run `npm ci --ignore-scripts && npm test` in `packages/atlas-cli` and
`node --test scripts/runner/*.test.mjs scripts/local/*.test.mjs` at the root.
Before workflow push run `python .github/atlas/check-workflows.py`.

Real Linux verification is a dedicated `Cloud validation isolation` PR job:
build the trusted CLI, pull `node:22-bookworm-slim`, set
`ATLAS_TEST_CONTAINER_RUNTIME=/usr/bin/docker`, then run the container tests.
The job must fail when Docker is unavailable. It exercises filesystem,
credential and network isolation plus a scripted-model native coder journey
that introduces a test regression, reads the real container failure, repairs
it and produces a verified change without importing test-generated files.
It also exhausts the real container's memory quota and requires an
infrastructure-failure receipt rather than baseline assertion evidence.
The scripted model proves plumbing, not hosted-model coding quality.

The local Windows Docker daemon was unavailable; real-container tests were
therefore not claimed as passing locally. Exact local/CI results belong in the
PR and progress entry. This change is not deployed or live-verified.

Local evidence: strict CLI compilation passed; focused isolation tests passed
11 with three real-container tests skipped; runner/local-script tests passed
71/71 after rebasing; all 11 workflows passed the repository checker using Git
Bash. The final full CLI suite passed 506, failed four and skipped seven. All four
failures reproduced in the same unmodified tests on a clean main worktree
(`4f89f19`), 21 passes/four failures across those 25 baseline tests. They are
Windows diff/file-URL and file-mode issues, not new isolation regressions.
Temporarily disabling the hosted-isolation guard made its negative test fail;
the source was restored and the tests passed again.

## Limitations and next slice

- Dependency provisioning uses ordinary bridge egress, not a domain allowlist.
  Validation stays offline. Registry credentials/private packages are not injected.
- The initial image is a mutable Node tag, has no Git/compiler toolchain, and
  is not a VM. Provision an approved digest-pinned development image next.
- Snapshots are limited to 100,000 entries/512 MiB; there is no aggregate
  writable-disk quota. Container and daemon failures are surfaced, but abrupt
  host death/SIGKILL needs a durable cleanup reconciler.
- The CLI container mode requires the complete trusted Atlas checkout because
  it reuses `apps/local-control`'s container policy. Local process verification
  remains available when no container was requested.
- No persistent cloud machine, dev-server service, generic worker leasing,
  durable hosted tool checkpoint/resume or new mobile control API is claimed.
- Sandbox/workflow changes require owner review. No auto-merge or deploy.

Next eligible implementation: a durable hosted dispatch/outbox and cloud-worker
lease adapter over existing task contracts, with cancellation, orphan cleanup,
idempotent receipts and tenant-scoped artifacts. Coordinate that contract with
the existing runtime/security claims before starting it; retain Actions as an
optional execution adapter.
