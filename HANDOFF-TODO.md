# Atlas — pending work

Companion to `HANDOFF.md`. Updated 2026-09-14 after the production setup completed.

> **Naming:** this file is *not* `todo.md`. The repository already has `TODO.md`
> — a 353-item long-range roadmap (280 unchecked). On a case-insensitive
> filesystem (macOS, Windows) `todo.md` and `TODO.md` are the same path, so a
> new lowercase file would silently overwrite that roadmap. This file is the
> short, actionable list of *what is blocking a working product today*.
> `TODO.md` is aspiration; this is the blocker list.

Ordering matters. Items in §1 gate everything below them.

---

## 1. Production setup — completed

The initial Atlas instance is configured and live. The new `/setup` control
center now reports these checks from the running Worker without returning
secret values. A brand-new instance still needs one trusted bootstrap path;
the coding agent never receives account-administration credentials.

- [x] **1.1 — Grant `ATLAS_GITHUB_TOKEN` the `Actions: Read and write`
      permission.**
      Fixes the live bug in `HANDOFF.md` §4.1: every scheduled self-improvement
      run since Sep 6 has died with `curl: (22) ... error: 403` at the dispatch
      step. The token can read pull requests (the guard step passes) but cannot
      POST to `/actions/workflows/{id}/dispatches`.
      Where: https://github.com/settings/tokens?type=beta → edit the token →
      Repository permissions → **Actions: Read and write** → Update.
      Verify: run `atlas-self-improve.yml` manually from the Actions tab; the
      "Dispatch the coder agent" step should print `Dispatched.`

- [x] **1.2 — Add `D1: Edit` and `Account Settings: Read` to
      `CLOUDFLARE_API_TOKEN`.**
      The token deploys Workers but cannot touch D1, so migrations cannot run
      (`HANDOFF.md` §4.2). The dry run picked the right files; the real run died
      on `Unable to get membership roles`.
      Where: https://dash.cloudflare.com/profile/api-tokens

- [x] **1.3 — Confirm the D1 database name.**
      `migrate-d1.yml` was last exercised with `database_name=atlas-db`, the
      documented default. The real name lives in the `ATLAS_D1_DATABASE_NAME`
      secret and **has never been confirmed** — the run failed on permissions
      before it got far enough to tell us. Check the name in the Cloudflare
      dashboard (Workers & Pages → D1) against `wrangler.jsonc` before 1.4.

- [x] **1.4 — Apply migrations `0001_square_mandroid.sql` and
      `0002_short_prowler.sql`.**
      Run `migrate-d1.yml` with the dry run **first**, read the file list, then
      re-run for real. Both are purely additive (`CREATE TABLE` /
      `CREATE INDEX`, no `DROP`, no `ALTER`).
      Until this lands the `users`, `subscriptions`, `task_usage` and `tasks`
      tables **do not exist** and any sign-up writes to missing tables.

- [x] **1.5 — Create the GitHub OAuth App.**
      https://github.com/settings/applications/new
      Homepage: `https://atlas-web.cornerstonemarketingus.workers.dev`
      Callback, character for character:
      `https://atlas-web.cornerstonemarketingus.workers.dev/api/auth/github/callback`
      A mismatched callback fails at GitHub's end with an error the app never
      sees, so this is worth pasting rather than typing.

- [x] **1.6 — Set three repository secrets.**
      https://github.com/cornerstonemarketingus/atlas/settings/secrets/actions/new
      - `ATLAS_SESSION_SECRET` — 32+ random bytes. Rotating it logs everyone out.
      - `ATLAS_GITHUB_OAUTH_CLIENT_ID` — from 1.5
      - `ATLAS_GITHUB_OAUTH_CLIENT_SECRET` — from 1.5 ("Generate a new client
        secret"; it is shown once)

- [x] **1.7 — Re-run `deploy-cloudflare.yml`.**
      Worker runtime secrets are uploaded by the deploy, so secrets added in 1.6
      do not reach the running Worker until a deploy runs.
      **Read the "Upload Worker runtime secrets" step output.** It prints what
      uploaded and what was skipped, and it is the only trustworthy statement of
      what the live Worker can see. Expect `Uploaded 5 Worker secret(s).` and no
      `ATLAS_SESSION_SECRET` / `ATLAS_GITHUB_OAUTH_*` in the skipped list.

- [x] **1.8 — Verify sign-in actually works.**
      Open the live URL in a private window and sign in with GitHub. This is the
      first end-to-end exercise of the auth path against real GitHub; it has
      only ever run against a stub.

---

## 2. Billing — optional, and only for taking money

Atlas is fully usable without any of this. `ATLAS_OPERATOR_TOKEN` already
bypasses plan gating, which is how the owner uses it free today. Do §2 only when
opening paid sign-ups.

- [ ] **2.1 — Create Stripe products/prices**, note the price IDs.
- [ ] **2.2 — Set `ATLAS_STRIPE_SECRET_KEY`, `ATLAS_STRIPE_WEBHOOK_SECRET`,
      and the price-ID secrets**, then re-deploy (same reason as 1.7).
- [ ] **2.3 — Point the Stripe webhook at `/api/billing/webhook`** and send a
      test event. An unverified webhook means subscriptions never activate.

---

## 3. Repository housekeeping

- [ ] **3.1 — Review and close stale PR #16 if it has nothing to preserve.**
      Atlas now counts only `atlas/task-*` pull requests toward its autonomous
      review limit, so unrelated human work no longer blocks the nightly queue.
      Closing a stale Atlas PR remains a human review decision.

- [x] **3.2 — Vercel no longer serves a broken copy of the product.**
      `vercel.json` used to publish `apps/web/dist/client` — static assets with
      no server — while every database route imports `cloudflare:workers`, which
      cannot run outside Workers. The preview looked like Atlas and failed on
      sign-in. It is now a catch-all **307 redirect** to the Worker, with a
      meta-refresh page behind it for anything that bypasses the redirect.
      307 rather than 301 on purpose: a permanent redirect is cached by browsers
      more or less forever and would be painful to undo if the project is ever
      pointed somewhere real.
      Still optional: disconnecting the Vercel project entirely, which is an
      account action and no longer urgent now that the URL lands on Atlas.

- [x] **3.3 — Keep the nightly run at 4am Chicago time across DST.** The
      workflow schedules both possible UTC hours and proceeds only when the
      timezone-aware gate resolves to 04:00 in `America/Chicago`.

---

## 4. Improvements worth doing, none of them blocking

- [ ] **4.7 — Complete native mobile release gates.** The web app now has an
      installable manifest, public legal pages, and an authenticated deletion
      request path. The remaining Apple/Google gates and native-value plan are
      tracked in [`MOBILE-RELEASE.md`](MOBILE-RELEASE.md). Do not submit a plain
      WebView: add push approvals, biometric re-auth, secure storage, and deep
      links first.

- [ ] **4.1 — Complete the GitHub App manifest bootstrap flow.**
      A manifest flow creates the app *and* returns its credentials in one
      redirect, which removes three of the manual steps above and the
      copy-paste errors that come with them. Bigger change than it sounds: the
      token model differs (installation tokens, not user tokens), so the auth
      path in `apps/web/app/api/auth/` needs rework.

- [x] **4.5 — Add a mobile setup status center and protected operator session.**
      `/setup` presents the eight production checks at phone width. The access
      code is exchanged for an HttpOnly signed session and is no longer kept in
      browser `localStorage`.

- [x] **4.6 — Add explicit model fallback and bounded retry controls.** Coder
      jobs can use an operator-configured provider/model route list. All routes
      share the same output-token budget, and authentication or invalid-input
      failures never fall through to another vendor.

- [ ] **4.2 — Build replay.** Traces are written and readable, but nothing
      reconstructs or re-executes a session from one. This is the single
      highest-value unbuilt feature: "show me exactly what the agent did and
      why" is the demo that sells the verification claim.

- [ ] **4.3 — Widen secret detection beyond vendor prefixes.**
      Detection is pattern-based on purpose (entropy scanning redacts git SHAs
      and lockfile hashes and wrecks the model's reasoning), but a credential in
      an unrecognised format passes through. Any widening needs a test proving
      it does not start eating SHAs.

- [ ] **4.4 — Exercise `scripts/setup.mjs` against real GitHub.**
      Every path is tested against a stub, including failures and a leak check.
      It has never touched the real API. Needs a terminal, which the owner does
      not have — so this is for whoever picks it up next, not for him.

---

## 5. Before you change anything — read `HANDOFF.md` §6 and §7

The short version, because these have each already cost a day:

- Run `python3 .github/atlas/check-workflows.py` before pushing **any** workflow
  change. A malformed workflow fails with zero jobs and no error message.
- A literal `${{` anywhere in a `run:` block — even inside a string being
  searched for — makes GitHub reject the whole workflow before YAML matters.
- Check `packages/atlas-cli/src/cli.ts` wires whatever you add, and add a test
  that fails without the wiring. Three complete, correct features shipped inert
  because nothing constructed them.
- Do not "fix" the fact that assistant tool-call arguments are unredacted. That
  is deliberate and documented; redacting them corrupts customer files.
- Never give the agent credentials that can write secrets or mint tokens. It
  runs unattended and edits its own source.

---

## 6. Interactive AI operator — scope status

The goal is that Atlas stops being a GitHub Actions application: a local-first
conversational operator, with GitHub as one optional publishing adapter.

Status is reported in three separate columns on purpose — **implemented**
(code exists and is tested), **configured** (wired into the running product),
and **needs external credentials** (blocked on something only the owner can
supply). A feature that is implemented but unconfigured is not working
software, and the distinction has cost this repository real days.

### Milestone 1 — persistent agent runtime — **done**

Implemented and configured. See [`docs/agent-runtime.md`](docs/agent-runtime.md).

- Long-running local daemon owns agent execution (`apps/local-control`).
- Sessions, turns, and an append-only event log persist across restarts.
- Nine normalized event kinds stream over resumable SSE (`?after=` /
  `Last-Event-ID`).
- Pause, resume, cancel, retry, reconnect — over HTTP and in the local UI.
- Work runs in isolated Git worktrees; the operator's checkout is never
  touched.
- Leases with heartbeats; boot-time recovery of interrupted sessions.
- Token, time, tool-call, and cost budgets that survive restarts.
- GitHub Actions is an executor adapter, registered only when
  `ATLAS_GITHUB_TOKEN` and `ATLAS_GITHUB_REPOSITORY` are set. The existing
  workflow path is untouched.

Needs external credentials: nothing for local operation. A local model server
(Ollama) must be running for a coding session to do real work — without one
the run fails with a clear message, which is the correct behaviour, not a bug.

Two pre-existing bugs were found and fixed while building this:

- **Created files were missing from every portable patch.** The isolated
  runner captured `git diff`, which ignores untracked files — so every file
  the coder *created*, the common case for an agent, was silently dropped. It
  now stages into the throwaway worktree's own index and captures
  `git diff --cached`. Regression test:
  `agent-worktree.test.mjs`.
- **A cancelled run could report success.** An executor that swallowed its
  abort signal and returned `completed` was believed. Cancellation is now
  authoritative.

### Milestone 2 — conversational agent loop — **done**

Implemented and configured. The `conversation` executor streams a real
multi-turn loop against any OpenAI-compatible endpoint (Ollama, llama.cpp,
vLLM, LM Studio), so no hosted provider is involved.

- Incremental streaming: partial `assistant_message` events carry deltas, the
  final one carries the whole answer, so a client that joins late needs no
  replay of tokens.
- The model requests bounded tools; arguments are validated against a declared
  schema before anything executes, and unknown properties are refused rather
  than dropped.
- Private reasoning never leaves the daemon. Inline `<think>` blocks — which
  reasoning models emit inside `content`, where they would otherwise *be* the
  answer — are stripped, and the reasoning summary reveals no content unless an
  operator configures a summarizer.
- Attachments: images (inline as data URLs, so nothing is uploaded anywhere),
  text, repository files, screenshots, and PDFs with dependency-free text
  extraction that returns nothing rather than inventing content it could not
  read.
- Dictation against a configurable transcription endpoint, loopback by default.
- Stop-generation, regenerate, edit-and-resend, and retry. Editing a turn
  removes the answers that followed it, because they replied to a question that
  no longer exists.
- Compaction keeps the objective, pinned decisions and approvals, and
  tool-call/result pairs; it refuses rather than silently truncating what it
  cannot fit.

Needs external credentials: none. A local model server must be running to do
real work.

### Milestone 3 — tool runtime — **done**

Implemented and configured. Six families, every tool declaring a complete
contract before it can register.

- **Repository** — list, read, search, write, rename, delete, diff, branch,
  commit, and run one of a fixed set of verification commands.
- **Browser** — navigate, accessibility snapshot, click, type, submit, upload,
  download, extract. Accessibility-first: the model works from named element
  references, never coordinates, because a pixel is not something an operator
  can meaningfully approve.
- **Filesystem** — bounded read/write inside a named workspace, ZIP archiving
  (written by hand; this package takes no third-party dependencies), and
  artifact receipts that record where a file is without copying it anywhere.
- **Communications** — draft, request a decision, and send. A message must be
  drafted before it can be sent, so the operator has read the exact text.
- **Business workflows** — job application, CRM research, sales prospect, and
  marketing campaign briefs. Preparation only: none of them sends, submits, or
  applies, and an unsourced claim is labelled as unsourced.

Enforcement, all tested:

- Commands run without a shell, with an allow-listed environment, so a
  credential exported beside the daemon is not visible to a tool.
- Every path argument is confined to its repository or workspace root.
- A branch name cannot smuggle a command-line option.
- Approvals are one-time and bound to a digest over the session, the tool and
  the exact validated arguments. Editing a message after approval invalidates
  it; a denial stops the session rather than letting the model re-propose.
- Bulk outreach is refused outright rather than gated, since a limit an agent
  can ask permission to exceed is not a limit.

Needs external credentials: a browser session (the Windows companion, M5) and
a message transport for `communications.send`. Both fail closed with a clear
message until configured.

### Milestone 4 — infrastructure administration — **done**

Implemented; configured as far as it can be without the owner's tokens.

Adapters for Cloudflare (zones, DNS, Workers, D1, KV, R2, Browser Rendering),
Vercel (projects, deployments, domains, encrypted environment variables), and
GitHub/GitLab/Forgejo (settings, variables, secrets, workflows).

The shape that makes this safe:

- **Plan, then apply.** `infrastructure.plan` is a dry run that reads current
  state and returns the exact target, a redacted preview, and whether the
  change is reversible. `infrastructure.apply` needs approval bound to that
  plan's digest — so what is approved is *this record on this zone*, not
  "permission to change DNS". A plan is spent when applied.
- **Secret values never pass through the model.** The model names a credential
  *reference*; the vault resolves it at apply time. There is no `value`
  argument in any schema, and passing one fails validation.
- **Write-only secrets.** Vercel will decrypt an environment variable on
  request and Atlas deliberately does not ask — verification is by metadata.
  GitHub secrets are sealed against the repository's public key before they
  leave the process.
- **Verified after the fact.** Every apply reads the resource back, and
  reports a failure if it cannot confirm the change. Vercel rollback is
  supported because Vercel supports it; nothing claims a rollback it cannot do.
- **Credential vault** — DPAPI on Windows, Keychain on macOS, libsecret on
  Linux, scrypt+AES-256-GCM file as a fallback. `list()` returns names only.
  Secrets are written to a process's stdin, never passed as arguments where
  they would sit in the process table.

Needs external credentials: `ATLAS_CLOUDFLARE_TOKEN`, `ATLAS_VERCEL_TOKEN`,
`ATLAS_GITHUB_TOKEN` + `ATLAS_GITHUB_REPOSITORY`. Each must be a *scoped*
token. Without them the tools are registered and answer "not configured on
this machine", which is a better answer than the capability silently not
existing.

One caveat, stated because it will bite otherwise: GitHub's secrets API
documents libsodium sealed boxes. Atlas seals with RSA-OAEP through Node's own
crypto and refuses loudly if the host returns a non-RSA key, rather than
falling back to sending a plaintext secret. If GitHub returns a libsodium key
for your repository, set that secret through GitHub's own interface.

### Milestone 5 — computer operator — **done**

Implemented in `apps/windows-companion/src/operator/`, and driven by the
daemon over a Playwright page adapter when one is available locally.

- **Accessibility first, screenshot as fallback.** The model reads named
  elements and acts on references. A screenshot is taken only when the
  accessibility tree comes back empty, is stored on the operator's disk, and
  is never uploaded by being taken.
- **Deterministic classification.** Every action is classified by a pure
  function of the action and the element — read, navigate, input,
  sensitive input, submit, transfer, destructive, unsupported. A reassuring
  description from the model cannot downgrade the element: "just tidying up"
  on a button labelled *Delete this project* is still destructive.
- **Walls only a person can pass** — CAPTCHA, 2FA, re-authentication, identity
  verification, payment — are detected and hand the machine back, with the
  evidence quoted. Atlas refuses these even when approval has been granted.
- **Evidence before claiming.** Every acting method re-reads the page
  afterwards and records whether anything changed. A click that changed
  nothing is reported as a click that changed nothing, not as success.
- **Stale references** after a navigation or a popup are refused with an
  instruction to take a fresh snapshot, rather than clicking whatever now sits
  at that reference.
- **Twelve deterministic demo workflows** run against an in-memory fixture
  browser implementing the same page contract as Playwright, so they exercise
  the real classification, approval, evidence and CAPTCHA logic and run
  anywhere without touching a live site.

Found and fixed while building this: the typed value flowed into the
classification label, so the approval prompt for "type your password" would
have displayed the password — and written it to the audit log. Values are now
inspected to raise the risk class but never echoed.

Needs external credentials: none. Needs Playwright and a browser on the
machine, or the paired Windows companion; without either, the browser tools
answer "no browser on this machine".

### Milestone 6 — local models and routing — **done**

Implemented and configured. `GET /v1/models/health` reports the lot.

- **Hardware detection** — CPU, RAM, and GPU (nvidia-smi, then per-platform
  best effort). The figure that decides model choice is dedicated VRAM when
  there is a discrete GPU and system memory otherwise.
- **Discovery** — Ollama's native API and the OpenAI-compatible `/models`
  list, across the five ports these servers usually sit on. A server that is
  not running is a normal result, not an error. A plain-HTTP non-loopback
  endpoint is never contacted.
- **Recommendations** — the largest model that fits, per task, with what is
  installed reported separately from what would be better. Erring small is
  deliberate: a model slightly too large makes the machine unusable.
- **Context fit, and no silent truncation.** Context windows come from the
  server where it will say and are otherwise inferred — and an inferred figure
  is *labelled* inferred, because the difference matters. A prompt that does
  not fit is compacted with the operator told, or refused with the numbers.
  Nothing is ever sent for the server to quietly trim.
- **Task-aware routing** for planning, coding, vision and summarization, with
  bounded fallback that walks only the routes configured for that task.
  Authentication and invalid-input failures never fall through — a second
  identical error is not a diagnosis.
- **Evaluation fixtures** that answer the question that matters before giving
  a model tools: can it produce a valid tool call, can it refrain from calling
  one when none is needed, and can it emit strict JSON.
- **No vendor in customer-facing copy.** A route reads as "this machine" or a
  host; raw endpoint URLs and credentials appear nowhere in the health report,
  which the daemon boot test asserts.

Needs external credentials: none. Routes are configured through
`ATLAS_MODEL_ROUTES` (a JSON array of `{task, model, endpoint, contextWindow}`).

### Milestones 7–10 — not started

These are unbuilt. The runtime is the foundation they attach to, and the
adapter seams they need (executors, the tool-proposal and approval-request
event kinds, the capability/risk fields already carried on `tool_proposal`)
exist — but no code behind them has been written yet. Do not read the event
contract as evidence the features exist.

- **7 — Windows productization.** ZIP packaging and optional Authenticode
  signing exist; there is no MSI/MSIX, update manifest, or rollback.
- **8 — native mobile companion.** Tracked in
  [`MOBILE-RELEASE.md`](MOBILE-RELEASE.md). Do not submit a plain WebView.
- **9 — hosted browser execution.** Design notes only
  (`docs/hosted-approval-state-design.md`).
- **10 — billing.** See §2 above. Prices stay in configuration until the
  owner supplies final amounts.
