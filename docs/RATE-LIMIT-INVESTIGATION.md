# Atlas rate-limit investigation — 2026-09-27

## Confirmed failures

- Live coder run 36321596752 stopped on its first repository.search call because input validation rejected path. PR #159 fixes recovery; this was not a provider quota failure.
- PR #156 fixes missing short retry behavior for the fallback model. It is not deployed until merged.
- The #129 -> #130 -> #131 -> #132 -> #133 -> #158 stack adds inference contracts, a shared Durable Object quota ledger, circuit breakers, a target registry and chat reservations. It is still unmerged.
- In #158, a known capacity refusal longer than eight seconds withdrew the request and sent it anyway. This branch preserves the refusal and retry time, allowing callModel to use its fallback without hitting the exhausted primary.
- In #158, a streaming call released its reservation when response headers arrived. This branch holds it through completion, cancellation or stream failure.

## What these changes do not establish

No system can manufacture provider quota. Successful short smoke tests do not prove sustained capacity. The old Ollama 7B audit is gone and cannot establish its tool-calling behavior. Current coder variables select hosted Groq, not that local model.

The governor currently has no durable prompt/tool checkpoint and automatic wake/resume loop. An inline wait ending still reaches bounded retry/fallback and eventually a saved-work response. This branch does not claim indefinite execution or automatic resumption after daily limits.

Missing/unreachable governor bindings retain the existing direct-request behavior. Capacity scope defaults to endpoint origin plus key digest; it needs explicit account/organization scope configuration when multiple credentials share an allowance. The coder Actions runner is not yet using the web governor. These gaps mean the present system cannot promise zero 429s.

## Completion path

1. Review and merge ready fixes #156, #157 and #159 through normal GitHub checks. Merge the inference stack in dependency order, retargeting each child only after its parent lands; apply this branch after #158. Do not merge draft alternatives or duplicate smoke PRs blindly.
2. Deploy the Worker including its Durable Object binding/migration. Verify the setup governor readiness and both streaming and non-streaming chat. Repeat the one-file coder diagnostic and retain its audit.
3. Build durable inference jobs: persist request ownership, idempotency key, execution cursor and bounded tool results before waiting. Store retryAt and wake via a Durable Object alarm. Resume the same job without replaying successful side effects. Expose waiting/cancelled/completed states through authenticated polling and SSE reconnect.
4. Route only to configured, permitted targets with sufficient context/output/tool capabilities. Persist cooldowns by actual shared quota scope. Integrate coder reservations with the same quota accounting.
5. Add a supported self-hosted target when independent capacity is needed. Atlas already has the endpoint adapters; the requirement is a reachable, authenticated, benchmarked inference service, not a new model trained from scratch. An always-on host still has finite compute, so queueing and cancellation remain necessary.

## Acceptance evidence still required

Simulate concurrent chats and coder jobs against one quota, long/daily cooldowns, Worker restarts, duplicate submissions, cancelled streams and disconnected clients. Assert no request is sent during a known denial, successful tool effects execute once, jobs resume after capacity returns, secrets/prompts do not enter capacity logs, and all terminal outcomes persist.
