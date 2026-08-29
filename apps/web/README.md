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

- `CLOUDFLARE_API_TOKEN` — an API token scoped to Workers Scripts: Edit (add
  D1: Edit and R2: Edit only once this app actually uses those bindings).
- `CLOUDFLARE_ACCOUNT_ID` — from the Cloudflare dashboard sidebar.

Neither `/api/tasks` nor `/api/github/status` currently reads or writes D1 or
R2, so no database or bucket needs to exist for this deployment to work.

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

## GitHub Actions task runner

Set `ATLAS_GITHUB_TOKEN` to a fine-grained token with Actions write access and
optionally set `ATLAS_GITHUB_WORKFLOW` (defaults to `atlas-runner.yml`). Atlas
dispatches that workflow in the selected allowlisted repository with
`repository`, `branch`, `mode`, `objective`, and `task_id` inputs. The workflow
must declare matching `workflow_dispatch` inputs. `ATLAS_ALLOWED_REPOSITORIES`
is a comma-separated allowlist and defaults to `cornerstonemarketingus/atlas`.
Until approval persistence is connected, the API accepts Inspect tasks only.

When no GitHub token is configured, Atlas falls back to the existing
`ATLAS_AGENT_DISPATCH_URL` and `ATLAS_AGENT_DISPATCH_TOKEN` runner settings.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
