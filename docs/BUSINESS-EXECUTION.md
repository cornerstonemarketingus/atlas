# Business execution foundation

The local daemon now stores multiple businesses and persistent responsibilities,
and prepares construction-business launches through the existing durable mission
runtime. Open `/businesses` on the local daemon to create businesses, assign
responsibilities, inspect due reviews, preview plans and start preparation
missions. This is a local foundation, not a hosted UI or a live business operator.

All endpoints require the existing local authentication. Only the local owner
can write; paired devices can inspect records, due reviews and plans.

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/businesses` | Create `{name, objective, budget?}` |
| `GET /v1/businesses` | List businesses |
| `GET /v1/businesses/:id` | Inspect business and responsibilities |
| `POST /v1/businesses/:id/responsibilities` | Assign `{owner, objective, successCriteria, intervalMs}` |
| `GET /v1/businesses/due` | List responsibilities awaiting review |
| `GET /v1/businesses/:id/plan` | Preview construction launch preparation without execution |
| `POST /v1/businesses/:id/launch` | Start preparation with `{repository, model}` |
| `POST /v1/businesses/:id/responsibilities/:rid/review` | Record review evidence with `{missionId}` |

The launch plan creates five dependency-aware children: website, hosting
preparation, CRM preparation, lead-generation preparation and review. Each child
gets one fifth of the business execution budget and must return nonempty patch
evidence before dependents can run. Dependency results include artifact handoffs;
agents must inspect them because isolated worktrees do not automatically merge.
Budgets apply per launch, not cumulatively across all business missions.

Use `?template=self-improvement` on the plan preview or add
`"template":"self-improvement"` to the launch body to prepare controlled Atlas
improvements. This audits three coding weaknesses, implements each in its own
isolated worktree and creates a review packet. It cannot merge or deploy on its
own. All five stages require artifact evidence; a test report still needs review.

Responsibilities and due dates survive daemon restarts and mission completion.
An owner label records accountability; it does not grant an agent permissions.
Review requires a completed mission scoped to the same business with child
evidence. Recording a review does not establish that every business KPI passed.
Due responsibilities are surfaced for supervision; no background dispatcher
automatically runs them yet.

Current execution uses isolated coding worktrees. Completion means reviewable
preparation artifacts exist, not that hosting is live, CRM delivery succeeded or
outreach was sent. Evidence checks validate executor artifact metadata, not test
results or business performance. Existing tool approvals remain authoritative;
plan instructions are not an authorization boundary for future executors.

Next integration work: connect conversation intake and a business UI, route
operational steps through the authorized tool executor, verify receipts and live
health checks, enforce cumulative business spending, dispatch recurring reviews
with leases and deduplication, and connect improvement proposals to protected
repository review and deployment policies.
