# Atlas capability roadmap and parallel workstreams

Updated 2026-09-25 against PR #59 (`claude/atlas-platform-development-o9znpd`)
and observed Windows test results. This is a dependency plan, not a claim that
the listed product is complete. Every workstream must land as a tested,
reviewable PR. Do not merge or deploy without owner authorization.

## Product promise

**Atlas gets work done and proves it.** Chat is the command surface. Create,
Operate, Automate, and Activity are concurrent workspaces over one runtime,
not separate agent modes. Policies, budgets, approvals, leases, and audit stay
inside the trusted kernel. No model may approve its own action or verify a
failed action by assertion.

## Verified baseline

PR #59 adds substantial runtime integration: durable outbox delivery, team
mission execution over the existing scheduler, approvals during a step,
recovery, local desktop tools, a platform terminal tool, MCP stdio, scoped
memory recall, model fallback for conversation, innovation briefs, and a local
console. PR #59 remains a draft. Its CI is green, but that is not production
validation. The hosted task dispatcher still has a documented owner credential
blocker. The local Windows run of `apps/local-control` yielded 299 pass, 19
fail, 3 skipped; terminal tests assume Unix binaries/POSIX paths and the MCP
env test omits Windows baseline variables. See `CURRENT-STATE.md` and
`RECOVERY.md`.

The first verification-safety defect found during this pass is fixed on the
stacked branch: a model's `passed: true` can no longer override a failed,
denied, or pending tool action. Fingerprints remain in memory and are not
written to artifacts or audit events. Focused mission tests pass 16/16.

## Backlog map for the 200-item capability list

| Requested item groups | Status from inspected code | Next dependency / workstream |
|---|---|---|
| 1, 17, 21–24, 35, 44–49, 83–89, 169, 174, 177–184 | Persistent sessions, mission scheduler, family graph, outbox, leases, approval gates and evidence exist in pieces; PR #59 connects a local team mission path. Full hosted unification, replay/re-execution, notification delivery, and conflict-aware leases remain incomplete. | A — finish canonical runtime and strict verification; B — durable scheduling after task lifecycle contract |
| 2, 112–118, 153–157, 186–188 | Chat-first shell was deployed; PR #59 has a local nine-section console. Hosted/local surfaces are not one synchronized workspace; full workspaces, activity replay, and global search are incomplete. | C — product shell / task activity; depends on real runtime events |
| 3, 96–104, 131 | No complete Project Genesis/full-stack builder, preview, DB/auth provisioning or domain workflow. Existing coder loop and deploy adapters are foundations only. | D — Create vertical slice after runtime, sandbox, preview service, and approvals |
| 4, 10–16, 86–88, 92–95, 105–111 | CLI coding and validation are real; heuristic code navigation exists; compiler/LSP, DAP, robust CI repair and broad language coverage are absent. | E — IDE/code intelligence, after filesystem and terminal portability |
| 5–6, 13, 51, 118 | Safe repository edits, worktrees, restricted terminal controller and command policy exist. Generic Windows terminal currently fails locally; containers/VM isolation, PTY, quotas and durable terminal sessions remain. | F — Windows terminal adapter/tests; G — isolated Linux/container runner |
| 7–9, 40, 42, 52–53, 167, 170–171 | Browser automation, companion pairing, cloud browser package and PR #59 Windows desktop driver exist. Hosted browser consumer, multi-session takeover, macOS/Linux desktop and secure session recording remain partial/missing. | H — Operate sessions and takeover; separate OS-specific adapters |
| 12, 14–15, 34, 37, 121–130 | GitHub Actions/App and MCP stdio exist; review comments, issues, remote MCP OAuth, other git hosts, connector catalog, marketplace and stable APIs remain incomplete. | I — connector/ACP/API slices after authz and tenant boundaries |
| 18–20, 22, 28–31, 116, 145–148, 179–182 | Families, specialists, delegation and bounded parallel mission execution exist in PR #59. Agent worker pool, dynamic creation, leases, user-visible Teams, Skill builder/evals and marketplace are incomplete. | J — worker lifecycle/team supervision; K — Skill lifecycle only after verified task outcomes |
| 25–27, 80–81, 139, 185–186 | Scoped local memory and family recall exist; user/project/org UI, semantic/vector/graph retrieval, provenance controls and broad research citations remain incomplete. | L — Atlas Brain controls, after tenancy/access model |
| 32–33, 36–39 | MCP stdio client/runtime integration exists; HTTP transports, OAuth connectors, Atlas MCP server, channels and unified cross-channel identity are missing/partial. | I — connector framework, after policy model |
| 41–43, 61–79 | Local Ollama discovery/adapters and model routing foundations exist; local model distribution, hardware-aware runtime, multimodal and Atlas-managed inference are largely missing. | M — model runtime based on privacy/cost evaluations |
| 90–95, 141–147, 194–198 | Self-improve workflow and innovation pipeline exist, but fully autonomous self-modification must stay isolated, benchmarked, approval-gated and rollbackable. | N — self-improvement evaluation/rollback, after benchmark suite |
| 99–110, 131, 163–165, 176 | Cloudflare deployment and local infrastructure adapters exist. Domain/DNS, preview promotion, rollback, managed data services, one-click provisioning and desktop/mobile product are incomplete. | D — deployment/provider adapters with explicit approval |
| 119–128, 198–200 | Token/tool budgets, billing and owner controls exist in partial form; full multi-tenant SaaS, governance, analytics, residency and marketplace remain absent. | O — tenancy/security before customer expansion |

## Parallel workstreams

Each item below owns the named files/API area. A session must not edit files
owned by another active session; shared contracts require an integration PR.

| ID | Workstream | Owns | Depends on | Acceptance criteria |
|---|---|---|---|---|
| A | Verified mission correctness | `apps/local-control/src/agent/team/*`, `tests/team-missions.test.mjs` | None | Failed/pending actions never verify; retries reconcile exact actions; audit output contains no action fingerprint; resume/cancel tests pass. Current strict-verification changes are on the stacked branch and need PR/CI. |
| B | Canonical task lifecycle / outbox | `apps/local-control/src/platform/task-store.mjs`, `platform/outbox-dispatcher.mjs`, dedicated tests only | A | At-least-once delivery, idempotent consumers, DLQ/recovery; no second scheduler; crash/restart E2E. |
| C | Hosted workspace UX | `apps/web/app/AtlasShell.tsx`, chat/tasks/projects/activity UI and web UI tests | Runtime event API from B | Chat remains command center; Create/Operate/Automate/Activity can coexist; no fake status; mobile + browser tests. Avoid local console files. |
| D | Create / preview / publish | New Project Genesis and preview routes in `apps/web` plus browser-worker adapters | A, B, sandbox policy | Real project artifact, isolated preview, tests, approval before deploy/domain/DNS mutation, rollback evidence. |
| E | Code intelligence / IDE panels | `packages/atlas-cli/src/domain/*` and `apps/web` Create code panels | None, but keep contracts backward compatible | Compiler/LSP-backed symbols where available; evidence-linked diff/file views; tests across a fixture repo. Coordinate web shell changes through C. |
| F | Windows terminal support | `apps/local-control/src/platform/terminal/*`, terminal tests, Windows CI config | A | Native executable resolution and environment baseline are explicit, command invocation stays no-shell, approvals and containment work, Windows tests pass; unsupported isolation is clearly reported. |
| G | Container/VM isolation | New isolated runner package and its tests/docs | F interfaces frozen | Untrusted execution in disposable environment with resource/egress controls, cleanup, crash tests. No host credentials. |
| H | Operate sessions / takeover | `apps/windows-companion/src/desktop/*`, browser session API/UI under Operate, own tests | A, B | Multiple isolated sessions, genuine status, pause/stop/takeover where supported, approval/audit and ownership checks. Do not claim cloud browser is available without a consumer. |
| I | Connectors and protocols | `apps/local-control/src/platform/mcp/*`, connector APIs, focused tests | A policy interface | Streamable HTTP/OAuth with credential references, per-agent scopes, deterministic policy, redaction, reconnect and audit; Atlas MCP server separately versioned. |
| J | Team runtime / supervision | `apps/local-control/src/agent/team/*` outside A-owned verifier, family worker lifecycle and tests | A, B | Bounded specialists, scoped messages, budgets, restart recovery, cancellation and parent verification; no self-granting permissions. |
| K | Skills and workflow learning | New skills package and APIs, not family runtime files | A, J, audit/provenance | Verified task→reviewable skill proposal→eval→human approval→versioned private install; rollback and no auto-publish. |
| L | Atlas Brain | memory package/API/UI under Knowledge; separate tests | O tenancy boundary | Scoped retrieval, evidence provenance, inspect/correct/delete/export, retention tests; no cross-user reads. |
| M | Models/runtime | `apps/local-control/src/agent/models/*` and model tests | A | Real routing in every execution path, health/fallback/cost/privacy accounting; no credentials in child processes. |
| N | Controlled self-improvement | `.github/atlas/*`, self-improve workflow and eval packages | A, O, benchmarks | Admin-only activation; isolated branch/worktree; baseline/eval/security review; draft PR; explicit owner merge; rollback. Atlas cannot alter its own approval gates. |
| O | Auth, tenancy, and governance | `apps/web/db/schema.ts`, migrations, auth/session/repository APIs and security tests | None; coordinate migrations with owner | Tenant/member isolation; session revocation; per-repository authorization; rate limits; audit; migration and restore tests. No broader autonomous access before this. |
| P | Windows test portability | `apps/local-control/tests/platform-terminal.test.mjs`, MCP env tests, Windows CI | F | Tests use platform-appropriate fixtures; POSIX-only behavior skips explicitly; Windows behavior has actual Windows integration coverage; no suppressing real errors. |

## Immediate sequence

1. Finish and publish A (strict verification) as a stacked review PR; keep PR
   #59 draft until this and owner actions are resolved.
2. Complete P/F: Windows terminal behavior currently blocks reliable local
   developer use and was the source of 19 failures on this host.
3. Resolve PR #59 owner actions (hosted GitHub credential recovery and D1
   migration `0014`) only with the owner; do not read or print secrets.
4. Run the recorded E2E journey and hosted verification after recovery.
5. Land O security/tenant controls before widening users or self-improvement.
6. Build B/J, then C/H/D, then E/K/L/I/M, then N and broader SaaS features.

## Status discipline

- PR #59 has green Linux CI, but is still a draft and not deployed.
- The Windows local-control suite on this host: 299 passed, 19 failed, 3
  skipped. Failures are concentrated in POSIX terminal executable/path
  assumptions and Windows process environment; they are not counted as passes.
- Production task dispatch previously returned 502; owner must rotate or
  replace GitHub credentials and verify before declaring hosted coding usable.
- Do not label the 200-item roadmap complete by counting libraries, mocks,
  demos or checkboxes. Require wired runtime, tests, security boundaries and
  end-to-end evidence for every workstream.