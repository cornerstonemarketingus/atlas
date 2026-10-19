# Hosted website creation: why it answered "I can't", and what is fixed

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

Not covered by this change and still open: a hosted (Worker-only) builder with isolated execution and a public preview URL; that needs a runner/container design and owner decisions on cost and isolation. The GitHub Actions coder edits an existing repository; it does not create a new one.

## Hosted coder stalls (priority 4): findings

Run 43 (2026-10-19) did not hang. It ended after 4.7 min with `openai returned HTTP 429`; all four routes (Groq 120b/20b: provider-failure; Workers AI: rate-limit; OpenAI: rate-limit) failed, no Anthropic key was set, and 5 of 9 tool calls had failed earlier. The run already has a 15-minute coder deadline inside a 25-minute job, 30-second heartbeats, `Retry-After`-aware waits with fail-fast past `ATLAS_CODER_RETRY_MAX_DELAY_MS`, cross-vendor fallbacks and a written failure status. The per-route error detail is only in the run artifact. Not changed here: surfacing heartbeat counts/active route in the app needs runner-to-Worker reporting (protected workflow/runner paths); resumability across provider exhaustion depends on persistent workspace leases (see CLOUD-CODER-RECOVERY.md). Operational fix: add a funded provider key (docs/CODER-PROVIDER-LIMITS.md).
