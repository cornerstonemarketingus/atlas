# Atlas OS — security review (Phase 0)

Scope: code at base commit `4ce465e` on branch
`claude/atlas-implementation-eah694`. Work in progress on this branch
(`apps/local-control/src/platform/`, `apps/browser-worker/`, correlation ids) is
not reviewed here. Every finding cites the file read. No live deployment was
exercised.

## 1. Current controls

### 1.1 Authentication

| Surface | Mechanism | Evidence | Assessment |
|---|---|---|---|
| Web — GitHub OAuth | State cookie (10 min, HttpOnly, Secure, SameSite=Lax), code exchange server-side | `apps/web/app/api/auth/github-oauth.mjs:1-40`, `auth/github/callback/route.ts`; `web/tests/github-oauth.test.mjs` | Sound |
| Web — session | Custom HS256 token in `atlas_session` cookie, 30-day TTL, HttpOnly/Secure/Lax | `apps/web/app/api/auth/session.mjs:1-75`; `session.test.mjs` | Stateless: **no server-side revocation**; logout only clears the cookie (`auth/logout/route.ts`) |
| Web — owner via GitHub login | Logins in `ATLAS_OWNER_GITHUB_LOGINS` get `role: "operator"` | `github-oauth.mjs` `isOwnerGitHubLogin`; `callback/route.ts:45-50` | Owner session gets the **default 30-day TTL**, whereas access-code operator sessions get 1 h (`auth/operator/route.ts:33`) |
| Web — operator access code | Constant-time compare, Origin check, 1 h session | `auth/operator/route.ts:3-39` | Sound; no rate limit |
| Web — operator bearer token | `Authorization: Bearer $ATLAS_OPERATOR_TOKEN` | `app/api/tasks/operator-auth.mjs:21-25` | Plain `===` string compare (not constant-time); bypasses plan gating (`tasks/route.ts:35-43`) |
| Web — platform header | `oai-authenticated-user-id` trusted only if `ATLAS_TRUST_PLATFORM_HEADERS=true` | `operator-auth.mjs:13-19` | Safe only behind a header-stripping ingress (comment says so) |
| Web — companion device | `Bearer <id>.<secret>`, SHA-256 at rest, `timingSafeEqual`, revocation | `app/api/computer/companion-auth.ts:10-24` | Sound; unsalted SHA-256 acceptable for 32-byte random secrets |
| Web — runner results | GitHub OIDC JWT (issuer, audience, RS256, 10 min, `workflow_dispatch`, `refs/heads/main`) + live run lookup binding | `app/api/tasks/runner-result.mjs:6-42`, `tasks/result/route.ts`; `runner-result.test.mjs` | Strong |
| Web — Stripe webhook | HMAC signature, 300 s tolerance, event-id idempotency | `app/api/billing/stripe.mjs:69-82`, `billing/webhook/route.ts:14-16`, `billing_events` table | Sound |
| Local daemon | Owner token ≥32 chars, SHA-256 + `timingSafeEqual`; paired device tokens (hashed) | `apps/local-control/src/server.mjs:14-15,122-127` | Sound; binds `127.0.0.1` by default (`src/main.mjs:76`) |
| Local pairing | 6-digit one-use code, 5 min, rate-limited | `server.mjs:39-51,98`, `src/rate-limit.mjs` | Sound for loopback; brute-force risk grows if `ATLAS_LOCAL_HOST` is set to a LAN address |

### 1.2 Secrets handling

| Control | Evidence | Notes |
|---|---|---|
| Worker secrets uploaded only by deploy, skipped list printed | `.github/workflows/deploy-cloudflare.yml:48,123` | |
| GitHub App short-lived installation tokens preferred over PAT | `apps/web/app/api/tasks/github-app.mjs:43`, `tasks/route.ts:56-61` | PAT fallback `ATLAS_GITHUB_TOKEN` still supported |
| Redaction at five boundaries, fail-closed | `packages/atlas-cli/src/infrastructure/pattern-secret-redactor.ts`, `redacting-model-provider.ts`, `cli-redact.ts`; `scripts/runner/report-result.mjs:66-71` | Pattern-based; unknown formats pass (HANDOFF.md §9) |
| Tool subprocess env allowlist | `apps/local-control/src/agent/tools/process.mjs:11-28` | |
| Credential vault (OS keychain / AES-GCM file) | `apps/local-control/src/agent/credential-vault.mjs` | **Not used by the tool registry**: `secrets: (ref) => process.env[ref]` (`src/main.mjs:146`) |
| Local coder subprocess env | `apps/local-control/src/runner.mjs:15` (no `env` → inherits all), `scripts/local/run-coder.mjs:84` (`...process.env`) | Daemon env may hold `ATLAS_GITHUB_TOKEN`, `ATLAS_CLOUDFLARE_TOKEN`, `ATLAS_VERCEL_TOKEN` (`main.mjs:130,220-231`) |

### 1.3 Tenant isolation

- **There is no tenant entity.** `apps/web/db/schema.ts` has no `tenants`,
  `organizations` or membership table. Isolation is per principal string
  `requested_by` (`github:<login>`, `operator`, or platform id), filtered in SQL
  and again in `visibleTasks` (`app/api/tasks/route.ts:163-175`,
  `run-status.mjs`).
- Owner-scoped tables: `tasks`, `conversations`, `conversation_messages`,
  `run_events`, `computer_devices`, `computer_tasks`, `computer_approvals`,
  `computer_task_events`, `account_deletion_requests`.
- **Global (unscoped) tables:** `repositories` (merge policy keyed on
  `owner/name` only), `installations`. Merge policy lookup at dispatch ignores
  the caller (`tasks/route.ts:45-55`); editing is owner-only
  (`settings/repositories/route.ts:8-12,21-24`).
- **Repository authorization is deployment-global:** any signed-in principal
  may dispatch to any repo in `ATLAS_ALLOWED_REPOSITORIES`
  (`tasks/route.ts:25`, `dispatch.mjs:6-18`) using the deployment's GitHub
  credential. There is no check that the user has access to that repository on
  GitHub. Mitigated today only because the coder runner hard-codes a single
  repository (`scripts/runner/validate-inputs.mjs:5,37`) and self-protection
  restricts coder mode on it to the owner (`tasks/self-protection.mjs:16-26`).
- Contracts require `tenantId` (`packages/atlas-contracts/src/index.mjs:260,267`)
  but nothing populates it.
- Local daemon is single-owner by design; hosted browser library has explicit
  tenant checks (`src/agent/browser/hosted-browser.mjs:25-40`) but is not wired.

### 1.4 SSRF / URL controls

| Path | Control | Gap |
|---|---|---|
| `browser.navigate` (daemon) | http/https only (`src/agent/tools/browser-tools.mjs:28-39`) | No block on loopback, RFC1918, link-local (169.254.169.254), or `localhost:4317` (the daemon itself) |
| Hosted computer task `startUrl` | http/https only (`app/api/computer/tasks/route.ts:47-49`) | Same; executed on user's PC by the companion, which can reach the LAN |
| Chat model endpoint | HTTPS or loopback, no creds/query (`app/api/chat/model-endpoint.mjs:28-58`) | Env-configured only, acceptable |
| GitHub API calls | Fixed `api.github.com`, `encodeURIComponent` on path parts (`dispatch.mjs:35`) | `result/route.ts:31` interpolates `task.repository` unencoded (value is regex-validated at intake) |
| Infrastructure adapters | Base URL from env (`src/main.mjs:231`) | Operator-controlled |

### 1.5 Prompt-injection defenses

| Control | Evidence |
|---|---|
| System prompt marks repo/web/tool content as untrusted | `src/agent/conversation-executor.mjs:22`; `packages/atlas-cli/src/agent/provider-read-only-tool-agent.ts:246` |
| Model proposes, deterministic classifier decides for browser actions | `apps/windows-companion/src/operator/classification.mjs:4-10,105`; `operator.test.mjs` |
| Unknown tools / unknown args refused | `src/agent/tool-registry.mjs:34-55`; CLI `tests/model-tool-registration.test.ts` |
| Consequential actions require digest-bound approval | `tool-registry.mjs:89-95,193-203` |
| Bulk outreach refused outright | `tool-families.test.mjs:295` |

Gaps: no provenance tagging of content in model context (tool output is not
wrapped/labelled per-source); companion prompt concatenates the page ARIA
snapshot directly (`apps/windows-companion/src/index.mjs:34-40`); no
injection-focused test corpus; `browser.navigate` and `browser.snapshot` are not
approval-gated, so an injected page can steer navigation to internal hosts and
exfiltrate via URL.

### 1.6 Approval gates

| Gate | Evidence | Notes |
|---|---|---|
| Local capability policy allow/ask/deny, missing = deny | `src/main.mjs:141-146`, `src/store.mjs` `policy()` | |
| Local digest approvals, one-time | `store.consumeApprovedDigest` used in `main.mjs:123-127,190-191` | |
| Hosted companion approvals: action hash, 5 min expiry, device-bound | `app/api/computer/companion/approval/route.ts:19-26`, `approval/[id]/route.ts:15-24` | **Consume is check-then-update**: the `UPDATE … WHERE status='approved'` result is not checked (`[id]/route.ts:23`), so two concurrent consumers can both receive `consumed` |
| Hosted approval decision | `app/api/computer/approvals/[id]/route.ts:16-17` (owner + pending) | Does not check `expires_at` (consumption does) |
| Hosted coder mutation approval | Design only: `docs/hosted-approval-state-design.md` | Not implemented; hosted coder opens PRs without a pre-commit approval; human review happens at merge (`manual` default) |

### 1.7 Merge policy and self-protection

- Policies `manual | ci-gated | none` (`apps/web/db/schema.ts:4`); regression
  never auto-merges (`scripts/runner/create-coder-pull-request.mjs:187-190`);
  `ci-gated` with zero checks waits then holds (`merge-decision.mjs:22-31`).
- `none` merges immediately even when verification is not `passed` — only
  `regressed` blocks it (`create-coder-pull-request.mjs:187-196`).
- `merge_policy` is a `workflow_dispatch` input of `atlas-coder.yml`; anyone
  with Actions-write on the repo can dispatch with `none`. The self-improvement
  path pins `manual` (`.github/atlas/build-dispatch.py:36`).
- Self-protection: coder mode on `ATLAS_SELF_REPOSITORIES` only for principal
  `operator` (`app/api/tasks/self-protection.mjs`); workflow definition always
  from `main` (`dispatch.mjs:32,46-47`); target branch checked out as untrusted
  data (`atlas-coder.yml:103`).

### 1.8 Audit logs

| Log | Immutability | Evidence |
|---|---|---|
| `local_mission_events` | DB triggers reject UPDATE/DELETE | `src/store.mjs:52-53` |
| `agent_events` | Append-only by convention (PK `(session_id, sequence)`), `ON DELETE CASCADE` from sessions | `src/agent/session-store.mjs:42-49` |
| `local_audit` | No trigger; replaced wholesale by `/v1/import` | `src/store.mjs:33`, `server.mjs:105` |
| Audit sink failure stops the run | `apps/local-control/tests/agent-runtime.test.mjs:415` | |
| Hosted `run_events`, `computer_task_events` | Insert-only in code; no DB enforcement | `apps/web/db/schema.ts` |
| CLI JSON-Lines audit (digests, not content) | `packages/atlas-cli/src/infrastructure/json-lines-session-audit-store.ts`; REPLAY.md | |
| Hosted admin/auth audit (sign-ins, policy changes, repo-setting edits) | **missing** | `settings/repositories/route.ts` writes no event |

## 2. Gaps ranked by severity

| # | Severity | Gap | Evidence | Recommended fix (backlog item) |
|---|---|---|---|---|
| 1 | **High** | No tenant model; repository authorization is a deployment-global allowlist; merge policy and installations are global. Opening coder mode to more repos would let any signed-in user act on any allowlisted repo with the platform's GitHub credential | `schema.ts` (no tenant table), `tasks/route.ts:25,45-55`, `dispatch.mjs:6-18` | **Mitigated 2026-09-26**: every non-owner task checks the user's own GitHub permission on the repository (write for coder, read otherwise) before dispatch; a full tenant model (P9-1) is still open |
| 2 | **High** | Stateless 30-day sessions with no revocation; owner (operator-role) GitHub sessions also last 30 days; rotating `ATLAS_SESSION_SECRET` is the only kill switch | `session.mjs:2,26-39`, `callback/route.ts:45-50` | **Fixed 2026-09-26**: session ids, server-side revocation on sign-out and "sign out everywhere", 12 h owner sessions (migration 0014 must be applied) |
| 3 | **High** | SSRF: browser navigation and hosted `startUrl` accept any http(s) host incl. loopback, RFC1918, metadata IPs and the daemon's own port | `browser-tools.mjs:28-39`, `computer/tasks/route.ts:47-49` | **Fixed 2026-09-26** for the daemon's browser tools (refused) and the companion (asks); browser worker already had an origin allowlist |
| 4 | **High** | Local coder subprocess inherits the full daemon environment (infra/admin tokens) while running model-driven code against a repo | `src/runner.mjs:15`, `scripts/local/run-coder.mjs:84`, `main.mjs:130,220-231` | **Fixed** (verified 2026-09-26): the coder runs with `localCoderEnvironment()` — an allow-listed environment plus a placeholder model key; `tests/agent-worktree.test.mjs` asserts infrastructure tokens are absent |
| 5 | **Medium** | Hosted approval consumption is not atomic (check-then-update, result ignored) → one approval can authorize two actions under concurrency | `companion/approval/[id]/route.ts:19-23` | **Fixed 2026-09-25**: conditional update with `.returning()`, zero rows → 409; expired approvals cannot be decided (P1-6) |
| 6 | **Medium** | Operator bearer token compared with `===` (timing side-channel), no rate limit on any web route | `operator-auth.mjs:24`; no `429` in `apps/web/app/api` | Constant-time compare **fixed 2026-09-25**; rate limiting still open (P1-5) |
| 7 | **Medium** | `merge_policy: none` merges unverified (non-regressed) changes; the input is dispatchable by any Actions-writer | `create-coder-pull-request.mjs:187-196`, `atlas-coder.yml` inputs | **Fixed 2026-09-26**: any auto-merge requires a passed verification; the policy input itself is still a workflow input |
| 8 | **Medium** | Tool registry secrets read from `process.env`, not the vault; any declared env name is resolvable | `src/main.mjs:146` | **Fixed 2026-09-26**: vault first, environment fallback, declared credentials only |
| 9 | **Medium** | No hosted audit trail for security-relevant admin actions (repo policy edits, owner sign-ins, device pairing) | `settings/repositories/route.ts`, `auth/*` | Append-only `audit_events` table (P1-2) |
| 10 | **Medium** | Hosted "Cloudflare browser" tasks are accepted and billed-plan-gated but have no executor; users may believe work is running | `computer/tasks/route.ts:52-58` | **Fixed 2026-09-26**: never configured without an executor; API refuses instead of queueing |
| 11 | **Low** | Prompt-injection defenses are prompt-level + classifier; no provenance labelling or injection regression corpus | `conversation-executor.mjs:22`, `windows-companion/src/index.mjs:34-40` | **Fixed 2026-09-26** for daemon model turns: tool, memory and earlier-step content enters as one `<data source>` block it cannot close (`agent/untrusted.mjs`), instruction-shaped text is labelled, and `tests/fixtures/injection-corpus.json` is a regression corpus. Companion and hosted chat still rely on prompt wording |
| 12 | **Low** | `local_audit` has no immutability trigger and is overwritten by `/v1/import` | `store.mjs:33`, `server.mjs:105` | **Fixed 2026-09-26**: append-only triggers; imports labelled and their approvals spent |
| 13 | **Low** | No security headers configured for the web app (CSP, frame-ancestors) | `apps/web/next.config.ts` (empty) | **Partially fixed 2026-09-26**: framing/sniffing/referrer/HSTS/permissions are enforced and script-src nonce CSP is now emitted in `Content-Security-Policy-Report-Only`; promote to enforced mode after clean rollout |
| 14 | **Low** | `deploy-cloudflare.yml` and `provision-d1.yml` have no top-level `permissions:` block (default token scope) | `.github/workflows/deploy-cloudflare.yml`, `provision-d1.yml` | **Fixed 2026-09-25**; `check-workflows.py` now requires a top-level block (P1-7) |
| 15 | **Low** | Actions-minutes usage may be unavailable | `scripts/runner/actions-budget.mjs` | UNKNOWN blocks by default; explicit allow remains visible in artifacts and task results |
| 16 | **Info** | Secret redaction is pattern-based; unknown formats pass | HANDOFF.md §9 | Keep secrets out of repos; add entropy check for artifacts only |
