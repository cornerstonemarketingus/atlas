# Hosted project creation

Hosted chat exposes `workspace_create_project` and `workspace_project_status`.
`new_project_task` is distinct from work on the selected repository. Explicit
new-project requests do not offer the existing-repository task tool. The task
API also routes new-project objectives to Genesis before repository dispatch.
The model chooses a concrete idea, safe slug, curated template and visibility;
the trusted runtime owns execution. Private is the default. Public requires
an explicit user request in chat.

## Connection and credentials

The Cloudflare Worker cannot run Node SQLite, filesystem workspaces or git.
Connect a deployment-owned, running local-control Genesis node through a
customer-managed HTTPS proxy. The daemon continues listening on loopback.
Configure these **server-side Worker secrets** through the owner's existing
Cloudflare secret management process:

- `ATLAS_GENESIS_URL`: trusted HTTPS origin, e.g. `https://genesis.example.com`.
  No path, userinfo, query or fragment. Caller/model URLs are never accepted.
- `ATLAS_GENESIS_TOKEN`: that node's owner bearer credential. This is privileged
  control-plane access. Keep it server-only; never put it in client settings,
  model context, source control or logs.

The deployment workflow synchronizes these variables from repository secrets
when configured; missing values are skipped. No credential is supplied by the
code itself. Missing configuration reports
`execution_node_not_configured`, and never falls back to editing Atlas.
The bridge refuses redirects and bounds request time. A proxy-reached owner
request also requires the node's existing explicit remote-owner opt-in
(Settings → Reach Atlas); the bridge does not bypass this security setting.
The HTTPS node must be reachable from Cloudflare; a private tailnet address
alone is not reachable by a public Worker. Only the authenticated
deployment operator may use this deployment-owned node. Ordinary GitHub login
and paid tenant membership do not grant operator access. A per-user Genesis
node/OAuth connection remains future work.

On the Genesis node, use the existing OS-backed credential vault
(Settings → Credentials). `ATLAS_GITHUB_ACCOUNT_TOKEN` takes precedence over
`ATLAS_GITHUB_TOKEN`; the existing token is reused if it has account-level
repository creation permission. Prefer a user-authorized OAuth/user-to-server
credential with the needed permissions and normal renewal/revocation over a
permanent broad token. This change does not add a new OAuth consent flow.
Atlas sign-in currently requests only `read:user user:email` and discards the
profile access token; it cannot be repurposed for repository creation.
Actions `GITHUB_TOKEN` and repository-limited installation tokens do not prove
permission to create repositories for an account. The hosted dispatch token
remains separate and is not forwarded to Genesis.

Capability discovery uses GitHub's authenticated `/user` response and scope
metadata. Classic `repo` permits private/public creation, `public_repo` permits
public only. Missing scope metadata means **unknown**, not guaranteed access:
fine-grained/user-to-server restrictions are resolved by the real create/push
responses. Invalid credentials, known insufficient permission, denied policy
and unavailable hosts have distinct safe reasons. Permissions can change
between discovery and execution; failures remain authoritative.

## Execution, approval and result semantics

`POST /api/genesis/operations` delegates to owner-only
`POST /v1/genesis/operations`. The latter validates a request id, slug,
description, curated template (`web-app`, `static-site`, `api-service`),
GitHub host and visibility. It reserves a durable operation before planning.
Identical retries reuse that receipt; conflicting payloads are rejected.

Genesis creates a contained, isolated project and its own git repository,
plans implementation, scaffolds, runs declared checks and test/build commands,
and performs the existing preview/review stages. Missing coder capability,
failed checks, required answers or plan approval stop progress honestly.
After resolving a blocked project on the node, reaching ready continues its
pending publication without creating a second workspace.

`GenesisPublisher.requestRepository` reuses `createRepositoryCreator`:
plan → `publish.remote` policy → approval if required → apply
(`POST /user/repos`) → repository readback → authenticated git push → remote
main commit verification → published evidence. The GitHub account must still
match the approved plan. Readback must confirm owner/name, visibility and the
expected GitHub clone URL. Git credentials are scoped to that exact HTTPS
remote in the subprocess environment; they are absent from argv, persisted
git config, model messages, approvals and result metadata. Hooks and
interactive prompts are disabled for that push, as are HTTP redirects.

- `allow`: proceed without another approval.
- `ask`: wait for the existing node Approvals page, bound to destination and
  commit. Node/paired-device approval uses the existing decision handler.
- `deny`: refuse before building or contacting GitHub.

The receipt/status endpoint returns operation/project ids, state, repository
metadata, visibility, initial commit, approval id and deployment state.
The chat's activity card polls confirmed progress while open. An asynchronous
receipt is never completion. A created repo with a failed push is a failure
with the repository retained for inspection; Atlas never deletes it.
Restarted in-flight operations report interrupted and are never blindly
replayed across the external-action boundary. Approvals retain their existing
durable exact-commit semantics. To check a receipt after closing the chat,
ask `workspace_project_status` with its operation id or inspect Genesis.
The activity card itself is not saved into conversation history.

Deployment stays `not-deployed` until a separately authorized deployment
actually runs. A verified starter or business plan is not proof of an
autonomous production business, revenue, billing integration or monitoring.

## Scroll behavior and validation

Chat tracks the actual `.section-scroll` element. Content growth follows only
while the reader is within 80px of the bottom. Scrolling away locks the
viewport across streamed tokens and completion; returning near the bottom or
pressing Jump to latest resumes following. Sending, loading or changing a
thread resets initial following. No page-level `scrollIntoView` is used.

Tests cover actual scroll calculations/state transitions, intent separation,
structured tool execution, safe capability reasons, private defaults,
owner/HTTPS bridge boundaries, real Genesis workspace/check/build execution,
mocked GitHub create/readback and push, approval waiting, denied/insufficient
permissions, unknown scope metadata, visibility mismatch, failed push and
idempotent receipts. CI creates no real GitHub repositories.
