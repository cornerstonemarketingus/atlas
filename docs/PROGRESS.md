# Atlas program progress (handoff log)

Handoff log for [`PROGRAM.md`](PROGRAM.md). Append one row per PR, newest
last. A new session resumes from the last row's "Next".

Format: date | PR | phase/item | what shipped | evidence | open issues | next

## Current position

- **Phase:** 0 exit gate pending (owner: deploy + live session). Phase 1
  package work is built and in review as a stack; wiring hosted chat through
  it waits for #119 (both change the chat loop).
- **Workstreams (PROGRAM.md §4):** A, inference control plane,
  [#127](https://github.com/cornerstonemarketingus/atlas/issues/127)
  (claude-1). B, eval harness and dogfood log,
  [#128](https://github.com/cornerstonemarketingus/atlas/issues/128)
  (claude-2; brief in the issue's first comment).
- **Merge order for the Phase 1 stack:** #129 → #130 → #131 → #132 → #133
  (each is based on the one before; retarget to `main` as each merges).
- **Next for workstream A once #119 merges:** wire chat through the ledger
  (reserve/release with outcomes), move the memory digest after the history
  (cache finding in #133), `ATLAS_CHAT_MODELS` pool from the target
  registry, resumable chat turns (task id, event log, SSE replay, polling).
- **Phase 2 (coder) work that does not wait on chat:** escalation merged
  (#135; its workflow wiring #136 is protected). Import graph and
  `atlas tests-for` merged (#137, with tsconfig `paths`/`baseUrl`). In
  review: the coder's `repository.tests_for` tool (#138; adds about 90
  tokens per coder request, a deliberate contract change flagged for
  review), package graph and workspace imports (#141), env/config
  references (#142). Remaining 2.3: entrypoints, CI/deploy targets, schemas.
- **CI:** "Genesis (real coder and browser)" failed intermittently on main
  after #135 and on #137 (`repairsUsed 2 !== 1`). It passes on the same code
  elsewhere and never fails locally. #139 makes the assertion print the
  transitions so the next failure names its cause (merged). Root cause still
  open.
- **Blocked on owner, in order:**
  1. Merge [#123](https://github.com/cornerstonemarketingus/atlas/pull/123)
     (PR 0, CODEOWNERS), then add the branch ruleset below and turn on
     "Allow auto-merge" (Settings → General → Pull Requests).
  2. Merge [#119](https://github.com/cornerstonemarketingus/atlas/pull/119)
     and [#125](https://github.com/cornerstonemarketingus/atlas/pull/125)
     (both protected; #124 is already merged), then run "Deploy Atlas web
     to Cloudflare Workers".
  3. Fix the GitHub credential: a fine-grained PAT with Actions, Contents and
     Pull requests read and write on this repository saved as
     `ATLAS_GITHUB_TOKEN` (or the GitHub App with the same permissions),
     then redeploy. `/api/setup/status` now says exactly which permission is
     missing for which kind of credential.
  4. Run "Verify hosted Atlas" in `chat` mode with the conversation that
     failed in production; streaming and non-streaming must both pass. Then
     a real usage session with no empty replies and no user-visible 429s.
- **Ruleset (GitHub → Settings → Rules → Rulesets, target `main`):** require
  a pull request; require review from Code Owners; require the CI status
  checks; block force pushes and deletions. Agents never edit this.
- **Open Phase 0 item not doable yet:** 0.1 "resume automatically once
  fixed" needs a refused dispatch to be persisted and retried; that is
  Phase 1.2's durable execution.

## Log

| Date | PR | Phase/item | What shipped | Evidence | Open issues | Next |
|---|---|---|---|---|---|---|
| 2026-09-27 | [#118](https://github.com/cornerstonemarketingus/atlas/pull/118) | pre-program (coder rate limits) | CLI coder: Groq TPM pacing from headers, exact retry waits (Go durations), fail fast past the cap to the next fallback route; chat parses the same waits | atlas-cli 439/439; CI green | Open, mergeable | — |
| 2026-09-27 | [#119](https://github.com/cornerstonemarketingus/atlas/pull/119) | 0.2, 0.3, 0.4, 0.5 | Empty HTTP 200 classified; final synthesis (tool-free, adaptive output room, reasoning_effort low only when writing up finished work, fallback model after two empties, saved-work reply with `finalization` when nothing answers); Groq tool_use_failed corrected once without dropping tools; fallback/web-search/allowed-repos uploaded to the Worker with a runtime-vs-deploy drift test; chat release gate in "Verify hosted Atlas" | web 253/253; CI green on 10c4ef9; gate checked against a local stand-in (pass and fail) | Protected paths (workflows): owner review. Exit gate needs deploy + live run | Owner: merge, deploy, run gate |
| 2026-09-27 | [#120](https://github.com/cornerstonemarketingus/atlas/pull/120) (draft) | 1.1 (early) | packages/atlas-inference: error taxonomy, rate-limit header parsing, per-target capacity state | 21 package tests; CI green | Capacity state is isolate memory; rework into a Durable Object keyed by quota scope, add CAPACITY_EXCEEDED and eligibility preflight | After Phase 0 gate |
| 2026-09-27 | [#121](https://github.com/cornerstonemarketingus/atlas/pull/121) (draft) | 1.2 (early) | In-memory inference governor and queue; logical parallelism (all ready team steps) separated from inference concurrency | 33 package tests, web 253/253; CI green | Must move into the Durable Object with reservations, idempotency, resumable chat stream | After #120 rework |
| 2026-09-27 | [#122](https://github.com/cornerstonemarketingus/atlas/pull/122) (merged) | program setup | docs/PROGRAM.md, CLAUDE.md, this log, docs/TODO-MAP.md (299 unchecked TODO items mapped to program phases: 273 tasks, 13 rules, 6 decisions, 4 owner, 3 another agent's) | docs only | — | PR 0 (CODEOWNERS), then 0.1 credential handling |
| 2026-09-27 | [#123](https://github.com/cornerstonemarketingus/atlas/pull/123) | PR 0 | CODEOWNERS for every protected category in PROGRAM.md §3 (workflows, auth/credentials/tenancy, redaction, approvals, merge/steward, self-improvement, sandbox/policy/egress, security policy, the program and CLAUDE.md); guard test fails if an entry matches no file | runner scripts 49/49; guard mutation-checked | Owner merges; ruleset is owner-only | Owner: ruleset + auto-merge setting |
| 2026-09-27 | [#124](https://github.com/cornerstonemarketingus/atlas/pull/124) (merged) | 0.1 | Setup probe checks Actions: write (dispatch to a branch that cannot exist: 403 = missing, 422 "No ref found" = granted, nothing runs); credential kind from prefix; exact missing permission with per-kind grant steps; rate-limit 403 told apart; dispatch failures use the same explanation and are never recorded as started | web 232/232; 9 new tests; guard mutation-checked (5 fail without it) | Auto-resume needs durable execution (1.2) | — |
| 2026-09-27 | [#125](https://github.com/cornerstonemarketingus/atlas/pull/125) (retargeted to main) | 0.1 | GitHub App token refusals named: key rejected, installation not found, Actions permission not granted | web 234/234 | Protected (github-app.mjs): owner review | Owner review |
| 2026-09-27 | [#126](https://github.com/cornerstonemarketingus/atlas/pull/126) (merged) | log | PROGRESS after #122-#125 | docs | — | — |
| 2026-09-27 | [#127](https://github.com/cornerstonemarketingus/atlas/issues/127) / [#128](https://github.com/cornerstonemarketingus/atlas/issues/128) | §4 | Two workstream issues with claim labels; claude-2 brief for the eval harness | issues | — | Owner starts the second agent from #128 |
| 2026-09-27 | [#129](https://github.com/cornerstonemarketingus/atlas/pull/129) | 1.1 | packages/atlas-inference: error kinds incl. CAPACITY_EXCEEDED, ProviderCapacityState, request/target/usage/checkpoint contracts, eligibility preflight; CI job | package 28/28 | Protected (ci.yml); whether providers count max_tokens at admission is unverified, so the conservative rule is the default | Owner review |
| 2026-09-27 | [#130](https://github.com/cornerstonemarketingus/atlas/pull/130) | 1.2 | Quota ledger in a SQLite Durable Object per quota scope: atomic idempotent reservations, expiry, header reconciliation, priority hold-back; setup status round trip | package 40/40, web 239/239, wrangler dry-run lists the binding; guards mutation-checked | Adds a DO migration to production: owner review | Owner review |
| 2026-09-27 | [#131](https://github.com/cornerstonemarketingus/atlas/pull/131) | 1.3 | Circuit breakers (HEALTHY/DEGRADED/OPEN/PROBING, one probe, doubling cooldown, config failures disable) | package 47/47; probe guard mutation-checked | Stacked | After #130 |
| 2026-09-27 | [#132](https://github.com/cornerstonemarketingus/atlas/pull/132) | 1.3 | OpenAI-compatible listModels and probed target registry | package 53/53 | Stacked | After #131 |
| 2026-09-27 | [#133](https://github.com/cornerstonemarketingus/atlas/pull/133) | 1.4 | Prompt fingerprints and cache-hit report; found chat's memory digest breaking the prefix cache | package 58/58 | Stacked; fix lands with chat wiring | After #132 |
| 2026-09-27 | [#135](https://github.com/cornerstonemarketingus/atlas/pull/135) | 2.4 | Escalate a failing repair to a stronger model from the checkpoint (`--escalate`, shared budget ledger) | atlas-cli suite green | Workflow env in #136 (protected) | Merged |
| 2026-09-27 | [#136](https://github.com/cornerstonemarketingus/atlas/pull/136) | 2.4 | Pass `ATLAS_CODER_ESCALATION*` into the coder and steward workflows | check-workflows.py clean | Protected path | Owner review |
| 2026-09-27 | [#137](https://github.com/cornerstonemarketingus/atlas/pull/137) | 2.3 | Import graph (TS/JS/Python, tsconfig aliases) and `atlas tests-for` with import-chain evidence | atlas-cli 445/445 | Genesis failure on first run (see CI above) | Merged |
| 2026-09-27 | [#138](https://github.com/cornerstonemarketingus/atlas/pull/138) | 2.3 | `repository.tests_for` coder tool | atlas-cli 442/442 | Contract change, about 90 tokens per request | Review |
| 2026-09-27 | [#139](https://github.com/cornerstonemarketingus/atlas/pull/139) | CI | Genesis visual-repair test prints transitions when the repair count differs | forced failure shows the dump | Diagnostic, not the fix | Merged |
| 2026-09-27 | [#141](https://github.com/cornerstonemarketingus/atlas/pull/141) | 2.3 | Package graph (npm/pnpm/PEP 621/Poetry, internal links) and workspace-package imports; `atlas packages` | atlas-cli 446/446 | TOML subset reader | Merge when green |
| 2026-09-27 | [#142](https://github.com/cornerstonemarketingus/atlas/pull/142) | 2.3 | Env/config references: reads, declarations, workflow secrets/vars, undeclared reads; `atlas env` | atlas-cli 444/444; never-read-.env guard mutation-checked | Lexical only | Merge when green |
