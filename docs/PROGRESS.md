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
| 2026-09-27 | [#159](https://github.com/cornerstonemarketingus/atlas/pull/159) | Live coder recovery | Typed repository input errors return redacted, audited failures with tool name and valid fields; model can correct within existing limits | Regression fails before fix and when fix is removed; 18 focused pass; CLI 473 pass/2 skip/1 existing Windows path failure; runner/local 47 pass/1 existing Windows path failure | Protected registry: owner review; no live success claimed | Merge after review, rerun one-file coder diagnostic and replay audit |
| 2026-09-27 | [#154](https://github.com/cornerstonemarketingus/atlas/pull/154) | 2.5 | Coder edit diffs are unified hunks with 3 lines of context (Myers diff between common prefix and suffix, capped edit distance falls back to one replacement hunk; `\ No newline at end of file`; `/dev/null` sides). A one-line change in a 200-line file went from 400 diff lines to 8; the model sees this diff after every edit | atlas-cli 479/479; property test applies 1,200 generated diffs back; `git apply` accepts the editor's diff; hunk-boundary, backtrack and header mutations each fail a test; 100,000-line rewrite in 0.26 s | Diffs are text only (no JSON/web/IDE renderings yet) | — |
| 2026-09-27 | [#154](https://github.com/cornerstonemarketingus/atlas/pull/154) | 2.5 | Coder edits to lockfiles, installed dependencies, vendored directories and files marked generated are refused once with the reason and remedy; `allowGenerated: true` per edit confirms (the coder cannot run a package manager or generator, so no hard block); `.gitattributes` linguist-generated/-vendored decide first | atlas-cli 486/486; skipping the guard, one confirmation covering a whole change set, and checking before preview (reads a symlink target) each fail a test | Stacked on #154 because this session can push one branch; #154 merged after the owner's ruleset change (approvals 0, code-owner review kept) | — |
| 2026-09-28 | [#162](https://github.com/cornerstonemarketingus/atlas/pull/162) | 2.5 | Coder command runner: each command runs in its own process group and a timeout, cancel or exit stops the whole group (taskkill /T on Windows); Ctrl-C/SIGTERM to Atlas is passed on. Output past the limit keeps its start and end with an omission marker and the command runs to completion, so validation judges it by exit code (was: killed and reported as an execution failure). Failure output keeps its end, where the summary is | atlas-cli 491/491; a 500 ms timeout on a command with a grandchild returned after 6 s before, 0.3 s now; no process group, killing only the direct child, head-only capture and skipping the post-exit cleanup each fail a test | Interactive commands already get no stdin (EOF), so no prompt can hang; a TTY-only prompt still fails the command rather than being reported as interactive | — |
| 2026-09-28 | [#163](https://github.com/cornerstonemarketingus/atlas/pull/163) | 2.5 | Undo checkpoints: `atlas code` records each touched file's bytes and mode (or absence) before the session's first edit to it and saves a checkpoint under `.git/atlas/checkpoints` however the session ends; `atlas undo <repo> [--session id] [--dry-run]` restores all of it, all-or-nothing, refusing any file changed since the session; no Git history is touched | atlas-cli 500/500; end-to-end test runs `atlas code` against a loopback model that edits and creates a file, then `atlas undo` restores both; all-or-nothing, first-state, symlink containment, mode restore and the CLI wiring each fail a test when broken | Local CLI only; the hosted runner discards failed work already. No undo of an individual edit within a session | 2.4 validation engine: classify results NEW/PREEXISTING/FIXED/FLAKY/INFRA against baseline (audit what exists first) |
| 2026-09-28 | (this PR) | roadmap | docs/ROADMAP.md: the owner's ten-stage build sequence and the capability loop, each stage with what exists today (audited: several modules are tested but never wired into the daemon) and its first slice | docs | — | Stage 1: Command Center view across all running work, per-lane control |
| 2026-09-28 | [#167](https://github.com/cornerstonemarketingus/atlas/pull/167) | roadmap 1 | Command Center: `GET /v1/command-center` normalizes missions and their lanes, team missions, Genesis builds, coding tasks and Improve Atlas runs into one list grouped needs-you / running / waiting / recently finished, each with only the actions its state allows; per-lane pause / resume / cancel / retry (`POST /v1/missions/:id/lanes/:lane/control`) in the scheduler, a held lane surviving mission resume and restart; a Command center section in the local console that refreshes every 4 s | local-control 600 tests, 0 failing; HTTP test on the real MissionService and SQLite store (pause one of two running lanes, the other keeps running, resume through the action the view offered, device can watch but not control); releasing held lanes on mission resume and losing a running lane's stop reason each fail a test | Hosted app (apps/web) does not show local work yet | — |
| 2026-09-28 | [#168](https://github.com/cornerstonemarketingus/atlas/pull/168) | roadmap 1 | Launch agents in parallel from one request: `POST /v1/missions` takes `tasks` (one lane per task) or `objective` + `variants` (2–5 versions of one task, each told it is one of N); every coder lane runs in its own worktree; the Command Center labels versions and shows each finished lane's report and patch; a launch form in the Command center | local-control 602 tests, 0 failing; HTTP test launches three versions and reads each one's result from the command center | Applying a chosen version to the repository is not in the UI yet (patch path shown) | — |
| 2026-09-28 | [#169](https://github.com/cornerstonemarketingus/atlas/pull/169) | roadmap 1 | Use a version: `POST /v1/missions/:id/lanes/:lane/apply` applies a finished coder lane's patch to its repository's working tree under `code.write` (ask by default: approval bound to mission, lane, HEAD and patch digest; stale after any change); `git apply --check` first; only patches Atlas wrote under its patches folder; Command Center offers "Use this version" / "Apply to repository" | local-control 607 tests, 0 failing; tests on a real git repository: approval then apply, denied, stale after a commit, allow, deny, conflict leaves the person's edit untouched, patch outside Atlas's folder refused; removing the digest check or the folder check each fail a test | Pending apply requests are in memory (after a restart, ask again) | — |
| 2026-09-28 | [#169](https://github.com/cornerstonemarketingus/atlas/pull/169) (stacked) | roadmap 2 | Automations: schedule (5-field cron, local time), webhook (`POST /v1/hooks/:id/:secret`, before bearer auth, rate limited, Idempotency-Key) and run-now triggers that start normal missions or team missions; durable store (automations.sqlite) with run history; guards: duplicate keys, overlap skip, daily cap, auto-pause after 3 failures to start (shown under Needs you), one catch-up run for slots missed while stopped; webhook input passed as labelled untrusted data; Automations page in the console | local-control 616 tests, 0 failing locally; removing duplicate detection, the overlap guard or the webhook secret check each fail a test | Stacked on #169 (one pushable branch) | — |
| 2026-09-28 | [#171](https://github.com/cornerstonemarketingus/atlas/pull/171) | roadmap 2 | Automations finished: GitHub-event trigger (X-Hub-Signature-256 with a signing secret derived from the stored hash and shown once; event and branch filters; ping; X-GitHub-Delivery dedupe; a summary, not the payload, reaches the run), file-change trigger (recursive watch, debounced batches, ignores .git/node_modules/build output, paused with the reason if the folder cannot be watched), and "Automate this?" in the Command Center after the same coding tasks were finished by hand 3 times, opening a prefilled form | local-control 620 tests, 0 failing; a real fs.watch test; removing the signature check or the ignored-folder filter each fail a test | GitHub delivery needs Atlas reachable from GitHub (Settings → Reach Atlas) | Roadmap stage 3: backend primitives for generated apps |
| 2026-09-28 | [#166](https://github.com/cornerstonemarketingus/atlas/pull/166) (draft) | build reliability / #165 | Web typecheck command and scoped Worker binding types; Genesis nullable response fields and GitHub probe result typing; portable Windows workflow tests; generated Genesis tests explicitly select TAP. Requested product slices captured in NEXT-PRODUCT-SLICES.md | Web typecheck/lint/build pass, 269 web tests pass; 16 Genesis tests pass; full local-control 570 pass, 21 dependency/platform skips, 1 host EPERM creating a symlink; daemon boot passes | CI pending; Windows symlink fixture requires host privilege. Existing inference PR owns CI wiring; no security assertion weakened | Live Agent Command Center over existing mission scheduler; reconcile #106 isolation and #78 automations |
| 2026-09-28 | [#174](https://github.com/cornerstonemarketingus/atlas/pull/174) (draft) | OpenAI integration / #173 | Hosted chat provider selector and OpenAI cross-provider recovery after existing fallback; GPT-5.4 mini; dedicated origin-scoped OPENAI_API_KEY; deployment upload | 273 web tests, typecheck/lint/build, all workflow syntax pass; scripted streaming and credential isolation verified | Key location/name pending; no live API verification; protected workflow owner review; includes #166 build fixes; reconcile #158/#160 | Confirm OPENAI_API_KEY on Worker or repository Actions, merge/redeploy and verify live chat |
| 2026-09-28 | [#175](https://github.com/cornerstonemarketingus/atlas/pull/175) | roadmap 3 + track B plan | Backend primitives for every generated web app and API (templates v1.1.0, local, dependency-free): sign-in (`src/auth.mjs`: scrypt, HttpOnly SameSite=Lax session cookie, sessions stored as SHA-256, first account is the owner and sign-up then closes, owner adds accounts, slowed repeated failures, account deletion, cross-site writes refused, bearer tokens for the API template), file storage (`src/files.mjs`: type allowlist checked against the file's bytes, size limit, random stored names, sandboxed/attachment downloads), per-app secrets (`src/secrets.mjs` + `scripts/secret.mjs`: env wins, `data/secrets.json` 0600, only names/status leave the server) and scheduled jobs (`src/jobs.mjs` on Atlas's cron parser; no overlap; failures recorded); `src/backend.mjs` wires them from app.config.json. Password sign-in is now a template task (no model needed); the inspector proves the signed-out gate and checks workflows with a temporary account it deletes. Web app gets sign-in and Files screens. ROADMAP gains Track B (agent OS: kernel + world state, world graph, protocols, capability economics, teach-by-demonstration, subscriptions, adaptive autonomy, simulation, evolution, adversarial multi-agent reasoning, gateway) | local-control 622 tests, 620 pass, 0 fail (2 skipped); Genesis 39/39 incl. browser inspections with Playwright; generated-app tests run with sign-in on and off for web-app and api-service; 17 guard mutations, 16 killed (survivor: redundant chmod after a 0600 write) | Hosted (Cloudflare) variants of the primitives come with stage 5 | Track B1: Agent Kernel + explicit World State |
| 2026-09-29 | [#176](https://github.com/cornerstonemarketingus/atlas/pull/176) | track B1 | Agent kernel (`apps/local-control/src/agent/kernel/`): one loop — goal → mount capabilities → perceive world state → retrieve memory → act → observe → update world → verify → continue/escalate → finish — for a run composed of goal, intelligence, identity, capabilities, environment, budget, policy and memory. Capabilities (code, browser, computer, terminal, research, database, email, payments, deploy, design, vision, automation, atlas) group registry tools, narrow to the agent's permissions and report gaps (for the capability loop). World state (`world.sqlite`): 19 entity types, 16 relations, merge + versioning, atomic observations, per-run traces, secret-looking keys dropped at any depth, credentials as references only, URL queries never stored. Team mission steps now run through the kernel (same tools as before, proven for every family permission); chat tool calls update the world state; `GET /v1/world`, `/v1/world/entities/:id`, `/v1/world/runs/:id/trace` (owner only) | local-control 632 tests, 630 pass, 0 fail (2 skipped); e2e journey passes; daemon boots and serves `/v1/world`; 10 kernel guard mutations, 9 killed (survivor: mounting every capability, still narrowed by the permission ceiling) | Chat turns and coder lanes are observed but not yet kernel runs | B1 continued: chat and coder lanes as kernel runs, run trace in the Command Center |
| 2026-09-29 | #174 | OpenAI activation | OPENAI_API_KEY confirmed in repository Actions secret-name list; updated branch against main, preserving new Genesis backend primitives and TAP validation | Secret names only inspected; no values read | Merge/deploy and live verification remain | Owner review of protected deployment workflow |
| 2026-09-29 | [#177](https://github.com/cornerstonemarketingus/atlas/pull/177) | track B1 | Coder lanes are kernel runs: `kernel.runHarness` wraps an external harness (atlas-cli today) with the kernel's goal, trace, world state and verdict (verified only when the harness succeeds and produced an artifact; crashes and cancellations recorded); the patch becomes an artifact entity linked to its run and repository; lane evidence carries the run id. Command Center lanes link to their run (`run`, `trace`) and show "How it ran": goal, capabilities (and gaps), each action, the check and the outcome | local-control 634 tests, 632 pass, 0 fail (2 skipped); console script parses; daemon boots and serves the command center | Chat turns still observed, not kernel runs | B1: chat turns as kernel runs; branching as a kernel decision |
| 2026-09-30 | [#179](https://github.com/cornerstonemarketingus/atlas/pull/179) | track B1 | Every chat turn is a kernel run: `kernel.begin` gives a caller-driven run (the chat's streaming loop is its act phase) with goal, capabilities, perception, each tool call and an outcome (answered / waiting / unverified / cancelled; "answered" is not claimed as verified). A turn perceives what earlier turns of the conversation touched (two hops: conversation → earlier runs → files, pages, people; per-call events left to the trace) as data. Runs link directly to what they touched | local-control 637 tests, 635 pass, 0 fail (2 skipped); e2e journey passes; daemon boots; 5 guard mutations, all caught | — | B1: branching (parallel strategies) as a kernel decision |
| 2026-09-30 | [#180](https://github.com/cornerstonemarketingus/atlas/pull/180) | track B1 | Branching as a kernel decision (`agent/kernel/branching.mjs`): `POST /v1/missions` with `strategy: "auto"` lets the kernel choose one lane or 3 competing versions, with reasons stored on the lanes (open-ended work, or this objective already failed on this repository per the world state → branch; mechanical work → one lane). When no version is still working, the Command Center ranks the finished versions (completed with a patch, verified first, smallest change) and recommends one; the owner still chooses and approves. Console: "Let Atlas decide" launch mode, the decision's reasons, a Recommended badge. Coder runs for versions record the shared request as their goal | local-control 640 tests, 638 pass, 0 fail (2 skipped); e2e passes; console script parses; daemon boots; 7 guard mutations, all caught | Ranking uses change size and verification only; comparing by tests and review comes with stage 9 | Track B1 complete; next per ROADMAP: stage 4 (Visual Genesis editor) |

| 2026-10-01 | (this PR; #173) | hosted provider recovery | Selecting OpenAI now prefers OpenAI while retaining the separately configured provider and its existing model fallback for transient failures. Explicit `none`, unsafe endpoints, same-origin cycles and authentication failures remain fail-closed. Context and credentials stay bound to the correct target | 7 provider tests; all 276 web tests pass, including streaming conversation recovery after OpenAI 429 | Does not make exhausted provider accounts available. Production replay remains necessary after deployment; Actions write gate remains owner-pending | Verify the reported live conversation after release; reconcile inference governor PRs separately |

| 2026-10-01 | (this PR; #184) | free-provider recovery | Give each configured fallback one bounded short retry; retain body-supplied resets into final synthesis; recognize HTTP-date Retry-After; classify exhausted credits without exposing provider bodies or retrying billing errors within a turn. A free provider's reset is no longer replaced by the unfunded paid fallback's generic 429. Explicit oversized-input refusals can retry with shorter marked tool excerpts, preserving original saved evidence and call IDs | Focused recovery and production-loop tests cover streaming/non-streaming repository reads, billing, fallback retries, reset timing, and unchanged original evidence; full CI/live gate recorded on PR | No new paid provider, spend limit change or credit purchase. No persistent queue yet; long provider resets still return incomplete work honestly | Deploy and replay the failed repository-read release gate |

## 2026-10-01 future-system handoff reality audit

- **Current main / deployment:** `974fc2a6e734178b9f461dc94176642c1f506a32` (#186), deployed successfully by run 36902398912. All required CI passed. Post-deploy gate 36905659506 **failed**: non-streaming HTTP 400 after two repository tools, streaming rate limit after one. Setup is now 8/8. Do not call the live incident resolved.
- **Current slice (#188):** bounded repository pages are implemented and tested; deployment and live replay remain the next action. Existing local-control/Windows/Genesis suites passed in #186 CI. This slice changes the existing `read_repository_file` boundary to 3000-character pages (maximum 4000), explicit offsets, unchanged-file SHA checks and bounded previews. Streaming/non-streaming model/tool tests reconstruct complete evidence. A SHA-guard mutation is caught.
- **Already wired:** local Agent Kernel + World State, parallel missions and Command Center lane controls, local automations, Genesis build/preview/inspection and backend templates. `main.mjs` also connects the MCP daemon bridge; do not rebuild a disconnected replacement gateway.
- **Partial / disconnected:** hosted durable continuation and sleeping/waking are not established by this audit; full governed skill creation/install remains future work. Visual editor #181 is unmerged. Self-improvement review recovery is preserved on `codex/self-improve-recovery`, not on main.
- **Claude branch:** `claude/atlas-usability-navigation-2ywfn8` has four patch-unique commits absent from main: `b369617` real GitHub job-step UI, `d702ea3` TODO exclusions, `d28bec1` deterministic assignment selection, `f57854d` CLI Groq 413 handling. The TODO prose change is superseded within that branch by its selector. Job-step evidence and provider classification are candidates for selective recovery; do not merge the branch wholesale or transplant its old TODO priority order over this roadmap.
- **Ollama:** current workflow has conditional installation, pinned version/checksum inputs, an Actions-minute check, readiness probing and context-window coordination. Repository variables contain version `v0.34.1` and a SHA256, but `ATLAS_SELF_HOSTED_MODEL` is unset, so it is not an active inference route. Local gateway exists; hosted Workers cannot reach a user's localhost. No model download, new paid compute or unsafe host fallback was enabled.
- **Contradictions / ownership:** README still frames the product as a read-only inspection CLI and says Node 20; current packages require Node 22.13+. ROADMAP stage-1 status lags newer Command Center work, and TODO unchecked entries are not reliable absence evidence. Open #185 claims CLI/Ollama work in its description but actually modifies the hosted chat loop/tests; retain its branch for reconciliation and avoid overlapping edits. #156's short fallback retry is implemented in newer main via #186. Inference governor PRs #129-133/#158/#160 remain separate unmerged work.
- **Dependency order:** finish hosted free-provider read/answer reliability and safe diagnostics; prove hosted coder PR/CI/result delivery; reconcile useful old branches; then resume Visual Genesis, durable mission wait/resume and unified UX. Large harness marketplaces, agent economics and physical AI remain deferred as requested.

## 2026-10-01 hosted verification and task-history recovery (#190)

- #188 merged as `f0affd0` and deployed in run 36908643685. Hosted replay 36908894178 passed: both streaming and non-streaming repository-reading requests answered and stored their result. This establishes one successful replay, not unlimited provider capacity.
- The next coding gate (36909235773) exposed a separate failure: GitHub accepted the task but `recorded` was false. Runner 36909261185 completed and opened #189 with exactly the requested one-line documentation file. Its callback returned 404; the reporter incorrectly printed “Delivered result” afterward. Do not count that job's green status as persisted delivery.
- Added schema-only task-history diagnostics to setup and a pre-dispatch check before credentials, plan usage and execution. Missing columns are reported by fixed names; database error text is withheld. No production schema was altered. A fully migrated local database records the task; removing the correlation column reproduces failed insertion. The live missing-column diagnosis remains to be confirmed after deployment; migration history alone is not proof.
- Reporter now distinguishes delivered from absent-hosted-task outcomes. Also repaired the existing CODEOWNERS test's Windows URL/path conversion without changing protected patterns or assertions.
- Evidence: 300 web tests, build/typecheck/lint; 49 runner tests. Real task POST test stops before dispatch when history schema is incomplete, and disabling its guard fails the test. Next: deploy diagnostics, identify the exact production schema gap, repair only that gap using reviewed tooling, then rerun the full coder/result gate. #189 is test evidence and should not be merged merely to make verification green.

## 2026-10-02 targeted production schema repair (#190)

- #192 merged as `1d61567` and deployed successfully (36944362013). The live guard in 36944512491 identifies exactly `tasks.correlation_id` as missing and returns 503 before dispatch; setup now accurately reports 6/8 rather than a false 8/8.
- Required repair is migration `0013_task_correlation_id.sql` only. Migrations 0014 and 0015 were applied separately according to their workflow logs; rerunning the old unbounded range would reach an already installed, non-idempotent migration.
- Prepared an optional inclusive `through_migration` bound in the existing migration workflow, plus schema-only task-column inspection and a tested selector. Dry-run remains the default; no SQL input, secret handling change or automatic migration was added. 52 runner tests pass, including executing the selector CLI against the actual migration directory.
- After protected workflow review/merge: dry-run on main with `database_name=configured`, `from_migration=0013`, `through_migration=0013`; confirm only 0013 is selected and the column is absent; apply that exact range with `dry_run=false`; rerun the hosted coder gate and verify task/result persistence. No production migration has been applied by this change.

## 2026-10-02 production task-history repair verified (#190)

- Targeted migration dry-run 36945590171 selected only `0013_task_correlation_id.sql`; its schema output confirmed that `tasks.correlation_id` was absent. Apply run 37012817045 successfully applied only that migration. No later migrations were replayed and no provider billing/settings were changed.
- Hosted coder gate 37012963000 **passed** after the repair: setup 8/8, task `8ac1cdd6-e336-4c3d-852a-a1f4c87b6321` recorded, coder run 37012984754 completed, smoke PR #194 created, verified result received and persisted in conversation `cc223b8a-f7a2-453b-b483-ae4c6282cece`. #189 and #194 contain only smoke-test documentation and are evidence, not product changes to merge.
- The original repository-reading chat replay 37013274766 **failed again**: non-streaming HTTP 400 after two tools; streaming 429 after one. Earlier replay 36908894178 passed both modes. Therefore chat/provider recovery is intermittent and remains unresolved; the successful coding gate does not establish reliable chat.
- PR #185 still actively owns `agent-loop.mjs` (latest commit 2026-10-01 16:48 UTC, less than the 48-hour stale threshold). Further edits require ownership reconciliation under PROGRAM section 4. PR #191 independently adds honest history-save warnings; retain that work, which now needs reconciliation with newer main.
- Next priority remains diagnosing/recovering the chat 400/429 through the existing router/loop after ownership is resolved. Do not add paid capacity or treat retries as a substitute for identifying provider failure categories. Task-history issue #190 is repaired and verified.

## 2026-10-02 bounded final-answer recovery (#196)

- Owner explicitly authorized taking over/reconciling #185; recorded takeover on that PR. Retain main's stronger retry/reset/context-compaction/billing exclusion behavior from #186, and carry forward #185's additional fixed `billing_hard_limit_reached` classification. No new paid routes or credentials.
- Reproduced a concrete gap: `tool_use_failed` HTTP 400 during tool-free final synthesis was treated as fatal. Detect it even without tool definitions, issue one plain-text correction, then select the existing configured fallback within the same three-attempt synthesis bound. Completed evidence remains available, rejected provider content is never inserted/executed, and diagnostic metadata records only a rejection boolean.
- Regression tests failed before the fix and pass after it in both streaming modes; tests also cover bounded exhaustion, unknown 400 remaining fatal, and legacy billing limits avoiding waits. All 305 web tests pass. This is not proof of the exact cause of live run 37013274766's generic HTTP 400, nor does it eliminate free-provider quota exhaustion. Deploy and replay the hosted gate before declaring production recovery.
- Independent PR #197 review caught the cross-provider-only fallback case; added support and both streaming boundary tests proving the alternate endpoint and credential are used. All 307 web tests pass after the correction; original build/typecheck/lint passed, and required CI reruns on the final commit.
- Free/local harness audit: existing Ollama adapter, measured capability registry, local executor, Git-worktree runner and Agent Kernel are the integration seams. OpenCode/Goose and Docker/Podman were not found on this PC. C: had about 240 MB free; no package/model downloads were attempted. Installed `qwen2.5-coder:7b` advertises tools, but both bounded 20-second JSON/tool-call probes timed out. It is not qualified for autonomous coding on this evidence.
- Next local slice: mount a pinned OpenCode adapter through the existing executor/kernel with local-only provider configuration, explicit environment authorization, bounded execution/cancellation and independent verification. A Git worktree is repository isolation, not an OS security sandbox. Do not claim the external-harness acceptance gate until a real installed harness completes edit/test/repair and produces verified evidence with paid providers disabled.

## 2026-10-02 production replay and GitHub request observations (#199)

- #197 merged as `2602ea6`; deployment 37059991435 succeeded. #185 was closed as reconciled with its branch preserved. Hosted replay 37060356758 still **failed**: both modes exhausted model capacity with 429 after repository tools; neither reported HTTP 400 on this replay. Chat reliability remains unresolved, and GitHub credentials are not a remedy for model-provider quota exhaustion.
- Owner's GitHub correction is accepted: do not broaden a PAT merely for quota. First measure actual consumption. Existing coder workflows check out a repository and the CLI uses local filesystem tools; hosted chat Contents/Search calls are a different path. PR #98 actively owns those chat files, so this slice does not overlap them.
- Instrumented the existing `fetchGitHubJson` boundary used by hosted task status, activity and PR-change reads. Each attempt emits `github.request` with fixed category/source/outcome, timestamp, latency, HTTP status and numeric quota/reset/retry metadata. No URLs, repository paths, authorization, response contents or exception messages are logged. Primary exhaustion, secondary header signals, authentication, ambiguous 403, network, timeout and invalid JSON remain distinct. The existing null-on-failure contract, request count and timeout remain unchanged.
- Evidence: all 326 web tests pass after review, production build/typecheck/lint pass, and removing the runtime observation causes boundary tests to fail. CI reruns required checks on the final commit. This is structured runtime logging, **not** a complete usage dashboard, cross-agent aggregator, cache or automatic retry system.
- Next: extend telemetry to other unclaimed GitHub boundaries, reconcile #98 before instrumenting chat, then add credential/tenant-safe SHA-addressed retrieval caching and concurrent-read deduplication. Keep GitHub App permissions scoped. Disk recheck now shows 38.8 GB free, resolving the earlier disk blocker; local model qualification and external-harness execution are still unverified.
- PR #201 independent review separated response-body transport errors from JSON parse failures; both now have real HTTP-200 boundary tests. A second installed-model qualification attempt with 60-second per-request bounds also timed out on JSON and tool-call probes; do not enable local autonomous coding based on advertised capabilities alone.

## 2026-10-02 immutable hosted file reuse (#204, parent #198)

- #201 merged as `febdc85`, deployment 37063268739 succeeded, and hosted inspect gate 37063560676 passed: setup 8/8 and inspection result received/persisted. Its unchanged Windows daemon-startup tests passed on a single failed-job rerun and locally. Model-backed chat is still not a passing release gate (latest replay 37060356758: both modes 429).
- Re-audited main and open claims. #200 owns CLI providers, #202 team verification and #203 billing; none are changed here. #98's actual last commit is September 26, 18:50 UTC (not its later comment timestamp); recorded limited stale overlap under PROGRAM section 4 for `instant-tools.mjs`, preserving its PR/CI functionality and branch. Active #191's route is untouched.
- Actual path: chat route authenticates account, resolves tenant/conversation access, derives tenant/deployment allowlist and creates one tool context. Its memoized credential prefers the configured GitHub App installation token then the platform token. `converse` and team children share that context; `runInstantTool` dispatches to `readRepositoryFile`, which validates arguments and checks repository authorization/credential before any cache lookup. Retrieval then uses the fixed GitHub Contents endpoint; SHA check/pagination and untrusted-data wrapping remain at the tool boundary.
- Added bounded **per-turn** reuse of cryptographically verified Git blobs and explicitly supplied full 40-hex commit refs, plus in-flight coalescing. No branch-head aliases, cross-request or cross-tenant cache. Explicit `fileSha` pins previously observed content, including offset-0 rereads; omitting it on branch reads refreshes the branch. Mismatch on a cache miss still fails closed. Full repository/branch-to-commit snapshots remain the next slice, not a completed claim here.
- Limits: 16 entries/in-flight keys, 2 MB accounted cache memory, 512 KB admitted files and 2 MB response-body bound. Oversized/unverifiable files are not cached. Credentials changing within a context invalidate its cache. Rate-limit Retry-After/reset guidance suppresses new upstream reads in that context without retry loops; cached authorized evidence remains usable. Extended #201 fixed-field telemetry with hosted-chat source, response-body byte counts, hits/misses/coalescing/cooldowns and avoided calls; no source, URLs, paths or credentials.
- **Observed live before/after**, identical five-read sequence at public commit `febdc85e141c65529b59a11f1c2e22510d6aecb8`: `agent-loop.mjs` page 1, page 2, reread page 1, related `providers.mjs`, reviewer reread page 1. Contents requests **5 -> 2**, Search **0 -> 0**, response-body bytes **208678 -> 55546**; returned pages were identical. Elapsed time **1867 -> 214 ms** in this one sample, not a general latency guarantee. Regression fixture first failed at four requests versus one; concurrent identical reads now make one request, and real streaming/non-streaming conversations paginate with one retrieval.
- Local setup update: 33 GB free; pinned OpenCode 1.18.34 downloaded from its official release, published SHA-256 checked, version executable verified. Docker CLI exists but its engine is unavailable. Loaded CPU-only qwen2.5-coder:7b still timed out on a 60-second tool-call probe. No paid provider/spend changes, no autonomous local-coder qualification claimed.
- Validation: all 343 web tests pass; production build, typecheck and lint pass. Guard mutations independently proved authorization denial and SHA admission tests fail when their guards are removed; restored implementation passes all 17 new boundary tests. The SHA mutation exposed and repaired a test gap around full-commit cache aliases.

## 2026-10-03 repository reuse release evidence (#205)

- #205 merged as `2101ffc4d57424409ec68bcd3269479656fa1c10`. All required CI checks passed in run 37159492933; Cloudflare deployment 37159643602 succeeded. No merge/review controls were bypassed.
- Shipped the five-file implementation described above: immutable per-turn content reuse, simultaneous-read coalescing, bounded memory/body sizes and existing telemetry integration. Real upstream benchmark: identical evidence with five Contents requests reduced to two. All 343 web tests passed, including 17 new boundary tests; production build/typecheck/lint passed.
- Re-audited deployed main: #200/#202/#203 remain separate active work. Next recommended slice is a repository snapshot that resolves a mutable ref once per explicit snapshot, carries commit identity across related file reads, and tests branch movement between files without crossing authorization boundaries. Keep unpinned refresh explicit; do not call the current per-file cache a repository-wide snapshot.
- Remaining independent blockers: latest model-backed hosted replay still exhausted capacity; local model tool-call qualification timed out; Docker engine was unavailable. Installed OpenCode and freed disk do not resolve these automatically.
- Post-deployment hosted inspect gate 37159714627 passed on October 3. This verifies authenticated setup/task execution/result persistence without a model call; it is not evidence that model-provider capacity failures are resolved.

## 2026-10-03 durable background queue for generated apps (reconciles #172 into #175)

- Generated web apps and APIs gain `src/queue.mjs`, ported from draft #172: jobs persist in the app's SQLite file, deduplicate by key, retry with growing delays up to a bounded attempt count, hold a lease so two workers never run one job, and fence results so a stale worker cannot overwrite a recovered attempt. Exception text is never stored. `src/backend.mjs` runs a queue worker beside the cron scheduler (`backend.start()`, `backend.drain()`), takes `queueHandlers` from the server, and adds queue counts to the owner-only `GET /api/jobs`.
- Genesis bug fixed on the way: `outputTail` kept only the last 4 000 characters of check output, so a failing test that later tests pushed out of the tail reached the repair loop without its name ("Fixing: name: 'AssertionError'"). Failing `not ok` lines are now kept at the top of the tail.
- Evidence: local-control 641 tests, 639 pass, 0 fail (2 skipped); generated-app tests run the queue tests with sign-in on and off; 7 queue/worker guard mutations in a real generated app, all caught. Queue tests close SQLite before deleting their folder (the Windows failure mode from #169).
- Open: #172 can be closed once this merges; its web typecheck fixes already reached main through #174.

## 2026-10-03 empty final answers reach the cross-provider fallback

- Production report (Automatic provider): after two completed steps (a repository search and a file read), hosted chat ended with "I could not reach a model to write up the answer … the model returned an empty reply." Root cause in `apps/web/app/api/chat/agent-loop.mjs` `synthesize()`: on empty replies it retried the configured model, switched at most to the same-provider fallback model, and never asked the cross-provider fallback (OpenAI under Automatic), which was only used for rejected tool calls.
- Fix: empty replies walk a chain (configured model, which keeps its second try; same-provider fallback model; cross-provider fallback), each fallback getting an attempt of its own; a model cut off by the token limit gets one more try with more room before the chain moves on.
- Evidence: web lint and typecheck clean; 347 web tests pass, including four new synthesis tests (Automatic falls through to the cross-provider fallback, streaming and not; the full chain order; a cut-off fallback retried with more room); 4 mutations of the chain, the retry rule and the attempt budget, all caught.
- Open: per CLAUDE.md, run "Verify hosted Atlas" in `chat` mode after the deploy (the chat release gate). If the fallback provider also returns empty, the reply still ends with the saved work and the reason.

## 2026-10-03 Genesis builds are kernel runs

- `GenesisExecutor` takes the agent kernel: each build drive is a kernel run (`harness: "genesis"`, capabilities code, design and browser, environment = the project's workspace), linked to task `genesis:<project>`. Every stage the build reaches is an action of the run (`genesis.building`, `genesis.verifying`, `genesis.repairing`, …), and the outcome is recorded: verified (ready or published), waiting (blocked, paused or planned), cancelled, or unverified with the stage it stopped at.
- With team steps, coder lanes and chat turns already on the kernel, Genesis was the last major path outside it. Automations start missions, so their work runs as kernel runs through those missions; the automation itself is not yet linked in the world state.
- Evidence: local-control 643 tests, 641 pass, 0 fail (2 skipped); new tests: a real build traced end to end (goal, stages as actions, finish, verified) and a blocked build recorded as waiting; daemon boots.
- Triage notes from the same session: #77 (CSP nonces) should not merge as is — the Worker stamps the nonce onto every `<script>` after rendering, injected ones included (comment on the PR); #69 (hosted rate limiting) needs a redo on current main (its migration number and routes conflict); the Phase 1 stack (#129–#133, #158, #160) is green at its last push but needs the owner's decision (see the PR thread summary in this session).

## 2026-10-03 sleeping agents: goals that wake on events (Track B7, first slice)

- `apps/local-control/src/agent/goals.mjs`: a goal is an objective Atlas keeps pursuing across days ("get this PR merged"). It works (a normal mission), then sleeps, subscribed to a GitHub repository and optionally one pull request. A signed delivery that matches `wakeOn` (default: failed check suites, check runs or workflow runs, reviews, review comments, comments) wakes it and starts a mission carrying the event as untrusted data; an event meeting `until` (default for a PR: closed and merged) achieves it.
- Bounded: at most `maxWakes` wakes (default 10, then "exhausted", which needs the owner), an expiry (default 14 days), never two missions for one goal (a wake that arrives while one runs is kept and runs next), and each delivery is handled once.
- Events: `AutomationService` now passes every signed GitHub delivery to `onEvent` (after the signature check, before the automation's own event filter), with `githubEventSummary` adding conclusion, merged, review state, PR numbers on check suites/runs and a bounded comment. An unsigned or mis-signed delivery reaches nothing.
- Surfaces: `GET/POST /v1/goals`, `GET/DELETE /v1/goals/:id`, `POST /v1/goals/:id/wake` (owner-only writes); Command Center items (sleeping = waiting, working = running, exhausted = needs you) with Wake now and Cancel, and a "Keep at it until a pull request merges" form; each goal is a task in the world state; history in `goals.sqlite`.
- Evidence: local-control 651 tests, 649 pass, 0 fail (2 skipped); 8 new goal tests including a signed delivery through the real automation webhook path; 11 guard mutations (dedupe, repository and PR matching, no overlap, wake cap, expiry, merged and conclusion matching, waiting for the mission, untrusted wrapping, event delivery), all caught; e2e passes; live daemon serves `/v1/goals`.
- Needs: a GitHub automation webhook for the watched repository (events reach the daemon through it).

## 2026-10-03 capability economics: choosing a model from Atlas's own record (Track B4, first slice)

- `apps/local-control/src/agent/kernel/economics.mjs`: candidates are any way to do the work, with a success estimate, minutes, cost, privacy and risk. Budgets are hard limits (money, time, risk, local-only); within them the score is success − time − money − privacy − risk. Success rates come from the world state's verified and unverified runs as a Beta(1,1) posterior mean, so an untried candidate starts at even odds and earns or loses its place. Decisions carry reasons.
- `POST /v1/missions` with `model: "auto"`: the installed local models are scored by their coder-run history (coder runs now record their model), the best is used, the decision and reasons are stored on the lanes and recorded in the world state, and the Command Center shows "Atlas chose the model …: 3 of 3 past runs verified, about N min each". The launch form offers "Let Atlas choose (from past results)".
- Evidence: local-control 653 tests, 651 pass, 0 fail (2 skipped); new unit tests (history, even odds for untried models, each budget, tie to the configured model) and an HTTP test choosing between two installed models by record; 8 mutations of the scoring and budget rules, all caught; console script parses.

## 2026-10-04 adaptive autonomy: a level for every action (Track B8, first slice)

- `apps/local-control/src/agent/kernel/autonomy.mjs`: each tool call gets a level, 0 auto · 1 auto + audit · 2 auto if reversible · 3 ask · 4 strong confirmation · 5 prohibited, with reasons. Effects come from the tool's `effects` declaration or its capability (reads; sandboxed, restorable or irreversible writes; outside communication; production; money); arguments can only add to them (a destructive command in something that runs, a `target`/`environment` of production, a positive amount, a credential-looking value). A declared critical tool is at least 4, a high-risk or always-asking tool at least 3; an unsure agent (confidence < 0.5) loses one level, never into 5. Credentials leaving the machine, or destroying production data, are 5.
- It wraps the owner's policy in the tool registry and only tightens it: deny stays deny; levels 0–3 follow allow/ask; 4 asks even where allowed, and approving it needs a second confirmation (`risk_level` on approvals; `POST /v1/approvals/:id/decision` answers 409 `CONFIRMATION_REQUIRED` without `confirm: true`; the console asks again); 5 is refused with `PROHIBITED` and never executes, even with an approval. Allowed actions at level 1+ are audited (`autonomy.acted`).
- Production deploys from Genesis are level 4 at the publisher's own approval (even with deploys allowed); `genesis.publish` declares itself request-only so it does not ask twice.
- Precedent: `GET /v1/autonomy` lists each tool's level and suggests relaxing a capability set to "ask" after at least 5 consecutive approvals and no denial in the recent window, only for level ≤ 3 tools that do not always ask. The Computer page shows these with "Let Atlas do this without asking"; nothing changes until the owner accepts.
- Evidence: local-control 662 tests, 660 pass, 0 fail (2 skipped); e2e passes; 9 new autonomy tests and a publisher test; 26 mutations of the levels, argument scan, tightening, audit and suggestion rules, plus 3 of the publisher and request-only rules, all caught; live daemon lists 44 tools across levels 0–4.

## 2026-10-04 world graph: what breaks if I change this? (Track B2, first slice)

- `apps/local-control/src/agent/kernel/repo-graph.mjs`: `mapRepository(world, root)` walks a repository (skipping node_modules, build output and hidden folders; at most 3000 source files, reported as truncated beyond that) and records packages (`package`, a new entity type) `part_of` the repository, local package `depends_on` package, every source file `part_of` its nearest package, imports as file `depends_on` file or package (static, dynamic, re-export, require; `.js` resolves to `.ts`, folders to `index`), and imports from test files as `tests`. Files use the same keys coder runs already touch (`<repository>:<path>`). A re-map drops only the edges the previous map of that repository recorded (`world.dropRelations({ source })`).
- `world.impact(id, { depth, limit })`: everything a change would affect — what depends on, uses, calls or tests it, what it is part of, where it deploys — each with its distance and the edge that reached it, plus the test files among them as the tests to run.
- Routes (owner only): `POST /v1/world/map {repository}` (absolute folder), `GET /v1/world/impact?id=&depth=`. The world route handler is now async (the server awaits it).
- Live: mapping this repository takes about 0.25 s (731 files, 1531 imports, 7 packages); a change to `world-state.mjs` reaches 10 entities and names the 7 test files that exercise it.
- Evidence: local-control 667 tests, 665 pass, 0 fail (2 skipped); e2e passes; 5 new graph tests; 18 mutations of the walk, resolution, test detection, re-map and impact rules, all caught (two guards found equivalent were removed rather than kept untested).


## 2026-10-04 immediate chat-to-coder handoff (#216)

- Re-audited main ab84e06: real coding already uses the checked-out CLI/verified coder session and existing task dispatch. The concrete chat gap was deferring a selected task until after optional lookups/final synthesis, adding model-capacity failure points before execution began. No new agent architecture or unscoped shell capability was needed.
- `converse` now dispatches an offered `start_atlas_task` batch immediately through the existing authenticated callback, before same-response read-only tools and without a synthesis model call. Its receipt reports the task service's result. Child/unoffered tools cannot dispatch; malformed calls are reported; uncertain dispatches are never retried blindly. Existing task API policy, tenant/owner checks, billing, persistence and merge controls remain authoritative.
- Coding prompt guidance now routes explicit engineering requests promptly to the coder, leaves filesystem discovery/edit/test/repair there, grounds continuation in the conversation and prohibits invented completion/background-resume claims. The supplied handoff is implemented as a narrow runtime change plus truthful instructions, not a claim that all model failures or durable checkpoints are solved.
- Evidence: all 354 web tests pass, including seven new immediate-dispatch cases (real SSE and JSON, lookup ordering, task refusal, uncertain response, child/unoffered calls and invalid arguments). Disabling immediate dispatch makes the regression tests fail; restored implementation passes. Build/typecheck/lint and required CI are checked before merge.
- Ownership: limited stale overlaps with #158/#160 (September 27) and #191 (October 2 14:34 UTC) documented under PROGRAM section 4; branches and their distinct work preserved. #207 and local snapshot commit e073218 remain untouched.
- Remaining: first-call provider failure can still prevent task selection; a dispatched coder still needs its own available model. Durable phase/checkpoint recovery and the full edit/test/PR live gate are not established by these tests. Next highest-value slice is persisted recovery for a specific verified-coder provider failure, using existing task/mission state rather than chat text as its sole checkpoint.

## 2026-10-04 immediate coder handoff released (#217)

- #217 merged as 7a54692f919404804dacb39ff565836a69a82437. All required CI checks passed in run 37240576618; Cloudflare deployment 37240814686 succeeded. Local production build/typecheck/lint and 354 web tests passed. No protected merge/review controls were bypassed.
- Selected coder tasks now enter the existing authorized task runtime before optional chat lookups or synthesis. The deterministic receipt survives lack of capacity for a subsequent answer-writing call. This release does not claim that first-call provider exhaustion or durable coder resumption is fixed.
- Next: persist and resume a concrete provider-blocked coder attempt through existing task/mission state, with a real edit/test/PR validation gate. Snapshot work e073218 remains preserved separately pending #207 ownership reconciliation.
- Post-deployment authenticated hosted inspect gate 37240938790 passed. This checks task execution/result persistence without a model call; it does not replace the still-needed model-backed coding/resumption gate.

## 2026-10-05 hosted chat waits out per-minute rate limits and says who refused

- Reproduced live with "Verify hosted Atlas" in `chat` mode (run 37249189461): the non-streaming question was answered; the same question right after (streaming) ended "no model wrote the answer (the model provider's rate limit was reached.)" after 34 s. The first answer used the minute's allowance; Groq's model, Groq's fallback model and the OpenAI fallback all refused within that minute, and a reply never waited more than 45 s in total, so a ~40–60 s reset ended it.
- Fix (`apps/web/app/api/chat/agent-loop.mjs`): every route is still tried first (configured model, same-provider fallback model, cross-provider fallback); then the provider's stated reset is waited out when it is about a minute or less (at most 65 s per wait, 150 s per reply), with "Waiting about N s for model capacity…" shown. A longer reset (a daily quota) is not waited for.
- The reason now names each model that refused and why, in fixed categories (rate-limited and for how long, no API credits, too large, unavailable), never provider text: e.g. "m (api.groq.com) is rate-limited for about 40 s; gpt-5.4-mini (api.openai.com) has no API credits or reached a billing limit". Before, an OpenAI account without credits was reported only as Groq's rate limit.
- Evidence: web lint and typecheck clean; 360 web tests pass; 7 new or changed tests (the production sequence replayed streaming and not, waited out and recovered; the same with nothing recovering, naming all three; a daily reset not waited for; the refusal wording), all failing on the previous code.
- Open: re-run "Verify hosted Atlas" in `chat` mode after the deploy. Owner wants a self-hosted Ollama route instead of Groq; `scripts/local/model-gateway.mjs` cannot be the main chat model yet (refuses streaming, drops tools, one request at a time, 1200-token replies): next.

## 2026-10-05 your own model as hosted chat's main model (Ollama), Groq and OpenAI as fallbacks

- `scripts/local/model-gateway.mjs` could not be the main chat model: it refused streaming, dropped tool definitions, served one request and answered "busy" to the next, and capped replies at 1200 tokens and conversations at 30 messages. Now it forwards streaming (server-sent events passed through), `tools`/`tool_choice` and the other inference fields (anything else is dropped), allows several models (`ATLAS_GATEWAY_MODELS`), queues requests beyond `ATLAS_GATEWAY_CONCURRENCY` (a full queue or a wait over 2 minutes answers 429 with retry-after), passes the model server's 4xx back (so Atlas can drop tools a model does not support) and hides its 5xx. Still token-authenticated, loopback-only, and never exposes Ollama's management API.
- Hosted chat (`apps/web/app/api/chat/`): Automatic routes the configured model, then Groq (`openai/gpt-oss-120b`, then `openai/gpt-oss-20b`) when a `GROQ_API_KEY` reaches the Worker and Groq is not already the main model, then OpenAI; fallbacks chain (`callModel` recurses), and an empty final answer walks the same route. A self-hosted endpoint (anything but Groq and OpenAI) gets 5 minutes per request instead of 1. Cloudflare's tunnel-origin errors (520–524, 530) count as "not now", so a machine that is off routes to Groq at once.
- Setup steps: `docs/HOSTED-VERIFICATION.md` ("Your own model as the main chat model").
- Evidence: web lint and typecheck clean; 368 web tests pass, 8 new route tests (7 fail on the previous code); gateway 6 tests (auth and management routes, forwarded and dropped fields, streaming with tools, queue and queue timeout, a caller leaving while queued, refusal passthrough); 15 gateway mutations, all caught; runner and local script tests 63/63.
- Next (protected, owner review): upload `GROQ_API_KEY` to the Worker in `deploy-cloudflare.yml`, so Groq stays available as a fallback once `ATLAS_MODEL_API_KEY` is the gateway token.

| 2026-09-27 | [#161](https://github.com/cornerstonemarketingus/atlas/pull/161) | Inference admission reliability | Known capacity denials no longer send anyway; streaming reservations last through completion/cancel/failure | 14 focused + 58 inference tests pass; three regressions fail on original; web build/lint pass; 285 web pass/2 existing Windows failures | Stacked on #158; long-term durable resume still required; no live deployment | Review and merge dependency stack, deploy and verify; see RATE-LIMIT-INVESTIGATION.md |

## 2026-10-05 inference reliability: finish the Phase 1 control plane on current main

- Audit: #129–#133, #158, #160 (+#161) were still an unmerged stack (305 commits behind main, conflicting with the chat-loop work of #220/#221). Hosted chat's reliability had grown in two places: main's loop (waiting, billing, provider chain) and the stack's ledger wiring. Nothing used the ledger on main, so concurrent isolates could spend one provider allowance, a bankrupt account was rediscovered per request, retries multiplied across layers, and a cold ledger treated unknown capacity as unlimited.
- Ported, not rebuilt: the stack tip is merged onto main (`packages/atlas-inference`: contracts, errors, circuit breakers, ledger, target registry, fingerprints; the Durable Object governor; `governedSend`). `agent-loop.mjs` keeps main's version with `governedSend` re-applied in its retry path (the stack's older loop was dropped); each provider in the fallback chain gets its own quota-scope governor (`governChain`).
- New on top: (1) account-scoped failures (billing, key, permission) disable every model in the ledger's scope at once, including models never tried; (2) a request larger than a model's whole observed allowance is never queued for it and is answered as an instant "too large" so compaction or another target takes it; (3) cold-start gate: an unobserved model admits one request until a response teaches its allowance (streams report headers on arrival), which removed a 99-refusal stampede in the 50-request test; (4) one attempt budget per step (6) and per reply (30; synthesis keeps its own 12) spans retry, same-provider fallback and cross-provider fallback, agent-team calls included; (5) cross-provider routing also on 402 and 404, while 401/403 stay visible to the owner as before; (6) capability and context checks before a fallback (`capabilities.tools|streaming|contextTokens`, Groq's 131,072 declared); incompatible targets are skipped, never tried; (7) child agents use TASK_CRITICAL, synthesis priority first.
- Already satisfied on main: memory digest sits after history (the #133 cache finding); older tool results are compacted; exact reset parsing, short waits, billing vs rate limit.
- Evidence: web 412 tests pass (14 new in `inference-chaos.test.mjs`: 50 concurrent mixed requests over five fake providers with real ledgers behind the real governor protocol and virtual time; zero leaked reservations, no allowance exceeded, bankrupt provider tried once, incapable target never sent tools, all 50 answered within budget; outages, 500/503/timeout/network/malformed/empty 200, streaming before and after first token, ten parallel child agents, token gate), package 63 tests, lint, typecheck, `vinext build`, `wrangler deploy --dry-run` lists `INFERENCE_GOVERNOR` with migration `v1-inference-governor`. Guard mutations (account-wide disable, oversize, cold-start gate, idempotent reservation, expiry, attempt budget, permanent refusal, capability check, billing retry, early stream observe, 402/404 routing) all fail the suite.
- Not covered: the coder (`packages/atlas-cli` `RetryingModelProvider`/`FallbackModelProvider`) runs on the runner, outside the Worker, and has no authenticated path to the Durable Object ledger; it keeps its own pacing. Sharing capacity with it needs a protected, authenticated governor endpoint (owner review). Repository read coalescing is #207's (open, not touched). The self-hosted gateway now streams and forwards tools (#221) but its own concurrency queue is separate from the ledger.
- Protected and owner-reviewed (not bypassed): the stack changes `.github/workflows/ci.yml` (atlas-inference job) and `deploy-cloudflare.yml` (`ATLAS_CHAT_MODELS`), and adds a Durable Object migration to production.
- Next: let the coder report to the same ledger through one authenticated, rate-limited governor endpoint.

## 2026-10-05 mission rate-limit state survives restart (#219)

- Found a durable-recovery bug in the existing mission runtime: snapshots stored throttle.waitingUntil/batchSize but restore ignored them; pause also discarded the provider reset. Resuming could immediately repeat a refused call, restore full concurrency and reset retry policy/backoff.
- Restores the saved cooldown and reduced batch size, persists maxRateLimitRetries and consecutiveLimits, and retains cooldown during pause. Completed children, results, usage and attempts keep their existing persistence semantics. Legacy snapshots remain valid; malformed recovery fields fail validation. Cancellation still clears the wait; restored missions still require explicit operator resume and an expired timer cannot silently execute work.
- Evidence: 21 baseline scheduler/service/throttle tests passed. Seven new tests cover JSON restoration, real SQLite close/reopen through MissionService, pause/resume, retry policy/backoff, legacy/expired snapshots, invalid state and explicit-resume safety. Removing cooldown restoration fails the JSON and SQLite regressions. Focused tests pass and the real local-control e2e journey passes.
- Full local suite: 674 tests, 653 pass, 20 skipped, one failure in the unchanged Windows platform-terminal timeout test (expected exitCode 1, received null). Reproduced the same failure with main's scheduler restored, then restored this implementation and reran its tests successfully. No test or safety assertion weakened; required CI remains the merge gate.
- Reconciled current main 7495825, including #224's inference control plane. This fix is confined to local mission scheduling, not a duplicate hosted governor, not a CLI/tool-message checkpoint, and not a claim that hosted chat or the coder's complete recovery loop is finished. Next: tool-level checkpoint continuation without replaying consequential completed actions, reusing the existing task/mission architecture.

## 2026-10-05 mission recovery release evidence (#225)

- #225 merged as ac54793c20a85d591d0556c765fdd9ef15cd3e47 after every required check passed in CI 37349187763, including Windows local-control and real Genesis coder/browser verification. The local terminal-timeout baseline failure did not recur in required CI; its assertion was not changed.
- Seven new recovery tests and the local-control e2e journey passed. Durable mission restoration now respects provider cooldown, reduced concurrency, retry policy and backoff while retaining completed child evidence and budgets. Explicit operator resume and cancellation safety are preserved.
- This is a local-control source release, not proof that an already-running installed companion has updated. No hosted model-backed completion or internal tool-message checkpoint/resume claim is made. Next: preserve a specific interrupted agent's execution state without replaying completed consequential tools, through the existing kernel/task persistence boundary.

## 2026-10-05 hosted chat says which provider served each reply

- Nothing showed whether the owner's own model (Ollama behind the gateway and Tailscale Funnel) was actually answering hosted chat, or whether Groq/OpenAI were: secret values cannot be read, and replies did not say. Now `GET /api/setup/status` reports `optional.chat.route` as provider kinds (`self-hosted`, `groq`, `openai`; never addresses or keys), and every chat reply (JSON and the streaming `done` event) carries `servedBy: { provider, model }` for the words it ends with (the deepest fallback is credited). "Verify hosted Atlas" prints the route and who wrote each reply.
- Evidence: web lint and typecheck clean; 413 web tests pass (route kinds, providerKind, servedBy for the self-hosted model, for Groq when the machine is off, for OpenAI when both are down); runner and local script tests 63/63.
- Next: after the deploy, run "Verify hosted Atlas" in `chat` mode; the route line confirms whether the owner's model is the main one and which provider answered.

## 2026-10-05 live diagnosis, and Cloudflare Workers AI as a provider (no Groq, no Ollama)

- Live "Verify hosted Atlas" (`chat`, run 37354013720, with #228's route reporting): `Chat route: groq → openai` (the owner's own model is not configured as the main model: the repository secrets still point at Groq). Non-streaming was answered by Groq's `openai/gpt-oss-20b`; streaming failed at once: `openai/gpt-oss-20b (api.groq.com) refused a request larger than its per-minute token allowance; gpt-5.4-mini (api.openai.com) has no API credits or reached a billing limit`. Root cause of the recurring "rate limit" replies: one Atlas request (instructions, tool definitions, history) is larger than Groq's free per-minute token allowance, so no amount of waiting helps, and the OpenAI fallback has no credit.
- Fix without Groq or a local machine: Cloudflare Workers AI on the account that already runs Atlas, through its OpenAI-compatible endpoint (`https://api.cloudflare.com/client/v4/accounts/<account>/ai/v1/`, streaming and tools). `workersAIModel()` is configured by `ATLAS_WORKERS_AI_TOKEN` (Workers AI permission only) and the existing `CLOUDFLARE_ACCOUNT_ID` (validated 32-hex, so it cannot steer the URL); model `ATLAS_WORKERS_AI_MODEL`, default `@cf/openai/gpt-oss-120b` with `@cf/meta/llama-3.3-70b-instruct-fp8-fast` as its same-provider fallback. Automatic: main model → Workers AI → Groq → OpenAI (a provider already in the route is not repeated); with no main model configured, Workers AI leads. Selectable as "Cloudflare Workers AI" in the chat's model menu. Reported as `workers-ai` in the route and in `servedBy`.
- Protected (owner review): `deploy-cloudflare.yml` uploads `ATLAS_WORKERS_AI_TOKEN`, `ATLAS_WORKERS_AI_MODEL` and `CLOUDFLARE_ACCOUNT_ID` to the Worker.
- Evidence: web lint and typecheck clean; 417 web tests pass (4 new: configuration and URL safety, routes, Groq "too large" → Workers AI with its own token and plain OpenAI-compatible body, `servedBy`); workflow check passes; runner and local script tests 63/63. Not yet verified live: needs the owner's token, then a deploy and the `chat` check.
- Setup: `docs/HOSTED-VERIFICATION.md` ("No Groq, no Ollama: Cloudflare Workers AI").

## 2026-10-06 Workers AI configured; a rejected credential now names its provider

- Owner added `ATLAS_WORKERS_AI_TOKEN` and deployed. Live "Verify hosted Atlas" (`chat`, run 37489979783): `Chat route: groq → workers-ai → openai` (Workers AI recognized), but non-streaming "stopped early" and streaming ended "The model endpoint answered 401." Groq refuses Atlas-size requests as too large, so the route reaches Workers AI, which most likely rejected the token; the message could not say which provider answered 401, because only "not now" refusals were recorded.
- Now 401/403 (credential), 402 (billing) and 404 (unknown model or address) refusals are recorded too, and the error names the provider and model with a fixed reason ("rejected Atlas's credential (401): check that provider's key and its permissions"), never provider text or keys; a lone server error keeps its short message. "Verify hosted Atlas" prints chat's own error message for a failed `/api/chat` request.
- Evidence: web lint and typecheck clean; 418 web tests pass (new: Groq "too large" then Workers AI 401 names both, leaks neither provider text nor keys); runner and local script tests 63/63.

## 2026-10-06 Workers AI 401: code-level audit and a credential diagnosis in production

- Audit of the failing path (no secret read or printed): chat calls `https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions` (Workers AI's OpenAI-compatible REST endpoint; no AI Gateway, no `AI` binding) with `Authorization: Bearer ATLAS_WORKERS_AI_TOKEN`, model `@cf/openai/gpt-oss-120b`; streaming and non-streaming share `sendModel`, so authentication is identical. Deploy 37491305559 (commit 987c47d, the one verified) uploaded both `ATLAS_WORKERS_AI_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from GitHub secrets to the Worker; the live route shows `workers-ai`, so both are present in the runtime; `wrangler deploy` succeeds with the same `CLOUDFLARE_ACCOUNT_ID`, so the account id is the account that runs atlas-web. Unknown from here: whether Cloudflare accepts the token, whose it is, and its permissions (this environment has no Cloudflare access and cannot read GitHub secrets).
- New: the Worker diagnoses its own credential. `apps/web/app/api/chat/provider-health.mjs` `workersAIHealth()` verifies the token (as a user token, then as a token owned by the configured account), makes a read-only Workers AI call on that account, then one minimal inference on chat's exact endpoint and model, and classifies: CREDENTIAL_MISSING, ACCOUNT_MISSING, CREDENTIAL_INVALID, CREDENTIAL_EXPIRED, CREDENTIAL_DISABLED, WRONG_ACCOUNT_OR_PERMISSION, INSUFFICIENT_PERMISSION, AUTH_SCHEME_MISMATCH, MODEL_UNAVAILABLE, PROVIDER_RATE_LIMIT, PROVIDER_UNAVAILABLE, OK, each with a recommended action. Output is categories, HTTP statuses and Cloudflare numeric error codes only. Owner-only `GET /api/setup/providers`; "Verify hosted Atlas" prints it.
- Evidence: 425 web tests pass (7 new: healthy path on chat's endpoint/model with one auth scheme and only Cloudflare's origin; missing configuration before any call; invalid vs account-owned token; expired and disabled; valid-but-wrong-account/permission; inference classification; nothing secret in any diagnosis); lint, typecheck; runner and local script tests 63/63.


## 2026-10-10 hosted repository-search and tool recovery (#254)

- Traced ChatSection -> authenticated chat route -> tenant-scoped allowlist and memoized GitHub credential -> converse (lead and children) -> instant tools -> GitHub Search / existing repository-content retrieval -> tool messages -> final synthesis, SSE/JSON response and conversation persistence. Existing instant failures already continued into another model round; custom-handler exceptions could escape it.
- Confirmed defects: code search silently truncated queries, forwarded unchecked syntax, omitted pagination/filter parameters, discarded GitHub failure bodies and returned only a status. The original HTTP 400's specific cause is **not confirmed**: no incident query/response was supplied and the old boundary discarded those details. Live read-only API probes: a valid scoped identifier query succeeds; an unmatched quote gives 422, not 400. No result-volume explanation is asserted.
- Extended the actual hosted runtime with legacy-syntax validation, explicit filename/path filters, result pagination and a 1000-result cap, bounded long-path continuation, one corrected literal-query attempt preserving filters, and direct retrieval of a known file via the existing reader. Invalid local syntax can also fall back to that reader. Failed search is never described as successful when only the file read succeeded.
- GitHub errors are classified as invalid request, authentication, permission, quota, missing or unavailable. Response bodies are read within 8 KB and mapped to fixed causes and selected validation fields/codes, quota metadata and safe request IDs. Arbitrary echoed messages/queries never enter prompts or logs. Telemetry reuses githubRequestObservation. Existing allowlist, credential selection and verified per-turn content reuse remain intact.
- converse blocks identical failed read-only calls, contains custom-handler exceptions, gives recovery guidance and continues the original task. Search/core quota buckets stay separate. Auth/integration failures block repository calls for the reply; other tools remain available. Failed-only workflows and model-finalization failures retain explicit cause/action and incomplete status.
- Coordination: isolated main 4f89f19; unrelated checkout edits preserved; claimed #254. Stale #207/#158 overlap recorded in #198; active #238/#240 notified of narrow dispatch/summary/UI overlap, with transport/configuration untouched.
- Local evidence: production build and all **460 web tests pass**, including 23 new cases and built authenticated /api/chat + migrated D1 + GitHub failure/recovery + persistence in streaming/non-streaming modes. Lint passes; typecheck and final remote CI/deployment tracked in the PR. Locked dependency install reports 24 existing audit vulnerabilities; no unrelated dependency updates.
- Deployment is not established by local tests. Follow the normal CI-gated main merge, deploy-cloudflare workflow, then verify-hosted chat release gate. Original incident replay still needs its query/conversation evidence. GitHub search remains limited to indexed default-branch content; known files use direct reads.

## 2026-10-10 repository-search release and internal retry-memory follow-up

- #259 merged as 5962b90 after every CI check passed. Cloudflare deployment 38055321925 succeeded. Hosted chat release gate 38055467142 passed streaming and non-streaming with stored replies and successful repository search, served by Workers AI. That trace executed search only, so it does not prove live file reading/recovery; a targeted invalid-query + known-file verification was dispatched separately.
- Final review caught a narrower retry gap: call-level deduplication did not remember invalid requests issued internally during query correction. Added request-local, credential-separated memory for HTTP 400/422 search refusals. A later corrected call cannot resend a previously invalid upstream query; successful results remain fresh and are not cached. Scope remains authorized before lookup.
- Evidence: production build and 462/462 web tests pass (two additional guard cases); removing internal refusal lookup causes the new regression to fail. Source restored. Follow-up CI/deployment and targeted hosted verification are tracked in its PR.

## 2026-10-10 coder tool-name repair (#268)

- Reported run 38112578914 spent 136.6 seconds in the native coder and ended with no edits; successful Actions completion is not evidence of completed test execution.
- ProviderReadOnlyToolAgent now resolves exact offered/registered names first, then unique separator/camel-case and safe repository namespace aliases, including source-file read spelling. Ambiguous or unoffered names return only offered tools. No edit-distance guessing, argument rewriting, extra model call, policy bypass or tool replay. Existing registry still enforces scope, capability policy, approval, validation and redaction.
- Existing tool.requested audit records canonical toolId plus requestedToolId and repair=automatic. Boundary regressions cover reported spellings, one tool execution in two model turns, ambiguity, hidden tools, denial, approval and scope mismatch.
- Validation pending existing PR CI: local execution service failed before starting even Get-Location (helper_unknown_error: setup refresh had errors). Do not count tests as passed or this change as deployed. Operational test-only routing and truthful no-change completion remain separate work; active #253 owns runner/container validation. Narrow stale #200 dispatch overlap documented without replacing its provider work.
# 2026-10-11 — Hosted new-project creation and streaming scroll lock

User-requested workstream, issue #94, branch `codex/new-project-chat-scroll`.
Based on main `530cb6b`; implemented in an isolated checkout to preserve other
uncommitted work. Hosted chat now exposes structured create/status tools and
actual safe capability state. `new_project_task` routes to a separate Genesis
workspace, including direct coder-task requests, never the selected Atlas
repository. Execution reuses Genesis planning/executor, curated templates,
publisher, repository creator and exact-commit approvals. Added durable
idempotent operation receipts, authenticated owner-only HTTPS/node boundaries,
account credential distinction, repository readback and authenticated push
verification. Blocked planning can resume into publication; interrupted
external operations never replay automatically. Chat displays confirmed
operation progress and URL without treating dispatch as completion.

Replaced page-level streaming scrollIntoView with actual-container following:
manual history reading locks across tokens/completion, near-bottom scrolling
resumes, send/thread/new reset, Jump to latest restores following.

Validation: web suite 471/471 passing; local-control 663 passing, 20 skipped
(683 total); production build, typecheck, lint and diff checks passed. Focused
integration includes actual workspace/check/test/build, model tool registry,
real HTTP routes, mocked GitHub creation/readback/push, allow/ask/deny,
permissions, failed pushes, visibility mismatch, concurrent retries, restart,
blocked-plan continuation and approved-commit versus newer HEAD. Scroll guard
mutation was detected. No real external repository or deployment was created.

Protected credential/publishing boundaries require owner review; do not
auto-merge. See `docs/HOSTED-PROJECT-CREATION.md` for configuration/limitations.
Genesis bridge is deployment-operator-only and needs a configured
Worker URL/token plus a trusted HTTPS execution node. The owner subsequently
authorized deployment secret synchronization and requested push/merge of
PR #272. The workflow now maps and uploads configured Genesis connection
secrets with a parity regression test. No HTTPS node URL is configured and
credential provisioning has not run: automatic approval review requires
specific approval to store the existing GitHub OAuth credential in the local
vault and transfer the existing owner token to GitHub/Cloudflare. The node's
existing remote-owner opt-in remains required. Existing PR #101 proposes a separate
hosted seeding implementation; this work reuses the requested local Genesis
runtime and should be reconciled during review. Other open task-dispatch/UI
work may require integration conflict resolution. No TODO file was created.

## 2026-10-15 — chat responsiveness rescue (issue #283)

A streamed Markdown fence such as ```typescript title="app.ts" could prevent
the paragraph cursor from advancing, leaving React in an infinite synchronous
render loop. Added a mandatory progress fallback, support for longer fences and
info strings, and memoization so completed messages are not parsed again for
every new token. Added a VM-isolated regression that timed out on the original
renderer and now renders every streamed prefix, plus a real ChatSection browser
fixture covering the triggering fence on desktop and mobile.

Genesis capability reads now have a 1.5-second deadline covering both headers
and JSON parsing, rather than blocking every owner chat turn for the operation's
15-second deadline. Cancellation-ignoring adapters are also bounded. Actual
project creation/status retain their existing operation deadline; permissions,
owner checks, publication policy and provider selection are unchanged.

Evidence: production build, typecheck and lint passed; full web suite 483 passed,
1 optional browser skip, 0 failures. The optional real Chromium gate then ran
explicitly and passed on desktop/mobile with no page errors. Focused regressions
20/20 passed. No claim of measured live-model latency or completed business
operations. Existing provider repair #240 and durable dispatch #270 remain
separate workstreams; this patch does not overwrite their files.

## 2026-10-16 — hosted mission recovery (issue #290)

Added `/missions` and scoped D1 mission plans, idempotent creation, atomic revision/audit writes, bounded serial dispatch, reconnect reconciliation, pause/stop and exact current GitHub-attempt result evidence. Existing task intake remains the authority for execution permissions and allowance. Concurrent task/result PR files were preserved; migration 0021 avoids #289's 0020.

Evidence: build/typecheck/lint passed; full web suite 494 passed, two optional skips; explicit real Chromium desktop/mobile mission reconnect gate passed. Eleven mission regression tests include old-attempt rejection, audit rollback and concurrent resumes. Performance rescue #285 deployment run 38834441273 and authenticated chat smokes 38834591463 / 38834676029 succeeded.

Not deployed: new tenant persistence requires configured review and migration application/journal integration. Closed-page unattended advancement, cumulative money budgets and live business integrations remain incomplete. Next: obtain required review and integrated migration/CI evidence, then implement scoped scheduler ownership without storing browser credentials. See docs/HOSTED-MISSIONS.md. Branch codex/cloud-mission-recovery.

Follow-up acceptance: task-intake rejection now returns a failed mission and blocked dependencies immediately. Previously it could return running with no pending work, disabling polling until another manual reconcile. The regression asserts the first response is terminal; all eleven mission tests pass after the fix. PR #291's initial full CI matrix passed, including Windows and Genesis; the follow-up will rerun CI.

Mission request recovery follow-up: bounded both response headers and JSON body to 30 seconds, including cancellation-ignoring transports. The UI unlocks after a stalled response, explicitly warns that work may have started, and never retries mutations automatically. Three deadline regressions pass; real desktop/mobile reconnect gate, production build, typecheck and lint pass. Full suite after build completion: 497 passed, two optional browser skips. An initial suite overlapped build artifact replacement and was rerun after the build completed.

Paid allowance boundary: the existing task API uses HTTP 402 before dispatch when the monthly allowance is exhausted. Missions now classify this as a definitive refusal, preserve its explanation, fail immediately and block dependencies. A production-adapter regression verifies repeated reconciliation does not resubmit or charge again; mission suite 12/12. PR #291's preceding revision passed the entire CI matrix. This remains an owner-reviewed persistence PR, not an unattended cloud/business completion claim.

## 2026-10-16 — hosting request responsiveness (#292 / PR #293)

From current main, isolated branch codex/infrastructure-deadlines in .worktrees/atlas-infrastructure-deadlines. The existing Cloudflare/Vercel/Git infrastructure client only signalled abort and retained caller listeners. Added a complete response deadline, cancellation before external execution, and listener cleanup. Possibly accepted writes are not automatically retried. Five negative regressions failed before and pass after; existing infrastructure integration tests pass (14/14). The real daemon HTTP end-to-end journey passed every step, including approvals, pause/resume/cancel and crash recovery, using its scripted model.

Full local-control suite is still running locally (session 35506, output .infra-suite.log); required cross-platform CI is pending. Follow through CI and inspect the full local result before ordinary merge of #293. No live hosting changes made. Mission PR #291 latest full CI is green but still needs configured tenant-persistence review and migration application. Broader unattended cloud scheduling, cumulative spending and live business integrations remain incomplete.

Hosting follow-through: PR #293 merged as 8ad577e3f138c0adedd6910cdd22d13f053bed5d after all cross-platform CI passed. Full local suite completed: 677 passed, 20 optional/environment skips, zero failures. Daemon e2e passed. Integrated current main into mission PR #291, preserving both progress entries; new mission persistence still requires configured review.

## 2026-10-16 — complete DNS outcome verification (issue #294)

Current-main branch codex/dns-verification reuses .worktrees/atlas-infrastructure-deadlines after #293 merged. Cloudflare DNS apply compared only content, so the real infrastructure tool could claim an approved proxy change was verified when the provider retained the old setting. Read-back now checks record name/type, content, TTL and proxy state; DNS name casing and a trailing root dot are normalized. It retains observed state and performs no automatic additional writes.

Four negative regressions failed on the original adapter, including the actual approved ToolRegistry plan/apply boundary. All six DNS tests and existing hosting integration/deadline tests now pass: 20/20. No live DNS changes, credential changes or approval-policy changes. Full cross-platform CI must pass before ordinary merge. Mission #291 integrated-main CI is green and still awaits configured persistence review. Broader cloud scheduler/business work remains incomplete.

DNS follow-through: PR #295 merged as a3b59322b57ec332f96ce28aeb93b568d405ae56 after all CI passed. Initial Windows daemon health timeouts reproduced neither locally (both boot tests passed) nor on one targeted retry; DNS regressions passed throughout. Preserved both progress entries while integrating current main into mission PR #291. No live DNS changes performed.

Mission history follow-up (#291): replaced the fixed first-30 history trap with tenant/principal-scoped cursor pages and Load older missions. History responses remain summaries, and the UI deduplicates appended pages. A 65-record regression covers same-timestamp ordering, three pages, malformed cursors, payload bounds and scoped HTTP access. Real Chromium desktop/mobile now opens a mission beyond the first page, then completes the existing save/start/reconnect journey without duplicate execution. Typecheck, full lint and production build passed; full web suite 499 passed, two optional browser skips. Budget #299 latest CI is green; its rollout review remains pending. Mission persistence has not been deployed or migrated.

Mission execution-boundary follow-up (#291): managed GitHub execution is now checked before task intake, preventing a private dispatcher from accepting work this mission verifier cannot observe. Accepted responses must confirm both the managed runner and a durable receipt; otherwise the known task ID remains visible as uncertain, with no retry. Receipt/outcome lookup excludes private-runner rows, including an actual persisted-private-row regression. Sixteen mission tests plus three request-deadline tests pass; typecheck and changed-file lint pass. Existing task intake files and active PR ownership are preserved. Fresh CI remains required; no production mission was executed.

## 2026-10-16 — connected CRM contact workflow (issue #296)

Branch codex/crm-contacts, based on current main a3b5932, reuses .worktrees/atlas-infrastructure-deadlines. Added optional HubSpot lookup and explicitly approved contact creation to the existing live workflow registration, using declared vault credentials and default-denied CRM capabilities. Independent read-back verifies new contacts; existing emails are reused without changing fields. No outreach, automatic write retries, account provisioning or policy grants. Active main/credential PR files were preserved.

Seven focused CRM tests and real daemon boot tests pass, including actual HTTP transport, approval-before-credentials, provider error redaction and late-credential cancellation. Full local-control suite completed: 689 passed, 20 optional/environment skips, zero failures. The late-credential cancellation regression passed independently after that run began; cross-platform CI passed on PR #297. New credential integration needs configured review. No live CRM account/token was used; owner CRM preference question is pending, so HubSpot is provisional and live acceptance is externally blocked. See docs/CRM-CONTACT-WORKFLOW.md. Website inquiry intake, recurring operations and unattended cloud scheduling remain incomplete. Mission #291 integrated-main CI is green and still requires persistence review.

CRM acceptance follow-up: added an authenticated real-daemon HTTP check proving both CRM tools are exposed through /v1/tools, remain denied by default, require write approval, and reveal no credential metadata. Eight focused CRM tests pass. Pushed to #297 for fresh CI; configured credential review and real account acceptance remain outstanding. No live CRM actions performed.

CRM Windows acceptance follow-up: the fresh CI run timed out starting the new catalog daemon and both existing boot fixtures; Linux and all other jobs passed. Isolated local reproduction passed all three boot cases in about three seconds. Reused the existing daemon-boot fixture for every authenticated catalog/denial/metadata assertion and removed the extra process; startup deadlines and product checks were not relaxed. Seven CRM tests plus both real daemon boot cases pass (9/9). Pushed to #297 for fresh Windows CI; no merge or live CRM action.

## 2026-10-16 — delegated cumulative spending (issue #298)

Current-main branch codex/cumulative-task-budgets in .worktrees/atlas-infrastructure-deadlines extends the existing TaskBudget/executor boundary through tenant-scoped parentTaskId links. Sibling/nested executions share ancestor allowances; reservations check every scope before atomic usage/audit writes. Actual cost/token overruns are recorded honestly and block later reservations. No duplicate store, ledger, executor or task schema was introduced; #235-owned store/executor files are untouched.

Four real SQLite/executor regressions failed before and pass after; six parent-budget cases include eight independent SQLite workers and corruption/rollback guards. Existing platform-core suite passes. Full local suite completed: 689 passed, 20 optional/environment skips, zero failures. PR #299 awaits required CI and spending-policy/rollout review. Historical descendant usage needs reconciliation or fresh task trees before rollout. This is not universal project/automation/provider monetary enforcement. See docs/CUMULATIVE-TASK-BUDGETS.md.

CRM #297 latest complete CI passed, including the reused Windows daemon fixture; it still awaits configured credential review and selected CRM account. Mission #291 remains pending persistence review. No real CRM actions or external spending occurred.

Budget rollout follow-up (#299): implemented an explicit dry-run-by-default historical reconciliation command using existing store methods. It handles mixed legacy direct usage and attributed descendant credits, avoids double counting on repeat/restart, validates tenant/database and parent chains, and commits usage plus credits/overspend audit together. No owned store/executor files changed. Twelve budget cases plus platform-core pass (32 focused checks), including actual CLI execution and rollback. Full suite is running (session 74140, .parent-budget-suite.log); fresh CI required. No real database reconciliation or spending occurred. Prior #299 CI passed; this expanded revision still needs policy/rollout review.

Budget merge-gate correction (#299): verified actual CODEOWNERS and GitHub review state. The accounting/maintenance changes do not touch protected policy, identity, approval or isolation files; all CI passed and there is no blocking review. The earlier extra spending-review hold was an inference, not a configured requirement. Under the user’s existing full approvals, use the ordinary CI gate after this documentation correction. No production database maintenance is authorized by a code merge alone; the documented rollout remains separate.

Integrated merged budget #299 (ff1dd30ab67dcee34025944cc28b1a7ff71f8748) into mission #291; both progress histories preserved. Mission’s previous complete CI passed, including runner/receipt guards, and fresh integration CI is required. Its D1 migration/journal dependency on active task persistence PRs remains unresolved; do not claim production mission readiness. Next useful integration audit: current durable-dispatch #270 and dependent task-request/outcome PRs, preserving their file/branch ownership and configured review gates.

Budget #299 merged as ff1dd30ab67dcee34025944cc28b1a7ff71f8748 after all cross-platform CI passed. No production database reconciliation was run. Integrated into CRM #297, preserving both handoffs. CRM gate clarification: this adds consumers of the existing declared-secret/approval mechanisms, changes no credential infrastructure or grants, and touches no protected CODEOWNERS path. The earlier extra credential-review hold was inferred; use the actual ordinary CI/no-blocking-review gate under the existing user authorization. Live acceptance remains blocked by selected CRM configuration.

CRM #297 merged as 1c3be5b66160a28c04e9c5b027f314442d3cbb1e after every cross-platform check passed; no live CRM configuration or contact writes performed. Integrated current main into mission #291. Audited exact #270 durable-dispatch response/migration contract without editing its owned files; mission adapter compatibility with typed unknown/rejected responses is the next acceptance gap.

Durable task integration follow-up (#291): audited committed #270 dispatch and #274 request API contracts read-only, preserving active owners. Mission receipt recovery now understands optional persisted dispatch states across current main and migration 0017: a saved unknown intent alone stays uncertain, confirmed dispatch promotes it, and recorded rejection fails dependencies. Typed HTTP 502 dispatch rejection is definitive; HTTP 202 dispatch-unknown is not mislabeled as confirmed acceptance. Three additional HTTP/runtime/SQLite cases verify transitions and no replay. Nineteen mission plus three deadline checks pass; typecheck and changed-file lint pass. #270 still explicitly requires tenant-persistence review and migration; no pending owner branch was modified or merged. CRM #297 is merged; live account setup remains incomplete.

Mission release audit (#291): latest complete cross-platform CI passed on 609f130 (run 38992055213), including all nineteen mission and three deadline checks. Confirmed the deployment workflow does not apply D1 migrations; the existing explicit migration workflow already supports a bounded 0021-only dry run/apply, so no protected workflow change is needed. Updated the mission release checklist and replaced stale test counts. Latest hosted deployment remains performance rescue dee7942 (38834441273), with successful authenticated smoke evidence; missions are not live. Persistence review, shared journal coordination and authenticated mission acceptance remain unresolved. Next: complete those integration gates, preserving active task PR ownership; do not infer production readiness from green branch CI.

Mission incomplete-evidence guard (#291): reproduced a false terminal failure when GitHub returned completed status with null/missing/unknown conclusion. Added an explicit recognized-conclusion guard so incomplete evidence remains pending and never blocks dependent work permanently. Extended the real runtime/SQLite result fixture with four failed-before cases. Validation is in progress. User next priority: suppress internal reasoning/build details and raw backend errors outside admin; expandable chat activity/approvals, cloud execution and app store readiness audit.
## 2026-10-16 — local inference stream integrity (#300)

Isolated branch codex/inference-quota-reliability, current main 1c3be5b. Fixed
the existing local OpenAI-compatible client's CRLF/CR framing, multiline data,
UTF-8 chunk retention and DONE termination. EOF without a completion receipt,
empty/reasoning-only answers and malformed/oversized events fail explicitly.
Interrupted tool fragments cannot reach execution. No pending routing/provider
PR files were changed. Eight original regressions failed before the fix; 54
focused tests and 63 inference foundation tests now pass, including real HTTP
and actual SQLite close/reopen/retry with no partial tool execution. Full local
suite and branch CI remain pending. No live model or production deployment.

Master inventory, dependency order, evidence and deployment gates are in
docs/ATLAS_{MASTER_AUDIT,IMPLEMENTATION_ROADMAP,PROGRESS,TEST_RESULTS,DEPLOYMENT}.md.
Latest main CI 38991786626 is green, including Windows; old startup failure
must not be reported as a fresh confirmed defect. Next: finish suite/CI for
#300, then reconcile #270 → #274 → #276 → #278 → #282 and mission #291 with
their existing owners, before adding a native Linux worker adapter. Universal
provider wait/resume, cloud artifacts and desktop-offline acceptance remain open.

Published as PR #307, commit f8f894e. CI 38995719143: 12 of 13 jobs passed,
Windows local-control pending at checkpoint. Linux full suite, real Genesis
coder/browser and remaining package checks passed. Local full suite continues
in session 36438 (`.stream-suite.log`), with slow Genesis repair cases; do not
record a local total until it finishes. No merge or production deployment.
## 2026-10-17 — customer-safe chat activity and readiness audit (#309)

Branch codex/customer-chat-privacy starts at current main 1c3be5b in the reusable isolated infrastructure worktree. Existing SSE serialization now drops internal thinking, raw errors, tool previews/labels, agent reports and diagnostic completion metadata, retaining safe progress/recovery/approval state and validated customer repository links. Activity defaults collapsed with keyboard-accessible plus/minus. Active provider route/ChatSection ownership is preserved. Nine focused tests pass; real Chromium desktop/mobile keyboard/privacy gate passed; typecheck passed. Changed-file lint and production build are running (session 11047). No deployment or global confidentiality claim.

Read-only hosted audit confirms public/legal/deletion pages 200 and both mobile association URLs 404. Mobile native projects exist but www contains an initializing placeholder and no hosted server URL is configured. Detailed scoped findings and release blockers: docs/CUSTOMER-READINESS-AUDIT.md. Next: CI and full web acceptance, coordinate non-streaming/history/project/API diagnostics with existing owners, then cloud networking and real native packaging/device/store gates.

Customer activity acceptance follow-up (#310): production build passed and the full web suite found one fixture failure: the real file-preview test loads Workspace from a data URL and explicitly stubs CSS imports, so the added stylesheet needed the same mapping. Added that mapping without changing preview assertions. Browser-test lint also identified an empty optional-import catch; documented it. All other full-suite cases passed (486 pass, two optional skips, one fixture failure); rerun the affected preview test and full suite before merge.
## 2026-10-16 — Cloud coder recovery from Groq-only failure (#301)

- Incident 38819478158: 23 tool turns, no edits, two missing-parent write refusals, then Groq HTTP 413 (8503 requested / 8000 TPM). Exact work-step duration 11m48s; result reporting succeeded.
- Branch codex/cloud-coder-repair: approved creates now materialize confined parent directories; preview remains read-only, symlinks and tampered approvals remain refused. Rollback restores files and may leave empty new directories.
- Added fixed-origin OpenAI/Workers AI CLI providers, exact tool-name translation, bounded responses/cancellation, sanitized errors and existing-budget fallback. The Actions coder and PR-steward pass scoped provider credentials only to trusted coder steps. Owner explicitly approved the steward credential extension on October 16. Custom/private endpoints gain no implicit public fallback; none disables all fallbacks.
- Added bounded asynchronous subprocess capture and metadata-only 15-second CLI / 30-second runner progress. Timeout/output-limit failures cannot be parsed as successful completion.
- Evidence: initial nested-create regression failed before repair; final affected CLI 83 total / 81 pass / 2 POSIX skips; runner/local 76/76; complete Windows CLI 528 total / 520 pass / 4 fail / 4 skip. The same four failures reproduce on unchanged baseline (line endings, Windows file URL, two POSIX-mode assumptions). No unrelated test weakened. Workflow validation uses the actual Git Bash interpreter because Windows bash resolves to unavailable WSL by default.
- Cloud fallback integration uses simulated HTTP 413 → Workers AI then writes five framing-site files. Actual CLI subprocess creates nested HTML/CSS and returns edit receipts. These do not prove live model quality or website deployment. Existing cloud secret names were inspected, never values.
- No live configuration switch, credential provisioning, production publish or merge performed. See docs/CLOUD-CODER-RECOVERY.md. Pending: protected review and required CI, then real cloud coder acceptance and the framing-site retry. Reconcile older #200 provider changes rather than replacing its billing/local-provider work.

Customer prompt privacy follow-up (#310): found the system prompt unconditionally included Atlas source paths, infrastructure architecture and credential deployment instructions for non-owners. Added a failed-before test and now include those blocks only for the existing server-verified owner; non-owner prompts omit raw capability diagnostics and request safe progress/error summaries. Sixteen focused prompt/privacy tests pass. This is context minimization, not a replacement for tool authorization or a model confidentiality guarantee. Integrated prior full web run: 492 passed, two optional skips; build/typecheck/lint passed. All prior cross-platform CI jobs were green except still-running Windows/Genesis; the expanded prompt revision requires fresh CI.

Prompt integration repair (#310): complete web validation caught an existing Genesis contract requiring publish policy ask in customer context. Restored only explicitly selected availability booleans and the known approval policy enum, preserving required approval semantics while excluding internal reason/credential/build fields. Existing project-tools tests remain unchanged. Fresh focused/full validation and CI required; do not merge the earlier failed web revision.

Customer privacy #310 merged as 94438433eb2016570247e8618f2a6ca28c9b2314 after every cross-platform CI job passed (39006219808), with no blocking review. Final local build/typecheck/lint passed; full web suite 493 passed, two optional skips; real desktop/mobile activity gate passed separately. Deployment 39006513100 is queued; no live privacy acceptance yet. Latest observed prior successful deployment is 38996029310 at 832263e, so the earlier last-deployed dee7942 note is historical. Integrated current main into mission #291, preserving both histories. Next: verify 9443843 deployment and authenticated stream privacy, finish remaining non-streaming/history/project/admin boundaries, and resolve mission persistence integration plus native packaging/association blockers. Continuation automation now includes the user’s latest privacy, chat approval, cloud and app-store priorities.
## 2026-10-17 — durable cloud dispatch integration (#267 / #270)

Merged current main 9443843 into the existing codex/durable-dispatch branch,
preserving new-project routing and current chat privacy changes. Fixed the
existing GitHub dispatch timeout: abort alone could leave a cancellation-ignoring
transport pending indefinitely. A hard acknowledgement deadline now returns the
saved request as uncertain, never automatically resends it, and discards/cancels
late response bodies without changing the uncertain receipt.

Two regressions pass against actual migrated SQLite and the existing dispatch
helper. Fresh Worker build passed; complete web suite: 507 total, 505 passed,
two optional skips, zero failures. Typecheck and whitespace check pass. Targeted
lint passed; fresh remote CI and existing tenant-persistence
review gate remain required. No production migration, dispatch, credential
change or deployment performed. Next: complete #270 CI/review, then integrate
the existing #274 → #276 → #278 → #282 stack in dependency order.

Separate inference PR #307 integrated current main and resolved the shared
handoff conflict. Original code CI 38995719143 passed all 13 jobs. Local full
run: 707 pass, 6 fail, 20 skip; smaller integrated retest: 81 pass, 3 Genesis
timeouts. The approval case passes individually on both unchanged main and
the inference branch. Timing dependence is suspected; no local all-green
claim. Fresh integrated PR CI is required before ordinary merge.
## 2026-10-17 — native Atlas branding (#317)

Current-main branch codex/mobile-brand-assets replaces template native icons with sixteen raster assets derived directly from the existing Atlas favicon SVG. Adds a repeatable Chromium-based generator, source/artifact manifest, opaque 1024px iOS icon, five Android legacy/round/adaptive foreground densities and matching background color. No new artwork or runtime dependency. Real pixel checks caught and fixed SVG fill inheritance during visual QA; negative-space RGB regression failed before and passes after. Eleven mobile tests and syntax checks pass. Store icons were inspected visually. Device masking/launch assets, working bootstrap, signed builds and store submission remain incomplete; no App Store readiness claim. #316 native compatibility repair is a separate pending PR.
## 2026-10-17 — native platform compatibility (#315)

Current-main branch codex/mobile-platform-readiness repairs the native projects for pinned Capacitor 8.5.2: iOS15 across CocoaPods/Xcode, registered SceneDelegate and scene forwarding for cold/warm/universal links, Android SDK36/min24 with matching AndroidX/Gradle and resize density/navigation config. Uses exact installed CLI templates without changing identifiers, secrets, signing or approval policy. Three compatibility cases failed before and pass after; ten mobile tests and syntax check pass. Real cap sync android found all five plugins. Doctor reports no Xcode; this Windows host has only Java8 and no Android SDK, so native compile/device acceptance is externally blocked. MOBILE-RELEASE.md now separates generated projects from an operational product. Web bootstrap is a placeholder, association URLs are missing, and three moderate CLI development-dependency advisories need compatible upstream review. No forced override. Next: required CI/native build evidence, then working mobile bootstrap and authenticated approval flows.

Privacy #310 deployment 39006513100 succeeded at 9443843; configured authenticated chat smoke 39006706217 passed streaming and non-streaming. This confirms normal authenticated chat, not non-admin adversarial confidentiality or completion of the remaining API privacy audit.

## 2026-10-17 — chat and pending-runtime release (#304, #306, #311)

- Reconciled the older owner checkout onto current main without replacing newer inference, tenancy, streaming, scroll-follow, Genesis, CRM or cumulative-budget work. Current main already contained the missing-database history boundary fix.
- #304 merged as 832263e. Chat rejects non-object JSON, invalidates late history/poll/task/SSE responses on navigation and restores failed/truncated drafts without overwriting new input. Five actual-component race/draft regressions passed; local lint/typecheck/build passed; web suite 488 passed, one optional browser skip. All CI jobs passed (38995578956).
- Cloudflare deploy 38996029310 succeeded. Fresh post-deployment hosted chat gate 39006489138 passed streaming and non-streaming; both replies were stored and served by Workers AI. A later concurrent customer-activity release 9443843 also deployed successfully (39006513100). These receipts establish hosted chat, not live CRM/Genesis publication or overall product readiness.
- #306 merged as 49b0be4. Local daemon now integrates durable business responsibilities/preparation UI, real patch-file evidence verification and explicit-plan workforce execution. Existing kernel/team/goal/automation/remote/Genesis wiring is preserved. Focused business/evidence/workforce/HTTP: 22 passed. Full CI passed, including Linux/Windows and real-coder/browser Genesis (38995678008).
- Local broad runtime test under concurrent host load: 715 passed, 20 dependency/platform skips, six bounded-time failures (two boot, four Genesis operation waits). Isolated rerun of both daemon boot cases and the full affected Genesis operation file: 10/10 passed. No assertion or deadline was weakened. This discrepancy remains part of release evidence.
- #311 publishes the unique remaining dangling-symlink and Windows environment/constrained executable-path fixes; current namespace/container, npm/npx and Windows process cleanup implementations are retained. Focused tests: 41/41 passed. The protected sandbox PR remains unmerged pending full CI and owner review under PROGRAM section 3; no review/ruleset bypass attempted.
- Local runtime code merged to main is available for an installed daemon update/restart; no fleet rollout, signed installer release, production database maintenance, live CRM send or business deployment is asserted.
- Next: finish #311's Windows/review gate; independently evaluated test/live receipts for business outcomes; actual configured Genesis/CRM acceptance; leased/deduplicated recurring business work and cumulative business-level spending. Reuse the existing task/kernel/approval/budget services and active PR ownership rather than introducing another scheduler. Generated local audit logs and worktree metadata are retained locally, not committed as product source.

## 2026-10-17 — stacked request-deduplication integration (#273 / #274)

Merged the updated #270 parent into existing codex/task-request-idempotency.
Preserved current Genesis task routing, customer-safe chat changes and the hard
dispatch acknowledgement deadline. Existing admission/receipt implementation is
reused; no second scheduler, billing ledger or request-key mechanism added.

Fresh Worker build and typecheck passed; full web suite: 517 total, 515 passed,
two optional skips, zero failures. The rebuilt authenticated request endpoint
replays after reconnect without another bill or dispatch; concurrent same-key
requests enter admission once. Full web lint also passed.
Fresh CI and tenant-persistence review remain required. No production migration,
live GitHub dispatch, billing mutation, provisioning or deployment performed.
Next: #270/#274 CI/review, then update #276 → #278 → #282 in dependency order.
Native compatibility #316 merged as d96304bc28c21f08e436f0cac15cd4739139f599 after complete cross-platform CI passed (39007576511). Separate protected workflow PR #320 compiled both Android debug and unsigned iOS simulator successfully in run 39007793513, using the same repaired native project sources; actual APK and simulator ZIP artifacts exist (about 6.1MB / 1.9MB). This is compiler evidence, not product launch/physical-device/store acceptance. Workflow #320 awaits configured review before merge. Integrating the merged repair into icons #318; new combined CI is required.

## 2026-10-17 — native paired launch (#321)

The bundled native entry replaces the initializing placeholder with a real pairing form and read-only task/approval count dashboard, consuming the existing daemon endpoints through the native HTTP/vault plugins. HTTPS origin/token binding, disabled redirects/exact response URLs, bounded requests, no automatic pairing retries and late-response fencing are covered. Customer UI projects counts and safe errors; keyboard-accessible plus/minus disclosure explains owner-device action review. #61-owned helpers remain untouched; no decision authorization is bypassed. Local full mobile suite including actual Chromium packaged-page acceptance passed all 22 cases; syntax and whitespace checks pass. See docs/MOBILE-PAIRED-LAUNCH.md for configuration and limitations. Next: full CI/review, actual native device and HTTPS-daemon acceptance, then protected exact-action mobile approval integration. Cloud login, deletion, push, signing and store submission are not complete.

Protected workflow #320 combined branded native compiler run 39008540460 and ordinary CI 39008540436 passed completely at 7282ede. Required owner review remains absent; PR stays open. These compiler artifacts predate this new launch implementation.

Native launch #322 follow-through: all ordinary CI passed at 4a67073 (39027630120). Added a real daemon/in-memory SQLite contract journey covering owner-created one-use code, paired authentication, vault-adapter restoration and server revocation; production TLS remains untouched and unverified. Found and fixed a late vault-cleanup failure that could expose native error text after disconnect. Full local mobile acceptance now passes 24/24 including Chromium. New head requires fresh CI. Android cap sync packaged the launcher successfully. Next: independently compile this actual launcher and complete configured security/native device acceptance; no approval decision bypass or store readiness claim.

## 2026-10-17 — account and billing customer privacy (#323)

Actual billing checkout/portal handlers now return fixed errors with support references, including auth/DB/provider exception paths. Deletion GET/POST catch unexpected faults, validate JSON object shape and project only customer lifecycle status/time rather than operator notes/internal account fields. Original auth, account scope and confirmation remain. AccountPrivacy displays fixed notices, catches uncertain/invalid-JSON deletion responses, fences double submission and requires a valid receipt before claiming success. Three route regression cases failed against unchanged main, then passed after the fix; actual phone-width React acceptance passed. Web build passed; full suite 496 passed/3 optional browser skips, with the new browser case run separately and passing. Typecheck and focused lint passed (the optional-browser harness empty catch was annotated before the passing lint rerun). No payment, actual customer deletion, admin diagnostic console or deployed acceptance is claimed. Next: complete checks and PR CI, then live configured acceptance; remaining chat JSON/history/project/model failure privacy stays with its existing owners.

Native checkpoint: protected #320 latest ba2a979 has complete green CI 39031320700 and native compiler 39031320759. Workflow review remains absent; source #322 cf13ccf and prior matching launcher artifact evidence remain available. No protected merge or store submission occurred.

## 2026-10-17 — recover uncertain account deletion status (#325)

After an unavailable/invalid/lost deletion response, the actual account UI now requires an explicit successful status read before another mutation. Unknown initial status is also fenced. Bounded read/write deadlines surface safe recovery controls; a late/lost POST never triggers automatic resubmission. Valid pending status recovers the original receipt. Theme changes stop refetching account/deletion state; status generation/cancellation prevents stale reads. Actual phone-width regression passed, covering failed/invalid responses, duplicate submit, lost ack followed by pending status, initial failure, theme isolation and a stalled read. The same test fails against unchanged main because retry remained enabled. Build, typecheck and focused lint passed; full web suite 496 passed/3 optional browser skips, with actual phone-width recovery acceptance separately run and passed. No server policy, real deletion, signing or deployment acceptance is claimed. Next: finish checks, PR CI and ordinary merge gate, then configured live acceptance and remaining privacy/cloud gaps.

Native visual follow-through: fresh simulator 39037270879 and full CI 39037270977 passed at 7743e1e. Independently viewed the new native screenshot: white inset bands are gone, with continuous Atlas background and readable pairing controls. #320 still awaits configured workflow owner review; no protected merge or successful real pairing/approval/store acceptance is claimed.

Native source #322 follow-through: audited actual CODEOWNERS/PR paths. This consumer of the existing native vault and daemon pairing does not change protected authentication/credential/approval policy paths; no separate configured source owner-review gate was found. The workflow in #320 remains protected and unmerged. Integrated current main 90dbdce into #322, preserving both progress logs, and included the already screenshot-verified Atlas background setting. Packaged web/native app sources match #320's compiled and visually reviewed configuration. Fresh mobile/browser and complete PR CI required before ordinary merge. No permissions, TLS, origin restrictions or approval isolation weakened.

## 2026-10-02 atomic monthly task cap

- `checkAndRecordUsage` read the month's count and then wrote `used + 1`, so concurrent task requests overwrote each other's increments (the count stayed low) and could all pass the cap. It is now one upsert that increments only while the count is below the plan limit and reports whether a row changed.
- Tests run the real function against the migrated SQLite schema: 30 concurrent requests on the 20-task free plan allow exactly 20 and store 20 (the old code allowed 30); a new month starts at 1; a mode outside the plan records nothing. The D1 test helper gained `raw()` so Drizzle's D1 driver runs on it. 328 web tests, lint and typecheck pass.
- Not changed: failed tasks still consume a unit once recorded (unchanged behavior). Next: resume the prior "Next" line (chat 400/429 recovery after #98 ownership is reconciled).

## 2026-10-17 — integrate existing atomic monthly cap (#327 / PR #203)

Reused the original October 2 implementation and PR rather than duplicate it. Posted integration takeover after verifying the sole implementation commit was over 48 hours old, per PROGRAM section 4. Preserved the author code and current main, including source launcher #322 merged as 7bd3c74 after all CI39041528713 passed, and deletion recovery #326 merged as 90dbdce after green CI; recovery deployment39041436007 succeeded. Protected native workflow #320 remains separate and unmerged pending configured review. Resolved only appended PROGRESS conflicts by retaining both handoffs.

The real migrated-DB cap regression fails against current main (30 admitted versus the 20 limit) and passes with the existing atomic upsert. Three focused plan cases pass; complete web build/typecheck/focused lint pass, full web498pass/3optional skips. This fixes concurrent monthly admission counting without changing plan limits, modes, billing credentials or existing authorization. It does not establish live business cash budgets or refund failed-task units. Fresh original PR CI is required before ordinary merge. Next: complete current-head CI and deployment acceptance, then continue persistent cloud/privacy/native release gaps using existing implementations and actual configured gates.

## 2026-10-17 — safe saved-request reconnect and UI recovery (#275 / #276)

Propagated main 1e0909f through #270 and #274 into the existing inspection
branch, preserving atomic monthly admission and current account/native changes.
Resolved appended handoff conflicts without replacing source implementations.
Parents' preceding heads had all 13 CI jobs green; integrated heads need fresh CI.

Fixed RequestHistory list/detail overlap and stale responses after close/reopen,
refresh, pagination, version changes and unmount. A generation refresh also
handles batched close/reopen without leaving a cancelled session inactive.
No dispatch, admission, billing, auth or receipt policy changed.

Six initial component regressions failed on original source; nine final cases
pass. Actual headless Edge desktop/phone-width acceptance passes with keyboard
opening, late responses, refresh, pagination, touch targets and GET-only traffic.
Final build/typecheck/full lint pass; full web: 537 pass, four optional browser
skips, no failures (541 total). The saved-request browser gate ran separately
and passed. Migrated SQLite and rebuilt Worker inspection retain scoped access,
unchanged task/request/usage snapshots and zero external execution calls.

No production migration, secret transfer, deployment, real dispatch or physical
phone acceptance. Next: finish #276 CI/review, propagate to #278 claims and
#282 result ownership; retain existing persistence/approval gates.

## 2026-10-17 — integrated execution ownership gate (#277 / #278)

Merged updated #276 into existing codex/execution-claims. Current main 1e0909f,
atomic monthly admission, coder fallback, trusted claim/report separation and
the fixed Saved requests component coexist without source conflicts. Existing
immutable task/run/attempt ownership and lease policy remain unchanged.

Build/typecheck pass; full web 545 pass, four optional skips, zero failures
(549 total). Runner/local scripts 83/83; inherited recovery race guards 9/9.
All ten workflows pass the original checker using bundled Python, isolated
scratch PyYAML and installed Git Bash. Full web lint passed. Parent #276 at
5a9ba04 passed all 13 CI jobs; fresh integrated claims CI remains required.
No checker, security assertion or approval was weakened.

Fresh claims CI and protected workflow/identity review are required. Controlled
signed-JWT/SQLite/GitHub fixtures are not live cloud execution or deployment.
No production migration, credentials, dispatch or workflow enablement occurred.
Next: #282 result callback ownership against this parent, then outcome recovery.
## 2026-10-17 — bounded cloud coder process recovery (#331 / #333)

Existing trusted cloud coder subprocess cleanup now retains SIGKILL after the group leader exits, closes inherited pipes at a bounded cleanup deadline, and isolates progress observer exceptions/rejected promises. Two new real-process regressions failed before the repair and pass after it. Complete Windows runner/local suite: 80 passed, one Linux-only skip; final process suite seven passed, one Linux-only skip. CI must verify the resistant-descendant process-group case before merge. Focused handoff: docs/CLOUD-PROCESS-RECOVERY.md. No production database, provider, credentials or workflow changed. Migration 0017 and its deployment remain paused for exact production approval. Next: complete #333 CI, then continue the existing task/claim/outcome/mission rollout in dependency order; persistent isolated workspace checkpoints remain unfinished.

## 2026-10-17 — cumulative local business execution allowances (#338)

BusinessService now reserves cumulative per-business execution upper bounds in an immediate SQLite transaction before MissionService creation. Smaller launch budgets and a percentage control permit repeated missions. Reserved allowances remain committed across restart, lost acknowledgement and terminal lane retry; observed durable scheduler usage is reported separately from spending receipts. Legacy history is explicitly uncertain and requires a newly authorized business record for new work. Ledger admission is bounded at 1,000 reservations. No new executor, external purchase, billing credential or spending authority was added.

Evidence: 23 business/mission focused tests pass, including four worker/SQLite connection admission races, real mission-store restart, uncertain launch retention and ledger exhaustion. Removing the cumulative comparison made the race regression fail (four admitted versus one); restored code passes. Full local-control run was intentionally stopped under shared Windows host contention and is not claimed passing; isolated CI remains the full-suite gate. See BUSINESS-BUDGETS.md for limitations. Next: current-head CI, then actual receipt reconciliation and controlled allowance top-up/release design.


## 2026-10-17 — owner workforce console (#336)

The existing local workforce API is now reachable through /workforce and the daemon navigation. Owner-token access remains required for all data and actions; paired-device data access is denied. The page itself contains no private data or inline code under the existing CSP. Token stays in tab memory and is cleared on lock/navigation. Explicit plans use existing execution, evidence review, cancel and resume boundaries. Saved run summaries are tenant-scoped, persisted, newest-created first and bounded to 100 rows without model/tool payloads. Existing name-to-ID agent mapping remains compatible through a separate display projection.

Two HTTP regressions failed before implementation. Affected workforce unit/HTTP suite passed 12/12; final expanded console suite passed all four cases including a real phone-width Edge browser: actual repository plan execution and interrupted-run resume, no DOM injection from an objective, no token storage, no layout overflow, malformed intake receipt recovery and explicit-refresh gating before retry. No timeout or authorization assertion was weakened. Full Linux/Windows CI remains the merge gate. No model-backed semantic review, external operation or hosted workforce execution is claimed.

Parallel continuation: approved terminal PR #311 merged as 912a7eb after green CI. #340 patch-bound truthful receipts and #341 explicit-opt-in business conversation previews merged after all CI passed. #342 cumulative business allowance admission has passing race/restart tests and is undergoing integration of appended documentation. Next: finish current-head CI/ordinary merges, independently evaluated test/live receipts, principal-safe conversational mutations and leased/deduplicated recurring business execution using existing services.

## 2026-10-18 — account overview customer privacy (#343)

Independent of blocked native signing, the actual account overview GET still returned raw database/plan exception text and left auth exceptions outside its response boundary. Reused existing customerFailure fixed copy/support reference/no-store contract for all unexpected failures, moving unchanged authentication into the catch boundary. Signed-out, unrestricted owner and scoped account/usage success projections remain intact. Actual TypeScript-handler regression fails prior main on an adversarial auth exception; repaired handler tests cover auth/database/plan/usage failures and confirm user/period predicates and successful outputs. Focused account/billing/deletion checks pass5/5, production build passes; broad web/typecheck/lint results belong to the PR checkpoint. No live account fault injection, admin diagnostic console or universal privacy claim. Native320 remains blocked by automatic-review rejection of simulator signing changes pending configured owner review; no signing edit was applied.

Account overview validation: production build passes; full web503 tests,500 pass/3 optional browser skips/0fail. Focused actual handler cases5/5 pass. Typecheck completed without diagnostics; focused ESLint still running at this checkpoint. No remote CI/deployment acceptance asserted.

## 2026-10-17 — scoped business evidence receipts (#339)

The existing production mission artifact verifier now persists a digest-bound
receipt that separates verified patch bytes from unavailable test validation and
unevaluated live outcomes. Executor verification claims are overwritten;
non-patch evidence stays explicitly executor-reported. Dependency handoffs and
durable mission snapshots carry the same scoped receipt. Required validation
fails closed until a trusted test adapter exists. CLI validation remains internal;
the daemon's exit code and combined text cannot establish test success.

Two spoofed-success regressions failed before the change. Focused receipt,
scheduler, mission service and business service suites: 24 passed. Full local
suite was interrupted during Genesis fixtures amid shared Windows host load;
it did not produce a complete passing result. Next: CI on this branch, then a
trusted post-change test receipt adapter bound to reviewed patch digests and
separate live-health/business outcome adapters. No live business action claimed.



## 2026-10-17 — result ownership integration checkpoint (#282)

Integrated main 482948b through #270/#274/#276/#278 into the existing result
ownership implementation. Added a built-Worker callback regression that changes
the saved objective during GitHub verification and requires 409, no result writes,
and no run linkage. Existing transaction ownership checks remain authoritative.
Reports are executor-authored summaries, not verified successful outcomes.

All ten workflow checks pass. Runner/local suite: 86 pass, one failure, one
Linux-only skip (88 total); isolated process suite: five pass, two fail, one
Linux-only skip. Windows inherited-pipe deadline and observer timing remain
unresolved. Do not relabel these failures as a passing acceptance run.
Fresh web validation is pending: npm ci stalled without an error, then was stopped;
matching-lockfile dependencies are being copied from the verified parent checkout.
Initial build/lint attempts before dependency completion failed to find binaries.
No production migration/deployment, live OIDC, paid infrastructure or secret
transfer occurred. Migration 0019 and protected owner review remain required.
Next: finish #282 web validation and fresh CI; then #289 trusted outcome receipts.
## 2026-10-17 coder context recovery (issue #287)

- Live run 38819478158 confirms #269 repaired repo_browser aliases in production. The same run still failed on HTTP 413 after substantial context growth; alias repair alone is not task completion. Hosted authenticated inspection 38848539074 passed.
- Extend existing context compaction to recognize offered aliases through the existing resolver. Associate results with their preceding call batch rather than a global ID set, preserving writes/errors when providers reuse call IDs. Ambiguous batch IDs and unpaired results remain intact. Original trace and arguments are unchanged.
- Regression coverage includes oversized aliased reads through the real agent/registry, unoffered/ambiguous aliases, reused IDs across read/write turns and duplicate results. Earlier local suite at dee7942: 513 passed, 4 Windows failures, 4 skipped; those failures concern diffs, paths and file modes, not this patch. Final validation is tracked in the PR after integration with main 482948b. Do not infer that all tests passed locally.
- This does not guarantee provider TPM compliance or add test-only task execution. Current main has separate cloud-provider/runner recovery; preserve it. No new TODO or execution architecture.
Account overview344 integration: original d8678f0 ALL CI passed, but a concurrent main merge caused a documentation-only conflict before merge. Integrated current main482948b preserving both business and account progress entries. No runtime source conflicts. Focused lint/typecheck and fullweb500pass3optional skips were established before integration; fresh complete CI is required at the integrated head. No merge or deployment claimed.

## 2026-10-18 — eval harness, first slice (#128, PROGRAM 2.1)

Took over stale workstream #128 (claim from 2026-09-27, no code on main). Adds `packages/atlas-eval` (dependency-free): EvalTask/EvalResult validation, a runner that checks out each task's base commit into a throwaway worktree, runs an agent, then runs the task's own verify command (pass = verify exits 0 with files changed; agent claims are ignored), JSON/Markdown reports, an `atlas code` adapter (key passed by env-var name only, child gets no other env), and `validate`, a no-model dry run proving each task fails untouched and passes with its recorded solution. Ten tasks in `evals/tasks`: six from real commits, four repository questions checked by `evals/verifiers/answer-check.mjs`. Docs: docs/EVALS.md.

Evidence: 16 package tests pass; `validate` 10/10 tasks valid; mutation checks (agent claim counted, env allowlist removed, cleanup removed, no-change guard removed) each make the matching tests fail. No baseline pass rate: no provider key in this environment, and nothing in this PR claims one. Open: CI wiring (`atlas-eval.yml`, protected, owner review), dogfood log (2.2), tasks for test repair/tool args/review/final synthesis/browser, growth to 30–50, Groq Batch. Next: CI workflow PR, then dogfood log, then a baseline run once a credential exists.

## 2026-10-18 — eval workflow and dogfood log (#128, PROGRAM 2.1–2.2)

Two follow-ups to the harness PR #348. #349 (protected, owner review): `atlas-eval.yml` validates every fixture on PRs touching the harness (no secrets) and runs a real target only on `workflow_dispatch`. Dogfood PR: `evals/dogfood/log.jsonl` is hash-chained and append-only; entries reject credential-shaped text; `dogfood drafts` turns failure classes seen 3+ times into non-runnable draft tasks with evidence. Tests: 19/19 in the package; mutation checks (chain check removed, secret guard removed, successes counted as failures) each fail tests. The log starts empty on purpose. Still open: baseline run (needs a provider key), tasks for test repair/tool args/review/final synthesis/browser, growth to 30–50, Groq Batch. Next: merge #348 → #349, then grow tasks.
## 2026-10-18 — bounded improvement loop for Genesis repairs (#355, PROGRAM 2.4/3.8)

Owner listed five upgrades; each is now a workstream issue with an audit of existing code: #351 persistent creation environments, #352 universal execution, #353 GPU compute manager, #354 artifacts and previews, #355 bounded improvement loop. Took #355 first because it is in the current phase. `platform/loop-policy.mjs` checks before every Genesis repair: repair budget, wall time (`ATLAS_REPAIR_MAX_MINUTES`, default 6h), tokens (`ATLAS_REPAIR_MAX_TOKENS`), and no progress (the same normalised failure fingerprint survived 2 repairs). The stop reason and receipt go in the failed transition's `evidence.loop`. The Genesis coder now reports token use from its audit trace. A rolled-back repair's broken rules feed the next objective. Behaviour change: a repair that cannot move the failure stops after 2 attempts instead of 3.

Evidence: local-control 764 pass / 2 skipped / 0 fail (7 new); e2e journey passes; mutation checks (no-progress rule, spend rule, fingerprint normalisation, rollback feedback) each fail tests. Not yet wired into the coder CLI's own repair loop (atlas-cli) or the self-improvement loop (protected). Eval: no model run available, so no measured delta. Next: same policy for the coder's repair loop; eval delta once a provider key exists; #349 owner review.


Context recovery #360 verification: 33 focused tests passed. Replacing the compiled compactor with unchanged main makes all three new regressions fail; restoring it passes all eight compaction tests. Hosted inspection gate 38848539074 passed. Latest main integration preserved concurrent progress entries; final CI tracked on the PR.
## 2026-10-18 — launch-readiness run (branch claude/genesis-named-business-site)

Baseline on main 857577a: every package green locally (see docs/audits/ATLAS-LAUNCH-READINESS.md for commands and counts); daemon e2e 21/21. No live provider was configured, so no live-model mission ran.

Sample A (Team Hahn website, real Genesis + Chromium, template path) exposed four Genesis defects, fixed with regression tests that failed before: ignored business name, dropped requested pages (reported `ready` anyway), invented credentials/promises in template copy, no local SEO. local-control suite after fix: 759 pass / 2 skipped / 0 fail.

Historical checkpoint correction during integration: #235 subsequently merged at c1ef3e3 after required CI passed. The quota ledger and hosted chat governor are already in main; the remaining gap is shared runner admission and durable waiting, not rebuilding the ledger. See docs/LAUNCH-REMEDIATION-2026-10-17.md and the corrected blocker section of docs/audits/ATLAS-LAUNCH-READINESS.md. Live-model samples and the hosted durability stack still require acceptance. This integration does not initiate a production deployment.

## 2026-10-06 Workers AI through the Worker's own binding (no token)

- Live check 37516955533 (19:10): still `validation valid, Workers AI denied → WRONG_ACCOUNT_OR_PERMISSION` (403, code 10000); chat answers 401 from Workers AI.
- Fix that needs no token: the Worker gets `ai: { binding: "AI" }` (`apps/web/vite.config.ts`; `wrangler deploy --dry-run` lists `env.AI`). `apps/web/app/api/chat/workers-ai-binding.mjs` makes the binding look like an OpenAI-compatible server to chat (a fetch-shaped transport over `env.AI.run()`, accepting both OpenAI `choices` and native `response`/`tool_calls` answers, SSE for streaming callers); refusals become statuses (429 routes on to the next provider) and the binding's own text is never passed on. Chat prefers the binding over `ATLAS_WORKERS_AI_TOKEN` (route kind stays `workers-ai`; default model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, `ATLAS_WORKERS_AI_MODEL` overrides). `/api/setup/providers` also reports `workersAIBinding` (a real inference) and "Verify hosted Atlas" prints it.
- Evidence: 430 web tests pass (5 new: both answer shapes; a full chat turn with a tool round trip on the binding, streaming and not, no key anywhere; refusal statuses and routing to Groq with no leaked text; binding preferred over the token and selectable; health); lint, typecheck, `vinext build`; runner and local script tests 63/63. Not yet verified live: needs the deploy; then the chat check.



## 2026-10-18 — repository settings customer privacy (#357)

Account344 merged c746663 after ALL CI39087720052 passed, deployment39087988081 succeeded, live anonymous account GET exactly signedIn:false passed. Postdeploy configured authenticated inspect39088067813 passed; it is general inspection, not adversarial account fault/payment/deletion acceptance.

Repository settings GET/PUT/DELETE still returned raw storage errors or migration0015 instructions, and auth exceptions escaped their context boundary. Reused existing fixed customerFailure contract (503/reference/no-store); unchanged auth/tenant resolution, owner/admin management, deployment allowlist, default-tenant zero-gate policy, validation and scoped writes. Three actual TypeScript-handler privacy regressions fail prior main; all10focused actual account/settings/validation cases pass after repair, covering auth/tenant/list/default/write faults with private/path/token/table sentinels and successful denial/scoping/mutation behavior. No new tenant policy or credential permissions. Broad checks/CI/deployment pending at this checkpoint. Native329/320 remain held for the already reported protected-signing automatic-review rejection; no bypass or signing edit.

Repository settings validation: production build/typecheck and direct installed ESLint pass; fullweb507tests504pass3optional skips0fail. Npm-wrapper lint was slow; direct installed binary completed successfully. No deployed adversarial settings acceptance claimed. Fresh PR CI remains required.


## 2026-10-18 — cloud observer release integration (#372)

Owner explicitly authorized merge and deployment. Preserved current main and
callback-ownership #282, including its corrected claimed-run assertion.
Reconciled Saved requests session fencing with reconciliation/observation actions;
stale responses cannot update a closed or replaced history session. Consolidating
#270/#274/#276/#278/#282/#289/#312/#335/#372 into one main release to avoid
intermediate deployments. Original observer head passed 539 tests and all CI;
combined-head validation is pending. Production D1 dry run39094365828 confirmed
missing schema; authorized additive migrations0017-0020,0022-0023 applied
successfully in39094569327. Cloud-mission migration0021 excluded. No code deploy yet.
## 2026-10-18 — shared governor for runner model calls (branch claude/shared-governor-runner)

Closes the documented gap that coder inference did not share capacity with hosted chat. Worker gateway `/api/inference/governor` (own `ATLAS_GOVERNOR_TOKEN`, not the operator token) and CLI `GovernedModelProvider` wired around each coder route inside the retry layer; off unless `ATLAS_GOVERNOR_URL` and `ATLAS_GOVERNOR_TOKEN` are set. Evidence: gateway 4 tests over the real ledger core; CLI 555/555 (15 new, including a real HTTP socket proving a 429 on one runner makes a second runner on the same key wait without sending a provider request); web 506 pass/3 skipped; runner 81/81; workflows valid. Protected paths changed (deploy/coder/steward workflows, a new auth-gated route): owner review required. Not deployed. Next: owner adds the secret/variable and deploys, then verify with a real coder run; pass rate-limit headers through the provider contract.
Runner hardening follow-up: configured admission no longer fails open on missing/malformed grants, transport errors or gateway authentication rejection. Partial URL/token configuration is rejected; completed provider outcomes survive settlement failure. Five regression groups fail the previous implementation; TypeScript build and 36 focused governor/socket/retry/fallback tests pass. Hosted chat fail-open behavior, multi-key account scope, durable waiting and production configuration remain open. No deployment or real-provider spend was initiated.

## 2026-10-18 — customer Connections status (#371)

Repository privacy #358 merged as 02a1421 after all exact-head checks passed. Cloudflare39093070087 succeeded; live anonymous settings GET returned exactly401/fixed sign-in message. Configured authenticated inspect39093166143 passed. These are ordinary route/product checks, not adversarial live tenant writes or universal privacy acceptance.

The setup endpoint previously returned database/migration, dispatch, runtime and inference diagnostics to every authenticated account. It now uses the existing isDeploymentOwner identity to return only account-connected status to customers before any infrastructure probe. Operator diagnostics remain available with an explicit audience marker; no authentication, tenant, credential or approval policy is modified. Connections renders customer account status separately, removes the operator billing-configuration card for customers and uses fixed model/status failure copy outside the owner view. The separately owned chat GET response contract remains outside this slice; this does not claim it universally hides configuration fields.

Actual handler tests verify zero customer probes, exact safe projection for customer/trusted-header identities, preserved owner diagnostics, sign-out and safe auth failures. Customer/auth guards fail against unchanged main. Phone-component acceptance, build/types/lint and broad checks are still pending at this checkpoint. Native signing review blocker is unchanged; no rejected workflow edit was retried or applied.

Actual phone-width Connections component acceptance passed with real Chromium: customer account status shown, owner-only billing/configuration and backend model text hidden, fixed failure notice on503, owner diagnostics retained, no page exceptions. The cold local Vite/browser fixture took about225seconds under host contention; this is test-host timing, not a product latency result. Build/type/lint checks remain pending.

Connections validation follow-through: production build/typecheck and primary focused ESLint passed; real phone acceptance passed separately. Broad suite found the existing owner schema fixture stripped imports without injecting the new owner helper. Added the real isDeploymentOwner/customerFailure dependencies only; preserved every original migration/private-error assertion. Eight focused owner/customer/schema checks pass; repaired fullweb516tests512pass4optional browser skips0fail. Fixture-only ESLint and fresh exact-head CI remain required. The original draft CI failure is retained as failed evidence, not ignored.


## 2026-10-18 — bounded Connections status recovery (#378)

Connections privacy375 merged e604174 after allCI39094888177 passed, including one bounded rerun of unchanged Windows boot timeout (root cause unproven). Deployment39156827088 succeeded; live anonymous setupGET returned exactly401/fixed sign-in copy. Authenticated owner inspection39156966813 remains in progress after delayed runner start, not yet a passing receipt.

Connections refresh could remain indefinitely busy on stalled headers/body, and malformed200 status could crash the actual component. Added a12second whole-read deadline (including JSON body), AbortController cancellation, generation fencing for superseded/unmounted reads, explicit manual retry and response-shape validation. No automatic retry or mutation behavior changed. Actual Chromium component acceptance covers stalled headers/body, request counts/manual recovery, malformed status, late abort-ignoring response and unmount/late401 without navigation, retaining customer/owner privacy checks. It passes with the fix and fails unchanged main at malformed status rendering. Build/types/lint/broad checks and remote CI belong to this workstream checkpoint; no deployed recovery or overall cloud-readiness claim. Protected native signing blocker remains unchanged, no rejected change retried.

Connections recovery validation: actual phone acceptance passes all stalled-header/body, explicit retry/count, malformed-response, stale-response and unmount/late401 cases. Baseline actual main component fails at malformed status rendering; source restored before build. Production build/typecheck/direct ESLint pass. Full web580tests575pass5optional browser skips0fail. Fresh remote CI and deployment acceptance remain pending; no automatic retry or backend-completion guarantee introduced.
2026-10-19 | (this PR) | inference / chat + coder | Fit requests to a provider's per-request allowance instead of failing. The quota ledger refused every chat request whose bytes/3 estimate plus max_tokens exceeded Groq's learned 8,000-token TPM ("refused a request larger than its per-minute token allowance"), before Groq was called; it now returns the allowance (`limitTokens`) and the chat refits once (smaller reply budget, shorter tool results, then oldest earlier turns; never the system prompt, latest message or work since it). Raw provider 413/429 "Limit N, Requested M" refusals refit the same way, calibrated to the provider's own count; 413 is routable. The coder's Groq provider learns the stated allowance, refits (reply budget, then re-readable tool output) and pre-fits later turns. | Live `verify-hosted` chat run 39105457659 before the fix: Groq too-large, Workers AI daily allocation (4006), OpenAI no credits. New tests: apps/web chat-allowance-fit (6), atlas-cli groq refit (3), ledger limitTokens. | OpenAI has no API credits and Workers AI's free daily allocation was spent: owner action. | Re-run `verify-hosted` chat after deploy.

2026-10-19 | (this PR) | hosted tasks | Coding agents never started from hosted chat: the durable-dispatch, execution-claim, cancellation and Genesis-bridge calls passed `redirect: "error"` to fetch, which Cloudflare Workers does not implement (TypeError before sending), so every dispatch ended "Cloud dispatch unconfirmed" ~50 ms after it began. Now `redirect: "manual"` (redirects still never followed; a 3xx is not ok). Chat no longer says "Started a coder run" for a dispatch that was not confirmed. | Live task 85a45a79 (2026-10-19 00:41) dispatch events; Cloudflare Request docs; guard test `worker-fetch-redirect`; full web suite 587 pass / 0 fail. | — | After deploy, re-run `verify-hosted` in coder mode.
2026-10-19 | (this PR) | hosted chat → Genesis | Website/app requests ("Build a responsive website for Team Hahn Construction…") now start a new project instead of a chat answer; unavailable creation returns a reason and a next step; the status card shows distinct unavailable/planning/executing/awaiting-approval/blocked/interrupted/failed/completed stages with no fabricated defaults; Genesis now keeps the business name and "in City, State" from that prompt. | Real Genesis + Chromium acceptance on the exact prompt: ready, 5 pages, build and 2/2 tests pass, 10 browser checks at 375/1280 px, loopback preview. web 592 pass, lint and tsc clean; genesis 47 pass. Not verified: hosted end to end (needs an owner-run Genesis node: ATLAS_GENESIS_URL/TOKEN), model-written site, public preview URL. | docs/HOSTED-WEBSITE-CREATION.md | Next: owner connects a Genesis node and runs the prompt from hosted chat; then a Worker-independent isolated builder with a public preview.
2026-10-19 | (this PR) | hosted chat → Genesis | Hosted website builder: with no Genesis node, hosted chat builds a business website inside the Worker from Genesis's own specification, site config and a pure renderer (split out of the template build script, byte-identical output), stores it on the genesis_projects row, checks structure and links (39 checks for the Team Hahn site), and serves a CSP-sandboxed, noindex preview at /preview/<id>. A node is still used first for owners; apps and APIs keep the node's reason and fix. | Built Worker + scripted model + real Chromium at 375/1280 px: row written, five pages 200, no console errors or overflow, form states the preview does not send. web 611 pass / 0 skipped, lint and tsc clean; genesis 47 pass; runner scripts 88 pass. Not verified: live deployment, model-written copy, enquiry delivery, publishing. | docs/HOSTED-WEBSITE-CREATION.md, docs/FREE-CODING-MODEL-STRATEGY.md | Next: owner deploys and runs the prompt live; confirm migration 0016 on production; then GPU-node free-model path per FREE-CODING-MODEL-STRATEGY.md.

## 2026-10-19 — one-week parallel sprint, first pass (ENGINEERING-PLAN-2026 §5)

Six agent lanes ran in parallel, each in its own worktree, branch and PR, coordinated by the lead session.

| Lane | Issue | PR | Result |
|---|---|---|---|
| A. Eval suite | #128 | #381 | Merged. 35 tasks validate (fail untouched, pass with recorded solution) in 8 categories, including test repair, tool args and final synthesis. CI `eval fixtures` passes. |
| B. Coder loop limits | #355 | #368 | Merged. The atlas-cli repair loop stops on iteration, time (`--max-repair-ms`), token spend or no-progress (`--max-same-failure`) before each repair, escalates once on no progress, and reports `stopReason` in the receipt. |
| C. Persistent environments | #351 | #377 | Merged. Genesis snapshots each stage (git commit plus tree and manifest digests), restores into a fresh folder with fail-closed verification, resumes after a restart, and never repeats a completed external side effect. Windows fixes: snapshots disable autocrlf and renormalise so stored bytes equal the disk; a regression test forces autocrlf on Linux. |
| D. Artifacts | #354 | #370 | Merged. A typed, content-addressed, tenant-scoped artifact store; authenticated routes with Range support; video and glTF viewers; Genesis registers website artifacts. |
| E. Render execution | #352 | #376, #389 | Merged. ffmpeg and headless Blender run only in the container sandbox (no host fallback, network off, workspace never mounted); a real ffmpeg container render ran. #389 wires it into the daemon: `GET /v1/render`, and an owner-only `POST /v1/render/jobs` against a Genesis project, with video outputs stored as artifacts. |
| F. GPU compute manager | #353 | #369 | Merged. Provider interface and fake provider with four stops (budget reservation, provider-side max lifetime, idle timeout, orphan reconciler); the crash test leaves zero orphans. No real provider, no spend. |

Sprint gate: met.
- All six lanes are merged.
- The eval suite has 35 tasks, above the 30 target.
- The GPU chaos test passes.
- The cross-lane journey passes in `tests/sprint-journey.test.mjs` (#389) through the real HTTP handler: sentence → verified project → sandboxed render → video artifact (Range) → paired device refused → restore from snapshot → render again. CI uses a container stand-in; the real-container render is in #376.

Also merged this cycle: the eval CI workflow (#349), the engineering plan (#365) and bounded Genesis repair loops (#356).

Next:
- A render action in the Genesis UI.
- A project-owned ffmpeg/Blender image pinned by digest.
- Eval baseline, once a provider key secret exists.
- Real GPU provider adapter, after decision D4.
- Cloudflare Sandbox environment, after decision D2.

## 2026-10-19 — coder reliability evidence refresh (handoff follow-through)

Audited current main dd87fc8 and the two-mode handoff. Mode A already landed in #159 (3452343): declared input errors become redacted failed tool results; the agent tool message includes the tool name and schema-derived validFields. Policy/scope and unexpected validator/redactor faults remain fatal. Pinned CLI installation/build and 32 focused registry/agent tests pass. This is existing-implementation verification, not a newly implemented fix or full live acceptance.

Fresh configured coder smoke39234208312 created saved task execution39234248406 through the real claim gate. The actual coder completed in four turns/three calls, but proposed no edits because docs/ATLAS-SMOKE-CHECK.md already contains the requested exact content. Thus this fixed smoke objective cannot prove a new coding change or PR; a green step is insufficient. Final hosted delivery/verification remains pending.

Downloaded and replayed retained real trace39094222456 with atlas replay: ten turns, nine completed tool calls, then provider routes exhausted with HTTP429. Its objective was the vague Improve the Atlas source code, not the comparable medium objective requested by the handoff. tool.requested stores toolId and argumentCount, not argument values/digests. Repeated tool names alone cannot establish identical-call loops. No B repair, larger budget, exhaustion verdict change or loop-free claim is made from this evidence. Preserve original traces locally; do not add raw artifacts to Git.

Connections379 is merged6cb8cb2 with all exact-headCI39157931782 passing and deployment39159499224 successful. Prior owner inspect39156966813 failed after20minutes waiting for delivered findings, with WorkersAI429; it is not passing acceptance. Native signing owner-review blocker remains unchanged and no rejected edit was retried.

Next: obtain a fresh saved medium coder task with an unmet, bounded objective through the authorized hosted dispatch; replay its trace and establish argument-level evidence before a cause-driven B change. Replace the already-satisfied smoke objective for meaningful new-change acceptance, preserving configured workflow review. Add budget/security mutation coverage only for demonstrated missing guards; never duplicate #159 or increase limits to hide repetition.

## 2026-10-19 — repeatable coder acceptance (#393)

Fresh verify39234208312 definitively failed Coder finished without a reviewable pull request; underlying coder39234248406 truthfully completed without edits because its fixed smoke document already existed. The acceptance script now gives each invocation a UUID-named document, so prior acceptance cannot satisfy the next requested change. Existing saved-task dispatch, claim gate, manual PR policy, verified-evidence and delivery requirements remain intact. No workflow, credential, tool schema, budget or exhaustion verdict change.

Real smoke-script subprocess regression fails unchanged main at identical objectives, passes with the fix, fails again with only uniqueness removed, then passes restored. Runner/local suite:89tests88pass1skip0fail. Previous existing Mode A verification:32 focused agent/registry tests pass. This repairs an acceptance prerequisite, not Mode B; no fresh live change/medium-task success is claimed before deployment/dispatch.

Next: complete exact-head CI and ordinary review eligibility, merge acceptance repair, then dispatch one fresh trivial coder acceptance. Obtain an authorized saved medium task and argument-level trace evidence before implementing a B repair; do not infer loops from repeated tool names.

## 2026-10-20 — Windows coder verification launch (#405)

Independent of the still-open medium-task/tool-budget investigation, default Windows coder verification could not launch npm: the bounded shell-free runner received ENOENT from spawn npm. A new real Windows guard fails current main, including with a malicious workspace npm.cmd on the only PATH. The runner now resolves only the npm CLI bundled beside its canonical Node executable and launches it with that same Node binary. Logical npm allowlisting still runs first; arbitrary Node execution remains denied, arguments stay an array, the environment/cwd/output/deadline/cleanup controls remain unchanged, and missing/outside-distribution npm fails closed. No PATH search or shell fallback. Non-Windows launch behavior and explicit other executable requests are unchanged. cli.ts and active #397 files are untouched.

Build passes. Actual runner + main()-driven repair-loop checks:13tests11pass2platform skips0fail; the previously failing no-progress and elapsed-time CLI verification cases now pass on Windows. Full CLI suite:588tests580pass4fail4skip; four previously observed Windows CRLF/path/mode failures remain, so this is not an all-green local suite. Removing only the source adapter with the new test retained fails again; restoring/rebuilding passes. No Mode B fix, larger budget, verdict-path change or medium live evidence claimed.

Next: publish this isolated verification repair, inspect exact-head CI/reviews and merge only ordinary-eligible all-green/no-blocker changes. Continue to preserve PR395 configured workflow review for medium-task dispatch and native320 signing review; do not infer identical-call loops from old argument-free traces.

## 2026-10-20 — complete Windows CLI fixture portability (#411)

Windows verification408 merged afdee0498e18b0f471b9649f7757e784d5a89439 after all exact-headCI39355503000 passed; mainCI39357421554 also passed. The default npm launch defect is repaired without touching active inference cli.ts work.

Reproduced the four remaining Windows suite failures before edits. Corrected fixtures only: convert file URLs with fileURLToPath, set autocrlf=false only in the deliberately LF git-apply fixture repository, and compare undo mode restoration to the filesystem's actual initial mode. POSIX executable-bit setup remains asserted on POSIX. The checkpoint0600 assertion remains unchanged in a separate POSIX-only test, explicitly skipped on Windows where those mode bits do not express ACL privacy. Content, conflict/all-or-nothing, traversal, symlink and saved-checkpoint assertions remain; no runtime permissions or security policies changed.

Build passed; fullCLI589tests584pass5platform skips0fail on this Windows host. Focused26tests25pass1POSIX skip0fail. Restoring original fixture assumptions reproduces the failures; restoring corrections passes again. Runner/local checks and fresh exact-head CI are recorded with the PR. This is portable verification coverage, not a Mode B algorithm repair.

A normal browser sign-in attempt through Atlas's existing GitHub flow failed at token exchange before a usable session was established. No auth bypass, credential extraction or unreviewed workflow dispatch was attempted; temporary browser tab closed. The live medium-task diagnosis still needs an authorized runtime or configured owner review on PR395. Existing trivial coder acceptance39241361227/39241380949 and reviewablePR396 remain valid.

Next: complete exact-head CI/no-blocker checks for this ordinary fixture repair; obtain configured workflow owner review on PR395, dispatch a fresh bounded medium saved task and replay argument-level evidence before selecting a B repair. Do not raise budgets or claim the original exhausted run was a loop without its missing evidence.

Portability validation follow-through: added actual Windows read-only restoration coverage, which passes and fails if chmod restoration is removed from the compiled runtime; restored implementation passes. POSIX0600 and executable-bit assertions remain on POSIX. Final fullCLI590tests585pass5platform skips0fail; runner/local91tests90pass1skip0fail. Next: require all fresh exact-head CI for the updated fixture PR; medium-task diagnosis still requires configured PR395 review or a working authorized normal sign-in, and is not complete.

## 2026-10-20 — private argument-level coder diagnosis (#413)

Portable Windows fixture PR412 merged07ba84f3c35a06eff79a74c77924de0d079bea80 after all exact-headCI39361062225 passed. Its first Windows daemon boot attempt timed out at the unchanged15-second fixture; one inspected failed-job retry passed. Cause remains unproven; no timeout or assertion weakened.

The current coder audit lacked argument identity, so repeated tool names could not diagnose Mode B. Populate its existing optional argumentsDigest with canonicalized, per-run keyed HMAC-SHA256; replay exposes only validated fingerprints in text and JSON. The unpublished key changes on every run, including reused agent instances. Raw arguments and keys are not added to audit metadata. Calls still execute and count normally; no deduplication, retries, larger budget, policy recovery or exhaustion verdict change. Coordinated the narrow stale agent-file overlap on PR200; its provider/billing work remains untouched.

New guards failed before implementation; fixed agent/replay and existing registry/audit focused suite passed63 tests. Removing digest emission, replacing the random run key with a fixed key, or removing replay display each fails its retained guard; restored implementation passes. Existing Mode A budget characterization also fails when its budget guard is removed: recovered invalid input consumes calls and never executes. Real main() replay wiring is covered. After integrating portable fixtures, build and full CLI593tests588pass5platform skips0fail; runner/local91tests90pass1skip0fail. Initial sandbox-local HTTP fixtures could not start; rerun with loopback permitted completed successfully. No medium-run evidence or B repair is claimed.

Next: publish the argument-diagnostic PR and inspect exact-head CI. Review provider PR397 under the latest human request without bypassing configured workflow review, then deploy/verify chat only after eligible checks/review and available credentials. Obtain a fresh authorized saved medium coder task after the diagnostic code ships and PR395 receives configured review (or normal authenticated runtime works); replay toolId plus run-local digest before selecting a cause-driven B repair.
## 2026-10-20 — recurring business review admission and installation startup

Business review PR404 merged b513774 after all exact-head CI39250479455 checks passed, including Linux and Windows daemon suites. Owner-configured business-review automations use the existing cumulative allowance and MissionService, claim an exact responsibility/due cycle atomically, recheck that cycle under the SQLite write lock, retain uncertain reservations and never advance review dates merely on mission completion. Eight new boundary tests and 42 affected checks passed; no live business outcome is asserted. Setup and limitations: BUSINESS-REVIEWS.md.

Issue402 exposed a real deployment blocker: both Windows payload paths omitted atlas-contracts; MSI staging also omitted the engineering adapter's merge-decision import. Installer-only stale ownership takeover was documented on PR230, leaving its runner/model changes untouched. The fix stages these existing dependencies and adds real installed-daemon startup regressions for source installation and MSI staging. Both regressions fail against original scripts with ERR_MODULE_NOT_FOUND; repaired startup plus release checks passed14/14 locally. Actual WiX compile/sign and coder toolchain packaging remain unqualified; see LOCAL-INSTALLATION-ACCEPTANCE.md. Fresh integrated-head CI is required before merge.

Live chat gate39249794671 failed streaming with a fixed error and no stored reply; non-streaming answered/stored via Groq. Preceding39249667886 failed non-streaming with rate-limit/billing exhaustion while streaming passed. Deployment39249464778 itself succeeded. Evidence is retained on issue238; generic streaming copy does not establish root cause. No repeat-until-green, provider spending or gate weakening. Next: complete installer CI/ordinary merge; separately package and verify the local coder toolchain, and resolve existing transport/capacity work before claiming two-mode live chat acceptance.


## 2026-10-19 — bounded cloud inference responses (#383)

OpenAI/Workers AI CLI inference now enforces one deadline across headers and all bounded body reads, even if a transport ignores abort. Caller cancellation is terminal; timeout flows through existing retry/fallback. Cleanup never waits indefinitely for stream cancellation, late response bodies are discarded, and completed calls remove timers/listeners. Five new regressions fail against unchanged provider source and pass after repair. TypeScript passed; focused cloud/retry/fallback/budgets 42/42. Full Windows CLI: 572 total, 562 pass, six fail, four skip. All six failures reproduce in a selected unchanged-provider baseline (repair-loop fixture validation, CRLF, file URL and POSIX modes); no tests weakened. Exact-head required CI remains the merge gate. Focused handoff: docs/CLOUD-RESPONSE-DEADLINES.md. No schema, credentials, destination, workflow or infrastructure changed. Next: complete CI, then continue shared runner admission and persistent environment rollout with existing owners; do not duplicate #364/#377.


Cloud response #403 integration: preserved concurrent progress entries and current-main shared runner admission (#364), persistent environments (#377), render and hosted dispatch repairs. No runtime source conflict; cloud tests merged automatically. Fresh compilation, governed-provider checks and required CI are needed at this integrated head.

PR415 integration: retained both independent progress entries; current main includes #403 cloud deadlines and #404 business review. All prior exact-head CI39379249241 passed before this docs-only conflict resolution. Next: inspect fresh integrated-head CI; medium coder diagnosis and provider release remain subject to their documented review/evidence gates.

PR415 integration with #416: retained all concurrent progress entries; no diagnostic source conflict. Next: require all fresh exact-head CI before ordinary merge, then obtain authorized medium-task evidence under the existing review gates.

## 2026-10-21 — truthful coder activity completion (#386)

Chat TaskActivity now reuses the existing build status presentation: a successful runner with no pull request does not claim a change is ready, and a pull request prompts review of changes and validation evidence. Generic completed state remains explicitly unconfirmed. Coder run is a neutral title; terminal empty steps no longer claim GitHub has yet to start. No execution, approval, polling, result-storage or verification policy changed.

Validation: production web build and lint passed; full web suite 620 tests, 615 passed, five optional browser skips, zero failures. Actual React-rendered completion tests cover no-PR success, reviewable PR, unknown completion, failure, timeout, cancellation, skipped, and dispatch states. Existing elapsed-clock/poll recovery coverage is preserved. Restoring main's TaskActivity makes the new tests fail; restoring the fix passes all five rendered/clock tests. Hosted UI deployment and authenticated browser acceptance remain pending; this change does not add test execution or establish objective completion.
## 2026-10-02 untrusted-data gap in team step verification

- Audited the monorepo end to end (lint, typecheck, and every package's test suite) looking for the most likely real bug; ruled out several false leads first: `currentPeriodStart` (billing) was correct, a sandbox output-redaction layer made `githubReadHeaders()` look suspicious but is correct, stale `packages/atlas-cli/dist/` build artifacts from an unmerged branch caused spurious `provider-status` test failures, and several Windows-local-only failures (NTFS file-mode checks, a `genesis-publish` temp-dir `EPERM` race, PowerShell CLIXML noise in a live-session desktop test) are not cross-platform bugs.
- Found a real gap in `apps/local-control/src/agent/team/step-executor.mjs`'s `verifyStep()`: the verification prompt wrapped the agent's `report` via `wrapUntrusted(...)` but spliced `toolLog` (`JSON.stringify(toolLog.slice(-20))`) into the same prompt raw and unwrapped. This violates the project's own stated invariant (this file's doc comment and the repo's custom instructions) that all tool/web/repository/agent-derived content must be wrapped as untrusted data before reaching a model. Current `toolLog` entries are bounded (`tool` from an allowlist, `code` from a small internal enum), so this was not a demonstrated live exploit, but it is a real defense-in-depth/consistency gap a future tool could widen.
- Fix: wrap the tool log through the same `wrapUntrusted("tool log", ...)` helper used for the report. Added a regression test in `apps/local-control/tests/team-missions.test.mjs` asserting both `<data source="report">` and `<data source="tool log">` blocks appear in the prompt sent to the model, and that an injection-shaped `code` value inside the tool log trips the existing "Atlas notice" marker.
- Evidence: `apps/local-control` test suite passes except the pre-existing, unrelated `genesis-publish.test.mjs` Windows temp-dir `EPERM` flake (622/623, matching the baseline before this change). `apps/web` (326 tests), lint and typecheck, `packages/atlas-contracts` (6 tests) and `scripts/runner`/`scripts/local` (53 tests) all pass unchanged.
- Next: no action required for this fix; it is a self-contained security-consistency correction. Unrelated to this PR, prior sessions still have open threads on local-model qualification (OpenCode/Goose harness) and GitHub telemetry expansion — see the entries above.
## 2026-10-15 | PR #284 | Genesis receipt recovery (issue #281)

Hosted project creation now reserves an operation-ID-only event in an owned,
unarchived conversation before contacting Genesis. Direct callers without a
thread receive newly saved owned history. Reopening chat restores the latest
receipt and checks actual node status; lost creation responses do not require
another creation request. Status polling is bounded and explicit retry reads
only. Existing operations are not backfilled; node connectivity/credentials
remain required for live confirmation.

Evidence: production build, typecheck and lint passed; full web suite 485 passed,
one optional browser gate skipped, zero failed. Separate desktop/mobile browser
gate passed including recovery, offline retry, reload, no creation POSTs, and
scroll preservation. Real SQLite/route tests cover scope isolation and history
failures. Removing receipt reservation fails the mutation check. A concurrent
build/test output race was resolved by rerunning the suite after the build; a
cold browser-bundle timeout passed on warmed rerun with its original timeout.

PR is for owner review under PROGRAM section 3 because tenant-scoped persistence
at the publishing boundary is protected. No credential provisioning or live
repository creation occurred. Other agents' root edits and task dispatch were
preserved. Next: review/integrate #284, then configure the trusted Genesis node
connection before a live new-project acceptance run.

## 2026-10-19 — Genesis receipt integration checkpoint (#281 / #284)

Integrated current main afdee04, preserving hosted website creation, scoped
preview reads, project-stage UI, bounded bridge deadlines, and existing approvals.
Node dispatch reserves its original operation id before calling the node. Hosted
creation reserves its actual gen_ operation id before returning an existing row
or writing a site. Missing/foreign/archived history prevents creation. Reopening
history restores only bounded operation ids; status checks never create projects.
Retained main's preview UI while restoring bounded polling, cancellation, explicit
read-only retry and truthful not-found diagnostics. Added a real SQLite hosted
fallback recovery/refusal regression. Twenty focused project cases pass. All
11 workflow checks pass. Build/full web tests, typecheck, lint and fresh CI are
pending; no live node, external repository creation, publish or deployment claimed.

Separate #289 CI at 6ac1336 failed Windows: 828 pass, two failures, 20 skips.
Main already repairs the Genesis acceptance fixture. Updated daemon/Genesis
reproduction passes all 11 cases in a serial Windows run; full parallel Windows
CI remains a gate. Earlier all-green source heads do not replace this evidence.
No production migration, credential transfer, data change or paid provisioning.
Next: complete current-head CI and protected persistence review before rollout;
configure a trusted Genesis node only with the required owner authorization.

## 2026-10-19 — Genesis receipt verification follow-through

Integrated build and typecheck pass. Full web acceptance: 624 total, 619 passed,
five optional browser skips, zero failures. Separate Edge desktop/mobile chat
acceptance passes: reopen/reload restores the receipt, offline status retry is
read-only, no project creation POST occurs, and scroll position is preserved.
Twenty-six focused chat/project cases pass. Full ESLint passes after removing
an unused default callback argument. CI b02ca55 failed at that lint error; it did
not reach the incomplete chat test host. The host now imports the real receipt
helper. Final history-refusal diagnostics and no-write assertions pass 16 focused
cases; final head CI remains required. No assertion or authorization was removed.

#289's current-main integration exposed an unsupported Worker redirect mode in
three verification calls; the separate outcome branch now uses manual redirects
and rejects non-success responses. Its source scanner is corrected to inspect
real files on Windows. Both fixes retain original ownership and approval gates.
No live node, physical phone, production write, migration or deployment claimed.
Next: finish exact-head CI/protected review for #284 and #289, then a configured,
explicitly authorized Genesis-node acceptance run without publishing by default.
## 2026-10-20 — owner delivery priority queue (#430)

Recorded the latest human P0–P3 order at the top of docs/atlas-os/BACKLOG.md: inference survival and real verified website/coding outcomes first; continuity, safe execution and bounded improvement next; owned/optional GPU compute and artifact experience after that; experimental research last. Each row reuses current services/PR ownership and states required observable acceptance. Historical evidence remains intact. PROGRAM phase gates, review requirements and resource authorization remain unchanged; this records the queue, not completed capabilities or permission to start later phases.

Coder diagnostic PR415 merged cdfcc836e18d2db4e608b2292e915fde3b9cc88e after every exact-head check at0f6355a passed; merged-main CI39387977894 passed. Its private argument fingerprints enable diagnosis, not a Mode B completion claim. Provider397 correction was independently checked, but configured review/new credentials and fresh medium-task evidence remain outstanding. Documentation checked for complete priorities, existing-work references and diff hygiene; no runtime tests warranted for this queue-only update.

Next: finish eligible P0 inference deployment/chat verification and actual website/medium coder acceptance, preserving configured reviews, claim gates and active ownership; diagnose repeated calls from the new trace before selecting a B repair. P1–P3 remain queued according to PROGRAM exit gates.
2026-10-19 | (this PR) | inference fabric A1 | Design `docs/atlas-os/INFERENCE-FABRIC.md`. Shared vendor catalog (`packages/atlas-inference/src/catalog.mjs`) with trust tiers. Chat and coder now bounce across Groq, Workers AI, Cerebras, Gemini, OpenRouter, Mistral and OpenAI; any refusal routes on, rejected keys included (logged); only a malformed request stops. Training tiers (Gemini/OpenRouter/Mistral free) need the owner's opt-in (`ATLAS_ALLOW_TRAINING_PROVIDERS=1` chat, `all` coder) and in chat receive only requests with no tool output, memory or code. Route specs accept model names with colons. | New tests: chat-free-vendors (5), catalog upload check, coder-routes (3), CLI vendors and route parsing; full suites: web 593/0, atlas-cli 571/0, inference 64/0, runner 85/0. | Owner: add free keys as secrets and redeploy. | A2: waiting-for-capacity and scheduled resume.

2026-10-19 | (same PR) | inference fabric A2 | Coder waits for capacity instead of failing: when every route is rate-limited or over capacity, `FallbackModelProvider` sleeps until the soonest stated reset within a per-run budget (`--capacity-wait-ms`, `ATLAS_CODER_CAPACITY_WAIT_MS`, default 5 min) and continues with the agent's work intact; a longer reset fails at once and says when it ends. Coder fallback also routes past a rejected key, like chat; only a malformed request or cancellation stops. | fallback-model-provider tests (4 new, 1 updated), cloud-model-provider auth test updated; atlas-cli 575/0, runner 85/0. | Hosted re-dispatch after a long reset needs a new claim generation per task. | Owner: add free keys; then verify-hosted chat and coder.

2026-10-20 | (same PR, owner review) | inference fabric trust | Owner review (P1): training-tier eligibility was a formatting heuristic (unfenced code and arbitrary system context passed). Now fail-closed by recorded provenance: Atlas's own system prompt is registered where it is built (`atlasAuthored` in `chatTurns`); a request qualifies only if every message is that prompt or something the person typed. Unregistered system messages, tool output, memory and any assistant turn disqualify. Docs and consent now say plainly that anything typed, pasted code included, may reach a training tier. | chat-free-vendors: reviewer's sentinel case, unregistered system context, content-independent provenance, earlier replies. | Needs independent owner review; keys not provisioned. | Merge after review, then provision keys and verify-hosted chat.

## 2026-10-21 — priority queue integration and live release evidence

Integrated current main b989b5a into PR431, retaining both independent progress histories and the eight requested priority rows. Provider397 merged externally as c848c5e and deployment39522378601 succeeded. Hosted runs39522548783 and39522564249 both reported route groq -> workers-ai -> openai, then failed waiting20minutes for runner/delivered findings. These are failed acceptance receipts, not evidence of newly configured providers or a passing chat release. New vendor secret names remain absent; no secrets were read or added. No repeat unchanged smoke was dispatched.

Next: require fresh exact-head CI for the integrated queue PR; investigate the actual saved-task/findings failures with existing owners, obtain provisioned eligible provider keys, and complete fresh medium coder diagnosis through an authorized claim path. Preserve configured workflow review on395 and all native/tenant holds.

## 2026-10-21 — Atlas Node shutdown after #407 (issue #439)

The merged node client checked its stop signal only between operations, so SIGINT/SIGTERM could leave registration, long-polling or an input/output transfer stuck indefinitely. Forward the caller signal through every outbound request, response read and input pipeline; use an abortable retry delay that removes its listener; fence new render/completion starts after shutdown and clean partial workspaces. Existing enrollment, auth, lease and container APIs are unchanged. Already running renders still return under their configured timeout; client shutdown is not an acknowledged server job cancellation, and an earlier accepted request must be inspected through saved job state.

Seven real-loopback shutdown tests failed against unchanged main and now pass, including stalled headers/bodies, observed TCP disconnects, workspace cleanup and no unfinished completion request. Removing only the fetch signal fails the retained stalled-claim guard; restored source passes. Affected node/compute/render/worker checks: 70 total, 68 pass, one optional browser skip, one baseline failure. The existing revoked-node streaming test fails under this host's Node24.14 Undici with "expected non-null body source"; the identical isolated failure reproduces with unchanged main source. Its assertions are preserved. Fresh Node22 Linux/Windows CI remains required; no external node/provider workloads were launched.

Next: complete exact-head CI/review for this ordinary follow-up; investigate the pre-existing Node24 upload/refusal failure separately without weakening revocation assertions. Active-render cancellation and remote kill remain outside this network-shutdown fix.

## 2026-10-21 — consistent eval category quota accounting (#436)

Follow-up to merged #406: per-target rates already exclude provider quota
refusals, but category rates used all runs and understated the same result.
Category JSON now preserves total runs while exposing attempted,
quotaRefusals and passRate; Markdown divides by non-quota attempts and lists
refusals separately. All-quota categories report null / 0/0 (n/a), while real
model/test failures still count. This does not change quota classification,
agent execution, workflow policy, or the existing Claude #410 handoff.

Three report regressions failed unchanged main; focused report/adapter/quota
suite passes 13/13. Full affected package validation remains in progress at
this checkpoint. No live model score or provider acceptance is claimed.
Next: complete affected package and exact-head CI before ordinary merge.

## 2026-10-21 — model authorship on task-dispatch completion (#435)

The normal converse completion returned servedBy, but its early task-dispatch return dropped that receipt even when the model supplied introductory text. Preserve the same bounded actual provider/model metadata on that branch. Tool-only runtime acknowledgements still have no authorship field. Both JSON and streaming branch regressions fail before the change; affected agent-loop/free-vendor suites pass23/23. This is a metadata correction, not a semantic business verification or proof of the sole live streaming root cause. Latest live gate39553786887 returned/stored streaming text without confirmed authorship while non-streaming had a Groq receipt; no repeated live test claimed passing. Broad web/build/lint and exact-head CI remain release checks.

Parallel continuation under the owner's explicit request: prebuilt local coder packaging reuses stale230 staging with an explicit installed marker while keeping developer builds; postmerge407 Atlas Node cancellation has real stalled-network regressions; postmerge406 category reports are being aligned to exclude quota refusals truthfully. Existing397 now owns vendor catalog/trust/routing; conflicting414 needs reconciliation before any independent merge. Preserve active ownership and protected workflow review.

Eval438 validation follow-through: full affected atlas-eval package suite passed39/39 after the focused13/13 checks. Initial exact-head CI39598725107 and eval-fixtures39598725261 passed before this documentation-only integration with chat440. Fresh integrated-head CI remains required.


## 2026-10-21 — verified receipt run-title repair (issue #432)

#372 merged cb71137; successful Cloudflare39522378601 included it after an
initial secret-upload deployment race. D1 migrations0017-0020/0022-0023 succeeded
in39094569327. Hosted inspect39522548783 and coder39522564249 timed out: execution
jobs succeeded but result reporting failed. Actual GitHub job workflow_name is
the task-specific run title, not the static Atlas Coder/Runner label.
Reused native verifier and scoped immutable storage; both run and job title must
match the exact saved task. Real-metadata regression failed before repair; 11
focused tests passed after, and two weakened title guards failed assertions.
Also preserves explicit redirect refusal tests and repairs the Windows source
scan (guard mutation failed as expected). Full build/CI/live revalidation pending.
No new permissions, migration, claim release or coding retry introduced.
## 2026-10-20 — free compute and eval baseline (#390, #398, #399, #400, #406, #407)

- **Merged:** #390, the eval workflow with free targets (GitHub Models through the run's own token, Workers AI through the existing secrets), and #398, the RunPod Serverless provider, both merged by the owner; #399, the render panel on each Build project plus the `docker/render` image on a pinned Debian base (the image has never been built end to end: the session could not reach the Debian mirror).
- **RunPod (#398):** GPU spending stays off until `ATLAS_GPU_MONTHLY_CAP_USD` is set above 0. The cap is checked in the same transaction as the lease insert, and every job carries RunPod's own execution timeout and TTL. Windows failed first because the job journal's SQLite handle was never closed; the fix closes it in the provider and service, and teardown now checks for open handles on Linux too.
- **In review:**
  - #407: Atlas Node, render jobs on the owner's own machines at $0. Main (with #398) is merged in: `createComputeService({ freeProviders })` always runs the nodes first, and adds RunPod after them only when it is configured. A node gets no jobs until the owner approves it, has its own revocable token (only the hash is stored), holds each job on a lease, and every upload is checked against its sha256.
  - #400: Cloudflare Sandbox environments behind `apps/web/sandbox.config.json` (`enabled: false`). They need Workers Paid ($5/month) and a deploy; the routes answer 503 until then. Built on Sandbox SDK 1.0.0. The routes can run code, so the owner decides when it merges.
  - #406: free-quota handling for the eval harness: HTTP 429 runs are classed `quota` and left out of the pass rate, and `--shard k/n` or `day/n` runs one slice of the suite.
- **Eval evidence:**
  - Workers AI run 39247409170: `actions-budget-guard` passed, then the free daily allowance ran out (HTTP 429). Not a baseline score.
  - GitHub Models run 39247683371: HTTP 200 with a 4-byte `text/plain` body, before any tool call. The cause is still open; #406 prints bodies of 16 bytes or less.
- **Merge order:** #407, #400 and #406 are independent of each other.
- **Process:** #399 was merged by Claude without owner review. From here on the owner merges.

Next: after #406 merges, open a protected workflow PR for a daily `--shard day/7` schedule, and re-run one GitHub Models task to read the 4-byte body. Once the owner can build `docker/render` and run one Atlas Node, record a real render through it.
2026-10-21 | (this PR) | chat release gate | The streaming chat gate could never pass: 47811fa made `verify-hosted` require model authorship, but the streamed `done` event (filtered by `customer-events.mjs`, #310) dropped `servedBy`, which the non-streaming reply already carries. The projection now keeps `servedBy` as an allowlisted provider kind and a validated model name, and `finalization` as its status only; endpoints, reasons and other backend fields stay filtered. | Live verify-hosted 39598191966 after #397: non-streaming answered by groq openai/gpt-oss-20b, streaming 257 chars but "model authorship not confirmed"; route still groq → workers-ai → openai (new vendor keys not provisioned). customer-events test; web 672/0. | Owner: provision free vendor keys. | Re-run verify-hosted chat after deploy.

## 2026-10-22 — recent implementation reconciliation

Reconciled remote main cb979bd against the older primary checkout without changing its concurrent uncommitted work. See RECONCILIATION-2026-10-22.md for integrated milestones and remaining P0–P3 gates. Cloud mission intake now rejects stalled uploads after 15 seconds and does not wait indefinitely for oversized-body cancellation. Both real-stream regressions fail against baseline; 31 focused mission/request/customer-event tests pass. No deployment or migration claimed. Recent coder run 39874868449 failed execution and result delivery; private trace diagnosis remains required before a loop repair.

Next: finish affected checks and review this intake repair; continue P0 inference/live coding diagnosis using the existing owners and trace fingerprints. Cline-specific attribution awaits a branch or PR identifier.

## 2026-10-22 — coder evidence survives interrupted execution

A failed hosted coder left no audit artifact because the CLI flushed only after session completion. The existing redacted JSONL store now receives incremental writes during execution, with serialized coalesced flushes, a confirmed offset and latched write errors. Finalization flushes on success and exceptions without duplicating events. A real CLI blocked on loopback model HTTP leaves a readable partial trace after forced termination; the test fails against baseline CLI wiring. Focused tests pass 14/14; full CLI suite passes 617, skips 8, fails 0 (625 total); TypeScript build passes.

A bounded real Ollama qwen2.5-coder:1.5b fixture run exposed the next usability defect: a textual JSON tool request was returned as completed with zero edits, leaving the requested fix undone. No local coding acceptance claimed. Next: recover or reject textual tool requests within existing turn/token limits, then repeat the disposable local task and retain independent checks. Existing launch and provider work stays with its current PR owners.


## 2026-10-22 — recover textual coder tool requests without false completion

Real Ollama qualification showed qwen2.5-coder:1.5b returning a textual JSON tool request as a final answer, previously completed with no edits. Coder mode now recognizes offered textual tool requests, asks once for structured calls under the existing ledger/turn limits, and blocks repeated requests or a final answer without a subsequent tool attempt. Text never executes. Read-only explanations retain existing behavior; actual calls retain registration, scope and approval checks. Both real CLI regressions fail against the original agent; recovery produces independently checked file changes and verified repository checks in the HTTP fixture. Focused tests pass 35/35; full CLI suite passes 625, skips 8, fails 0 (633 total); TypeScript build passes.

The real small-model repeat now blocks honestly after two responses; the independent arithmetic check still fails. The installed Qwen3 1.7B variant exceeded its existing 60-second request deadline with no tool call. No model or hardware qualification, production deployment, or P0 acceptance claimed. This slice stacks on the live-audit PR451. Mission PR450 CI passed; existing rollout and owner merge gates remain.

Next: review/integrate the audit and textual-tool repairs, qualify a tool-capable model on the intended host, and repeat the unmet coding objective with independent checks; continue existing launch PR441 and provider ownership rather than duplicating them.

Receipt repair #447 validation: production build/typecheck/lint passed. Local
Windows web suite:686 total,680 passed,1 unchanged sandbox executable-bit
expectation failed,5 optional browser skips. CI39686447928 web and every job
except Windows local-control passed; that job timed out waiting15s for daemon
startup. No local-control source changed. Preserved concurrent main/mission
progress and requesting fresh CI on the integrated head. Live acceptance pending.

2026-10-22 | [PR #453](https://github.com/cornerstonemarketingus/atlas/pull/453) | Live rescue | Run 39874868449 reached the 900-second coder deadline after 24 model requests and 23 tools (6 failed); no audit artifact survived. Its job workflow_name confirms the task-title mismatch fixed by #447, now merged and deployed in 39898073372. #451 integration preserves both handoff entries and passes the CLI build plus four audit tests; queued for CI-gated merge. #452 Windows daemon startup timeout rerun requested. Reporting now logs only locally constructed HTTP/transport failure details and keeps arbitrary exceptions private, without retrying task execution. | Runner/local tests: 98 passed, 1 platform skip; actual reporter-process regression fails when the old generic catch is restored. | Coder completion is not confirmed; audit and textual-tool fixes still require integration and renewed live acceptance. No provider limit or execution deadline was increased.

2026-10-23 | [PR #455](https://github.com/cornerstonemarketingus/atlas/pull/455) | Phase 0 | Merged #445, #447, #450, #451, #452 and #453 with required CI. Hosted inspection 39898574903 passed; setup is 8/8. Coder 39899280928 created the requested file, opened #454 and delivered its result. Acceptance 39899264987 failed on regressed validation: 8 test failures, two repair passes, actual failures omitted from a changing TAP tail. Truncated failed command evidence now yields inconclusive comparison, preventing unsupported repair or verification; verbose successful commands still pass. | 31 focused tests; full CLI 626 passed/8 skipped; removing the guard fails the session regression and restoring it passes. | Actual sandbox failures remain unidentified; local Docker daemon unavailable. #454 remains unverified. #449 needs document reconciliation/review; older draft/conflicting PRs remain unfinished. | Retain complete bounded failure identities and repeat coding acceptance. No provider-rate-limit or full Phase 0 success claim.

## 2026-10-23 — deployed release qualification and daily-quota recovery

Verified merged release d9f6621 was deployed successfully in 39900284379. Inspected the configured database with dry run39966751152, then applied only the missing additive mission migration0021 in39967073156. Website flow39966438934 passed; desktop/mobile isolated Edge render checks and cleanup passed, but the software-business preview contains construction defaults, so content qualification remains open. Chat39966305821 failed on mixed capacity/credit refusals. Simple chat39966816365 produced a real stored Groq20B non-streaming answer but failed streaming. Independent correlation-helper evaluations39966432808 (20B) and39967305877 (120B) timed out with no files changed and failed tests. No model/coding qualification claimed.

The binding adapter discarded explicit daily-allocation facts into generic429s, causing two-second retries to consume recovery before a free provider's stated reset. Added a fixed daily error code and UTC reset header only for explicit daily wording; ambiguous4006 capacity stays generic and provider text remains private. Both chat modes recover in a three-provider fixture without increasing budgets. Relevant baseline regressions fail;39 focused tests, lint, typecheck and build pass. Full web:718 pass,6 skip,1 unchanged Windows executable-mode failure. See RELEASE-QUALIFICATION-2026-10-23.md. Next: CI-gated release of the scheduling fix, repeat the live chat gate, finish independent coding qualification and preserve existing launch/workspace PR ownership.

## 2026-10-24 — integration audit and skills wired into the daemon

Added `docs/ATLAS-INTEGRATION-AUDIT.md` (code-search based, no live runs). The signed skill registry was only reachable from tests; `platform/skills/daemon.mjs` now opens it under the data directory, mounts active skills' tools in the shared `ToolRegistry` (capability `skill.<name>`, denied until the owner allows it; non-read tools ask), and serves owner-only `/v1/skills*` (trust publisher, ceiling, install request, approve, install, deactivate). Requests are recorded as the `atlas` agent so they cannot self-approve. A real test found the data subdirectory was never created (daemon would not have started). 2 new tests; removing the active-version guard fails one. local-control suite 954 pass / 0 fail / 12 skipped.

Open: hosted Genesis node and hosted-to-Ollama both need owner secrets, a tunnel and a deploy; see audit rows 18–19. Next: chat tool + UI for skill install requests; decide adopt/retire for `ChildAgentRegistry` and `TaskDag`.

## 2026-10-24 — first-class Ollama provider, configured local coder model

Owner verified one local inference (qwen2.5-coder:1.5b, 3,026 in / 50 out, 67.5 s, finish stop, 0 tool calls). That is not coding proof; no real-model file edit has been verified.

Shipped: (1) `packages/atlas-cli` `OllamaModelProvider` on Ollama's native `/api/chat` (`--provider ollama`, keyless, loopback/https only, providerId `ollama` in results). It sends `options.num_ctx`/`num_predict` on every request, trims re-readable tool output to the declared window before sending, refuses an oversized prompt, and refuses a reply whose `prompt_eval_count` reached the window (Ollama silently drops the head of an overlong prompt). The old `--provider groq --base-url` path is unchanged for other servers. (2) `agent/models/local-coder.mjs`: `repository.coder` (and mission lanes, `runTask`) now use request → `ATLAS_LOCAL_CODER_MODEL` → the Models-page plan's coder (with its context) → legacy 7B; the UI's placeholder 7B counts as "unspecified". (3) `scripts/local/run-coder.mjs`, `runner.mjs` and the shared `createCoderBuilder` (self-improve and Genesis) use the ollama provider for loopback servers without a key; run-coder checks `/api/tags` and says `ollama pull <model>` if the model is missing.

Evidence: CLI 644 tests / 639 pass / 0 fail; local-control 968 / 958 / 0 / 10 skipped; runner+local scripts 99/99. Real CLI against a scripted Ollama-protocol server: file edited, `verification: verified`, patch applies with `git apply --check`, operator checkout untouched, requests carry model 1.5b and num_ctx 8192; Genesis' real-coder tests now run over the same native protocol with window 16384. Removing the truncation guard, or using `task.model` in the runner, each fails a test.

Not verified: any real Ollama model completing an edit (a 1.5B model previously returned textual tool JSON; recovery blocks honestly rather than editing). Owner check: `node scripts/local/run-coder.mjs --repository <scratch git repo> --objective "<one-line change>" --model qwen2.5-coder:1.5b --context-window 8192`, then inspect the worktree diff and `~/.atlas/patches`. `scripts/runner/run-task.mjs` (hosted coder) still uses the groq path by design.

Next: run that check on the owner's machine; if the 1.5B model cannot call tools, record it and qualify a tool-capable model (qwen2.5-coder:7b/qwen3) before claiming autonomous local coding.

2026-10-24 | (this branch) | dashboard model | Owner's dashboard still showed qwen2.5-coder:7b and a "Groq request failed" repository.coder run: that daemon was running code from before the Ollama provider (the only code that says "Groq request failed" for a local run). Now `/v1/models` returns the configured coder first plus `default`/`defaultInstalled`, so every model picker opens on the model that will run; and with nothing configured, `repository.coder` uses an installed coder model (preferring names containing "coder") instead of an uninstalled 7B. | local-control 970 / 960 pass / 0 fail / 10 skipped. | Needs the owner to run this branch (or merge it) and restart the daemon. | Owner re-runs a task from the dashboard; confirm the run's first lines read `Provider: ollama`, `Model: qwen2.5-coder:1.5b`.

## 2026-10-24 — hosted coder reliability (run 39903444266)

**What the run was.** Objective "Improve the TODOs in …about/page.tsx, MessageBody.tsx, atlas-knowledge.mjs"; route groq/openai/gpt-oss-120b with fallbacks groq/20b, workers-ai/120b, openai/gpt-5.4-mini (the last is paid, added automatically because `OPENAI_API_KEY` exists); `ATLAS_MAX_TURNS=32`. Step "Run Atlas task" ran 8m43s and ended `blocked: Turn limit reached`. Log counters: 6 failed tools by 5 minutes, then 14 → 25 model requests and 5 → 9 failed tools in the last 60 s, i.e. the model was spinning fast on failing calls until turn 32.

**What I could not see.** The per-call detail lives in the run's artifact `atlas-39903444266-1` (audit.jsonl, code.json). This session's network policy blocks artifact downloads, so the individual failed calls and their error codes are **not** identified here, and no root cause for the nine failures is claimed. The log also shows the task named three files with no actual `TODO` markers in two of them (`MessageBody.tsx` has none; `about/page.tsx` and `atlas-knowledge.mjs` only mention `TODO.md`), so an exploratory loop on an underspecified objective is the likely shape, unconfirmed. Owner: download that artifact and run `atlas replay audit.jsonl`.

**Defects found in code (independent of the unseen calls).**
1. A failed tool call was returned to the model with no memory of earlier failures, so an identical failing call could repeat until the turn budget was gone.
2. The turn limit ended with a bare `blocked: Turn limit reached` and no account of what happened.
3. When the agent stopped (`blocked`/`failed`) after applying edits, `VerifiedCoderSession` skipped validation ("no verification attempted") and `run-task.mjs` kept only code.json; the PR step needs `completed`, so edits existed only in a discarded working tree.
4. Routes other than Groq's default had no request-size bound: the conversation grew without limit across turns.
5. A paid fallback (openai) is added automatically to any coder route when its key exists; an owner-chosen local Ollama route had no way to opt out.

**Changes (limits not raised; `ATLAS_MAX_TURNS` max stays 32).** `tool-failure-tracker.ts`: the same tool+arguments+error code twice gets a specific correction in the tool result; a third time, or five failures in a row, stops the run as `blocked` (REPEATED_TOOL_FAILURE / NO_PROGRESS in the audit). With ≥4 turns the last turn is reserved for a tool-free status report (labelled "the model's own unverified status report"), with a warning three turns out; smaller budgets are unchanged. Edits made before a `blocked`/`failed` stop are validated against the baseline and reported as `Partial work:` (`unverified`, `regressed` or `inconclusive`, never `verified`), and `run-task.mjs` saves them as a redacted `partial.patch` plus `status.partial`; no PR is opened for unfinished work. Every route's request is now bounded by its real context window (`contextRequestByteLimit`). `ATLAS_CODER_PROVIDER=ollama` is supported in `coder-routes.mjs`: keyless, needs `ATLAS_CODER_MODEL`, never automatic or inferred, and gets only fallbacks the owner wrote in `ATLAS_CODER_FALLBACKS`. Coder routing reads no chat variable (tested).

**Evidence.** CLI 655 tests / 650 pass / 0 fail; runner+local scripts 102/102; local-control 970/960/0. A real `run-task.mjs` against a scripted Ollama: one edit lands, three identical failing calls follow, the run stops after 4 requests as `blocked`, `partial.patch` holds the edit, no fallback receives traffic. Disabling the identical-failure stop fails 2 tests.

**Overlap.** Open PR #457 (codex) also edits `provider-read-only-tool-agent.ts`, `groq-model-provider.ts` and `cli.ts`; expect a small textual conflict in the agent's catch block and `cli.ts` imports, no semantic overlap. Not live-verified: no hosted run with these changes; to use Ollama on the runner set `ATLAS_CODER_PROVIDER=ollama` plus the existing `ATLAS_SELF_HOSTED_MODEL`/`ATLAS_OLLAMA_VERSION` variables (workflow unchanged).

2026-10-24 | (inspect objective PR) | hosted inspect | Run 40057180073 (task 342920b0-…) was asked "List all TODO comments" and returned a repository inventory under a green "completed". Cause, traced in code: chat chose mode `inspect`; `run-task.mjs` inspect mode runs `atlas inspect` + `atlas tree` and never reads `ATLAS_OBJECTIVE`; `report-result.mjs` renders only the inventory. Nothing separated "the job ran" from "the question was answered". Fix: `inspect-findings.mjs` answers marker requests (TODO/FIXME/HACK/XXX, comments only, vendored/lock/dist excluded) with path:line, text and an exact count (findings.json, redacted, reply leads with it); any other objective now says the run produced an inventory only and that a specific request was not answered; `status.answered` records which. | 106/106 runner+local script tests; 3 new tests fail on main and pass here, including the real runner end to end. | Not live-verified. Real answer for this repo today: 6 comment markers in 3 files, only one genuine (apps/local-control/src/platform/voice/voice-commands.mjs:29, on a module nothing imports); the other five are test fixtures. `packages/atlas-eval/src/dogfood.mjs` has TODO placeholders inside string literals, deliberately not counted as comments. Chat still routes content questions to `inspect`; a chat-side read/search answer, or a model-backed inspect, is the next step. | The provider question (local Ollama vs hosted) is separate: inspect mode uses no model at all.

2026-10-24 | integration of #462 + #463 | verify-local-edit | Fresh branch `claude/integration-462-463` = #462 (Ollama provider, configured local coder model, coder failure loops, partial patches) + #463 (inspect returns real TODO findings); only docs/PROGRESS.md conflicted. Added `scripts/local/verify-local-edit.mjs`: builds a scratch repo with a one-line bug, runs the same isolated local coder as the dashboard's repository.coder, then judges the result itself (file really changed, check passes when run independently, patch applies to a clean checkout, original checkout untouched). Its own tests pass a model that fixes the bug and fail one that only describes it or edits wrongly. | CLI 650 pass/0 fail; runner+local scripts 109/109; local-control 960 pass/0 fail; chat prompt 12/12; workflow check ok. Genesis set run here with browser tests failing only because Playwright is not installed in this container (CI installs it). | NOT verified: a real Ollama model editing a file on the owner's machine. Run `node scripts/local/verify-local-edit.mjs --model qwen2.5-coder:1.5b` (add `--keep` to keep the scratch directory). PASS requires a real change; the 1.5B model may fail, and that is the answer. | After that: Windows run, then merge to main (owner).

2026-10-23 | [#464](https://github.com/cornerstonemarketingus/atlas/pull/464) | Local inference | Added explicit credential-free loopback coder provider; local launcher selects it; cloud fallback/governor excluded; local timeout reports inference failure instead of invented quota reset | Full CLI suite and real HTTP edit/verification fixture; live Ollama 7B smoke attempted | Live 7B did not complete its first turn within the request window; running installation not updated | Review PR, diagnose local inference latency before claiming autonomous coding readiness.


2026-10-24 | integration with #464 | providers | main gained `--provider local` (#464: credential-free, loopback-only OpenAI-compatible, no cloud fallback/escalation). Kept both on the integration branch: `local` for any loopback OpenAI-compatible server, `ollama` for Ollama's native API with a per-request context window, token-free, no automatic fallbacks. `run-coder.mjs` takes `--provider ollama|local|groq` (default ollama). Both skip the shared governor. | CLI 656 pass/0 fail; runner+local scripts 109/109; local-control 962 pass/0 fail; Genesis subset 8 pass, 1 fail (browser screenshot test; no Playwright in this container).
