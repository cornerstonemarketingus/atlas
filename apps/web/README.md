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
  with the "Actions" repository permission set to Read and write. Without this
  (or a configured GitHub App, see below), task dispatch responds 503.
- `ATLAS_OPERATOR_TOKEN` — a secret string of your choosing. `/api/tasks` and
  `/api/github/status` normally require the `oai-authenticated-user-id` header
  that only the OpenAI Sites platform injects; outside that platform (e.g. this
  Cloudflare deployment) they instead accept `Authorization: Bearer
  <ATLAS_OPERATOR_TOKEN>`. The dashboard prompts for this value once and
  remembers it in the browser's `localStorage`. Without it configured, the
  dashboard's access-code screen has nothing correct to accept.

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
straight to a branch, but currently ignores this setting and never merges
its own PR regardless of what's selected — that enforcement is the next
piece of work, deliberately shipped after the open-a-PR path is proven.

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
- `coder` → `atlas-coder.yml` (override with `ATLAS_CODER_WORKFLOW`),
  `contents: write` + `pull-requests: write` — it pushes a new branch and
  opens a pull request, but never merges it.

### Coder mode

Reads the repository with the same tools `inspect` uses, proposes file edits
through a digest-bound safe editor (`packages/atlas-cli`'s
`SafeRepositoryFileEditor`), and opens a pull request summarizing what
changed — it stops there. Needs one more repository secret:

- `GROQ_API_KEY` — an API key from [console.groq.com](https://console.groq.com/keys).
  Without it, coder tasks fail immediately with a clear message rather than
  silently doing nothing.

Optionally set the `ATLAS_CODER_MODEL` repository **variable** (Settings →
Secrets and variables → Actions → Variables tab, not Secrets) to pick a
different Groq-hosted model; defaults to `openai/gpt-oss-120b`.

When no GitHub token is configured, Atlas falls back to the existing
`ATLAS_AGENT_DISPATCH_URL` and `ATLAS_AGENT_DISPATCH_TOKEN` runner settings.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
