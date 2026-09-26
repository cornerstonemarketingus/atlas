# Claude Next Build Handoff

## Current rollout

PR #70 contains conversation task identity. The current follow-up commit adds:

- local-control health metrics: memory usage, active sessions/agents, queued turns, and mission batch depth;
- bounded LRU policy-decision caching;
- SQLite WAL confirmation and a mission-event index;
- transient Playwright action retries with exponential backoff;
- `atlas code --dry-run`, which denies repository writes;
- CI caching for `node_modules` and the pnpm store.

Validation completed locally: local-control 388 tests with 387 passed and one Windows symlink-privilege skip; CLI 424 passed; browser-worker 20 passed with Chromium.

## Next integrations

Build in this order, each as a small PR with an end-to-end acceptance test:

1. Project Genesis / Quick-Start (#73): create a project artifact, provision the repository and D1 schema through owner-approved adapters, create the free-tier billing row, and expose the first usable `/quick-start` Projects action.
2. Hosted scheduled automations (#78): finish the draft PR, verify pause/resume, budgets, idempotency, and event triggers; add a Monday-style schedule acceptance test.
3. Spreadsheet artifact export: add a bounded CSV/XLSX artifact tool and make it downloadable; chat may report the artifact while computer tasks gather source data.
4. Hosted agent spawning: connect complex-job planning in hosted chat to the existing task dispatcher and preserve owner approval, budgets, and evidence boundaries.
5. Account filtering (#71): merge only after PR #67, apply D1 migration 0015, and scope computers/approvals/tasks by authenticated account.

Then address the health dashboard, strict CSP/injection protection (#77), hosted rate limiting (#69), desktop safety activation, internet MCP settings, sandbox git persistence, billing alerts, and memory UI.

## Credential requirement

Do not place a token in source, chat, logs, or this document. The repository owner must add a rotated GitHub App credential or fine-grained PAT as `ATLAS_GITHUB_TOKEN` in repository Actions secrets. It needs Actions read/write for workflow dispatch, Contents read/write for branches/commits, and Pull requests read/write for PR creation and merge-queue operations. Keep the self-improvement merge policy owner-controlled and protected by required CI checks.

## Acceptance rule

No roadmap item is complete until the running hosted or local path reaches it, the approval/evidence behavior is tested, and the operator can inspect the result without seeing credentials.