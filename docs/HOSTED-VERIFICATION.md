# Hosted Atlas verification

The hosted workspace runs inspect, debug, and coder jobs through GitHub Actions.
Inspect reports repository structure; it does not yet generate an objective-specific
implementation plan. Coder proposes a pull request and records baseline/post-change
validation separately from the workflow conclusion.

## Results in the conversation

Both runner workflows have a separate reporting job. It reads bounded artifacts as
data, redacts their text using the trusted CLI, and posts findings to
`/api/tasks/result`. GitHub OIDC authenticates this call without a shared callback
secret. The Worker verifies the signature, audience, expiry, repository, main-branch
workflow, run attempt, and exact task identifier. The task's stored owner determines
the recipient. Stable event/message IDs and a D1 batch prevent duplicate results
on network retries. Existing tables suffice; this change needs no migration.

Repository execution jobs have no `id-token: write` permission. Keep reporting
isolated: never execute target repository code in a reporting job.

The Build conversation polls for delivered findings. A green workflow does not
imply a change, a pull request, or passing validation. Missing artifacts and failed
delivery are reported explicitly. Older runs have no callback and retain their logs.

## Hosted model configuration

Chat uses `ATLAS_CHAT_BASE_URL`, `ATLAS_CHAT_MODEL`, and `ATLAS_MODEL_API_KEY`.
For the exact Groq base URL `https://api.groq.com/openai/v1`, deployment can reuse
the existing `GROQ_API_KEY` when no separate model key is set. It never forwards
that fallback credential to another model host.

Coder uses its own repository variables. To use the existing hosted provider,
unset `ATLAS_SELF_HOSTED_MODEL`, select `ATLAS_CODER_PROVIDER=groq` and a supported
`ATLAS_CODER_MODEL`, and remove local-only context/output-window overrides.
The Atlas-only runner installs the target CLI's dependencies without lifecycle
scripts and verifies `packages/atlas-cli` by default.

Ollama is optional. An installed/downloaded model is not proof it fits in memory
or responds within the request deadline. A Worker cannot reach the PC's localhost.
If exposing a local model, put `scripts/local/model-gateway.mjs` behind HTTPS,
configure a random 32+ character `ATLAS_MODEL_API_KEY`, and point the tunnel at
gateway port 11435. Do not expose Ollama's unauthenticated management API directly.
Availability then depends on the PC and tunnel remaining online.

## Live acceptance checks

Run **Verify hosted Atlas** manually with `inspect`, `chat`, then `coder`.
The workflow uses the existing operator secret without printing it. It also verifies
that a forged platform identity header is rejected on the public Worker.

Inspect must return findings into the conversation. Chat must return and persist
a nonempty reply. Coder must open a small documentation PR, deliver findings,
and include a `verified` baseline/post-change verdict. The workflow fails on an
empty green run. It uploads `smoke-result.json` as evidence; review the PR diff
and leave the smoke PR unmerged unless the documentation is wanted.

Public Workers must leave `ATLAS_TRUST_PLATFORM_HEADERS` unset. Only deployments
behind an ingress that removes client identity headers may opt in to that legacy
platform-header authentication path.
