# Atlas program progress (handoff log)

Handoff log for [`PROGRAM.md`](PROGRAM.md). Append one row per PR, newest
last. A new session resumes from the last row's "Next".

Format: date | PR | phase/item | what shipped | evidence | open issues | next

## Current position

- **Phase:** 0 (live rescue). All Phase 0 code is in review; the exit gate
  needs the owner (deploy and a live session), so Phase 1 has not started.
- **Blocked on owner, in order:**
  1. Merge [#123](https://github.com/cornerstonemarketingus/atlas/pull/123)
     (PR 0, CODEOWNERS), then add the branch ruleset below and turn on
     "Allow auto-merge" (Settings → General → Pull Requests).
  2. Merge [#119](https://github.com/cornerstonemarketingus/atlas/pull/119)
     and [#124](https://github.com/cornerstonemarketingus/atlas/pull/124)
     (+ [#125](https://github.com/cornerstonemarketingus/atlas/pull/125),
     protected), then run "Deploy Atlas web to Cloudflare Workers".
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
| 2026-09-27 | [#124](https://github.com/cornerstonemarketingus/atlas/pull/124) | 0.1 | Setup probe checks Actions: write (dispatch to a branch that cannot exist: 403 = missing, 422 "No ref found" = granted, nothing runs); credential kind from prefix; exact missing permission with per-kind grant steps; rate-limit 403 told apart; dispatch failures use the same explanation and are never recorded as started | web 232/232; 9 new tests; guard mutation-checked (5 fail without it) | Auto-resume needs durable execution (1.2) | Merge when green |
| 2026-09-27 | [#125](https://github.com/cornerstonemarketingus/atlas/pull/125) (stacked on #124) | 0.1 | GitHub App token refusals named: key rejected, installation not found, Actions permission not granted | web 234/234 | Protected (github-app.mjs): owner review | Owner review |
