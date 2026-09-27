# Atlas — working notes for Claude Code

**The governing program is [`docs/PROGRAM.md`](docs/PROGRAM.md).** Read it,
then read [`docs/PROGRESS.md`](docs/PROGRESS.md) (the handoff log) before
picking up work. Resume from the "Next" line of the latest PROGRESS entry.

## Rules that are easy to get wrong

- Phases in PROGRAM.md run in order and each has an exit gate. Do not start a
  phase whose predecessor's gate has not passed.
- Protected paths (see `.github/CODEOWNERS`) need owner review: open the PR
  normally, never try to bypass review, never edit rulesets or CODEOWNERS to
  unblock yourself.
- Never reduce what Atlas can do to fit a provider limit; schedule or route
  instead.
- `TODO.md` is a long-range wishlist and often stale. Truth order: code +
  tests + live verification > PROGRESS.md > TODO.md.
  [`docs/TODO-MAP.md`](docs/TODO-MAP.md) says which program phase owns each
  TODO section.
- Never put secrets in prompts, logs, commits or PR text.

## Layout

| Path | What | Check (as CI runs it) |
|---|---|---|
| `apps/web` | Hosted app on Cloudflare Workers (chat, tasks, setup) | `npm ci && npm run lint && npm test` |
| `apps/local-control` | Local daemon, agent runtime, Genesis | `npm test`, `npm run e2e` |
| `apps/browser-worker` | Browser automation worker | `npm ci --ignore-scripts && npm test` |
| `apps/windows-companion` | Windows companion | `npm run check && npm test` |
| `packages/atlas-cli` | Coder CLI (TypeScript) | `npm ci --ignore-scripts && npm run build && npm test` |
| `packages/atlas-contracts` | Shared dependency-free contracts | `npm test` |
| `mobile` | Mobile shell | `npm run check && npm test` |
| `scripts/runner` | Coder runner, PR steward, hosted smoke | `node --test scripts/runner/*.test.mjs scripts/local/*.test.mjs` |
| `.github/workflows` | CI, deploy, coder, steward, verification | `python3 .github/atlas/check-workflows.py` before every workflow push |

## Deployment facts

- The Worker only sees secrets that `deploy-cloudflare.yml` uploads; a new
  runtime variable must be added there (a web test fails if it is not).
- A new or rotated secret reaches production only when "Deploy Atlas web to
  Cloudflare Workers" runs.
- "Verify hosted Atlas" (`verify-hosted.yml`) checks the live deployment; in
  `chat` mode it is the release gate for chat changes (streaming and
  non-streaming).
