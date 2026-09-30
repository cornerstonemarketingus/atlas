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

## 2026-09-30 — reconciliation of main d957cfb and Stage 4 first slice

Runtime/code and current CI take precedence over historical TODO counts. Main CI
run 36660910214 passed at d957cfb. B1 is complete at the documented scope: team,
coder and chat entry points use the kernel, typed World State and traces;
in-run dynamic branching and stronger comparative judging remain future work.
Command Center lanes/controls/version selection, durable automation triggers,
Genesis build/check/preview/inspection/publishing, and local backend primitives
are present in runtime and boundary tests. OpenAI selection/fallback merged in
#174; explicit per-provider hosted smoke verification remains in #178.

### Open PR reconciliation (recommendations, not automatic merge/closure)

| PR | Disposition | Retained value / required action |
|---|---|---|
| #178 | MERGE after protected owner review | Provider smoke gate; green CI at audit; workflow ownership applies. |
| #172 | REBASE/REPAIR | Salvage durable queue/lease/idempotence behavior; remove #175/#174 overlap. |
| #160 | REBASE/REPAIR | Model pool must preserve new OpenAI selection, provider fallback and endpoint validation. |
| #159 | REBASE/REPAIR | Useful invalid-tool-input recovery; conflicts with current CLI/policy. |
| #158 | REBASE/REPAIR | Governor wiring must retain current chat/finalization contracts and deploy bindings. |
| #157 | REBASE/REPAIR | Unknown Actions-budget protection is useful; main still fails open; protected workflow review. |
| #156 | SUPERSEDED as standalone direction | Fold retry coverage into the reconciled inference stack before closing. |
| #133 | KEEP ACTIVE | Prompt fingerprints; integration evidence still needed. |
| #132 | KEEP ACTIVE | Target registry; not the canonical production router yet. |
| #131 | KEEP ACTIVE | Circuit breakers depend on the quota ledger. |
| #130 | REBASE/REPAIR | Durable ledger/governor needs current deployment integration. |
| #129 | REBASE/REPAIR | Base of the inference stack; refresh CI/base and prove consumers. |
| #105 | REBASE/REPAIR | Browser snapshot/download draft has a method inserted inside another method; do not merge as-is. |
| #101 | REBASE/REPAIR | Preserve hosted repository creation; reconcile newer Genesis and entry paths. |
| #98 | REBASE/REPAIR | Hosted CI/PR tools absent from main instant-tool list; scope/log-redaction tests needed. |
| #97 | REBASE/REPAIR | Hosted memory is distinct from local memory; resolve migration numbering/isolation. |
| #77 | REBASE/REPAIR | Report-only CSP is not strict enforcement; prove renderer compatibility. |
| #69 | REBASE/REPAIR | Hosted rate limiting useful; refresh migrations, identity and failure policy. |
| #61 | KEEP ACTIVE, deferred | Retain mobile companion work without delaying the next product milestone. |

No open PR was automatically merged or closed. Stack order is
#129 → #130 → #131 → #132 → #133 → #158 → #160, with a reconciliation against
current main required before production rollout. Labels alone do not establish
current ownership; examine branch commits and claim comments before takeover.

### Actual blockers and documentation differences

Inference stack integration and protected review remain release work. Main CI
being green does not prove clean-machine onboarding, persistent cloud execution,
or production routing through every inference component. Historical local test
counts are not a fresh run. The September 25 CURRENT-STATE and branch-era BACKLOG
are historical snapshots. README incorrectly called model integration, browser,
editing/repair and multi-agent workflows absent; its capability summary is
corrected here after recording the stale documentation-only takeover on #101.
ROADMAP Stage 1 wording lagged the runtime; Stage 4 remains the next major stage.
TODO-MAP counts are explicitly dated; unchecked tasks are not capability evidence.

### Recommended dependency order

1. Review/ship explicit provider smoke release gate (#178).
2. Reconcile the inference stack with current OpenAI and finalization behavior.
3. Prove capacity exhaustion, provider recovery and saved-work resume boundaries.
4. Keep capability documentation aligned with runtime evidence.
5. Static-site selection → source → deterministic edit → verified rebuilt preview (this slice).
6. Scoped natural-language visual requests through the existing coder.
7. Web-app/component source mapping and existing-project template migration.
8. Deterministic color/spacing/font editing.
9. Parallel visual alternatives using existing mission lanes and patch approval.
10. Browser QA through publish/deploy acceptance journey.
11. One coherent goal-entry experience with advanced controls retained.
12. Clean-machine onboarding and first-run diagnostics.
13. Persistent isolated execution and resumable checkpoints.
14. Automations executing in that persistent environment.
15. Live observation, human takeover, re-observation and safe resume.
16. Approved, verified skill installation/capability loop.
17. Independent review and cost-per-verified-outcome evidence.
18. Usage/billing/support diagnostics for external customers.

Safe parallel tracks: inference reconciliation, visual editor, onboarding
verification and documentation audit, with non-overlapping file ownership.
Keep inference stack layers sequential; selection precedes scoped visual changes
and alternatives; sandbox persistence precedes migration/always-on automation;
observation precedes takeover/resume. Avoid speculative councils/economics work.

### Stage 4 vertical slice — issue #74, codex/visual-genesis

Claimed #74 after checking no label/comments or competing visual PR. The local
Build screen now opens a separate loopback design view for new static sites.
Renderer metadata identifies home hero headline/intro fields in site.json by
JSON pointer (no DOM-text guessing). Edit → Apply and verify changes only the
selected field and retains unrelated manual configuration. It reuses Genesis
planning approval, durable transitions, executor, generated checks/tests/build,
preview manager and browser inspector. No model call is made for this edit.
Digest/version checks reject stale input, including changes while awaiting plan
approval. Unsupported templates/older renderer metadata are explicitly reported.

Boundary files: platform/genesis/{visual,preview,routes,service,executor}.mjs,
static-site renderer/generated test, local server CSP and Build UI.
Tests: genesis-visual.test.mjs exercises authenticated HTTP and actual Chromium
UI selection → source mapping → code/config change → rebuild → browser inspection.
The existing Genesis CI glob includes this test with GENESIS_REQUIRE_FULL=1.

Security: design view has no bearer token, no APIs/proxy target, contained bounded
artifact reads, exact Host checking, nonce-only picker script and no forms or
connections. Parent accepts messages only from the current iframe/origin/session.
Local dashboard CSP permits loopback preview frames; this security-boundary change
needs owner review under PROGRAM §3, so no auto-merge is requested.

Limits: first slice edits home headline/intro text in newly generated static sites.
General components, natural-language changes, restyling, move/delete/duplicate and
parallel alternatives remain incomplete. Design view intentionally disables app
scripts/forms; use the normal preview for interaction. HTTP-only verification is
reported when Chromium is unavailable. This does not complete all of Stage 4.

Validation for this slice: initial Genesis baseline 26/26; affected Genesis suite
with GENESIS_REQUIRE_FULL=1, CLI dependencies and Chromium: 41/41 passing, no skips.
Both new HTTP/browser boundary tests pass. The generated publishing suite passes
8/8 after updating its exact heading assertion for renderer metadata. Removing
the digest/version rejection makes the HTTP test fail (409 expected, 200 actual);
restoring it passes. UI script syntax and git diff whitespace checks pass.

The broad local Windows run recorded 620 passes, 3 failures, 19 skips before
installing CLI dependencies and repairing the heading assertion. Two failures
(symlink privilege and terminal timeout exit-code expectation) reproduced from
an unchanged archive of origin/main; the third was this slice's publishing
assertion and is fixed. No security assertion was weakened. CI remains the
cross-platform release gate; owner review is required before merge.
