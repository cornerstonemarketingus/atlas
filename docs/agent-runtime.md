# The Atlas agent runtime

Atlas used to run its work by dispatching a GitHub Actions workflow and
reading the result back out of a log. That made GitHub the execution engine,
the interface, and a hard dependency all at once: no network, no Atlas; no
GitHub token, no Atlas; and nothing to talk to while a job was in flight.

The agent runtime replaces that. It is a long-running local process that owns
agent execution, streams what it is doing as it happens, and treats GitHub
Actions as **one executor adapter among several**. Nothing in the runtime
depends on GitHub, Cloudflare, or a hosted model provider.

## Where it lives

| File | Responsibility |
| --- | --- |
| `apps/local-control/src/agent/events.mjs` | The normalized event contract every executor speaks |
| `apps/local-control/src/agent/session-store.mjs` | Durable sessions, turns, and the append-only event log |
| `apps/local-control/src/agent/budget.mjs` | Token, time, tool-call, and cost budgets that survive restarts |
| `apps/local-control/src/agent/run-control.mjs` | Cooperative pause and abortive cancel for one run |
| `apps/local-control/src/agent/runtime.mjs` | The runtime: leases, recovery, the turn queue, fan-out |
| `apps/local-control/src/agent/executors.mjs` | The local and GitHub Actions executor adapters |
| `apps/local-control/src/agent/github-actions-client.mjs` | A scoped client that can dispatch one workflow and read its runs |
| `apps/local-control/src/agent/routes.mjs` | The HTTP surface, including resumable SSE |

The daemon is `apps/local-control/src/main.mjs`, unchanged in how it starts:

```
node apps/local-control/src/main.mjs
```

## The event contract

Every executor emits the same nine kinds, and clients render them without
knowing which executor produced them:

`status` · `assistant_message` · `tool_proposal` · `tool_execution` ·
`validation_result` · `approval_request` · `artifact` · `error` · `completion`

Events are validated before they are stored — an unknown kind, a non-object
payload, or anything over 64 KiB is refused at the boundary rather than
reaching the log and every attached client.

`status` carries **progress**, not reasoning. Executors summarize what they
are doing; raw model thinking never becomes an event.

## Reconnecting

The event log is append-only, keyed by `(session_id, sequence)`, and the
sequence is allocated inside the same transaction as the insert. That makes
the cursor the whole reconnection story:

```
GET /v1/sessions/{id}/events?after=6
```

returns events 7, 8, 9… and then streams. A browser reconnecting on its own
sends `Last-Event-ID` and gets the same treatment. `subscribe()` registers the
listener *before* it reads the backlog and buffers live events until the
backlog drains, so a client reconnecting mid-run cannot fall into the gap
between "what was stored" and "what happens next", and never sees an event
twice.

The local UI streams with `fetch` rather than `EventSource`, because
`EventSource` cannot carry the bearer token and a token in a query string
would be written into browser history and any proxy log.

## Leases and restart recovery

A running session carries a lease: an owner ID and an expiry, renewed by a
heartbeat. This gives two things at once.

A second runtime cannot steal live work — `acquireLease` only succeeds when
the lease is free, already this owner's, or expired.

And a crash is recoverable. On boot, `recover()` finds sessions still marked
`running` or `queued` whose lease has lapsed, puts their in-flight turn back
on the queue, clears the dead owner's lease, and marks the session
`interrupted` — resumable, and honestly labelled in the meantime. A session is
marked `queued` *before* its run starts precisely so a crash in that gap is
still visible to recovery.

If the heartbeat ever fails to renew, the run cancels itself rather than
continuing without the lease it thinks it holds.

## Pause, cancel, and what Atlas will claim

Cancel is abortive: the `AbortSignal` reaches the model request and the child
process (`SIGTERM`, so the coder can still write its audit tail), and the run
stops. **A cancel is authoritative** — an executor that swallows its abort
signal and returns `completed` anyway is still reported as cancelled, because
Atlas does not claim a completion it cannot evidence.

Pause is deliberately not abortive. It suspends the run at its next
`checkpoint()` so a half-written file or a half-finished model call is never
the resume point. Until the run actually reaches a checkpoint, the status
stays `running` and the event says "pause requested" — it does not report a
pause that has not happened.

## Budgets

Five dimensions — input tokens, output tokens, tool calls, elapsed
milliseconds, cost — enforced per session and **persisted on the session
row**. A run interrupted at 90% of its token budget resumes with 10% left, not
a fresh allowance. An increment that would cross a limit is refused whole,
because a partially charged budget would let a caller exceed a limit by
retrying the same call in smaller pieces.

## Executors

An executor is anything with this shape:

```js
run({ session, turn, history, emit, budget, signal, checkpoint })
  -> { status, summary }
```

**`local`** (default) runs the coder against an isolated Git worktree. The
operator's checkout is never modified; work comes back as a portable patch
whose path is recorded as an `artifact` receipt. The receipt names where the
patch is — never its contents.

**`github-actions`** is registered only when `ATLAS_GITHUB_TOKEN` and
`ATLAS_GITHUB_REPOSITORY` are set. Absent those, it is not installed at all,
and every acceptance test still passes. Asked to run without configuration, it
fails closed with a message that says so rather than looking like a transient
error worth waiting out. Its client can dispatch one workflow and read that
workflow's runs — it cannot mint tokens, change secrets, or touch repository
settings, because the coding agent must never hold a credential that can widen
its own access.

## Audit

Every event is persisted, then audited, then fanned out — in that order. An
event that cannot be written or audited never reaches a client, because a
client that saw it would believe an action is on the record when it is not. A
failing audit sink fails the run.

## HTTP surface

| Method | Path | Who |
| --- | --- | --- |
| `GET` | `/v1/executors` | owner or paired device |
| `GET` | `/v1/sessions` | owner or paired device |
| `POST` | `/v1/sessions` | owner only |
| `GET` | `/v1/sessions/{id}` | owner or paired device |
| `GET` | `/v1/sessions/{id}/events?after=N` | owner or paired device |
| `POST` | `/v1/sessions/{id}/turns` | owner only |
| `POST` | `/v1/sessions/{id}/control` | owner only |

`control` takes `pause`, `resume`, `cancel`, or `retry`. A paired phone can
watch a session and answer approvals; it cannot create or steer work. That is
the same split the control plane already draws for tasks.

When no runtime is attached to the server, session routes answer `503` rather
than pretending the feature is missing.

## Tests

### Credential and approval boundary

Platform tools adapted from the agent registry resolve only their declared
vault references, after capability policy and approval succeed. Values enter
the trusted adapter transiently, never its model definition. The adapter's
output and errors are scrubbed using the resolved values before returning to
the executor; structured results retain their shape. The executor also
redacts credential fields, cookies, known host secrets and secret patterns
before durable tool records and model-visible results. Plaintext credentials
in tool arguments are refused. This protects the tool boundary, not arbitrary
artifact contents or every independent logging subsystem.

Artifact verification evidence is also scrubbed before persistence, including
sensitive fields and credential-bearing error codes. Trusted verifiers can
supply `knownSecrets` for exact-value redaction; submitted artifact contents
remain a separate ingestion boundary.

Approvals bind tenant, task, principal, agent, tool, arguments and trusted
runtime context. A runtime can supply repository, revision and context version
through `approvalContext`; callers and model arguments cannot substitute them.
Without that wiring those optional fields are null. Expiration and single-use
consumption are checked atomically in SQLite and authorization is checked again
after asynchronous credential lookup. Cancellation, expiry and timeout during
lookup prevent a late external action. Existing persisted approvals can resume
after restart with the same binding; changed context requires new approval.

Upgrade behavior is deliberately conservative: old action receipts lack the
new context binding. Their presence returns `LEGACY_ACTION_RECEIPT` rather than
silently repeating a mutation. Review the prior outcome and create a new action
when appropriate. Pending approvals using the older digest require reapproval.

The existing encrypted vault remains the storage boundary. Connection metadata,
account/scope health, credential leases and approval modes belong to the
credential broker workstream; these changes do not create a second vault or
claim that every existing adapter uses broker leases. Next integration work is
to bind authenticated actions to broker connection/account metadata, extend
redaction to artifact ingestion, and wire durable authorization checkpoints to
the existing paired-device approval routes. OAuth refresh, identity-field
disclosure, mobile push and autonomous signup remain separate implementation
steps with mandatory MFA, consent and payment checkpoints.

`approval-boundary.test.mjs` and `credential-boundary.test.mjs` exercise real
SQLite persistence, concurrent consumption, restart, expired authorization,
capability denial, delayed vault resolution and an authenticated loopback HTTP
service. The HTTP test verifies that a bearer reaches the service only after
approval and cannot be echoed into model-visible or durable results.

`apps/local-control/tests/agent-runtime.test.mjs`,
`agent-http.test.mjs`, and `agent-worktree.test.mjs` — 31 tests covering
success, timeout, cancellation, denial, retry, restart recovery, lease
contention, budget exhaustion, reconnect-without-gaps, audit failure, and a
real Git worktree run that leaves the operator's checkout clean.

Run them with:

```
cd apps/local-control && npm test
```
