# Atlas — gap analysis against the Create / Operate / Automate mission

Compares the mission brief (sections 1–28) with what exists on this branch.
"Foundation" names the code that should be extended rather than replaced.

| Mission area | Today | Gap | Foundation to build on |
|---|---|---|---|
| §1 Restore Atlas | Operational; see `CURRENT-STATE.md` | Vague-objective intake (RECOVERY §1) | `apps/web/app/api/tasks/route.ts` |
| §2 One canonical task lifecycle | `PlatformTaskStore` + contracts FSM; innovation builds use it | Coder tasks (`tasks` D1 rows, `local_tasks`) and missions still use their own lifecycles; outbox undelivered; no dead-letter consumer | `platform/task-store.mjs`, `agent/mission-service.mjs` |
| §2 One policy path | Three: `ToolRegistry` allow/ask/deny, `PolicyEngine`, family-graph authorization | Route every tool call through `AuthorizedToolExecutor` + `PolicyEngine` | `platform/executor.mjs` |
| §3 Create / Project Genesis | Missing | Persisted, versioned product brief → requirements → architecture → plan → missions | Innovation pipeline's brief/proposal/packet artifacts are the same shape one level up; reuse its validation + versioned events |
| §4 Instant backend | Missing (adapters exist for deploy only) | Provider-neutral provisioning adapters (DB, auth, storage, jobs, secrets) | `agent/infrastructure/adapter.mjs` |
| §5–6 Visual builder, design loop | Missing | Live preview with source mapping; render→screenshot→critique→repair | `apps/browser-worker` (screenshots), Design family (Visual QA / Accessibility agents) |
| §7 IDE workspace | CLI read tools + web chat | File tree/editor/diff/terminal over the same worktree agents use | `packages/atlas-cli` repository tools, `platform/terminal` |
| §8 Agent company | **Done on this branch**: BDE → Product Executive → 7 specialists; Engineering, Design, Computer Operations, Research peers; oversight | Agents are not yet bound to model sessions — they hold identity, permissions, budget and tasks, but executing an agent step is still a caller's job | `platform/family/*`, `platform/innovation/*` |
| §9 Model router | Two routers, neither drives execution | Conversation executor obtains its client from the platform router with fallback; record the model per step | `platform/models/router.mjs` |
| §10 Multi-agent review | **Council on this branch** (independent opinions, dissent preserved, digest-bound decision) | Extend councils to code review with deterministic evidence (tests, visual diffs) | `InnovationPipeline.convene/finalizeDecisionPacket` |
| §11 Computer control | Browser (companion + worker); terminal library | Desktop control missing; terminal controller not wired | `apps/windows-companion`, `platform/terminal` |
| §12 Human-behavior QA | Browser vertical slice | Scripted sign-up/CRUD/permissions missions with evidence | `apps/browser-worker`, Visual QA agent |
| §13 Deployment | Cloudflare deploy workflow; local plan/apply adapters | Preview/staging/production model with smoke test + rollback | `agent/infrastructure/*` |
| §14 Self-healing | Missing | Signals → repair missions with attempt caps | Pipeline's bounded repair loop (`maxRepairAttempts` → ITERATE) is the pattern |
| §15–16 Autonomous development / Atlas develops Atlas | Daily self-improve workflow (manual merge); **BDE pipeline on this branch** gives it evidence-backed direction | Connect the pipeline's commissioned build to the verified coder loop in an isolated worktree; the signal collector found **zero** inline TODO/FIXME markers in Atlas, so Atlas's own evidence must come from CI history, failed runs, docs backlogs and usage — not code markers | `collectRepositorySignals`, `lc/runner.mjs` worktrees, `atlas-self-improve.yml` |
| §17 Operate UI | Local UI + companion | Unified sessions view (who/what/where/permission/budget/evidence, pause/cancel) | `lc/ui.mjs`, platform dashboard |
| §18 Automate | GitHub cron only | Durable local scheduler + triggers that create platform tasks | `platform/task-store.mjs`, mission scheduler |
| §19–20 Business center, business missions | **BDE/Product org + Innovation Backlog + structured `BLOCKED_BY_*` reasons on this branch** | Revenue/usage/feedback data sources feeding evidence; budgets in dollars per mission | `platform/budget.mjs`, `apps/web` billing tables |
| §21–24 UX, copy, redesign, error experience | Web shell rebuilt in PR #58 | Create/Operate/Automate IA, error translation across web | `apps/web/app/AtlasShell.tsx` |
| §25 Security | SEC-4/5/6/14 fixed | SEC-1/2 (tenancy, revocable sessions) are prerequisites for widening access; SEC-3 SSRF in daemon tools | `SECURITY-REVIEW.md` |
