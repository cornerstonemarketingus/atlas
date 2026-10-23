# Bounded cloud outcome observation

Issue #334; stacked on claim reconciliation #312. Audit date: 2026-10-17.

## Repository finding and native integration

Atlas already persisted execution claims, authenticated outcome receipts and manual
Saved requests reconciliation. Missing reporting jobs still required a user to
return and ask for reconciliation. The existing Cloudflare Worker had only fetch
handling; no scheduled outcome observation was wired.

The Worker now exports a scheduled handler and its existing Vite/Wrangler binding
configuration registers a fifteen-minute cron. It reuses the normal D1 binding and
GitHub credentials; no separate scheduler, queue, agent framework or inference
router was added. No browser or personal computer must remain connected once a
user enables automatic status checks for a saved claim.

Cloudflare contracts: [scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)
and [cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
The generated production Wrangler config and actual built scheduled handler are
covered by tests. Live Cloudflare delivery and production deployment are unverified.

## Consent, authorization and phone controls

Saved requests shows the limits before opt-in and provides Enable/Stop automatic
checks. POST `/api/tasks/requests/[requestKey]/observation` accepts only an enabled
boolean, streamed within 256 bytes, and requires authentication, tenant membership,
same-origin/cross-site checks and JSON content type. Run IDs, credentials and quota
overrides are never accepted from callers. Responses are no-store and errors fixed.
Consent and its scope/audit event commit together. Audit failure cannot leave an
enabled watch. Disable is idempotent and does not create a new watch.

Watches bind to the exact saved tenant, principal, request correlation, conversation
and execution claim. Deployment operators and GitHub principals with durable user/
tenant membership are supported. Platform-header principals without durable member
records retain manual reconciliation. Each tick rechecks membership and ownership;
removed members cannot reserve new observations. Disable blocks future reservations;
an already reserved/in-flight metadata check may finish.

## Durable budgets and recovery semantics

Migration 0022 adds scoped watches and an observation reservation ledger:

| Limit | Fixed server policy |
|---|---|
| Schedule | Every 15 minutes |
| Per invocation | At most 2 sequential observations; 55-second network deadline |
| Per claimed task | 8 observations total, including unknown/reserved failures |
| Per tenant | 8 reservations per UTC day across principals |
| Global | 48 reservations per UTC day across tenants |
| Consent lifetime | 24 hours from first enable; toggles never extend it |
| Enabled, unexpired watch capacity | 32 per tenant; 256 globally |

A single SQLite INSERT condition rechecks every quota and identity before reserving;
its audit event shares the D1 transaction. Competing ticks cannot overrun the budget.
The `(task_id, slot)` primary key deduplicates repeated cron delivery. A reservation
is consumed before credential access; crashes, failures and uncertain acknowledgements
are not refunded or replayed within the slot. Next scheduled observation uses a
new slot only while consent and all budgets remain valid. The ledger's delete
trigger prevents accidental reservation refunds. There is no compute lease takeover.

Each reservation permits only an optional GitHub App token request and two exact
attempt/job metadata reads. App tokens request Actions read; existing dispatch token
requests retain Actions write. All token requests now refuse redirects and have a
ten-second timeout. Scheduled network requests also share a 55-second deadline.
With no active eligible opt-in, no GitHub credential or metadata request occurs.
Resource quotas bound checks, not dollar-denominated Cloudflare invoices; the cron
still uses Worker/D1 resources for its scheduled candidate query.

The observer calls existing exact-claim reconciliation and immutable receipt/audit
persistence. It cannot dispatch, bill task usage, execute code, cancel, renew or
release a claim, or authorize an execution retry. It creates no synthetic agent
summary. Terminal receipts suppress further checks; delayed real reporting remains
compatible. Reserved-but-unfinished slots remain uncertain and counted after crashes.

## Rollout, ownership and validation

Apply migration 0022 after the prior claim/receipt migrations, before this Worker.
0021 is reserved by cloud-missions PR #291; integrate the shared journal in merge
order. Tables are additive. No watch is enabled by migration or deploy. Missing
storage fails closed with fixed responses/logging. No new runtime secret is needed.
No migration, production deployment or live observation was performed here.

Narrow stale overlaps were documented under PROGRAM section 4 on #130/#77 (Worker),
#233 (Vite config) and #101 (token helper); each had no commits for over 48 hours.
Inference bindings, fetch/security headers, Genesis behavior, active mission work
and the dirty root checkout were preserved. Shared PROGRESS remains untouched;
this document and #334 carry the focused handoff. Owner review is required.

Executed: production build, lint, corrected typecheck, committed diff checks and
**531/531 web tests** passed. Seventeen focused observer/credential tests include
real migrated SQLite, real signed user sessions and the built HTTP -> scheduled
handler -> immutable receipt -> authenticated refreshed-request path with mocked
GitHub. They cover no opt-in, disable, expiry/toggle, revoked/foreign membership,
quota overrides, duplicate/crashed slots, uncertain failures, audit rollback,
concurrent budget contention, tick/deadline/capacity limits and absence of coding,
billing or fabricated messages. Six quota/membership/deadline/capacity guard
mutations produced assertion failures and were restored before the full suite.
GitHub CI results are recorded on the PR and claim issue.

## Remaining boundaries and next work

Physical mobile interaction and real cloud cron delivery remain unverified. This
observer is not an autonomous coding queue, execution lease renewal, recovery
approval system, billing ledger or proof of software correctness. Missing or
ambiguous GitHub evidence stays unconfirmed. There is no provider Retry-After
cooldown or per-user observer-health dashboard yet; failed checks consume their
fixed budgets. Watch/ledger retention and operational dollar ceilings are not
implemented by this slice.

Next: provider-aware observation cooldown and health reporting, then explicitly
reviewed recovery approvals that account for external side effects. Never restart
coding merely because a claim expired or a GitHub job failed/cancelled.
