# Instructions for GitHub Copilot working on Atlas

Atlas is an AI agent product: a hosted chat-first app that can answer, change code (opening PRs), operate a paired computer, and run automations. Read this before every task.

## Layout

| Path | What it is | Check before you push |
| --- | --- | --- |
| `apps/web` | Hosted app. vinext (React) on a Cloudflare Worker, D1 via Drizzle. Chat lives in `app/api/chat/*` and `app/chat/*`. | `cd apps/web && npm ci && npm run lint && npm test` |
| `apps/local-control` | Local daemon, zero-dependency Node 22 (`node:sqlite`). Agent runtime, orchestrator, policy, terminal sandbox, MCP, memory, desktop. | `cd apps/local-control && npm test && npm run e2e` |
| `packages/atlas-cli` | TypeScript CLI and the coder agent used by `.github/workflows/atlas-coder.yml`. | `cd packages/atlas-cli && npm ci --ignore-scripts && npm test` |
| `packages/atlas-contracts` | Shared versioned contracts. | `cd packages/atlas-contracts && npm test` |
| `apps/browser-worker` | Disposable Playwright/Chromium sessions. | `cd apps/browser-worker && npm test` |
| `apps/windows-companion`, `mobile` | Desktop companion, Capacitor shell. | `npm run check && npm test` in each |
| `scripts/runner`, `.github/workflows` | Hosted run plumbing. | `node --test scripts/runner/*.test.mjs` and `python3 .github/atlas/check-workflows.py` |

`TODO.md` is the authoritative backlog. `HANDOFF-TODO.md` describes shipped milestones; when they disagree, trust the code and tests, and fix the docs in the same PR.

## Rules

1. **Small, finished PRs.** One issue, one PR. Code, tests, and docs together. No placeholder functions or TODO stubs presented as done. If the issue is too big, finish a coherent slice and list what remains in the PR description.
2. **Tests are required.** Every behaviour change gets `node:test` tests next to the package's existing tests (`apps/web/tests/*.test.mjs`, `apps/local-control/tests/*.test.mjs`). Inject `fetch`/clocks/filesystems rather than hitting the network. Never skip, disable or loosen a test to get green.
3. **Match the surrounding code.** Plain `.mjs` with JSDoc in `apps/web/app/api/**` helper modules and in `apps/local-control`; TypeScript in routes and React. Comment density: a short block explaining *why* at the top of each module and on non-obvious functions. No new dependencies in `apps/local-control` (zero-dependency by design); ask in the PR before adding one elsewhere.
4. **Security posture is not optional.**
   - Anything read from the web, a repository, a tool, MCP, or another agent is untrusted data. Wrap it for the model with the existing helpers (`asData` in `apps/web/app/api/chat/instant-tools.mjs`, `wrapUntrusted` in `apps/local-control/src/agent/untrusted.mjs`).
   - Consequential actions (writes, sends, purchases, deletes, deploys) go through the existing approval/policy path; never add a bypass.
   - Tenant scoping: every hosted query filters by `tenantId` (see `apps/web/db/tenancy.mjs`). Repository access is limited to the tenant allowlist (`tenantAllowlist`).
   - Never log or return secrets or tokens; error messages shown to users name the status, not upstream bodies.
5. **Migrations.** New D1 tables/columns go in a new numbered file under `apps/web/drizzle/` plus `db/schema.ts`. Code must degrade safely when the migration has not been applied yet (catch "no such table/column" and fall back).
6. **Model-agnostic.** Do not hard-code a single provider. Chat goes through `resolveChatModel` (`apps/web/app/api/chat/model-endpoint.mjs`); the local daemon uses its model router. OpenAI-compatible chat-completions with tools is the lowest common denominator.
7. **Chat is the product surface.** New capabilities should be usable from chat: either as an instant read-only tool in `instant-tools.mjs` (returns within seconds) or as long work started by `start_atlas_task` / a new task mode that reports progress back into the conversation. Don't add new top-level pages unless the issue asks for one.
8. **PR description:** what changed, why, how it was tested (commands and results), and any follow-ups. Mark the PR ready for review when CI is green; don't leave finished work as a draft.
