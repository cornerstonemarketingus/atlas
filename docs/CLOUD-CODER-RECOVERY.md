# Cloud coder recovery

Incident: [run 38819478158](https://github.com/cornerstonemarketingus/atlas/actions/runs/38819478158).
The coder spent 23 tool turns without an edit, twice hit PARENT_NOT_DIRECTORY
when writing the requested Minnesota framing site, then exhausted its Groq
routes (8,503 tokens against an 8,000 TPM allowance). Results were delivered;
the 11m48s work step failed rather than remaining active.

## Implemented repair

- Approved file creates can materialize missing repository-relative parent
  directories. Preview and denied/tampered approvals create nothing. Every
  existing parent is rechecked for symlinks/non-directories before mutation.
  Updates, deletes and renames retain their existing path requirements.
  Transaction rollback restores files; new empty directories may remain.
- The coder CLI supports `groq`, `anthropic`, `openai`, and `workers-ai`.
  OpenAI and Workers AI use fixed vendor destinations, bounded responses,
  cancellation and sanitized errors. API redirects are refused. Namespaced
  Atlas tools map to valid cloud function names and back to exact registry IDs.
  OpenAI uses max_completion_tokens; Workers AI uses the compatible payload.
- The cloud runner includes available Workers AI/OpenAI/Groq recovery routes
  after explicit fallback routes. With no primary/model setting it prefers
  Workers AI, then OpenAI, then Groq. Explicit provider/model choices still win.
  `ATLAS_CODER_FALLBACKS=none` disables every fallback. A custom/private
  ATLAS_CODER_BASE_URL never gains public-cloud fallbacks implicitly.
- Auth failures remain explicit and do not change providers. Capacity/model
  failures continue the same model request through the existing fallback
  wrapper, without restarting the agent or replaying tool execution.
- The trusted CLI emits numeric model/tool/error counters every 15 seconds;
  the runner logs elapsed time and those counters every 30 seconds. Prompts,
  file contents, arguments and provider error bodies are not progress data.
  Output capture and timeouts remain bounded; a timed-out process cannot
  report a successful completion from earlier JSON output.

## Configuration after this change reaches main

The coder workflow checks out trusted main. A PR or branch alone does not
activate these changes for normal dispatched tasks. Protected workflow and
execution-boundary review must finish first.

| Provider | Repository secret | Model configuration |
|---|---|---|
| Workers AI | ATLAS_WORKERS_AI_TOKEN and CLOUDFLARE_ACCOUNT_ID | ATLAS_CODER_PROVIDER=workers-ai; ATLAS_CODER_MODEL=@cf/openai/gpt-oss-120b (or selected compatible model) |
| OpenAI | OPENAI_API_KEY | ATLAS_CODER_PROVIDER=openai; ATLAS_CODER_MODEL=gpt-5.4-mini (or selected compatible model) |
| Anthropic | ANTHROPIC_API_KEY | ATLAS_CODER_PROVIDER=anthropic; ATLAS_CODER_MODEL must name the intended Claude model |
| Groq | GROQ_API_KEY | Existing Groq variables retain their meaning |

Only credential names were inspected for the incident: Workers AI, Cloudflare
account ID and OpenAI secret names are present. This does not establish their
current validity, permissions, balance or model availability. No secret was
copied or new provider account provisioned.

Explicit route examples:

```
ATLAS_CODER_FALLBACKS=workers-ai:@cf/openai/gpt-oss-120b:ATLAS_WORKERS_AI_TOKEN,openai:gpt-5.4-mini:OPENAI_API_KEY
```

Configured routes share the existing task output-token budget. This change does
not establish a new global monetary ledger or a dedicated GPU fleet. Cloud
inference and finite GitHub Actions jobs do not depend on the owner's PC;
persistent workspace leases/checkpoint migration remain the separate cloud
execution workstream.

## Verification scope

Regression first reproduced the nested-directory failure. Tests cover preview
purity, exact approval, symlink replacement, cloud provider/key separation,
no credential redirects, HTTP 413 to Workers AI, authenticated-error refusal,
empty/oversized replies, cancellation, fixed function-name round trip, output
limits, timeout cleanup and metadata-only progress. A registry integration
writes all five framing-site files after a simulated Groq refusal; an actual CLI
subprocess test exercises nested-file creation and change receipts.

Provider HTTP responses are scripted fixtures. Live model quality and production
website delivery are not claimed. After merge, verify the selected cloud route
with a bounded real coder task, inspect actual edits/verification/PR, then retry
the framing-site request. Do not mistake a green workflow or repository URL for
a deployed website.

API references: [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create),
[Workers AI compatible endpoints](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/).

## Automatic PR repair scope

The owner explicitly approved the scoped credential extension on October 16.
Both the main coder and the PR-steward now declare the same existing cloud
credentials only in their trusted coder steps. The steward checks out trusted
main, restricts workflow-run repairs to same-repository atlas/task branches,
disables dependency install scripts and uses scrubbed validation child
environments. Protected workflow review still applies before deployment.

## October 21, 2026 — coder reliability repair

This pass inspected the existing checkout at cb979bd and reused its registry,
validation runners, package graph, session checkpoints, OIDC callback and PR policy.
No TODO file was added.

### Incident evidence and limits

The public page for [run 39636188754](https://github.com/cornerstonemarketingus/atlas/actions/runs/39636188754)
confirms failed coder and result-return jobs, with artifact
`atlas-39636188754-1` (ID 12363456957, SHA-256
`e1480656558b4fa8a7eb2c5ec58e5f48ee3708cc136870de57fc084af1933794`).
Its workflow commit 0dafff3 is present locally. Its runner only enforced an
outer subprocess deadline and replaced timed-out edits with an empty array;
its reporter discarded delivery exceptions behind a generic message.
These are verified source defects, not proof of the precise historical failure.

Authenticated API requests were forbidden, job pages required sign-in for logs,
and the artifact download was unavailable. The reported 23 requests, 22 calls and
five failed tools could not be independently reconstructed. The older
[run 38112578914](https://github.com/cornerstonemarketingus/atlas/actions/runs/38112578914)
was inspected through its public page, but its private execution evidence was
also unavailable. Do not infer specific failed arguments from these pages.

### Resulting behavior

- Existing alias resolution now considers all registered tools for ambiguity,
  normalizes namespaces/separators/camel case, and repairs only a unique strict
  namespace typo with an exact operation. Policy and offered-tool checks still
  apply. Audit records retain requestedToolId, toolId and repair=automatic.
  Invalid input responses include the expected nested schema.
- A conservative test-only objective, including “Run the test suite for the
  Atlas repository and report any failures.”, uses the existing package graph
  and validation runners without model calls, credentials, edits or repairs.
  Each discovered default package test script runs once. Assertion failures are
  reported as test failures; missing suites, interrupted commands, discovery
  warnings and infrastructure failures cannot claim complete execution.
- Hosted validation stays in disposable containers. Dependency-free packages
  without lockfiles skip unnecessary installs. Provisioning failure in one suite
  preserves other suite results. Scope is explicit: standalone/Python tests and
  platform/browser prerequisites are not automatically inferred or provisioned.
- The default coder deadline remains 900000 ms. ATLAS_CODER_TIMEOUT_MS accepts
  5000–2700000 ms; ATLAS_CODER_CHECKPOINT_INTERVAL_MS accepts 1000–60000 ms.
  ATLAS_CODER_JOB_TIMEOUT_MINUTES defaults to 25 in the workflow and is validated
  through ATLAS_JOB_TIMEOUT_MINUTES (11–60). The coder must leave at least ten
  minutes for setup, PR checks and recovery uploads. A longer coder deadline
  requires an explicit compatible job setting.
- The CLI receives a shorter cooperative deadline, sharing cancellation across
  models, tools, validation and repairs. Atomic redacted progress and incremental
  audits are saved periodically and around edits; existing undo checkpoints are
  saved continuously. Pre-mutation intent paths cover an interruption before the
  post-edit receipt. Recovery captures bounded tracked diffs and created/renamed
  file contents, with explicit omissions when capture cannot be complete.
- Existing bounded repair/escalation can continue within a run. Interrupted
  runs retain reviewable recovery evidence; automatic cross-run replay is not
  enabled. Restore against the recorded base, review and validate before resuming.
  Redaction can alter recovery content, so an artifact is not a lossless backup.
- Result delivery retains a safe delivery.json receipt and Actions summary,
  identifies OIDC/configuration/GitHub verification/ownership/storage failures,
  and attempts reporting even if the credential scanner build failed, using a
  fixed safe fallback when scanning is unavailable. A claimed task missing at
  the receiver fails reporting visibly. Authentication remains GitHub OIDC with
  audience atlas-runner-results; governor credentials are unrelated.
- Every automatic merge policy requires passing CI evidence, complete check/status
  pagination, fresh GitHub merge eligibility and the exact head SHA. Canonical
  verification status verified now works with the existing gate (legacy passed
  remains supported). PR/branch/commit receipts persist before subsequent calls.
  Required checks and owner reviews are never bypassed.
- Frontend and run summaries distinguish reported test failures from code
  regressions. A successful workflow without a PR makes no claim that a change
  is ready or that tests passed.

### Verification

- CLI build passed. Full CLI suite with concurrency 2: 642 tests, 637 passed,
  five optional skips, zero failures. The earlier concurrent run exposed a
  short process-startup fixture timeout; it was not suppressed or weakened.
  A final build and focused session/deadline rerun cover the last reporting fix.
- Runner/local suite: 123/123 passed. Workflow validation: all 12 passed.
- Web build, typecheck and lint passed. Full web suite: 715 tests, 709 passed,
  six optional browser skips, zero failures. After final presentation changes,
  the production build and 20 focused callback/status cases passed again.
- Actual CLI about-page fixture: aliased search/read, real patch, real baseline
  and post-change checks, and repaired-name audit evidence; four scripted model
  requests, no corrective alias round trip. Actual stalled-model deadline fixture
  retains the edit, progress, audit and undo record.
- Actual Docker coder journey passed: edit, failing test, repair, verified result.
  Actual Docker operational fixture passed without a lockfile or model credential:
  one suite executed, zero model turns/tool calls/input/output tokens, no edits.
- PR smoke fixtures execute real local staging, commit and bare-repository push;
  GitHub PR/check/merge requests are scripted. Reporter tests use actual HTTP
  retry/reset/redirect cases. Web callback tests exercise the built Worker.

### Outstanding live acceptance

No production deployment, new live Atlas task, live PR creation or CI merge has
been verified in this environment. Git HTTPS read access works, but API access is
forbidden. Cloudflare documentation fetch was denied by the network proxy, and
Cloudflare/operator/model credentials are not configured in this environment;
their presence in GitHub secrets does not make them available here.

A saved environment draft adds api.github.com, developers.cloudflare.com,
api.cloudflare.com and atlas-web.cornerstonemarketingus.workers.dev to the custom
network allowlist. Saving that draft does not activate or publish it. After the
environment settings are reviewed/saved/published and API access is available,
fetch the requested official setup instructions, inspect the original artifacts,
open the protected PR for owner review, and use the existing authenticated
smoke-hosted coder path to verify actual changes, validation, PR and persisted
frontend reporting. Do not claim this release gate from fixture results.

### Exact changed files

```text
.github/workflows/atlas-coder.yml
apps/web/app/api/tasks/result/route.ts
apps/web/app/build/task-presentation.mjs
apps/web/tests/result-storage.test.mjs
apps/web/tests/runner-result.test.mjs
apps/web/tests/task-completion-screen.test.mjs
docs/CLOUD-CODER-RECOVERY.md
docs/PROGRESS.md
packages/atlas-cli/src/agent/operational-test-session.ts
packages/atlas-cli/src/agent/provider-read-only-tool-agent.ts
packages/atlas-cli/src/agent/tool-name-resolution.ts
packages/atlas-cli/src/agent/verified-coder-session.ts
packages/atlas-cli/src/cli-operational-tests.ts
packages/atlas-cli/src/cli.ts
packages/atlas-cli/src/domain/validation-profile.ts
packages/atlas-cli/src/infrastructure/coder-progress-recorder.ts
packages/atlas-cli/src/infrastructure/container-validation-runner.ts
packages/atlas-cli/src/infrastructure/execution-deadline.ts
packages/atlas-cli/src/infrastructure/repository-test-planner.ts
packages/atlas-cli/src/infrastructure/validation-profile-runner.ts
packages/atlas-cli/tests/cli-execution-deadline.test.ts
packages/atlas-cli/tests/coder-progress-recorder.test.ts
packages/atlas-cli/tests/coder-reliability-journey.test.ts
packages/atlas-cli/tests/container-validation-runner.test.ts
packages/atlas-cli/tests/execution-deadline.test.ts
packages/atlas-cli/tests/operational-test-session.test.ts
packages/atlas-cli/tests/provider-read-only-tool-agent.test.ts
packages/atlas-cli/tests/tool-name-resolution.test.ts
packages/atlas-cli/tests/verified-coder-session.test.ts
scripts/runner/coder-execution-policy.mjs
scripts/runner/coder-execution-policy.test.mjs
scripts/runner/coder-recovery.mjs
scripts/runner/coder-recovery.test.mjs
scripts/runner/create-coder-pull-request.mjs
scripts/runner/create-coder-pull-request.test.mjs
scripts/runner/merge-decision.mjs
scripts/runner/merge-decision.test.mjs
scripts/runner/report-result.mjs
scripts/runner/report-result.test.mjs
scripts/runner/run-summary.mjs
scripts/runner/run-summary.test.mjs
scripts/runner/run-task.mjs
```
