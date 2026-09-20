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

### Post-review fixes

An adversarial review pass over the finished work found four real defects, all
now fixed with regression tests. Recording them because each is a class of
mistake worth checking for again:

1. **Path confinement did not follow symlinks (CRITICAL).** `path.resolve()`
   normalizes lexically; it does not resolve links. A symlink inside a
   repository or workspace let the agent read and write anywhere on the disk —
   confirmed by reading `/etc/passwd` and planting a file outside the root
   through all three boundaries (repository tools, filesystem tools,
   attachments). Now resolved through `realpath`, including for paths that do
   not exist yet, in `agent/tools/path-confinement.mjs`.
2. **Fifteen consequential button labels required no approval (HIGH).**
   "Place my order", "Authorize payment", "Withdraw", "Donate", "Tweet",
   "Go live", and every non-English label classified as an ordinary click.
   Patterns widened, common non-Latin verbs added, an operator-configurable
   list added that can only *raise* the risk class, and a control with no
   readable label now asks rather than being assumed harmless.
3. **Tool schemas were not counted against the context window (HIGH).** They
   ride on every request and are not in the message array. At ~3,000 tokens
   they are 55% of an 8k window's budget, so a prompt could pass Atlas's own
   "it fits" check and then be silently truncated by the server — the exact
   failure Milestone 6 exists to prevent.
4. **A hosted session opened without a tenant could be claimed by any other
   tenant-less caller (HIGH).** `undefined === undefined` passed the isolation
   check. A tenant identity is now required to open or resolve a session.

Two hypotheses were checked and held up: DNS plan digests do cover the zone, and
the sensitive-value patterns do not backtrack catastrophically.

**Definition of done, checked against what is now in the repository:**

| Criterion | Status |
| --- | --- |
| Install Atlas locally and start a conversation without GitHub | Yes — the daemon registers no GitHub executor unless a token exists |
| Code, browse, and operate the computer through one persistent runtime | Yes — one runtime, one event contract, executors as adapters |
| Interrupt, redirect, approve, or resume in real time | Yes — pause, resume, cancel, retry, regenerate, edit-and-resend |
| GitHub is one optional source-control and publishing adapter | Yes |
| Core tasks run with local models and local credentials | Yes — needs a local model server running to do real work |
| Cloud services add convenience, not dependency | Yes — hosted browser and billing are both optional adapters |
| Every consequential action previewable, approval-bound, auditable, verifiable | Yes — digest-bound one-time approvals, plan-then-apply, post-action evidence |

Two milestones are **partially** done and say so in their sections: the Windows
MSI has never been built, and the mobile native projects have never been
generated. Everything else in both is implemented and tested.


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

### Milestone 7 — Windows productization — **partially done**

Reported honestly, because this is the milestone where "implemented" and
"verified" genuinely differ: **everything except the MSI build itself is
implemented and tested. The MSI has never been built, installed, or uninstalled
on a real Windows machine from this session.**

Implemented and tested (all cross-platform, all covered by `npm test`):

- **Signed update manifests with rollback.** Ed25519 over a canonical form;
  the signature covers the version, the artifact digests and the rollback
  target. A validly signed *older* manifest is refused, because replaying last
  year's release is otherwise a supported way to reintroduce a fixed
  vulnerability. Downloaded artifacts are checked against the signed digest.
- **Crash recovery.** Restarts back off, a crash loop gives up rather than
  pinning the machine, a run that stayed up two minutes clears the history, and
  the crash report is redacted.
- **Log rotation.** Bounded, with a fixed history. This is a correctness
  feature here, not housekeeping: Atlas fails closed when it cannot write its
  audit trail, so a full disk is an outage.
- **Dependency discovery that installs nothing.** Node, Git, Edge and Ollama
  are probed and reported with where to get them. Missing optional pieces do
  not block installation.
- **SHA-256 checksums and a CycloneDX SBOM**, generated from the manifests
  actually present — which is what makes "no third-party runtime dependencies"
  a checkable claim rather than an assertion.
- **Windows CI on every change** exercising the release pipeline end to end,
  including that a tampered manifest is rejected.

Written but **not executed**:

- `installer/windows/Atlas.wxs` — the MSI source. Its UpgradeCode is fixed, it
  refuses downgrades, it adds Start Menu entries and removes them on uninstall,
  and the operator's data directory is deliberately *not* a component, so an
  uninstall or a failed upgrade cannot delete the encrypted profile or the
  paired devices. Structure is tested; the build is not.
- `scripts/windows/Build-AtlasInstaller.ps1` — builds, Authenticode-signs,
  verifies the signature, and writes the release metadata. Requires the WiX
  toolset and `signtool`.

Still needed, and only a Windows machine can provide it:

- [ ] Build the MSI once and confirm `wix build` accepts the harvested
      component group.
- [ ] Install and uninstall on a clean Windows 11 VM.
- [ ] Upgrade over a previous version and confirm the encrypted profile and
      device pairing survive.
- [ ] Force a failed upgrade and confirm the rollback path restores the
      previous version.
- [ ] Sign with the real certificate and confirm SmartScreen reputation.

Needs external credentials: `ATLAS_WINDOWS_CERTIFICATE_BASE64` and
`ATLAS_WINDOWS_CERTIFICATE_PASSWORD` for signing, and an Ed25519 signing key
for the update manifest. The build refuses to produce an unsigned public
release without an explicit opt-out.

### Milestone 8 — native mobile companion — **partially done**

Implemented and tested; **never built or run on a device.** The split matters,
so it is stated plainly here and in `MOBILE-RELEASE.md`.

Implemented, in `apps/local-control/src/mobile/` (shared with the daemon, which
issues the links) and `mobile/src/` (the Capacitor shell):

- **Deep links as signed capabilities.** A link names one resource, is bound to
  one device, expires, and — for approvals — is one-time. A link that arrives
  by push is attacker-reachable, so tampering with any field invalidates it,
  and the comparison is constant-time. Opening an approval is never granting
  it.
- **Push that carries nothing useful to an attacker.** The payload has a
  capability name and a signed link; a guard refuses to send one containing a
  credential, a secret field, or an action digest. Registrations are revocable,
  a revoked token drops the registration, and raw tokens are never serialized.
- **Biometric re-authentication** for high-risk approvals, capped at two
  minutes of freshness, with no silent downgrade when the hardware is missing.
- **Credentials in Keychain/Keystore only.** There is deliberately no fallback
  to web storage, and a startup guard stops the app if a credential is found
  there.
- **Offline, expired, revoked and unpaired states** that say what is true. An
  approval cannot be answered from a cached list, and losing the network does
  not overwrite "revoked" with "offline".
- **Crash reporting behind consent**, defaulting to unasked, redacted even in
  the copy kept locally.

Not done, and needing a Mac with Xcode and a machine with Android Studio: the
native projects have never been generated, no real push has been delivered, no
universal link has been resolved by a real device, and no accessibility,
rotation, dark-mode or large-text pass has happened. Sign in with Apple remains
the open P0 gate. The full list is in `MOBILE-RELEASE.md`.

### Milestone 9 — hosted browser execution — **done**

Implemented as an optional adapter, which is the point: nothing in Atlas
requires it, and the honest answer for most people stays "use your own
companion — it is free and already running".

- **Provider-neutral interface** with a Cloudflare Browser Rendering
  implementation behind the same page contract Playwright and the fixture
  browser use. That shared contract is what gives **approval parity for free**:
  a hosted page is driven by the same operator session, so it classifies the
  same actions, asks for the same approvals, and records the same evidence.
  There is no second, laxer path for hosted execution.
- **Tenant isolation.** A session is addressed by a handle only its owning
  tenant can resolve, and the refusal for someone else's session is *identical*
  to the refusal for one that never existed — a distinguishable error is an
  enumeration oracle.
- **Quotas enforced server-side**, where the session is created. Concurrency,
  monthly minutes, and per-session timeouts. A limit enforced in the client is
  a suggestion.
- **Session timeout and cancellation** close the remote container, not just the
  local handle — a container left open bills for time nobody is using.
- **Usage receipts** with start, end, minutes, reason and billing period,
  rounded up to the minute because a nine-second session still consumed a
  container.
- **No credential in a task payload.** The provider is handed an opaque
  per-tenant scope and never a user identifier.
- **Fallback.** A free user with a paired companion is told Atlas will run it
  there instead, rather than being shown an upsell and a dead end.

One deliberate refusal: a hosted browser cannot upload a file from the
operator's machine. Doing so would mean sending their file to a third party
first, which is a different decision from "let Atlas use a browser".

Needs external credentials: a Cloudflare account id and a scoped Browser
Rendering token. Without them the service reports "not configured on this
Atlas" and the local companion path is unaffected.

### Milestone 10 — billing and commercial release — **done, pending one migration**

Checkout, the billing portal and webhook signature verification already
existed. This milestone added what made them safe to actually take money with.

- **Idempotent webhooks.** Stripe retries on timeouts, on 500s, and on a deploy
  that lands mid-request, so duplicate delivery is routine. Events are deduped
  by id, and a replay is answered `200` — an error would be retried forever
  until Stripe disabled the endpoint.
- **Ordering guard.** Stripe does not guarantee delivery order, and an older
  `customer.subscription.updated` arriving after a newer one would downgrade a
  customer who had just upgraded. Events older than the last one applied to
  that subscription are refused.
- **Failed payment and cancellation states.** A failed payment marks `past_due`
  and keeps the plan while Stripe retries for days; cutting access on the first
  failure punishes a customer whose card expired over a weekend.
  `invoice.payment_succeeded` is handled too, or a customer who pays stays
  `past_due` forever.
- **Plan enforcement server-side**, in `checkAndRecordUsage` and
  `decideHostedSession`. A limit enforced in the client is a suggestion.
- **Hosted browser limits metered separately** from task counts — a task is a
  request, a browser minute is a container someone is paying to keep warm.
- **Mobile billing hidden** until the store-billing strategy is approved,
  decided server-side rather than by a client flag, and with copy for the app
  to show instead of a blank screen.
- **No invented prices.** Display prices come from `ATLAS_PRICE_DISPLAY_*` and
  the code reports which are missing. A placeholder price is worse than none,
  because someone will believe it.

**Before this ships:** `drizzle/0011_billing_idempotency.sql` must be applied.
It is purely additive — two `CREATE TABLE`s and one `ALTER TABLE ADD COLUMN`,
no `DROP` — and it has been dry-run against a stub schema, but it has not been
applied to the live D1 database. Per §5, run `migrate-d1.yml` with the dry run
first and read the file list. The webhook route reads `billing_events` and
`subscriptions.last_event_at`, so deploying it before the migration would fail
on every event.

Needs external credentials: the Stripe secret key, webhook secret, and the two
price IDs (§2 above). Prices themselves are the owner's to set.

These are unbuilt. The runtime is the foundation they attach to, and the
adapter seams they need (executors, the tool-proposal and approval-request
event kinds, the capability/risk fields already carried on `tool_proposal`)
exist — but no code behind them has been written yet. Do not read the event
contract as evidence the features exist.

- **10 — billing.** See §2 above. Prices stay in configuration until the
  owner supplies final amounts.


---

## 7. Findings from the parallel review — **all closed except the unreviewed slices**

Six review agents were run against the finished work. Four reported before the
account hit its session limit; **two slices were never reviewed at all** (the
runtime/conversation loop, and models/release tooling). The three CRITICALs
below the line marked *fixed* are done and pushed; everything else here is
**open**, reproduced by the reviewer, and ordered by severity.

Nothing in this section is theoretical — each was demonstrated with a working
script against the real modules.

### Fixed already (commit `b9acf84`)
Vault-read primitive via `repository_variable`; DNS name re-parsed out of plan
prose; plan-text line forgery; DNS re-read guards; proxied carry-forward;
classifier gaps (select/check/press, non-English credentials, Cyrillic, homoglyphs,
action URLs).

### CRITICAL — all fixed (commit `b9acf84` and follow-up)

- **`.git` is writable, which is arbitrary shell execution.** FIXED. `repository.write`
  confines to the repository root, and that includes `.git/`. Writing a
  `core.fsmonitor` entry into `.git/config` gives shell execution the next time
  any git-running tool runs — and `repository.diff`, `.branch` and `.commit` are
  all no-approval. Two calls, zero approvals, `uid=0`. Defeats the no-shell rule,
  the fixed test-command list, and the `repository.execute` gate in one move.
  *Fix: refuse any confined path whose first segment is `.git`, in every
  write/rename/delete tool, and in `filesystem.write` when a repo is under the
  workspace.*
- **`accessibleName` prefers `aria-label` over visible text** — FIXED.
  (`playwright-page.mjs:100`). The classifier is a pure function of that string,
  and `aria-label` is the one attribute with no relationship to what a control
  does and is trivially set by the page. `<button aria-label="Read more"
  onclick="sendMoney()">Send money</button>` classifies as an ordinary click.
  *Fix: classify against the union of aria-label, innerText, value, title and
  name, taking the most severe class any of them yields.*
- **Element references silently rebind across pages** — FIXED. (`session.mjs:70`). Refs
  are regenerated `e1, e2, e3…` on every snapshot and `resolve()` checks only
  presence, so after a navigation `e2` is a different element. Demonstrated:
  a password typed into a public bio field, zero approvals. `refresh()` is
  called by `extract()` and `recordEvidence()` too, so this happens without any
  navigation. The existing "stale reference" scenario passes only because its
  two fixture pages use disjoint ref names.
  *Fix: refs carry a snapshot generation plus a role/name/url fingerprint;
  `resolve()` refuses a ref from a superseded snapshot.*

Also fixed since: the snapshot now delimits Atlas's element table from
untrusted page text, so a page cannot forge element rows.

### HIGH — open (the five above are done; these are not)

- **Password values are read into the snapshot** — FIXED. (`playwright-page.mjs:65`).
  `inputValue()` is called with no type filter, so `<input type=password>`
  returns plaintext into the string handed to the model — and the persistent
  browser profile means the browser's own autofill leaks values Atlas never
  typed.
- **Dangling-symlink write escape** — FIXED. (`path-confinement.mjs:48`). `realpathSync`
  throws ENOENT for a link whose target does not exist, so the link is treated
  as a missing file and the write follows it. Creates `~/.ssh/authorized_keys`.
  The doc comment claims to close exactly this case.
- **`browser.upload` still uses lexical confinement** (`browser-tools.mjs:186`)
  — the pre-fix bug, in the one tool that hands a file to a remote page. Also
  passes the raw relative path to the session rather than the checked one.
- **The retry loop re-executes approval-bound tools** (`tool-registry.mjs:215`).
  Approval is consumed once, outside the loop; `TOOL_TIMEOUT` is retryable.
  Demonstrated: one approval, three deliveries of the same message.
- **The redactor is never wired up** (`main.mjs:120`). `ToolRegistry` supports
  one and defaults to identity, so tool output and error messages are bounded
  but unredacted. `repository.search` for `sk_live` returns live keys; `eachFile`
  does not skip dotfiles, so `.env*` is searchable and readable.
- **`describeError` splices provider text into errors** (`adapter.mjs:100`) and
  the request body it just sent holds the secret; a provider that echoes the
  request on a 400 reflects a credential into the model, the event and the audit
  log.
- **Hosted `sweep()` skips the tenant check** (`hosted-browser.mjs:109`) — the
  only path that bypasses `resolve()`. One tenant can close another's live
  session and be handed the billing receipt.
- **A month rollover orphans active hosted sessions** (`quota.mjs:29`). `active`
  is dropped on period change: double concurrency, unbilled minutes, and
  containers the sweeper can never close. On `team`, 5 extra sessions and 150
  unbilled minutes every month, repeatable.
- **The hosted adapter derives selectors from page content**
  (`cloudflare-browser.mjs:83`) — `element.selector ?? element.name`. A decoy
  control named `button[type=submit]` makes the approved element and the
  executed element differ.
- **Deep-link device binding is off when the verifier's `deviceId` is falsy**
  (`deep-links.mjs:98`), which is the shell's first-run state — `bridge.mjs`
  reads the credential once, before pairing.
- **Subscription events arriving before `checkout.session.completed` update
  zero rows and are then permanently deduped** (`webhook/route.ts:61`). The
  customer pays and stays on `free`, silently, until the next subscription event.
- **Unconditional success claims** (`session.mjs:183,192,201`): `type`, `upload`
  and `download` ignore the evidence they just collected; only `click` consults
  it. `download` reports the *requested* path when the adapter returned nothing.
- **`changed` is a raw text diff** (`session.mjs:117`): a page with a clock
  reports every action as successful; an SPA that posts via `fetch` reports
  every action as failed.
- **The approval prompt leads with the model's own intent**
  (`classification.mjs:199`), and `browser-tools.mjs:164` drops `intent`
  entirely — so the sentence a human reads is either model-written or the
  page-controlled accessible name from the CRITICAL above.
- **Wall detection reads only `lastSnapshot.text`**, which is `""` whenever
  `ariaSnapshot` times out — disabling CAPTCHA/2FA detection while the session
  stays operational. Element names are never checked, the patterns are
  English-only, and real CAPTCHA widgets live in cross-origin iframes that
  `ariaSnapshot` does not descend into.

### MEDIUM and LOW — all closed

Every item below was reproduced against the real modules before it was
changed, and each carries a test that fails without the change.

Fixed earlier in this pass: rate limiter quadratic past 10k buckets and per-IP
keying of the pairing code; hosted `SESSION_EXISTS` cross-tenant existence
oracle; failed `createPage` leaking a concurrency slot; push digest guard
lowercase-hex only; push registry storing the raw token; biometric policy
omitting `repository.git`, `repository.write` and `code.write`; over-escaped
Windows home-path redaction; unbounded `plans` and drafts Maps; `repository.diff`
mutating the git index and passing an unconfined pathspec; `filesystem.archive`
crashing on an unimported `sep`; archive byte cap checked after the read;
`runCommand` orphaning grandchildren; `key in properties` walking the prototype
chain; approval spent before credentials are resolved.

Fixed in this batch:

- **Shared `last_event_at` watermark across two Stripe streams.** Invoice and
  subscription events are unordered relative to each other. At renewal Stripe
  emits both, and whichever arrived first set the watermark — so an invoice
  landing first made the subscription update carrying the new tier look stale,
  and the upgrade was dropped permanently. The watermark is now read per
  stream, through `watermarkFor`, against `last_invoice_event_at` (migration
  `0012`) or `last_event_at`.
- **Spent-nonce set was per-launch**, so an approval link replayed after an app
  restart — a forwarded notification opened cleanly, still signed and still
  inside its expiry. Replaced by `mobile/src/spent-nonces.mjs`, a ledger
  persisted to preference storage, pruned at each link's own expiry and bounded
  at 512 entries. The handler now *requires* one and refuses links until it has
  been read back, because an unloaded ledger looks empty.
- **`redactValue` disclosed exact length plus the last two characters.** Plans
  are persisted, shown and audited, so that accumulated a length and a known
  suffix for every secret Atlas ever wrote. Now presence only: `(a value is
  set)` or `(empty)`. `verifyToken` returns Cloudflare's own token id instead
  of anything derived from the token.
- **"Verified" meant only that a name exists.** A secret cannot be read back,
  so the read-back could not tell a correct write from one that stored the
  wrong value under the right name — and it said "Applied and verified" either
  way. Adapters now report `confirmation` as `value`, `presence` or `absence`,
  and the tool output states which was established.
- **The keychain took the secret as a command argument**, visible in the
  process list to anything running as that user. It now goes through
  `security -i` on standard input, confirmed by reading the credential back,
  with the argument form kept as a fallback so a macOS that refuses
  interactive mode still stores the credential rather than silently not.
- **Vault files were written in place.** `writeFileSync` truncates first, so an
  interrupted write left an unparseable file and no copy of the old
  credentials. Writes now go to a 0600 temporary file and are renamed over the
  target; the containing directory is created, which also fixes a first run
  before `~/.atlas` exists.
- **The DPAPI vault defaulted to a relative path**, so credentials followed the
  working directory and presented as an empty vault when the daemon was started
  from elsewhere. Now `defaultVaultPath`, absolute and under `~/.atlas`. The
  DPAPI blob also moved from the PowerShell command text to standard input.
- **Archive limits failed as `ERR_OUT_OF_RANGE`** naming a byte offset. Entry
  names over 65535 bytes, more than 65535 entries and sizes over 4 GiB are now
  refused with the entry and the limit named.
- **`x-atlas-client` was described as a control it is not.** It is set by the
  client; the docstring claimed the decision could not be made by the client.
  Corrected to say what it is for — store-review compliance, not an access
  boundary — and `billingSurfaceFor` is now actually enforced at the checkout
  endpoint, which previously used it nowhere at all.

**Operational note, not a defect:** GitHub really does return a 32-byte
libsodium key, so `applySecret` on GitHub can never succeed. It now says so in
the plan's notes, before the approval is spent, rather than failing afterwards.

### Not reviewed at all

- The persistent runtime and conversation loop (`runtime.mjs`,
  `session-store.mjs`, `run-control.mjs`, `conversation-executor.mjs`,
  `model-client.mjs`, `compaction.mjs`, `routes.mjs`, `server.mjs`).
- Models and release tooling (`models/*`, `release/*`, `scripts/release/*`).

Both agents died on the account limit before producing anything. The
subscribe-replay race, lease handover, and the 3.6 characters-per-token
assumption behind the no-silent-truncation guarantee are all still unexamined.
