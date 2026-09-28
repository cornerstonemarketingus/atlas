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
| 2 | **Automate runtime** | Only GitHub Actions cron for Atlas itself. No user triggers. | Durable trigger store (cron, webhook, manual) that starts a normal mission; run history, pause/resume, idempotency, dead-letter; "Automate this?" after a repeated success. |
| 3 | **Atlas backend primitives** | Generated apps get SQLite storage and HTTP helpers only. | Auth (email/password, sessions), file storage, per-app secrets and scheduled functions as template modules Genesis apps use by default, local first, hosted later. |
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
