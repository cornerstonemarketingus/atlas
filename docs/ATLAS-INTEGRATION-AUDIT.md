# Atlas integration audit

Started 2026-10-24. Method: for each capability, whether `apps/local-control/src/main.mjs`
or `server.mjs` (the daemon's two entry points) import it, and whether a route or
registered tool reaches it. Evidence is a code search plus the test run named
below, not a live run. **Nothing here is live-verified unless a row says so.**
Truth order stays: code + tests + live verification > PROGRESS.md > TODO.md.

Classes: **VO** verified operational · **ID** implemented but disconnected ·
**PI** partially implemented · **BR** broken · **NI** not implemented ·
**BL** blocked by external requirements.

| # | Capability | Entry point | Imported + registered | Reachable | Real actions | Class | Missing connection / required fix | PR |
|---|---|---|---|---|---|---|---|---|
| 1 | Signed skills: package, registry, approvals, audit | `platform/skills/*` | **Was not imported by the daemon.** Now: `platform/skills/daemon.mjs`, mounted in `main.mjs`/`server.mjs` | `GET/POST /v1/skills*` (owner-only writes); tools join `ToolRegistry` as `skill.<name>` | Yes: verify signature, digests, ceiling, run package tests, install, load from verified bytes | PI (this PR) | No chat tool or UI page for install requests; a new version of an already-mounted skill needs a daemon restart; tools mounted after startup are not in the platform `AuthorizedToolExecutor` (built once at startup). | this PR |
| 2 | Atlas MCP server | `platform/mcp-server/*` | No importer outside tests | `main-stdio.mjs` is a standalone entry only; daemon exposes nothing | Unverified | ID | Mount `http.mjs` on the daemon behind the owner token, or document the stdio launch. | – |
| 3 | MCP client | `platform/mcp/daemon-bridge.mjs` | Yes (`main.mjs`, `ATLAS_MCP_SERVERS`) | Tools registered as `mcp.<id>`, denied until the owner allows | Yes when servers are configured | PI | Not exercised against a real server in this audit. | – |
| 4 | MCP gateway | `platform/mcp/gateway.mjs` | Only `detectInjection` is imported (`agent/untrusted.mjs`) | Partial | Injection screening only | PI | The gateway itself is not in the call path. | – |
| 5 | Self-improvement | `platform/self-improve/*` | Yes; `atlas.improve_self` tool (needs approval) + `/v1/self-improve*` + Command Center | Chat tool, API | Loop makes isolated-worktree changes, checks, policy, reviewer; merge is a separate owner decision | PI | Not run live here. Requires a git checkout of Atlas. No hosted-chat path: hosted Worker cannot reach the daemon without a Genesis-style node. | – |
| 6 | `ChildAgentRegistry` | `agent/child-agents.mjs` | No importer outside tests | No | Unverified | ID | Mission lanes and kernel runs do not create children through it. Needs a decision: adopt it for lane lifecycle (cancel, progress) or remove it. | – |
| 7 | Orchestrator `TaskDag` / `AgentLoop` | `platform/orchestrator/*` | No importer outside tests | No | Unverified | ID | Missions use `agent/mission-*`, not the DAG. Adopt for dependency ordering, or retire. | – |
| 8 | Planning (cost-aware, debate, team selection) | `platform/planning/*` | No importer | No | – | ID | Track B4/B11 consumers are not wired. | – |
| 9 | Engineering review scans | `platform/engineering/review.mjs` | Only `forbiddenPathChanges` is used (self-improve selector); `git`, `pipeline`, `worktrees` used by the loop | Partial | Yes for those | PI | Dependency/security scans are not in any run path. | – |
| 10 | Agent kernel, world state, repo graph, economics, autonomy | `agent/kernel/*` | Yes | `/v1/world*`; chat turns and Genesis builds are kernel runs | Yes | PI | Impact analysis is not yet fed into coding plans. | – |
| 11 | Missions and parallel lanes | `agent/mission-*` | Yes | API, Command Center | Yes | PI | Cancellation/progress exist per roadmap; retries and result aggregation not audited. | – |
| 12 | Goals and event subscriptions | `agent/goals.mjs`, `goal-routes.mjs` | Yes | `/v1/goals`, signed GitHub deliveries | Yes | PI | Wakes only on GitHub events; restart recovery not verified here. | – |
| 13 | Automations | `platform/automations/*` | Yes | API | Yes | PI | Not run live here. | – |
| 14 | Command Center | `platform/command-center.mjs` | Yes (`server.mjs`) | API + UI | Aggregates missions, Genesis, self-improve, automations, goals | PI | Chat actions and pending approvals are not confirmed as items; model target not shown per item. | – |
| 15 | Browser tools and worker | `agent/tools/browser-tools.mjs`, `apps/browser-worker` | Registered; fail closed with no companion | Chat tools | Needs a companion | PI/BL | Live observation and takeover (roadmap stage 6) not verified. | – |
| 16 | Desktop control | `agent/tools/desktop-tools.mjs` | Registered; fails closed without a desktop | Chat tools | Needs a desktop | PI/BL | `platform/desktop/*` is reached only through these tools. | – |
| 17 | Terminal tools | `platform/terminal/*` | Yes | Chat tools, approvals for high-risk | Yes | PI | – | – |
| 18 | Genesis (project creation) | `platform/genesis/*` | Yes | `/v1/genesis/*` | Yes locally | BL (hosted) | Hosted deploy reports `execution_node_not_configured`: needs `ATLAS_GENESIS_URL` + `ATLAS_GENESIS_TOKEN` secrets, an HTTPS tunnel to the daemon, remote-owner opt-in, and a deploy. `deploy-cloudflare.yml` already uploads both. | – |
| 19 | Hosted chat to local Ollama | `scripts/local/model-gateway.mjs` + `ATLAS_CHAT_BASE_URL` | Yes (documented in HOSTED-VERIFICATION.md) | Hosted chat route | Yes once secrets are set | BL | Needs gateway running, public HTTPS address, `ATLAS_CHAT_BASE_URL`/`ATLAS_CHAT_MODEL`/`ATLAS_MODEL_API_KEY` secrets, deploy. | – |
| 20 | Hosted chat release gate | `verify-hosted.yml` | Yes | Actions | Yes | BR (per PROGRESS 2026-10-23) | Streaming still failed on mixed capacity/credit refusals; fix #456 awaits release and re-run. | #456 |
| 21 | Hosted coder acceptance | `atlas-coder.yml` | Yes | Actions | Opened #454, unverified | BR | Acceptance 39899264987 failed on regressed validation; #455 merged, repeat pending. | #455 |

## Open PRs relevant to these rows (not touched)

#457 coder tool-call recovery · #461 chat health on Connections · #460 docs/MCP
entry point · #459 console wiring · #458 emergency stop · #449 workspace project
creation · #454 smoke-check file (unverified). Per PROGRAM.md, do not edit files in
another agent's open PR.

## Test evidence for this PR

`node --test apps/local-control/tests/daemon-skills.test.mjs`: 2/2 pass. Removing
the active-version guard in `daemon.mjs` makes the deactivation test fail.
`npm test` in `apps/local-control`: 966 tests, 954 pass, 0 fail, 12 skipped.
Not run: `npm run e2e`, any live daemon, any hosted workflow.

## Not done in this pass (handoff)

Unified execution decision record for chat; Command Center rows for chat actions and
approvals; browser takeover; restart recovery proof; adopting or retiring
`ChildAgentRegistry`/`TaskDag`; repo-graph impact in coding plans. Next: add
`atlas.skill_request_install` chat tool and a Connections page section for pending
skill approvals, then decide row 6/7.
