# Launching Atlas

Everything in code is done. What remains is configuration that only you can do,
because it needs accounts and credentials that live outside this repository.

**Live URL:** https://atlas-web.cornerstonemarketingus.workers.dev

Work through this in order. Each step says how to tell it worked, because
"the deploy went green" does not mean the feature works — a deploy succeeds
whether or not a secret behind it is set.

---

## 0. Check where you actually are

Sign in with your operator token and open:

```
GET /api/setup/status
Authorization: Bearer <ATLAS_OPERATOR_TOKEN>
```

It returns five booleans and no secret values. Everything below exists to turn
one of them `true`. Re-check it after each step — it is the fastest way to tell
a configuration change actually reached the running Worker.

---

## 1. Apply the database migrations — do this first

**Nothing about sign-up works until this is done.** `provision-d1.yml` created
the database and applied only the initial schema. The tables that hold users,
subscriptions, usage counts and task history were added later and have never
been applied, so a sign-in attempt today would write to tables that do not
exist.

1. Open https://github.com/cornerstonemarketingus/atlas/actions/workflows/migrate-d1.yml
   and click **Run workflow**
2. `database_name`: whatever `ATLAS_D1_DATABASE_NAME` is set to (default `atlas-db`)
3. `from_migration`: `0001`
4. `dry_run`: **true** — read the SQL it prints
5. Re-run with `dry_run`: **false**

Migrations apply in order and stop at the first failure, so a partial run leaves
you at a known point rather than a mixed schema.

---

## Two ways to do this

**Browser only — no terminal required.** Every step below is a web form. Direct
links are given at each step; nothing here needs a shell.

**Or, if you have a terminal**, `scripts/setup.mjs` does the mechanical parts:

```
node scripts/setup.mjs            # interactive
node scripts/setup.mjs --dry-run  # show the plan, change nothing
```

It shows which secrets are set, generates `ATLAS_SESSION_SECRET`, prompts for
the rest with input hidden, writes them, and checks Cloudflare D1 access. It
needs the GitHub CLI (`gh auth login`).

Either way the credentials stay with you. Writing repository secrets needs a
token with admin scope, and giving that to an agent that runs unattended every
night and edits its own source would hand it a way to escalate its own
privileges. That is why this is a setup step and not an Atlas feature.

## 2. Set the repository secrets

**Direct link:** https://github.com/cornerstonemarketingus/atlas/settings/secrets/actions/new

That form is all you need — name, value, "Add secret", repeat. No terminal.

The deploy workflow uploads each of these to the Worker. Anything you leave
unset is skipped, not an error — so you can do sign-in now and billing later.

### Sign-in (required for anyone but you to use Atlas)

| Secret | Where it comes from |
|---|---|
| `ATLAS_SESSION_SECRET` | Generate one: `openssl rand -hex 32`. Any long random string. |
| `ATLAS_GITHUB_OAUTH_CLIENT_ID` | GitHub → Settings → Developer settings → OAuth Apps → New OAuth App |
| `ATLAS_GITHUB_OAUTH_CLIENT_SECRET` | Same OAuth App, "Generate a new client secret" |

**Create the OAuth App here:** https://github.com/settings/applications/new

When creating it:
- **Homepage URL:** `https://atlas-web.cornerstonemarketingus.workers.dev`
- **Authorization callback URL:** `https://atlas-web.cornerstonemarketingus.workers.dev/api/auth/github/callback`

The callback URL must match exactly, including the scheme and no trailing slash.

### Billing (required to charge anyone)

| Secret | Where it comes from |
|---|---|
| `ATLAS_STRIPE_SECRET_KEY` | Stripe → Developers → API keys → Secret key |
| `ATLAS_STRIPE_WEBHOOK_SECRET` | Stripe → Developers → Webhooks → your endpoint → Signing secret |
| `ATLAS_STRIPE_PRICE_PRO` | The price ID (`price_…`) of your Pro plan |
| `ATLAS_STRIPE_PRICE_TEAM` | The price ID of your Team plan |

Add the webhook endpoint in Stripe pointing at:

```
https://atlas-web.cornerstonemarketingus.workers.dev/api/billing/webhook
```

Subscribe it to the subscription lifecycle events (`customer.subscription.*`,
`checkout.session.completed`). Take the signing secret from *that* endpoint —
it is per-endpoint, not per-account.

### Model provider (required for the coder agent to run)

One of these, matching what you want to use:

| Secret | For |
|---|---|
| `GROQ_API_KEY` | Groq-hosted models (the current default) |
| `ANTHROPIC_API_KEY` | Claude models |

Then set the repository **variable** (Variables tab, not Secrets)
`ATLAS_CODER_MODEL` to the model you want. A `claude-*` model automatically
routes to Anthropic; anything else routes to Groq.

---

## 3. Redeploy so the secrets reach the Worker

**Direct link:** https://github.com/cornerstonemarketingus/atlas/actions/workflows/deploy-cloudflare.yml
→ "Run workflow" → Run.

The "Upload Worker runtime secrets" step prints how many it uploaded and names
the ones it skipped. Read that output — it is the ground truth for what the
running app can see.

Then re-check `/api/setup/status`. Anything still `false` was not set, or was
set with a different name.

---

## 4. Verify the flows end to end

Do not skip this. Each of these has failed before in a way a green deploy did
not reveal.

1. **Sign in.** Open the site in a private window, sign in with GitHub. You
   should come back signed in, not to an error.
2. **Dispatch a task.** Run an `inspect` task. It should appear in your task
   list and reach a terminal status.
3. **Run the coder agent.** Dispatch a `coder` task with a small objective. It
   should open a pull request whose body contains a **Validation** section
   saying whether the change was verified.
4. **Subscribe.** With Stripe in test mode, run a checkout with card
   `4242 4242 4242 4242`. Confirm the subscription lands in the database and the
   plan changes.

---

## Using Atlas free, yourself

You do not need a subscription and you do not need to sign in with GitHub.

Requests carrying `Authorization: Bearer <ATLAS_OPERATOR_TOKEN>` bypass plan
gating entirely — every mode, no monthly task cap. That path exists precisely
because the operator is not a billed GitHub account and should not be guessed
into a tier.

Keep that token to yourself: it is a single deployment-wide credential, so
anyone holding it has the same unlimited access you do.

For reference, the tiers that apply to everyone else:

| Tier | Modes | Tasks / month |
|---|---|---|
| Free | inspect, debug | 20 |
| Pro | inspect, debug, coder | 200 |
| Team | inspect, debug, coder | 1000 |

---

## Daily self-improvement

`atlas-self-improve.yml` runs at **09:00 UTC**, which is **4:00am in Minnesota
right now** (CDT). GitHub's scheduler is UTC-only with no daylight-saving
awareness, so no single cron holds 4am local all year:

| Cron | Summer (CDT) | Winter (CST) |
|---|---|---|
| `0 9 * * *` *(current)* | **4:00am** | 3:00am |
| `0 10 * * *` | 5:00am | **4:00am** |

09:00 UTC is right for the longer stretch of the year. If a 3:00am run bothers
you once CST starts in November, change one line to `0 10 * * *`, and back in
March.

Each run picks one unchecked item from `TODO.md`, implements it, verifies it
against the repository's own tests, and opens a pull request.

**It never merges anything.** The merge policy is fixed at `manual` in
`.github/atlas/build-dispatch.py` and is not exposed as a workflow input, on
purpose: an agent that can merge its own changes can disable its own safety
rails and then keep running with them disabled.

It also skips the run when three pull requests are already open, because the
limit on useful self-improvement is how much you are willing to review, not how
much the agent can generate.

To change what it works on, edit `.github/atlas/self-improve-objective.md` —
that is an ordinary reviewable diff. To run it now, dispatch the workflow; you
can pass a one-off objective without editing anything.

---

## Known gaps, so they do not surprise you

- **`atlas debug` writes raw build output to `debug.json`**, uploaded as a
  workflow artifact (7-day retention, repository collaborators only). That
  output is not redacted — the runner is plain JavaScript and cannot reach the
  redactor. Everything the *model* sees is redacted; this artifact is not.
- **Secret detection is pattern-based, not entropy-based.** A credential in an
  unrecognised format passes through. It is a strong last line of defence, not
  a reason to relax about secrets in a repository.
- **Task-to-run matching is exact only for runs created from now on**, since it
  relies on a `run-name` the workflows only started setting recently. Older runs
  fall back to time-based matching.
