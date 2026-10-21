# Workforce execution milestone

The local daemon now connects persistent agent ownership, delegated tasks,
capability routing, authorized execution, deterministic quality review,
provenance-carrying memory, and restart recovery through `WorkforceCoordinator`.

This is an explicit-plan execution milestone. Automatic objective decomposition,
general coding/deployment execution, hosted inference pricing and credential
adapters, and model-based semantic review remain separate work. Schema checks
verify output shape and correspondence to successful tool records; they do not
establish the truth of every claim in generated text. Memory retains these
outputs as observations.

## Run locally

Start the existing local-control daemon. Set `ATLAS_WORKFORCE_REPOSITORY` to the
repository it may inspect (defaults to the daemon's working directory).
`ATLAS_WORKFORCE_MODEL` selects the configured model (default
`qwen2.5-coder:7b`); `ATLAS_MODEL_ENDPOINT` selects its endpoint. Repository
inspection does not require a running model server. The `model.respond` tool
supports bounded local inference and requires explicit input/output token
budgets. Hosted profiles can be represented by the router, but hosted inference
is refused by this initial adapter because pricing and credentials are not yet
configured here.

All workforce routes require the local owner's bearer token. Paired devices
cannot create or inspect workforce plans. Get `/v1/workforce` for stable agent
IDs, registered tools, and the confined repository root.

Open `/workforce` from the local console to inspect the persistent agents,
review an explicit JSON plan, start it, and inspect saved runs. The tab keeps
the owner token only in memory and clears it on lock/navigation. The supplied
example reads `README.md`; it does not automatically run a model or start work.
Use Refresh runs after an uncertain intake response before considering another
submission. The console never automatically resumes interrupted work.

`GET /v1/workforce/runs?limit=50` lists persisted summaries in creation order,
newest first, scoped to the local tenant and bounded to 100 rows. Summaries omit
tool input and model prompts. The existing detail endpoint remains available
to the authenticated owner. The overview retains its stable name-to-ID `agents`
map and adds an `agentDetails` array for display.

Select an interrupted run to resume explicitly, or cancel unfinished work.
Follow the task ID to the existing Task evidence console for artifacts and
policy records. A completed run means the existing deterministic schema and
tool-record checks passed; no semantic business outcome is inferred.

Post this body to `/v1/workforce/runs`, substituting IDs from the overview:

```json
{
  "ownerAgentId": "<rootId>",
  "reviewerAgentId": "<Quality Reviewer ID>",
  "objective": "Inspect the README and preserve reviewed evidence.",
  "constraints": { "privacy": "local_only" },
  "budget": { "toolCalls": 4, "wallTimeMs": 30000 },
  "steps": [
    {
      "agentId": "<Engineering Worker ID>",
      "calls": [
        {
          "tool": "repository.read",
          "input": { "path": "README.md", "lineCount": 20 },
          "outputSchema": { "type": "string", "minLength": 1 }
        }
      ]
    }
  ]
}
```

Intake returns HTTP 202 with `taskId`. Poll `/v1/workforce/runs/<taskId>`.
The existing `/platform` dashboard and `/v1/platform/tasks/<taskId>` show task
transitions, tool policy decisions, budgets, artifacts, review evidence, and
correlated events. Each step has its own task ID in the run snapshot.

## Durability and bounds

- Agents remain durable and are reserved while their workforce run is unfinished.
- Plans allow at most eight sequential assignments and sixteen calls per
  assignment. Tools retain their existing timeouts and path confinement.
- A run's execution budget is divided across assignments, so creating more
  workers does not multiply its allowed consumption. Lifetime agent tool-call
  reservations also survive restart.
- Quality review uses a separate agent, stored artifact digests, output schemas,
  successful tool-call records, and structured evidence. Rejection blocks parent
  completion and memory publication.
- Restart marks unfinished runs interrupted without launching work. Resume
  explicitly with POST `/v1/workforce/runs/<taskId>/resume`.
- Cancel queued or active work with POST `/v1/workforce/runs/<taskId>/cancel`.
  Active tools finish or reach their existing timeout, but their late results
  cannot complete the cancelled run. Correct an interrupted plan by cancelling
  it and submitting a new one.
- Successful tool calls replay from durable idempotency records if interruption
  occurred before artifact persistence. Uncertain in-flight actions are blocked
  by the existing executor instead of blindly repeating them.
- This initial runtime belongs to one local daemon process; distributed worker
  leasing and automatic failover are outside this milestone.

## Acceptance evidence

`workforce.test.mjs` exercises the full delegated execution and review loop,
agent identity reuse, queued restart, interruption between execution and
artifact commit, token usage, secret redaction, ownership isolation, and failed
quality checks. `workforce-http.test.mjs` exercises authenticated HTTP intake
through the daemon server and confirms reviewed artifacts reach the dashboard.
The existing daemon boot tests check production startup wiring.
