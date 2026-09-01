# vinext-starter

A clean full-stack starter running on
[vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and
Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

This starter does not use `wrangler.jsonc`.

## Included Shape

- edit site code under `app/`
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

Signed-in visitors receive both `oai-authenticated-user-id` and `oai-authenticated-user-email`. Private Sites require every visitor to sign in; public Sites may also have anonymous visitors, for whom neither header is present.

The user ID is stable for the same user on the same Site and different across Sites. Email and name are intended for display or contact purposes.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: build the starter and verify its rendered loading skeleton
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Deploying to Cloudflare Workers

`npm run build` produces a complete Wrangler config at `dist/server/wrangler.json`
(worker entry, static asset directory, compatibility settings) — no hand-written
`wrangler.toml` is needed. `.github/workflows/deploy-cloudflare.yml` builds this
app and runs `wrangler deploy --config dist/server/wrangler.json` on every push
to `main` that touches `apps/web/**`, or on manual dispatch.

Configure these repository secrets under Settings → Secrets and variables →
Actions before the workflow can deploy:

- `CLOUDFLARE_API_TOKEN` — an API token scoped to Workers Scripts: Edit, plus
  D1: Edit (repository settings — merge policy per repository — are stored
  in D1; see below).
- `CLOUDFLARE_ACCOUNT_ID` — from the Cloudflare dashboard sidebar.

### Provisioning the D1 database (one time)

`GET`/`PUT /api/settings/repositories` (the per-repository merge-policy
setting) needs a real D1 database — there is none until you create one:

1. Run the **Provision Atlas D1 database** workflow by hand (Actions tab →
   select it → Run workflow). It creates the database via `wrangler d1
   create` and applies the initial schema (`apps/web/drizzle/0000_*.sql`) to
   it. Note: this actually creates a billable-tier-eligible (though normally
   free-tier) Cloudflare resource — it's meant to be run once, deliberately,
   not automatically.
2. Copy the `database_id` it prints into two new repository secrets:
   `ATLAS_D1_DATABASE_ID` and `ATLAS_D1_DATABASE_NAME` (the name you gave it,
   default `atlas-db`).
3. Re-run **Deploy Atlas web to Cloudflare Workers** so the Worker's D1
   binding picks up the real database instead of a placeholder.

A later schema change needs its own manual `wrangler d1 execute <name>
--remote --file drizzle/<new-migration>.sql` — the provisioning workflow only
bootstraps the first migration.

Two more repository secrets, if present, are pushed to the Worker as secrets
on every deploy (each step is skipped, not failed, if its secret is unset):

- `ATLAS_GITHUB_TOKEN` — a fine-grained GitHub token scoped to this repository
  with the "Actions" repository permission set to Read and write, plus "Pull
  requests" set to Read and write. Without Actions write, task dispatch
  responds 503 (or falls back to a configured GitHub App, see below). Without
  Pull requests write, coder mode pushes its branch but the `atlas-coder.yml`
  workflow's own pull-request-creation step fails — GitHub blocks the default
  `GITHUB_TOKEN` from opening pull requests unless the repository separately
  enables Settings → Actions → General → "Allow GitHub Actions to create and
  approve pull requests," so `atlas-coder.yml` uses this token for that step
  instead.
- `ATLAS_OPERATOR_TOKEN` — a secret string of your choosing. `/api/tasks` and
  `/api/github/status` normally require the `oai-authenticated-user-id` header
  that only the OpenAI Sites platform injects; outside that platform (e.g. this
  Cloudflare deployment) they instead accept `Authorization: Bearer
  <ATLAS_OPERATOR_TOKEN>`. This is a shared admin/dev bypass, not a real
  per-user account — it carries no billing plan and is exempt from the usage
  caps below. The dashboard's "Use an access code instead" fallback prompts
  for this value and remembers it in the browser's `localStorage`. Real
  visitors sign in with GitHub instead — see the next section.

## Membership and billing

Real visitors sign in with GitHub (not the operator token above), and each
GitHub account is a billed customer with its own plan:

| Tier | Price | Modes | Tasks / month |
| --- | --- | --- | --- |
| Free | — | `inspect`, `debug` | 20 |
| Pro | $29/mo | + `coder` (opens PRs) | 200 |
| Team | $99/mo | + `coder` | 1000 |

`db/schema.ts` defines the exact numbers (`TIER_LIMITS`) if you want to
change them — they're a starting point, not something the code assumes is
fixed. `/api/tasks` checks the signed-in user's tier and monthly usage
before every dispatch and returns HTTP 402 with an explanation if either is
exceeded; the operator-token and OpenAI-Sites-platform paths skip this
check entirely (see above).

### GitHub sign-in

1. Create a GitHub OAuth App: your GitHub account → Settings → Developer
   settings → OAuth Apps → New OAuth App. Homepage URL is your deployed
   Worker's URL; **Authorization callback URL** must be exactly
   `<your-worker-url>/api/auth/github/callback`.
2. Set two repository secrets from that app's page: `ATLAS_GITHUB_OAUTH_CLIENT_ID`
   and `ATLAS_GITHUB_OAUTH_CLIENT_SECRET` (click "Generate a new client
   secret" for the latter).
3. Set `ATLAS_SESSION_SECRET` to a long random string you generate yourself
   (e.g. `openssl rand -hex 32`) — it signs the session cookie. Nothing
   reads this value back from you; treat it like a password and don't paste
   it anywhere it could be logged.

Without these three, `/api/auth/github/start` responds 503 and the
dashboard's sign-in button does nothing useful. Session cookies are
`HttpOnly; Secure; SameSite=Lax` and last 30 days; sign-out clears the
cookie immediately (`/api/auth/logout`, wired to the dashboard's "Sign out"
link).

### Stripe billing

1. In your [Stripe dashboard](https://dashboard.stripe.com), create two
   recurring Products/Prices — "Atlas Pro" and "Atlas Team" — matching
   whatever amounts you actually want to charge. Copy each Price's id
   (`price_...`).
2. Set `ATLAS_STRIPE_SECRET_KEY` (Developers → API keys — start with a
   `sk_test_...` key until you're ready to charge real cards),
   `ATLAS_STRIPE_PRICE_PRO`, and `ATLAS_STRIPE_PRICE_TEAM`.
3. Register a webhook endpoint: Developers → Webhooks → Add endpoint → URL
   `<your-worker-url>/api/billing/webhook`, events `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`. Copy the endpoint's signing secret into
   `ATLAS_STRIPE_WEBHOOK_SECRET`.

Without all four, `/api/billing/checkout` and `/api/billing/portal` respond
503 and the dashboard's upgrade buttons surface that message instead of a
redirect. The webhook handler verifies Stripe's signature itself
(`Stripe-Signature` header, HMAC-SHA256, 5-minute timestamp tolerance) — it
doesn't trust the request otherwise.

The `users`, `subscriptions`, and `task_usage` tables this all relies on
ship in `drizzle/0001_square_mandroid.sql` — apply it the same way as the
initial schema (see "Provisioning the D1 database" above): `wrangler d1
execute <name> --remote --file drizzle/0001_square_mandroid.sql`.

### Checking what's actually configured

`GET /api/setup/status` (same operator/session auth as everything else)
reports which of the above are wired up — booleans only, never secret
values: `sessionSecretConfigured`, `githubOAuthConfigured`,
`stripeConfigured`, `githubDispatchConfigured`, `operatorTokenConfigured`.
Useful right after setting new secrets and redeploying, to confirm they
took effect before walking the full sign-in/checkout flow by hand.

## Repository settings

`GET`/`PUT /api/settings/repositories` (same operator auth as the routes
above) stores one `mergePolicy` per `owner/name` in D1:

- `manual` (default) — a person merges every PR Atlas opens.
- `ci-gated` — Atlas merges its own PR once your existing build/test
  validation comes back green.
- `none` — Atlas merges immediately with no check at all. This is a real,
  deliberate option, not a safe default: it means a model's output can reach
  your default branch with nothing between it and production. Available for
  repositories that want it; never auto-selected.

The dashboard exposes this as a dropdown once you've entered a repository.
The coder agent (below) always opens a pull request rather than pushing
straight to a branch, and `/api/tasks` looks this setting up and passes it
into `atlas-coder.yml` as the `merge_policy` dispatch input, which
`create-coder-pull-request.mjs` (`scripts/runner/`) enforces after opening
the PR:

- `manual` — opens the PR and stops there.
- `none` — merges (squash) immediately after opening it.
- `ci-gated` — polls the head commit's check-runs (GitHub's Checks API;
  classic commit statuses from non-Actions CI aren't read) for up to 8
  minutes. Merges only once every reported check completed successfully.
  A check that fails, or a repository with no CI configured at all so
  nothing ever reports, both leave the PR open for a human — the absence
  of a signal is never treated as a passing one. The merge-vs-wait-vs-hold
  decision itself is a pure function (`scripts/runner/merge-decision.mjs`)
  with its own unit tests, independent of the GitHub API calls around it.

An immediate auto-merge failing (branch protection, a real conflict) is
never a crash — the PR stays open and `status.json`'s message says why.

## GitHub Actions task runner

Set `ATLAS_GITHUB_TOKEN` to a fine-grained token with Actions write access.
Atlas dispatches a workflow in the selected allowlisted repository with
`repository`, `branch`, `mode`, `objective`, and `task_id` inputs; the
workflow must declare matching `workflow_dispatch` inputs.
`ATLAS_ALLOWED_REPOSITORIES` is a comma-separated allowlist and defaults to
`cornerstonemarketingus/atlas`.

Three modes exist, each routed to its own workflow so a read-only mode's
token never carries write scope it doesn't need:

- `inspect` and `debug` → `atlas-runner.yml` (override with
  `ATLAS_GITHUB_WORKFLOW`), `contents: read` only.
- `coder` → `atlas-coder.yml` (override with `ATLAS_CODER_WORKFLOW`). Its
  job-level `permissions` are also `contents: read` — the push and PR steps
  authenticate with `ATLAS_GITHUB_TOKEN` instead of the default token (see
  "Coder mode" below), not because they need less access than before.

### Coder mode

Reads the repository with the same tools `inspect` uses, proposes file edits
through a digest-bound safe editor (`packages/atlas-cli`'s
`SafeRepositoryFileEditor`), and opens a pull request summarizing what
changed. Whether it goes on to merge that PR itself is entirely the
repository's merge-policy setting above. Needs one more repository secret:

- `GROQ_API_KEY` — an API key from [console.groq.com](https://console.groq.com/keys).
  Without it, coder tasks fail immediately with a clear message rather than
  silently doing nothing.

Optionally set the `ATLAS_CODER_MODEL` repository **variable** (Settings →
Secrets and variables → Actions → Variables tab, not Secrets) to pick a
different Groq-hosted model; defaults to `openai/gpt-oss-120b`.

Requests to Groq are capped at 4,096 output tokens per model turn (not the
whole session budget at once) and automatically retry a transient rate limit
or server error up to twice, honoring Groq's suggested wait when it names
one — a free-tier tokens-per-minute limit surfaces as a normal, self-healing
retry rather than an immediate task failure.

When no GitHub token is configured, Atlas falls back to the existing
`ATLAS_AGENT_DISPATCH_URL` and `ATLAS_AGENT_DISPATCH_TOKEN` runner settings.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
