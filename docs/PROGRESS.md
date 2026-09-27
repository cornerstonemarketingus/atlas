# Atlas program progress (handoff log)

Handoff log for [`PROGRAM.md`](PROGRAM.md). Append one row per PR, newest
last. A new session resumes from the last row's "Next".

Format: date | PR | phase/item | what shipped | evidence | open issues | next

## Current position

- **Phase:** 0 (live rescue). Exit gate not yet passed.
- **Blocked on owner:**
  1. Merge PR 0 (CODEOWNERS) and add the branch ruleset (below).
  2. Merge #119, run "Deploy Atlas web to Cloudflare Workers", then run
     "Verify hosted Atlas" in `chat` mode with the conversation that failed
     in production (streaming and non-streaming must both pass).
  3. Phase 0.1: give `ATLAS_GITHUB_TOKEN` (or the GitHub App) Actions,
     Contents and Pull requests read and write on the repository, then
     redeploy web.
- **Ruleset the owner adds (GitHub → Settings → Rules → Rulesets, target
  `main`):** require a pull request; require review from Code Owners;
  require the CI status checks; block force pushes and deletions. Agents
  never edit this.

## Log

| Date | PR | Phase/item | What shipped | Evidence | Open issues | Next |
|---|---|---|---|---|---|---|
| 2026-09-27 | [#118](https://github.com/cornerstonemarketingus/atlas/pull/118) | pre-program (coder rate limits) | CLI coder: Groq TPM pacing from headers, exact retry waits (Go durations), fail fast past the cap to the next fallback route; chat parses the same waits | atlas-cli 439/439; CI green | Open, mergeable | — |
| 2026-09-27 | [#119](https://github.com/cornerstonemarketingus/atlas/pull/119) | 0.2, 0.3, 0.4, 0.5 | Empty HTTP 200 classified; final synthesis (tool-free, adaptive output room, reasoning_effort low only when writing up finished work, fallback model after two empties, saved-work reply with `finalization` when nothing answers); Groq tool_use_failed corrected once without dropping tools; fallback/web-search/allowed-repos uploaded to the Worker with a runtime-vs-deploy drift test; chat release gate in "Verify hosted Atlas" | web 253/253; CI green on 10c4ef9; gate checked against a local stand-in (pass and fail) | Protected paths (workflows): owner review. Exit gate needs deploy + live run | Owner: merge, deploy, run gate |
| 2026-09-27 | [#120](https://github.com/cornerstonemarketingus/atlas/pull/120) (draft) | 1.1 (early) | packages/atlas-inference: error taxonomy, rate-limit header parsing, per-target capacity state | 21 package tests; CI green | Capacity state is isolate memory; rework into a Durable Object keyed by quota scope, add CAPACITY_EXCEEDED and eligibility preflight | After Phase 0 gate |
| 2026-09-27 | [#121](https://github.com/cornerstonemarketingus/atlas/pull/121) (draft) | 1.2 (early) | In-memory inference governor and queue; logical parallelism (all ready team steps) separated from inference concurrency | 33 package tests, web 253/253; CI green | Must move into the Durable Object with reservations, idempotency, resumable chat stream | After #120 rework |
| 2026-09-27 | this PR | program setup | docs/PROGRAM.md, CLAUDE.md, this log, docs/TODO-MAP.md (299 unchecked TODO items mapped to program phases: 273 tasks, 13 rules, 6 decisions, 4 owner, 3 another agent's) | docs only | — | PR 0 (CODEOWNERS), then 0.1 credential handling |
