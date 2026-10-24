# Recurring local business review preparation

The local owner can explicitly configure an automation with action kind
`business-review`. Nothing is scheduled by creating a business or assigning a
responsibility. Existing authentication, owner-only automation configuration,
pause/resume, run history, daily caps and interrupted-start recovery apply.

In the local console, open **Automations → New automation** and choose
**Does: Prepare a business review when it is due**. The form lists your
businesses and their active responsibilities (from `/v1/businesses`), takes
the repository folder and model, and asks for all five limits in plain units
(time in minutes, spend in US dollars). It checks them the way the daemon
does before sending, and submits exactly the body below. The **Businesses**
page (`/businesses`) is linked from the console's navigation.

Or POST `/v1/automations` with the owner token, using existing business and
responsibility IDs and an existing repository/model:

```json
{
  "name": "Prepare inquiry workflow review",
  "trigger": { "kind": "schedule", "cron": "0 9 * * *" },
  "maxRunsPerDay": 1,
  "action": {
    "kind": "business-review",
    "businessId": "YOUR-BUSINESS-ID",
    "responsibilityId": "YOUR-RESPONSIBILITY-ID",
    "repository": "C:/work/business",
    "model": "YOUR-CONFIGURED-MODEL",
    "budget": {
      "inputTokens": 100000,
      "outputTokens": 20000,
      "toolCalls": 40,
      "elapsedMs": 600000,
      "costMicroUsd": 100000
    }
  }
}
```

Use real lowercase IDs in place of the placeholders. All five budget dimensions
must be explicit non-negative safe integers; action fields are strictly checked.
The schedule uses the existing daemon-local five-field cron interpretation.
An enabled schedule dispatches only when that responsibility is due. A normal
mission produces a reviewable preparation report with the objective and success
criteria; each child carries business, responsibility and exact due-cycle scope.
Trigger payloads cannot change those instructions or execution limits.

The exact `(businessId, responsibilityId, nextReviewAt)` tuple has one durable
admission, shared across automation IDs, manual runs, schedule slots and daemon
restarts. Its cycle claim and cumulative execution reservation commit in the
same immediate SQLite transaction, before the mission can start. The service
rechecks the current cycle under that lock to avoid dispatching an obsolete
cycle after another connection records owner review. Duplicate known starts
become skipped automation history entries. Missing or unacknowledged mission
starts fail closed, keep their allowance reserved and require inspection; they
are never automatically replayed. Existing automation recovery also pauses any
start whose mission acknowledgement was lost on process restart.

Mission completion does not advance the due date or mark the responsibility
successful. The owner inspects the report and uses the existing review endpoint
to record a completed business mission and advance the next review date. That
existing endpoint accepts a completed evidence-bearing mission for the same
business; it does not independently evaluate KPIs or require exact responsibility
scope. This milestone does not change that review acceptance policy. Failed
preparation can be inspected/retried using existing mission controls; it does
not acquire another cycle allowance.

Reservations remain held for life across success, failure, cancellation and
retry, as described in [BUSINESS-BUDGETS.md](BUSINESS-BUDGETS.md). Old businesses
with unknown historical allowance remain blocked. Preparation creates no live
hosting/CRM/outreach operation, purchases, credentials or business outcome
receipts. It uses the existing isolated coder and artifact verification, not a
new operational executor. One automation service owns its store per daemon;
durable cycle admission additionally handles competing business connections.
