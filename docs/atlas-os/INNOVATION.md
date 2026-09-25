# Business Development, Product and the Innovation Backlog

Engineering asks *can we build this?* Business Development asks *should we?*
Product asks *what exactly?* Research asks *is the assumption supported?*
Design asks *how should people experience it?* Engineering builds it, QA
proves it works, Analytics determines whether it mattered — and the cycle
begins again.

Code: `apps/local-control/src/platform/innovation/`. Tests:
`apps/local-control/tests/platform-innovation.test.mjs`.

## Organization

```
Atlas Root
├── Business Development Executive          (business)
│   └── Product Executive
│       ├── Market Research · Competitive Intelligence · Marketing · Sales
│       └── Analytics · Customer Success · Finance / Unit Economics
├── Engineering Parent   (Architecture, Frontend, Backend, Database, Testing, Security, Deployment)
├── Design Parent        (Product Design, UI, UX, Accessibility, Visual QA)
├── Computer Operations  (Browser, Desktop, Terminal, Recovery)
├── Research Parent      (Web Research, Document Analysis, Fact Checking)
└── Reviewer · Guardian · Mentor   (oversight of every organization)
```

Engineering, Design, Computer Operations and Research are **peers** of the
business organization, not its children. The Product Executive commissions
them with `requestCrossFamilyHelp`: the peer receives a scoped subtask
(objective, MVP, acceptance criteria, packet digest) and acts with its own
permissions only. A scope carrying anything that looks like a credential or
permission is refused (`SCOPE_LEAKS_AUTHORITY`).

A parent holds the union of its subtree's permissions (the graph's subset
rule), so the BDE formally holds `opportunity.research`. Independence is
enforced separately: the submitter of a brief can neither research nor
product-review it.

## Pipeline

```
DISCOVERED → RESEARCHING → VALIDATED → PROPOSED → NEEDS_REVIEW → APPROVED
  → BUILDING ⇄ VERIFYING → READY_TO_LAUNCH → LAUNCHED → MEASURING
  → SUCCESSFUL | ITERATE            (REJECTED / ARCHIVED from most states)
```

| Step | Who (permission) | Guard |
|---|---|---|
| Submit Opportunity Brief | `opportunity.propose` (BDE) | All brief fields required; every evidence item cites a source; High confidence needs ≥1 strong item and ≥2 independent sources; competitor evidence requires an originality statement; Opportunity Memory refuses near-duplicates of anything known — including rejected ideas — unless the brief names the closed idea in `supersedes` **and** brings evidence it lacked |
| Research | `opportunity.research`, not the submitter | Unsupported assumptions reject the opportunity and the reason stays in memory |
| Product review → Implementation Proposal | `opportunity.review` (Product Executive), not the submitter | MVP, out-of-scope, acceptance criteria, dependencies, affected systems, plan, which peers to commission |
| Council | seated members with `opportunity.council` | Medium/Large/Major effort seats Business Development, Product, Research, Architecture, Design, Security, Finance, Customer Advocate, Engineering; Small seats Security only when a security risk is named. Requests/results are typed `REVIEW_REQUEST`/`REVIEW_RESULT` messages. Vacant seats are reported |
| Decision Packet | Product Executive | Refused until every seat has reviewed. Dissent is listed (`supporting`, `concerned`, `opposing`, `openConditions`), consensus is `unanimous_support`, `support_with_concerns`, `contested` or `no_council` — never averaged. SHA-256 digest of the canonical packet |
| Approve Build / Modify / Reject | **a human** | Bound to the packet digest; agents are refused (`AGENT_CANNOT_APPROVE`). Surfaces as an `innovation.build` entry in the approvals inbox, so a paired phone can decide. Modify reopens a new council round; Reject requires a reason kept in memory. Policy may auto-approve only efforts listed in `autoApproveEfforts` (empty by default), and never with security/legal/financial risk or any dissent |
| Commission | `innovation.commission` | Only against the currently approved digest. Creates one canonical platform task (authorized by the approver, success criteria = acceptance criteria, same correlation id) and one cross-family subtask per peer |
| Verify | `terminal.run_tests`, `visual.inspect` or `security.scan` | Passing needs evidence beyond a build log; failures return to BUILDING until `maxRepairAttempts`, then ITERATE for a person |
| Launch | **a human** | Bound to the approved packet digest |
| Measure / conclude | `opportunity.measure` | Only the brief's own success metrics; conclusion requires lessons, which Opportunity Memory returns with future similar ideas |

## HTTP (local daemon, after authentication)

| Route | Access |
|---|---|
| `GET /innovation` | Backlog page (no data without a token) |
| `GET /v1/innovation/backlog?state=` · `/opportunities/:id` · `/memory?q=` · `/organization` | Any authenticated caller |
| `POST /v1/innovation/opportunities/:id/decision` · `/launch` | Owner or paired device; recorded as that human |
| `POST /v1/innovation/opportunities` and `/:id/{research-request,research,product-review,council,council-reviews,packet,commission,verification,measurements,conclusion,lessons,archive}` · `POST /v1/innovation/signals` | Owner token (acting for the named agent) |

Failures return `{ code, message, blocked, unblock }`, where `blocked` is one
of `BLOCKED_BY_PERMISSION`, `BLOCKED_BY_POLICY`, `BLOCKED_BY_DEPENDENCY`,
`BLOCKED_BY_CAPABILITY`, and `unblock` is the minimum action that clears it.

## Not yet

Agents do not yet run on their own: each step above is an API a model-backed
agent worker will call (IMPLEMENTATION-PLAN step 1.1). Commissioned
Engineering work is not yet executed by the verified coder loop (step 2.1).
