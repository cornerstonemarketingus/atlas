# Atlas program progress (handoff log)

Handoff log for [`PROGRAM.md`](PROGRAM.md). Append one row per PR, newest
last. A new session resumes from the last row's "Next".

Format: date | PR | phase/item | what shipped | evidence | open issues | next

## Current position

- **Build sequence (owner, 2026-09-28):** [`ROADMAP.md`](ROADMAP.md) —
  Command Center → Automate → backend primitives → Visual Genesis editor →
  Cloud sandbox → Take Control → Connector/Skill marketplace → org knowledge
  graph → Reviewer/Security/QA agents → general artifacts, plus the
  capability loop. Stage 1 (Command Center) is in progress.
- **Previous scope (Phase 2, agent side):** done. 2.3 repository
  intelligence, 2.4 validation (baseline comparison with new / pre-existing /
  fixed / flaky / infrastructure classes, bounded repair, escalation) and
  2.5 safe tool runtime (#151, #154, #162, #163). Open: eval harness
  (workstream B), security/dependency scans (moved to roadmap stage 9).
- **Phase:** 0 exit gate pending (owner: deploy + live session). Phase 1
  package work is built and in review as a stack; wiring hosted chat through
  it waits for #119 (both change the chat loop).
- **Workstreams (PROGRAM.md §4):** A, inference control plane,
  [#127](https://github.com/cornerstonemarketingus/atlas/issues/127)
  (claude-1). B, eval harness and dogfood log,
  [#128](https://github.com/cornerstonemarketingus/atlas/issues/128)
  (claude-2; brief in the issue's first comment).
- **Merged by the owner since the last entry:** #119 (Phase 0 chat
  guarantees), #123 (CODEOWNERS), #125, #136, #138 (`repository.tests_for`
  coder tool), #146. The Phase 1 stack (#129 → #133) can now be rebased on
  `main` and the chat wiring started.
- **Merge order for the Phase 1 stack:** #129 → #130 → #131 → #132 → #133
  (each is based on the one before; retarget to `main` as each merges).
- **Next for workstream A once #119 merges:** wire chat through the ledger
  (reserve/release with outcomes), move the memory digest after the history
  (cache finding in #133), `ATLAS_CHAT_MODELS` pool from the target
  registry, resumable chat turns (task id, event log, SSE replay, polling).
- **Phase 2 (coder) work that does not wait on chat:** escalation merged
  (#135; its workflow wiring #136 is protected). Repository intelligence
  (2.3) merged: `atlas tests-for` (#137, tsconfig aliases), `atlas env`
  (#142), `atlas ci` (#143), `atlas packages` (#141, workspace imports),
  `atlas schemas` (#145), `atlas map` (#147), `atlas surfaces` (#150).
  Every 2.3 TODO item not needing an owner decision is done. 2.5: coder
  edits now keep file mode and the UTF-8 BOM (#151), and their diffs are
  real hunks instead of whole-file rewrites (see the last row). Groq pacing and exact waits merged (#118).
- **CI:** the intermittent "Genesis (real coder and browser)" failure was a
  render race in the generated web app (a slow response replaced the
  current screen); fixed in #144 with browser tests that reproduce it. A
  separate browser-worker race (an off-origin click reported before its
  navigation began) is fixed in #146, protected: owner review.
- **Vercel previews** hit the free plan's 100 deployments/day; the red
  "Vercel" status is not a required check.
- **Blocked on owner, in order:**
  1. Add the branch ruleset below and turn on "Allow auto-merge"
     (Settings → General → Pull Requests), if not done with #123's merge.
  2. Run "Deploy Atlas web to Cloudflare Workers" so #119 and #125 reach
     production.
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
| 2026-09-27 | [#141](https://github.com/cornerstonemarketingus/atlas/pull/141) | 2.3 | Package graph (npm/pnpm/PEP 621/Poetry, internal links) and workspace-package imports; `atlas packages` | atlas-cli 446/446 | TOML subset reader | Merged |
| 2026-09-27 | [#142](https://github.com/cornerstonemarketingus/atlas/pull/142) | 2.3 | Env/config references: reads, declarations, workflow secrets/vars, undeclared reads; `atlas env` | atlas-cli 444/444; never-read-.env guard mutation-checked | Lexical only | Merged |
| 2026-09-27 | [#118](https://github.com/cornerstonemarketingus/atlas/pull/118) | 0 | Groq pacing to the TPM window, exact waits, fail fast on daily quotas | atlas-cli 455/455, web 234/234 | | Merged |
| 2026-09-27 | [#143](https://github.com/cornerstonemarketingus/atlas/pull/143) | 2.3 | CI workflows and deploy targets (`atlas ci`) | atlas-cli 447/447 | | Merged |
| 2026-09-27 | [#144](https://github.com/cornerstonemarketingus/atlas/pull/144) | CI | Genesis web-app template render race (root cause of the Genesis CI failures) | race tests fail on the old template, pass now | | Merged |
| 2026-09-27 | [#145](https://github.com/cornerstonemarketingus/atlas/pull/145) | 2.3 | Migrations, tables, drift and API schemas (`atlas schemas`) | atlas-cli 465/465 | | Merged |
| 2026-09-27 | [#146](https://github.com/cornerstonemarketingus/atlas/pull/146) | security | Browser worker judges a click by the navigation it starts | new test fails on old code as CI did | Protected | Owner review |
| 2026-09-27 | [#147](https://github.com/cornerstonemarketingus/atlas/pull/147) | 2.3 | `atlas map`: packages with test reach and resolved entries, most-imported files, config gaps, delivery, data; each section states its basis | atlas-cli 467/467; 0.7 s on this repo | Lexical | Merged |
| 2026-09-27 | [#148](https://github.com/cornerstonemarketingus/atlas/pull/148) | 2.3 | `apps/local-control/.env.example`: the daemon's 27 settings with defaults and formats, no values | undeclared daemon reads 27 -> 0 | | Merged |
| 2026-09-27 | [#149](https://github.com/cornerstonemarketingus/atlas/pull/149) | 2.3 | `atlas env` counts PowerShell `$env:`, shell `export` and workflow `run:` exports as declarations (no plaintext companion template: its start script sets them from DPAPI) | atlas-cli 466/466 | | Merged |
| 2026-09-27 | [#150](https://github.com/cornerstonemarketingus/atlas/pull/150) | 2.3 | `atlas surfaces`: HTTP entry points with same-file auth guards; command, eval, raw SQL, computed-URL and secret-env sinks | 469/469; the 3 unguarded web routes are public by design | Guard check is per file | Merged |
| 2026-09-27 | [#151](https://github.com/cornerstonemarketingus/atlas/pull/151) | 2.5 | Coder edits keep permission bits and the UTF-8 BOM (were reset to 0600 and stripped), including delete rollback | 3 new tests fail on the old code | | Merged |
| 2026-09-27 | [#154](https://github.com/cornerstonemarketingus/atlas/pull/154) | 2.5 | Coder edit diffs are unified hunks with 3 lines of context (Myers diff between common prefix and suffix, capped edit distance falls back to one replacement hunk; `\ No newline at end of file`; `/dev/null` sides). A one-line change in a 200-line file went from 400 diff lines to 8; the model sees this diff after every edit | atlas-cli 479/479; property test applies 1,200 generated diffs back; `git apply` accepts the editor's diff; hunk-boundary, backtrack and header mutations each fail a test; 100,000-line rewrite in 0.26 s | Diffs are text only (no JSON/web/IDE renderings yet) | — |
| 2026-09-27 | [#154](https://github.com/cornerstonemarketingus/atlas/pull/154) | 2.5 | Coder edits to lockfiles, installed dependencies, vendored directories and files marked generated are refused once with the reason and remedy; `allowGenerated: true` per edit confirms (the coder cannot run a package manager or generator, so no hard block); `.gitattributes` linguist-generated/-vendored decide first | atlas-cli 486/486; skipping the guard, one confirmation covering a whole change set, and checking before preview (reads a symlink target) each fail a test | Stacked on #154 because this session can push one branch; #154 merged after the owner's ruleset change (approvals 0, code-owner review kept) | — |
| 2026-09-28 | [#162](https://github.com/cornerstonemarketingus/atlas/pull/162) | 2.5 | Coder command runner: each command runs in its own process group and a timeout, cancel or exit stops the whole group (taskkill /T on Windows); Ctrl-C/SIGTERM to Atlas is passed on. Output past the limit keeps its start and end with an omission marker and the command runs to completion, so validation judges it by exit code (was: killed and reported as an execution failure). Failure output keeps its end, where the summary is | atlas-cli 491/491; a 500 ms timeout on a command with a grandchild returned after 6 s before, 0.3 s now; no process group, killing only the direct child, head-only capture and skipping the post-exit cleanup each fail a test | Interactive commands already get no stdin (EOF), so no prompt can hang; a TTY-only prompt still fails the command rather than being reported as interactive | — |
| 2026-09-28 | [#163](https://github.com/cornerstonemarketingus/atlas/pull/163) | 2.5 | Undo checkpoints: `atlas code` records each touched file's bytes and mode (or absence) before the session's first edit to it and saves a checkpoint under `.git/atlas/checkpoints` however the session ends; `atlas undo <repo> [--session id] [--dry-run]` restores all of it, all-or-nothing, refusing any file changed since the session; no Git history is touched | atlas-cli 500/500; end-to-end test runs `atlas code` against a loopback model that edits and creates a file, then `atlas undo` restores both; all-or-nothing, first-state, symlink containment, mode restore and the CLI wiring each fail a test when broken | Local CLI only; the hosted runner discards failed work already. No undo of an individual edit within a session | 2.4 validation engine: classify results NEW/PREEXISTING/FIXED/FLAKY/INFRA against baseline (audit what exists first) |
| 2026-09-28 | (this PR) | roadmap | docs/ROADMAP.md: the owner's ten-stage build sequence and the capability loop, each stage with what exists today (audited: several modules are tested but never wired into the daemon) and its first slice | docs | — | Stage 1: Command Center view across all running work, per-lane control |
| 2026-09-28 | [#167](https://github.com/cornerstonemarketingus/atlas/pull/167) | roadmap 1 | Command Center: `GET /v1/command-center` normalizes missions and their lanes, team missions, Genesis builds, coding tasks and Improve Atlas runs into one list grouped needs-you / running / waiting / recently finished, each with only the actions its state allows; per-lane pause / resume / cancel / retry (`POST /v1/missions/:id/lanes/:lane/control`) in the scheduler, a held lane surviving mission resume and restart; a Command center section in the local console that refreshes every 4 s | local-control 600 tests, 0 failing; HTTP test on the real MissionService and SQLite store (pause one of two running lanes, the other keeps running, resume through the action the view offered, device can watch but not control); releasing held lanes on mission resume and losing a running lane's stop reason each fail a test | Hosted app (apps/web) does not show local work yet | — |
| 2026-09-28 | [#168](https://github.com/cornerstonemarketingus/atlas/pull/168) | roadmap 1 | Launch agents in parallel from one request: `POST /v1/missions` takes `tasks` (one lane per task) or `objective` + `variants` (2–5 versions of one task, each told it is one of N); every coder lane runs in its own worktree; the Command Center labels versions and shows each finished lane's report and patch; a launch form in the Command center | local-control 602 tests, 0 failing; HTTP test launches three versions and reads each one's result from the command center | Applying a chosen version to the repository is not in the UI yet (patch path shown) | — |
| 2026-09-28 | [#169](https://github.com/cornerstonemarketingus/atlas/pull/169) | roadmap 1 | Use a version: `POST /v1/missions/:id/lanes/:lane/apply` applies a finished coder lane's patch to its repository's working tree under `code.write` (ask by default: approval bound to mission, lane, HEAD and patch digest; stale after any change); `git apply --check` first; only patches Atlas wrote under its patches folder; Command Center offers "Use this version" / "Apply to repository" | local-control 607 tests, 0 failing; tests on a real git repository: approval then apply, denied, stale after a commit, allow, deny, conflict leaves the person's edit untouched, patch outside Atlas's folder refused; removing the digest check or the folder check each fail a test | Pending apply requests are in memory (after a restart, ask again) | — |
| 2026-09-28 | [#169](https://github.com/cornerstonemarketingus/atlas/pull/169) (stacked) | roadmap 2 | Automations: schedule (5-field cron, local time), webhook (`POST /v1/hooks/:id/:secret`, before bearer auth, rate limited, Idempotency-Key) and run-now triggers that start normal missions or team missions; durable store (automations.sqlite) with run history; guards: duplicate keys, overlap skip, daily cap, auto-pause after 3 failures to start (shown under Needs you), one catch-up run for slots missed while stopped; webhook input passed as labelled untrusted data; Automations page in the console | local-control 616 tests, 0 failing locally; removing duplicate detection, the overlap guard or the webhook secret check each fail a test | Stacked on #169 (one pushable branch); GitHub-event and file triggers not yet | Roadmap stage 3: backend primitives for generated apps |
