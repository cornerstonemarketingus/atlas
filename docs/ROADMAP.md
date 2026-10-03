# Atlas product roadmap (owner-set build sequence)

Set by the owner on 2026-09-28. This is the order of the next major
development cycle. [`PROGRAM.md`](PROGRAM.md) still governs *how* work is
done (merge policy, protected paths, testing rules, the never-list);
this file governs *what comes next*. Each stage ships as vertical slices:
wired, reachable from the UI or API, tested at its real boundary.

Status is from the audit of 2026-09-28 (code read, not claims in TODO.md).
"Built, not wired" means tested modules the daemon never imports; wiring
them is the cheapest progress available.

## Sequence

| # | Stage | Exists today | First slice |
|---|---|---|---|
| 1 | **Parallel Agent Command Center** | Missions run parallel coder lanes with a live event stream and mission-level pause/resume/cancel (`agent/mission-*`, Missions view); team missions (`agent/team`). Built, not wired: `ChildAgentRegistry`, orchestrator `TaskDag`/`AgentLoop`. | One view of all running work (missions and their lanes, team missions, Genesis builds, local tasks, self-improve runs) with per-item state, and pause/cancel of a single lane. |
| 2 | **Automate runtime** | Done (#169, #171): schedule, webhook, GitHub-event, file-change and run-now triggers starting normal missions; run history, overlap/daily guards, auto-pause, catch-up, "Automate this?". | Durable trigger store (cron, webhook, manual) that starts a normal mission; run history, pause/resume, idempotency, dead-letter; "Automate this?" after a repeated success. |
| 3 | **Atlas backend primitives** | Done (local): sign-in, file storage, per-app secrets and scheduled jobs are template modules every generated web app and API gets (`templates/shared/src/{auth,files,secrets,jobs,backend}.mjs`); password sign-in needs no model. Hosted variants come with stage 5. | Auth (email/password, sessions), file storage, per-app secrets and scheduled functions as template modules Genesis apps use by default, local first, hosted later. |
| 4 | **Visual Genesis editor** | Previews, Playwright inspection at phone and desktop widths, vision review. No picker. | Design proxy that injects an element picker into the preview (separate origin, postMessage only); DOM element → source file/line mapping; Edit, Ask Atlas, Delete, Move, Restyle routed into Genesis change requests; deterministic restyle for font, spacing and colour; "three versions" as parallel variants (uses stage 1). |
| 5 | **Cloud sandbox** | GitHub Actions coder runs; local container/namespace terminal sandboxes. | Modes Local / Cloud / Hybrid; an isolated Atlas machine with repo, dependencies and scoped secrets that keeps Genesis builds and automations running while the laptop sleeps. |
| 6 | **Take Control** | Companion stops with `HUMAN_REQUIRED` on login/CAPTCHA walls; approvals bound to exact actions. | Watch (live view) → Take control (user drives) → Return to Atlas (agent re-reads state and continues), for the browser worker first, then the desktop. |
| 7 | **Connector/Skill marketplace** | MCP client via `ATLAS_MCP_SERVERS` (wired); skills packaging with signed manifests (built, not wired); MCP gateway and Atlas MCP server (built, not wired). | Wire the skill registry and MCP gateway; a Connections catalogue with one-click install and per-connector policy; publishing an Atlas Skill. |
| 8 | **Organization knowledge graph** | Per-repository import, symbol, package, schema, delivery and surface maps (`atlas-cli`); scoped memory store. | Persist per-repo maps and link them (API → SDK → frontend → deployment → database) so "what breaks if we remove this endpoint?" is answered across repositories. |
| 9 | **Reviewer / Security / QA agents** | PR steward, self-improve reviewer, Genesis inspector and vision review; engineering review scans (built, not wired). | Independent agents (different model or prompt, never the author grading itself) posting CI statuses: Coder → Tests → Reviewer → Security → Browser QA → Merge. |
| 10 | **General artifacts** | None beyond Markdown briefs. | Genesis "create something": report, spreadsheet, presentation, dashboard alongside apps, combinable in one project. |

## The capability loop

Connecting stages 1, 7 and 9 with Genesis and self-improvement:

1. An agent notices it lacks a capability (a tool call that has no tool,
   a repeated manual workflow, a failed task whose cause is "cannot").
2. Genesis builds the capability as a tool or skill package.
3. Reviewer, Security and QA agents test and review it independently.
4. The owner approves installation (approval bound to the package digest).
5. Atlas installs it as a Skill; every future agent can use it.
6. Atlas records how and why it was created (provenance in memory).

Pieces that exist: self-improve loop (isolated worktree → checks → policy →
reviewer → patch), innovation pipeline (discover → council → approval →
build), `WorkerRegistry.capabilityGaps()`, skill proposals, approvals and
signed packages. Missing: runtime gap detection, self-improve producing a
skill package instead of a patch, and loading installed skills into the
tool registry. The loop becomes possible after stage 7's wiring and is
completed with stage 9.

## Relation to PROGRAM.md phases

- Phase 0/1 items waiting on the owner (deploy, chat gate, Phase 1 PR stack
  #129–#133, Groq capacity) stay open and are not blocked by this roadmap.
- Phase 2 (coder quality) is complete on the agent side except the eval
  harness (workstream B) and security/dependency scans, which stage 9 takes.
- This roadmap supersedes the order of PROGRAM.md Phase 3; its safety rules
  (approvals, budgets, sandboxing, no fallback from sandbox to host) apply
  to every stage here.

## Track B: Atlas as an agent operating system (owner-set 2026-09-28)

The product stages above stay. Underneath them runs a second, architectural
track, so that every stage is built on one runtime instead of adding
another kind of agent. The owner's framing: *Atlas is an operating system
for digital labor. Give it a goal; it assembles the intelligence, agents,
software, computers, tools, money, context and interfaces; executes;
verifies; learns the reusable procedure; and keeps working after the human
leaves.*

### Principles

1. **One agent abstraction.** No separate ChatAgent / CoderAgent /
   ComputerAgent / GenesisAgent architectures. An agent is an execution
   process: *Intelligence + Goal + Context + Capabilities + Environment +
   Identity + Budget + Policy + Memory*. Capabilities (`code`, `browser`,
   `computer`, `terminal`, `research`, `database`, `email`, `payments`,
   `deploy`, `design`, `vision`) are mounted per run, so a new harness or
   model is a new capability or intelligence, not a new architecture.
2. **One kernel loop.** Goal → perceive → retrieve context → plan → choose
   capability → act → observe → verify → update world state →
   continue / branch / escalate → finish.
3. **Explicit world state, not chat history.** The kernel reasons over
   typed state (user, machines, repositories, applications, browser
   sessions, files, databases, people, agents, tasks, deployments,
   services, credentials (references only, never values), approvals,
   events, artifacts, organizations); actions are transitions on it.
4. **Collaboration is structural, not voluntary.** The orchestrator, not
   the working agent, decides team composition. Independent work first,
   communication second: solvers do not see each other's answers before
   committing; evidence is sealed; then adversarial critique, then
   synthesis. No majority voting: a judge weighs evidence quality ×
   relevant expertise × independence × historical reliability ×
   calibration, and investigates dissent. Every important task gets a
   Devil's Advocate (assume the answer is wrong), a Missing Perspective
   and an Uncertainty agent. Reputations per domain are derived from
   verified outcomes, never self-reported. *No important conclusion
   depends on a single model's judgment.* Tiers set a minimum cognitive
   quorum (Standard ≥ 3 independent passes, Deep 5–8, Council 10–20+,
   Mission Critical until evidence/verification conditions hold). The
   metric is **cost per verified correct outcome**, not tokens per answer.
5. **Atlas grows by expanding its software body** (the capability loop
   above), not by changing weights.
6. **Safety rules still bind.** Money, autonomy and protocols extend the
   existing approvals, budgets, policies and never-list; they never
   bypass them. Spending is off until the owner sets a budget, and every
   purchase is bounded by it and audited.

### Sequence

| # | Item | Builds on (exists today) | First slice |
|---|---|---|---|
| B1 | **Agent Kernel + World State** | First slice done: `agent/kernel/` (kernel loop, capability mounting with gaps, typed world state with relations and per-run traces, secret-free by construction, `/v1/world`). Team steps run through it; coder lanes run as kernel runs with the atlas-cli coder as their harness; every chat turn is a kernel run (its streaming loop is the act phase) and perceives what earlier turns touched; the Command Center shows each lane's trace ("How it ran"); branching is a kernel decision (`strategy: "auto"`: open-ended work or an objective that already failed here runs as 3 competing versions, mechanical work as one; finished versions are ranked and one is recommended). | B1 done. Later: branch inside a run (not only at launch), and compare versions by tests and review, not only by change size (with stage 9 agents). |
| B2 | **World / Ontology Graph** | atlas-cli repo maps (imports, symbols, packages, schemas, delivery, surfaces), memory store, family graph, automations, deployments | Entities + typed relations (`uses`, `owns`, `calls`, `depends_on`, `deploys_to`, `tests`, `created_by`, `approved_by`, `failed_because`, `replaced_by`, `learned_from`) persisted locally; "what breaks if I change this?" answered across repos and services. Merges with stage 8. |
| B3 | **Agent-internet protocols** | MCP client (wired), Atlas MCP server (not wired) | A2A agent card + task endpoint (serve and call), AG-UI/A2UI event stream for generated interfaces; UCP/AP2/MPP behind the payments capability and owner budgets. |
| B4 | **Capability economics** | model router, difficulty, evaluations, `BudgetLedger`, provider throttle | Candidates are any path to the goal (a model, local model, deterministic code, API, browser action, another Atlas agent, an A2A agent, a human); score ≈ expected success × quality − latency − money − privacy − risk; budgets for compute, API, purchasing, time, risk. |
| B5 | **Teach Atlas (record → skill)** | browser worker, desktop controller, automations, skills packaging | Record semantic actions during a demonstration; propose an automation with trigger, variables, operations, recovery conditions and approval points. |
| B6 | **Persistent computers + task migration** | stage 5 | Local / Atlas Cloud / Customer Cloud / Hybrid; move a running mission between them by serializing state, files, checkpoint, browser intent, pending work and memory references. |
| B7 | **Event subscriptions / sleeping agents** | automations (triggers, GitHub HMAC, idempotency), missions | `wait_for(event)`, `subscribe(source)`, `wake_on(condition)`, `until(goal)`: a mission such as "get this PR merged" sleeps, wakes on CI or review, acts, and finishes when the goal holds. |
| B8 | **Adaptive autonomy engine** | approvals, `local_policies`, command policy, self-improve policy | Risk 0 auto · 1 auto + audit · 2 auto if reversible · 3 ask · 4 strong confirmation · 5 prohibited, from reversibility, money, credential exposure, external communication, production impact, data destruction, confidence and precedent. |
| B9 | **Simulation / competing strategies** | parallel versions (stage 1), isolated worktrees | Shadow runs of alternative strategies, scored on tests, security, performance, compatibility, complexity and cost before the real action. |
| B10 | **Evaluation-driven evolution** | self-improve loop, capability suite, evaluations | Goal-metric experiments ("cut median Genesis cost 20% without lowering success"); propose only changes that beat baseline measurably. |
| B11 | **Independent / adversarial reasoning** | team missions, family agents, reviewer | Principle 4 as the default orchestration for chat, research and review: quorum tiers, sealed independent passes, critic roles, evidence-weighted judge, outcome-derived reputations, "Atlas is thinking with N agents" in the UI. |
| B12 | **Atlas Gateway** | model client, MCP, budgets, audit log | One governed plane for every model call, MCP/A2A request, browser/computer action, API call, purchase and deployment: identity, policy, cost, audit, observability, without restricting providers. |

Also in scope on this track: **browser code mode** (bounded Playwright/CDP
scripts alongside semantic actions), **live observation + takeover** in the
Command Center (thinking, terminal, browser, desktop, files, agents; joins
stage 6), **dynamic interfaces** (Genesis generates a task workspace that
disappears or persists; joins stage 10), and Ollama as a first-class
interchangeable local engine (Groq stays an engine option, never the
architecture).

### How the tracks interleave

Stage 3 (backend primitives) finishes first because it is in progress.
Then B1 (kernel + world state) comes before stage 4: later stages mount on
the kernel instead of adding runtimes. After that the order alternates,
product stage then the Track B item it depends on (stage 5 with B6, stage 6
with live observation, stage 7 with B3/B12, stage 8 with B2, stage 9 with
B11, automations with B7).
