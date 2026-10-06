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

`apps/local-control/tests/agent-runtime.test.mjs`,
`agent-http.test.mjs`, and `agent-worktree.test.mjs` — 31 tests covering
success, timeout, cancellation, denial, retry, restart recovery, lease
contention, budget exhaustion, reconnect-without-gaps, audit failure, and a
real Git worktree run that leaves the operator's checkout clean.

Run them with:

```
cd apps/local-control && npm test
```

## Free Local AI guided setup

Open **Models → Free Local AI → Set up free AI** in the local Atlas console.
Choose Recommended, Faster, or Higher quality. Atlas checks hardware and disk,
starts or installs the runtime, downloads a model, checks available memory,
loads its configured context, creates a credential in the existing OS vault,
and verifies streaming and agent capabilities through the authenticated gateway.
It also runs Atlas's production coding loop against a disposable repository
and checks that the requested repair actually happened; an exit code alone
does not qualify a model. Probe code never executes model-authored JavaScript
inside the daemon.
The selected local model is applied only after verification. Failed downloads,
insufficient RAM, empty responses and failed tool-call probes remain failures.
The advanced model catalog retains Install, Remove and Run controls.

No per-message AI provider charges apply to local inference. Electricity and
hardware have costs. This initial local setup has **cloud fallback off**; an
owner can explicitly enable the configured fallback after a charge notice.
Existing configured routing continues
when no Free Local AI plan is applied. The local-only preference overrides the
conversation/team client, identifies the actual local model in the audit, and
fails promptly if the runtime is unreachable. Requests beyond the served
context are refused rather than silently truncated. The existing coding
executor receives the selected model, context and authenticated gateway;
its key goes only through the allowlisted child environment, never command
arguments or test-script environments. Coding runs require a measured repair
capability and remain local-only. This does not wire the runner to the hosted
Durable Object governor.

### Ownership and extension points

`agent/models/free-local.mjs` orchestrates the existing `ModelManager`,
`ModelPlanStore`, hardware catalog, credential vault, capability registry and
streaming model client. It is not another provider router. Runtime adapters
used by the setup expose `status`, `reachable`, `ensureServer`, `installRuntime`,
`install`, `warm` and `remove`; Ollama is the current implementation. Another
OpenAI-compatible runtime can implement those operations and inject its gateway
factory without changing the onboarding UI. Native inference, MLX, llama.cpp,
vLLM and LM Studio are extension targets, not shipped installers.

The catalog is the only source of recommendation model names. Estimates include
weights, quantization assumptions and context-dependent KV cache. Qwen3 small
entries use published Q4_K_M download sizes; the default CPU recommendation
keeps a smaller context and reserves at least 3 GiB of total system RAM for
other applications. Installation requires known free disk space with staging
headroom. Actual free RAM is checked again before loading; installed models
are not evidence that a model fits. Recommendations and relative quality/speed
scores are estimates, not a guarantee of agent reliability. Setup measures
tool formatting, JSON output, an actual coding repair and recall at approximately 1,024 tokens; that
short recall probe does not verify the whole configured context window.

### Security and connectivity

The gateway binds to loopback, compares a 256-bit random bearer credential in
constant time, restricts model names and upstreams, refuses redirects and never
exposes Ollama pull/delete/create endpoints. Credentials stay in the current
user's DPAPI/Keychain/keyring vault, not the model plan, API status or logs.
Request size, output size, generation time, concurrency and queue waits are
bounded. Authenticated `/v1/health` checks model availability in 1.5 seconds;
it is not proof that a future large generation will fit in memory.

**Connect hosted Atlas** checks Tailscale authentication and enables Funnel only
for the authenticated inference gateway. It refuses to replace an existing
private Serve listener, derives the HTTPS hostname from the client, and tests
authenticated HTTPS with redirects disabled. The private device-pairing
transport in `remote/access.mjs` remains private. Funnel installation/sign-in
and policy authorization are human boundaries. A verified public gateway is
not a registered hosted provider: the UI distinguishes those states.

Hosted per-user registration and revocation are still
required before this is a complete hosted onboarding feature. The current
Worker uses deployment-scoped model credentials. Do not publish another user's
gateway as a deployment-wide default or share one user's vault with another.
Until that registration exists, advanced single-owner deployment setup is in
`HOSTED-VERIFICATION.md`. Local fallback defaults off. Enabling it uses the
existing configured router only before a response starts; authentication,
invalid input, cancellation and mid-stream failures do not trigger fallback.
Status events and the audit identify the actual serving model and warn when
cloud provider charges may apply. No automatic difficult-task paid escalation
is implemented by this setup.

### Startup and troubleshooting

On Windows, **Start automatically on Windows** registers a limited task for
the current user at sign-in. It stores no password, ignores duplicate instances
and launches the existing Atlas supervisor with crash backoff and rotating logs. Task Scheduler also retries a failed supervisor up to three times. Windows installer payloads include the compiled coding CLI, shared contracts and inference package, without requiring development dependencies. The plan is restored and
reverified on daemon startup. It does not run before Windows sign-in. Other
platforms currently use their normal user service manager; installers for them
are not implemented. **Disable automatic startup** removes only this task.
Older plans without the current measured coding-repair capability require
setup again rather than silently restoring a model that only passed tool formatting.

- Computer/runtime offline: retry after starting the computer or runtime. No
  cloud call is made for an applied local-only plan.
- Low memory: close other applications or choose Faster. Avoid treating swap
  success as a comfortable memory fit.
- Failed agent test: choose another model. A vendor's declared tool support
  does not establish that Atlas's tool loop works reliably.
- Context too large: shorten the conversation or use a larger context/model.
  A small local model need not replace every Atlas workflow.
- Secure helper needs sign-in/authorization: follow the exact action shown,
  then retry Connect hosted Atlas. Never forward Ollama port 11434.

Developer verification: `node scripts/local/verify-free-local.mjs <model> --coder` uses
real Ollama, a temporary authenticated gateway and the production Atlas client.
It prints metadata and pass/fail probes, never credentials or model reasoning.
`node scripts/local/dogfood-free-local.mjs --setup` invokes the actual local
setup API using the owner's OS vault without printing its token.
