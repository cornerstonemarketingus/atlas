# Chat model recovery: Intelligence Layer execution targets

This extends the existing `apps/web/app/api/chat/model-endpoint.mjs` and
`agent-loop.mjs` behavior audited on `main` at `91820a6`. It does not replace
the existing retry handler with a provider SDK or create another agent loop.
It is an independently reviewable follow-up to capability-evidence PR #111.

## Behavior

The existing primary endpoint, Groq key lookup, default `openai/gpt-oss-20b`
fallback, explicit fallback name and `ATLAS_CHAT_FALLBACK_MODEL=none` remain.
`none` disables the legacy sibling fallback; separately configured recovery
targets remain governed by their explicit policy settings.

For each model step, the target selector filters configured targets by
permission, locality, declared tools/vision/context/output capability, credential
availability and estimated recovery cost. It applies the configured order or
local/reliability preference. Execution skips active cooldowns and sends the
same messages, tool schemas and call/result pairs to the next permitted target.
Completed tools are not rerun. Older tool-result compaction remains in place.

- A short 429 request/unknown/concurrency limit can wait and retry once.
- Numeric and HTTP-date `Retry-After` are honored. Groq token/request reset
  durations support `ms`, `s`, `m`, `h`, `d` and compound values. When multiple
  exhausted dimensions are identified, the latest required reset wins.
- Token limits and daily quotas move to alternatives without an immediate
  identical-context retry. Unknown daily reset gets a temporary 24-hour circuit.
- A model-specific limit skips that model; an explicitly provider-wide limit
  skips sibling models on the same provider/origin. Unknown scope stays model
  scoped: Atlas does not pretend a generic 429 establishes provider-wide quota.
- Network failures and HTTP 500/502/503/504 try the next permitted target.
  Authentication errors remain terminal. A 400/422 with tools lets other
  targets try before the existing retry without tools.
- No model switch happens after a successful response has begun streaming.
- At most eight configured execution targets, two attempts per target, sixteen
  sends, eight seconds of cumulative waiting and a 90-second recovery envelope
  per model step. Each fetch still has at most the existing 60-second timeout.
  Cancellation prevents subsequent sends. Redirects are rejected.

The selector is the chat integration point for the Intelligence Router, not a
claim that the full benchmark-driven registry router is already connected.
`BEST_AVAILABLE` currently uses operator-declared reliability. Unknown capability
data is not empirical evidence. Primary and legacy sibling preserve their
existing compatibility behavior; new tool/vision targets must declare support.

## Configuration

`ATLAS_CHAT_TARGETS` is an optional JSON array of up to six **additional**
operator-configured targets. It is never accepted from a chat request/model.
Each target must explicitly set `policyAllowed: true` to be used. Keys are
referenced through a dedicated environment variable; neither the primary key
nor `GROQ_API_KEY` is inherited by alternate targets.

Example (replace the illustrative provider and model with actual configured
services; the zero prices assert that the operator has verified free access):

```json
[
  {
    "id": "free-provider",
    "provider": "configured-provider",
    "baseUrl": "https://models.example.com/v1",
    "model": "configured-free-model",
    "apiKeyEnv": "ALTERNATE_MODEL_KEY",
    "policyAllowed": true,
    "capabilities": {
      "toolCalls": true,
      "vision": false,
      "contextTokens": 32768,
      "maxOutputTokens": 4096
    },
    "cost": {
      "inputMicroUsdPerMillion": 0,
      "outputMicroUsdPerMillion": 0
    }
  },
  {
    "id": "local-coder",
    "provider": "ollama",
    "baseUrl": "http://127.0.0.1:11434/v1",
    "model": "configured-local-model",
    "policyAllowed": true,
    "capabilities": {
      "toolCalls": true,
      "contextTokens": 32768,
      "maxOutputTokens": 4096
    }
  }
]
```

Loopback refers to **the machine running this chat server**. A hosted Cloudflare
Worker cannot reach the user's laptop through `127.0.0.1`. This change does not
introduce a paired-device model proxy. Local inference works when the configured
endpoint is reachable from the runtime executing chat. Non-loopback endpoints
must use HTTPS. URL credentials, queries and fragments are rejected.

| Setting | Meaning |
| --- | --- |
| `ATLAS_CHAT_TARGET_ORDER` | Optional JSON array naming every target exactly once, e.g. `["primary","fallback","free-provider","local-coder"]`. Omit `fallback` when none exists. Default preserves primary, sibling fallback, then configured array order. |
| `ATLAS_CHAT_ROUTING_POLICY` | `BALANCED` (default: configured order), `LOCAL_ONLY` (hard locality filter), `PREFER_LOCAL` (local first), or `BEST_AVAILABLE` (declared reliability descending). Every policy retains permission/cost/capability checks. |
| `ATLAS_CHAT_ALLOW_PAID_RECOVERY` | Must equal `true` before any additional target with a positive estimated cost is attempted. |
| `ATLAS_CHAT_RECOVERY_BUDGET_MICRO_USD` | Nonnegative integer budget for estimated additional-target spend across the entire HTTP turn, including team calls and retries. Default zero. |

New remote targets with unknown prices or missing referenced credentials are
ineligible. Local targets default to zero inference cost; explicit costs can
override that. Costs use **micro-USD per million tokens**, consistent with the
platform registry. Positive-cost sends synchronously reserve their estimate
before execution; concurrent team calls share the turn's reservation ledger.
The estimate is emitted before a paid attempt. Reservations are conservative
and are not refunded after failures. Estimates use characters/4 for input and
the requested output cap, so this is not a provider billing guarantee.

Primary and the legacy same-endpoint fallback retain existing operator
authorization; the new recovery budget is not a replacement for their existing
billing/budget policy. No new provider is discovered, enabled, or charged merely
because a request returns 429.

Optional target fields: `reliability` (0–1), `rateLimitScope` (`model` or
`provider`). `local`, if supplied, must agree with endpoint locality. Inline
`apiKey` is rejected. Invalid configuration returns a generic setup error without
echoing the configuration or credentials.

## Evidence and cooldown scope

`model-recovery.mjs` records allowlisted structured events: target/provider/model,
timestamp, HTTP status, parsed retry/request/token reset milliseconds, remaining
requests/tokens, category/scope, attempt count, turn/task identifiers when supplied,
input/output token estimates and cooldown deadline. It never reads error bodies
or logs prompts, endpoint URLs, credentials, or raw exceptions. Lead chat emits
`model_recovery` SSE events; planner/child calls share the same bounded state.

Supported category hints: `x-ratelimit-category` values `rpm`, `rpd`, `tpm`,
`tpd`, `input_tokens`, `output_tokens`, `concurrency`, `capacity`.
`x-ratelimit-scope: provider` is an explicit scope hint. Generic exhausted
token/request headers produce `tokens`/`requests`, not an invented minute/day
classification. Optional `x-ratelimit-remaining-{requests,tokens}-day` and
`x-ratelimit-reset-{requests,tokens}-day` identify daily quotas. Unsupported
provider formats remain unknown. Without authoritative timing, bounded
exponential jitter starts at 0.5–1 second and caps at 4–8 seconds.

Warm-worker caches are isolated by authenticated tenant and user, capped at
128 scopes, with 128 cooldowns and 128 telemetry events per scope. The lead,
planner, reviewers and child agents share cooldowns. If tenant resolution fails,
state is isolated to that request. Cold starts/worker migration forget state:
distributed quota coordination and durable replay are future work. Never use
this temporary cache as an authorization source.

When every eligible target is unavailable or the bounded recovery budget is
exhausted, Atlas retains its existing partial-work response behavior. This
change does not add durable paused-turn checkpoints or automatic delayed wakeups.

## Verification

Existing endpoint, loop, compaction and team tests remain. New tests exercise
multi-provider recovery, key isolation, preserved tool evidence, cooldown expiry
and provider scope, token/daily handling, numeric/date/compound resets, backoff,
policy/capability/cost filtering, paid reservations, cancellation, bounded scoped
telemetry and refusal to replay partial streams. All use scripted responses;
no live or paid model inference is required.

Validation on Windows/Node v24.14.0: all 240 web tests pass, ESLint passes,
and the production build succeeds. The existing workflow-dispatch regex test
requires the two workflow fixture files to use their Git-stored LF endings
(Windows autocrlf otherwise causes an unrelated failure). No workflow or test
assertion was changed. Standalone `tsc --noEmit` reports existing errors in
unchanged Genesis/setup routes and missing Cloudflare worker types; it reports
no errors in the modified chat files.
