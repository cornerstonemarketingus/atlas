# Atlas — engineering handoff

Written 2026-09-09 for an incoming agent or engineer picking this up cold.
Everything here was verified against the repository and the live GitHub API on
that date, not recalled. Where something is unverified, it says so.

**The actionable checklist is `HANDOFF-TODO.md`.** This file is the map; that
file is the work. (It is not named `todo.md` — the repo already has `TODO.md`,
a long-range roadmap, and on a case-insensitive filesystem the two are the same
path.)

---

## 1. What Atlas is

A multi-tenant SaaS that runs an autonomous coding agent against a customer's
GitHub repository. The agent reads the repo, proposes a change, **runs the
repository's own build and test commands before and after its edit**, compares
the two runs, repairs what it broke, and opens a pull request stating whether
the change is verified.

That verification loop is the entire competitive claim. Replit Agent, Codex and
similar tools generate a diff and stop. Atlas produces evidence. Anything that
weakens the loop — skipping baseline capture, treating pre-existing failures as
the agent's fault, auto-merging a regressed change — destroys the product's
reason to exist, not just a feature.

**Live URL:** https://atlas-web.cornerstonemarketingus.workers.dev
**Repository:** `cornerstonemarketingus/atlas`
**Host:** Cloudflare Workers. Not Vercel — see §7.

---

## 2. Current state, honestly

| Area | State |
|---|---|
| `packages/atlas-cli` | **371/371 tests pass**, `tsc` clean |
| `apps/web` | **73/73 tests pass**, build clean, `eslint` clean |
| CI (`ci.yml`) | Green. Three jobs: atlas-cli, apps/web, workflow syntax |
| Cloudflare deploy | Working. Last success deployed merge `27f7dd6` |
| Operator access | **Works today.** `ATLAS_OPERATOR_TOKEN` bypasses plan gating |
| GitHub sign-in | **Broken.** Secrets never set — see §5 |
| Stripe billing | **Not configured.** Secrets never set |
| D1 database | **Migrations 0001 and 0002 NOT applied.** Blocked — see §5 |
| Daily self-improvement | **Failing every run.** Live bug — see §4 |

Branch `claude/atlas-state-live-deploy-dcxay7` is **1 commit ahead of `main`**
(`bf2a430`, a docs-only change to `LAUNCH.md`). Not yet in a PR.

---

## 3. Where things live

```
packages/atlas-cli/          Strict TypeScript. Zero runtime dependencies.
  src/agent/
    verified-coder-session.ts    THE core loop: baseline -> edit -> re-verify
                                 -> diff -> bounded repair -> verdict
    verification-planning.ts     Pure planning. Picks which repo scripts to run
  src/model/
    coder-provider-selection.ts  Groq vs Anthropic routing (pure, testable)
    model-provider.ts            Provider-neutral message/tool contract
  src/infrastructure/
    redacting-model-provider.ts        Scrubs every OUTBOUND model request
    pattern-secret-redactor.ts         The detector itself
    policy-enforced-read-only-tool-registry.ts  Tool policy + output redaction
    transactional-repository-change-set-editor.ts  Atomic multi-file edits
    persist-session-audit.ts     Flushes the session trace to disk
  src/cli-redact.ts            `atlas redact` — the redactor as a subcommand
  src/cli.ts                   Command wiring. THE place features go inert

apps/web/                    Cloudflare Worker. React + D1 (Drizzle).
  app/api/tasks/route.ts       Dispatch + task history. Tenant isolation here
  app/api/auth/                GitHub OAuth sign-in
  app/api/billing/             Stripe
  db/schema.ts                 users, subscriptions, task_usage, repositories, tasks
  drizzle/000{0,1,2}_*.sql     Migrations

scripts/
  runner/run-task.mjs                  What GitHub Actions actually executes
  runner/create-coder-pull-request.mjs Opens the PR, enforces merge policy
  setup.mjs                            One-time operator setup (needs a terminal)

.github/workflows/
  ci.yml                  Tests. Added this session — the repo had none
  atlas-coder.yml         The coder agent
  atlas-self-improve.yml  Daily 09:00 UTC (= 4am America/Chicago in CDT)
  deploy-cloudflare.yml   Deploy + Worker secret upload
  migrate-d1.yml          Dispatch-only migration runner
.github/atlas/
  check-workflows.py      Validates workflows. Run before touching any of them
```

---

## 4. Open bugs

### 4.1 Daily self-improvement fails every run — HTTP 403

**Severity: high.** The headline autonomy feature has never once succeeded.

All four scheduled runs (Sep 6, 7, 8, 9) failed identically:

```
curl: (22) The requested URL returned error: 403
##[error]Process completed with exit code 22.
```

The failure is at the **dispatch** step in `atlas-self-improve.yml`, POSTing to
`/repos/{repo}/actions/workflows/atlas-coder.yml/dispatches`. The preceding
guard step succeeds, so `ATLAS_GITHUB_TOKEN` can *read* pull requests but cannot
*dispatch workflows*.

**Fix:** grant the fine-grained PAT `Actions: Read and write` on this repository.
That is an account action; no code change will work around it.

The step used to die with a bare `curl: (22)`, which said nothing about why —
which is how four consecutive runs failed without ever naming the missing
permission. It now uses `--fail-with-body`, prints GitHub's own message, and on
a permission error names the exact grant needed. It still exits non-zero: the
run fails as loudly as before, it just says why.

### 4.2 D1 migrations blocked on Cloudflare token scope

`migrate-d1.yml` dry run **succeeded** (Sep 7) and selected the right files:
`0001_square_mandroid.sql`, `0002_short_prowler.sql` — purely additive
`CREATE TABLE` / `CREATE INDEX`, no `DROP`, no `ALTER`.

The real run **failed**:

```
Unable to get membership roles. Make sure you have permissions to read the account.
Are you missing the `User->Memberships->Read` permission?
```

`CLOUDFLARE_API_TOKEN` can deploy Workers but cannot touch D1.

**Fix:** at https://dash.cloudflare.com/profile/api-tokens add **D1: Edit** and
**Account Settings: Read** to the existing token.

**Unverified:** the workflow was run with `database_name=atlas-db`, the
documented default. The real name is in the `ATLAS_D1_DATABASE_NAME` secret and
was never confirmed. It may also be wrong — the run failed on permissions
before it could tell us.

Until this lands, `users`, `subscriptions`, `task_usage` and `tasks` **do not
exist**. Sign-up would write to missing tables.

---

## 5. Setup steps still pending (all require account access)

Nothing here is automatable. GitHub has no API to create OAuth Apps, and secret
values live in accounts an agent cannot log into. See `LAUNCH.md` for the
browser-only click path with direct links.

1. **Cloudflare token** — add D1: Edit + Account Settings: Read
2. **GitHub OAuth App** — https://github.com/settings/applications/new
   Callback must be exactly:
   `https://atlas-web.cornerstonemarketingus.workers.dev/api/auth/github/callback`
3. **Three repository secrets** — https://github.com/cornerstonemarketingus/atlas/settings/secrets/actions/new
   `ATLAS_SESSION_SECRET`, `ATLAS_GITHUB_OAUTH_CLIENT_ID`,
   `ATLAS_GITHUB_OAUTH_CLIENT_SECRET`
4. **`ATLAS_GITHUB_TOKEN`** — add Actions: Read and write (fixes §4.1)
5. Then: run `migrate-d1.yml` (dry run first), then `deploy-cloudflare.yml`

The deploy's "Upload Worker runtime secrets" step prints what uploaded and what
was skipped. **Read that output** — it is the only reliable statement of what
the running Worker can actually see. As of the last deploy it read:

```
Uploaded 2 Worker secret(s).
Not configured (skipped): ATLAS_SESSION_SECRET ATLAS_GITHUB_OAUTH_CLIENT_ID
ATLAS_GITHUB_OAUTH_CLIENT_SECRET ATLAS_STRIPE_SECRET_KEY ...
```

---

## 6. Invariants — do not break these

These are load-bearing. Each exists because of a specific failure.

**Secret redaction fails closed, at five boundaries.** Tool output, tool
*failure messages*, every outbound model request, printed CLI output, and the
persisted audit trace. If redaction cannot run, the operation stops — it never
falls back to raw text.

**Assistant tool-call arguments are deliberately NOT redacted.** They carry the
file content the model asked to write; a placeholder there would be written into
the customer's repository or "restored" over real content on a later turn. That
is data corruption, not leak prevention. Repository content is already scrubbed
inbound, so nothing is lost. Do not "fix" this.

**A regressed change is never auto-merged**, whatever the merge policy says.

**The self-improvement agent's merge policy is hard-coded to `manual`** in
`.github/atlas/build-dispatch.py` and deliberately not a workflow input. An
agent that can merge its own changes can disable its own safety rails and keep
running with them disabled.

**Validation subprocesses get an explicit environment allowlist**, never the
inherited environment. A repository's test script is repository-controlled code;
handing it `GROQ_API_KEY` turns "run the tests" into credential exfiltration.

**Script names are validated before reaching npm.** A repo-controlled script
name beginning with `-` is parsed by npm as a flag — argument injection from a
hostile `package.json`.

**Tenant isolation on task history is enforced twice** — in the SQL predicate
*and* in `visibleTasks`. A filter that lives only in a query builder is one
refactor from being silently dropped. It keys on the principal string, never the
nullable `users.id`.

**Never give the agent credentials that can write secrets or mint tokens.** It
runs unattended nightly, edits its own source, and reads repository content
written by other people. `scripts/setup.mjs` runs on the operator's machine for
exactly this reason.

---

## 7. Gotchas that cost real time

**Vercel cannot host this app, and used to publish a broken copy anyway.**
`apps/web/db/index.ts` does `import { env } from "cloudflare:workers"`, a
Workers-only API, and every route touching the database imports it. `vercel.json`
published `apps/web/dist/client` — static assets, no server — so the preview
looked like the product and failed on sign-in. `vercel.json` now redirects
everything to the Worker (307, not 301, so it stays reversible). If you ever
point Vercel at something real, that file is where to start.

**A malformed workflow fails with zero jobs and no message.** GitHub parses
workflows before running anything. This has cost this repository three silent
failures. Always run `python3 .github/atlas/check-workflows.py` before pushing a
workflow change.

**GitHub evaluates `${{ }}` inside `run:` blocks before any YAML concern.** A
literal `${{` in an embedded script — even inside a string being searched for —
makes GitHub reject the entire workflow. A YAML parser cannot see this. It is
why embedded scripts were moved to files under `.github/atlas/`.

**`readline/promises`' `question()` does not work in a loop with piped stdin.**
Node drains the pipe and emits all lines at once, so only the first question
ever resolves. `scripts/setup.mjs` uses a shared line queue instead.

**Features go inert in `cli.ts`.** Three separate features this session were
complete, correct, and unreachable because nothing wired them up: redaction was
never constructed; the change-set tool was advertised to the model but not
registered (an unknown tool ends the session); the system prompt never mentioned
it. `tests/model-tool-registration.test.ts` now pins advertised == registered.
**When adding anything, check `cli.ts` wires it and add a test that fails
without the wiring.**

**Verify guard tests by breaking the thing they guard.** One test written this
session passed on the exact file GitHub had just rejected — worse than no test,
because it asserted confidence it had not earned.

---

## 8. How to verify

```bash
# atlas-cli — expect 371/371
cd packages/atlas-cli && npm ci --ignore-scripts && npm run build && npm test

# apps/web — expect 73/73
cd apps/web && npm ci && npm run lint && npm test

# workflows — before touching any of them
python3 .github/atlas/check-workflows.py
```

Live readiness (needs the operator token as a Bearer credential):
`GET https://atlas-web.cornerstonemarketingus.workers.dev/api/setup/status`

---

## 9. Known limits, stated plainly

- **Secret detection is pattern-based**, anchored on vendor prefixes and
  credential-shaped assignment keys, not entropy. Deliberate — entropy scanning
  redacts git SHAs and lockfile hashes and wrecks the model's ability to reason
  about a repository. **A credential in an unrecognised format passes through.**
  Last line of defence, not a substitute for keeping secrets out of the repo.
- **Replay is not built.** Traces are written and readable; reconstructing or
  re-executing a session from one does not exist.
- **Task-to-run matching is exact only for runs created since `run-name` was
  added.** Older runs fall back to time-based matching, which can mis-attribute
  two concurrent dispatches in one repository. Cannot cross a tenant boundary.
- **`scripts/setup.mjs` has never run against real GitHub.** Every path was
  exercised against a stub, including failures and a leak check. First live run
  is its first contact with the real API.
- **`TODO.md` has 280 unchecked items.** It is a long-range roadmap, not a
  backlog of blockers. Do not read it as work owed.
