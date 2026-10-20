# Hosted website creation: why it answered "I can't", and what is fixed

> Update (same day): hosted chat can now build a business website itself, with no Genesis node, no outside key and no code execution. See "Hosted builder" below. The node is still needed for apps, APIs and publishing a GitHub repository.

Date: 2026-10-19. Scope: hosted chat → Genesis for "Build a responsive website for Team Hahn Construction in Eagan, Minnesota, specializing in wood framing, windows, doors, and housewrap."

## Root cause (traced in code)

1. **Intent.** `classifyIntent` only treated "create a **new project / repo / app**" as a new project. The website prompt above classified as `chat`, so nothing marked it as project creation.
2. **Tool eligibility.** `workspace_create_project` is always offered, but `genesisBridge` (`app/api/genesis/bridge.mjs`) returns `unavailable` unless the caller is the deployment owner **and** `ATLAS_GENESIS_URL` (https origin) and `ATLAS_GENESIS_TOKEN` are deployed. Genesis (scaffold, build, verify, preview, publish) runs only in the local-control daemon (`apps/local-control`); the Worker cannot build a site. With no node, every attempt ends `unavailable`.
3. **Status UI.** `ProjectActivity` filled missing fields with defaults: `projectState ?? "planning"`, `operationId ?? "unavailable"`, `deploymentState ?? "not-deployed"`. A refused request therefore rendered as "New project: unavailable · planning · Operation: unavailable · Deployment: not-deployed", which looks like progress that is not happening. `bridge.create` also attached the request id as `operationId` even when no operation existed.
4. **Model answer.** The model received a bare `unavailable` result with no reason or fix, so it fell back to advice ("I can't create the website directly").

## What changed

- `app/chat/intent.mjs`: "build/create/make/design … a (adjectives) website / web app / landing page / online store" with no reference to an existing project is a new-project request. "Build the website in my project", questions ("How do I build a website?") and small edits are unchanged.
- `app/api/genesis/bridge.mjs`: every unavailable result carries `reason` and a fixed, secret-free `nextStep` (owner required, node not configured, invalid URL, token rejected, node error, unreachable, timeout). No receipt id is invented for an operation that was never accepted.
- `app/chat/project-state.mjs` (new) + `ProjectActivity.tsx`: distinct stages `unavailable | planning | executing | awaiting-approval | blocked | interrupted | failed | completed | unknown`. No defaults: unknown fields are not shown, "planning" appears only when the node reports a planning state, and a failing status poll is shown instead of silently retried.
- `atlas-knowledge.mjs`: a website/app for a named business is a new project; on `unavailable`/`failed` say nothing was created and quote `nextStep`.
- `apps/local-control/.../requirements.mjs`: Genesis ignored the business name and place unless phrased "for X, a … business based in Y". The acceptance prompt produced a site named "Website" with no Eagan or Minnesota anywhere. It now recognises "for <Name ending in a business or trade word>" and "in <City>, <US state>" (a region must be a real state, so "in Excel, Word" is not a place), for website requests only.

## Evidence

- Real pipeline, no model, real Chromium (`scripts/local/genesis-bench.mjs` runner with the exact prompt): state `ready`; project "Team Hahn Construction"; 5 pages (home, services, about, gallery, contact) built; build passes; 2/2 generated tests pass; browser inspection (10 checks) clean at 375 px and 1280 px; screenshots reviewed by hand (no overflow); preview served on loopback (`http://127.0.0.1:<port>`). Before the parser fix the same prompt produced "Website" with no location.
- Not run: a model-written site (no provider key in this environment), a hosted run, or any public preview URL.
- Tests: `apps/web` 592 pass / 5 optional skips / 0 fail (including new `tests/project-state.test.mjs`); web lint and `tsc --noEmit` clean; local-control `genesis-*` 47 pass / 3 skipped / 0 fail, with two new Genesis requirement tests.

## Owner actions (not done, require approval)

To make hosted chat actually create sites:

1. Run a Genesis node: the local-control daemon on a machine with Node 22, Chromium and a GitHub credential that can create repositories (publish policy `publish.remote`).
2. Expose it over **https** at a bare origin (no path/query/credentials), for example a Cloudflare Tunnel.
3. Add repository secrets `ATLAS_GENESIS_URL` and `ATLAS_GENESIS_TOKEN`, then run **Deploy Atlas web to Cloudflare Workers** (secrets reach the Worker only on deploy).
4. Sign in as the deployment owner (project creation is owner-only).
5. Verify with `GET /api/genesis/operations` (capabilities) before relying on chat, then run the Team Hahn prompt and confirm repository URL and commit from `workspace_project_status`.

The GitHub Actions coder edits an existing repository; it does not create a new one. Publishing a generated site (GitHub repository, public hosting, a custom domain) is still a separate, owner-approved step.

## Hosted coder stalls (priority 4): findings

Run 43 (2026-10-19) did not hang. It ended after 4.7 min with `openai returned HTTP 429`; all four routes (Groq 120b/20b: provider-failure; Workers AI: rate-limit; OpenAI: rate-limit) failed, no Anthropic key was set, and 5 of 9 tool calls had failed earlier. The run already has a 15-minute coder deadline inside a 25-minute job, 30-second heartbeats, `Retry-After`-aware waits with fail-fast past `ATLAS_CODER_RETRY_MAX_DELAY_MS`, cross-vendor fallbacks and a written failure status. The per-route error detail is only in the run artifact. Not changed here: surfacing heartbeat counts/active route in the app needs runner-to-Worker reporting (protected workflow/runner paths); resumability across provider exhaustion depends on persistent workspace leases (see CLOUD-CODER-RECOVERY.md). Operational fix: add a funded provider key (docs/CODER-PROVIDER-LIMITS.md).

## Hosted builder (no node, no key, no code execution)

`workspace_create_project` now tries a connected Genesis node first (owner only, can publish a repository), and otherwise builds a **business website** inside the Worker (`app/api/genesis/project-backend.mjs`). Apps and APIs still need the node and return the node's own reason and fix.

How it reuses Genesis instead of duplicating it:

- Specification: `inferSpecification` (`local-control/.../requirements.mjs`), unchanged.
- Site content: `siteConfig` (now the pure `templates/site-config.mjs`, extracted from the template index so the Worker does not pull in `node:fs`).
- Pages: `scripts/render.mjs`, split out of the generated project's `build.mjs`. The generated project and the hosted preview run the same renderer. A diff of `dist/` before and after the split is byte-identical for two different sites.

Isolation and persistence:

- Nothing generated is executed; the renderer only builds escaped strings. A project's durable source is its `site.json` plus the specification in the `genesis_projects` row (`requirements_json`, kind `hosted-static-site`; migration 0016), tenant- and principal-scoped. Pages are rendered from it on demand.
- Creation is idempotent per request id, capped at 20 sites per workspace per day, and reports `unavailable` with the migration to apply if the table is missing.
- `GET /preview/<id>[/<file>]` needs no sign-in; the id is an unguessable capability. Responses are `no-store`, `noindex`, `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; form-action 'none'`, and carry a visible "Atlas preview. This site is not published." bar. Only `.html`, `.css` and `.js` names of the stored site are served; everything else is a plain 404.
- The enquiry form validates in the browser and then says plainly that previews do not send enquiries; it never shows a false "thank you".

Verification and what it does not claim:

- `verifyHostedSite` checks every rendered page (one non-empty h1, title, description, language, viewport, every link and asset resolves, no external resources, only known scripts, structured data, form present, navigation and sitemap complete): 39 checks for the 5-page Team Hahn site. A site that fails its checks is not saved.
- It does **not** run a browser. The result says `browserChecks: "not-run"`, `enquiryDelivery: "preview-only"`, counts the `[Add … before you publish]` placeholders that still need real business facts, and `deploymentState: "not-deployed"`.
- Chat tells the model to report exactly these fields.

Evidence (built Worker, scripted model; `tests/hosted-site-worker.test.mjs`): a signed-in chat request with the Team Hahn prompt calls `workspace_create_project`, a `genesis_projects` row is written (status `ready`, city Eagan), `/preview/<id>` and its five pages, stylesheet and script return 200, an unknown or malformed id returns 404, and the card's status poll reads the same project through its own workspace only. In real Chromium at 375 px and 1280 px: correct heading, no horizontal overflow on any page, working navigation, form validation and the preview-only message, no console errors, every request 200. Web suite 611 pass / 0 skipped; lint and `tsc` clean.

Not done: a model-written site (the builder is deterministic; a model may later refine copy behind the same checks), enquiry delivery, publishing, a custom domain, and a live check against the real deployment (needs the owner to deploy this branch).

Owner steps for the hosted builder: deploy this branch ("Deploy Atlas web to Cloudflare Workers"); confirm migration `0016_project_genesis` is applied on production D1 (the builder reports `storage_not_ready` and names it if not); then run the Team Hahn prompt in hosted chat and open the preview link it returns.
