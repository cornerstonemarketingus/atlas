# Atlas launch-readiness run — 2026-10-18

Commit under test: main `857577a` (CI run 39084340344 green). Branch with fixes:
`claude/genesis-named-business-site`. Environment: Linux container, Node 22.22,
Chromium via Playwright, **no model-provider credentials and no Ollama**.
Nothing here touched production, secrets, or paid services.

## Verdict

**Not launch-ready.** The runtime around the model is solid and well tested; two
launch blockers are open, and no live-model mission could be run from this
environment. Do not label the product launch-ready until the items under
"Blockers" are closed.

## Evidence: baseline on unmodified main

| Suite | Command | Result |
|---|---|---|
| contracts | `npm test` | 6/6 |
| atlas-inference | `npm test` | 63/63 |
| atlas-cli | `npm ci --ignore-scripts && npm run build && npm test` | 540/540 |
| browser-worker | `npm ci --ignore-scripts && npm test` | 20/20 |
| runner scripts | `node --test scripts/runner/*.test.mjs scripts/local/*.test.mjs` | 81/81 |
| workflows | `python3 .github/atlas/check-workflows.py` | exit 0 |
| apps/web | `npm ci`; lint; typecheck; `npm test` | lint+typecheck clean; 498 pass / 3 skipped / 0 fail |
| local-control | `npm test` | 757 pass / 2 skipped / 0 fail (759 total) |
| daemon e2e | `npm run e2e` | all 21 steps PASS (approve/deny, one-use approval, pause/resume/cancel, SIGKILL mid-step then recovery, audit log). Model is scripted, so this proves the runtime, not model quality. |

Not run here: windows-companion, mobile (need Windows / native toolchains), live
hosted verification.

## Sample runs

| Run | Result |
|---|---|
| **A. Team Hahn website** (real Genesis pipeline, real Chromium inspection, template path, no model) | **Found and fixed 4 defects**, see below. After the fix: 6 pages built, checks + 2 generated tests + build pass, 12 screenshots (6 pages x 375/1280px) inspected, enquiry flow verified by the inspector. Screenshots viewed by hand: no overflow, readable, nav wraps correctly on phone. |
| B. Existing-codebase repair | **Not run.** Needs a live model; a scripted model would only replay my own answer. |
| C. Multi-agent lead app | **Not run.** Same blocker. No single- vs multi-agent comparison exists; do not claim one. |
| D. Rate-limit recovery | **Partially.** `packages/atlas-inference` (63 tests) and CLI/web suites cover 429/402/413/empty/timeout/malformed-tool/cancel with fixtures. Not covered on main: restart during cooldown and cross-process shared capacity, because the shared ledger is unmerged (see blockers). No new fixture proxy was built. |
| E. Interruption recovery | **Covered by the e2e journey** (SIGKILL daemon mid-step, restart, mission visible as interrupted, resume completes, approvals respected, no duplicate execution). Hosted-side recovery (PRs #270-#291) is unmerged and unverified. |
| F. Browser control | **Not run.** browser-worker unit suite passes (20/20); no end-to-end user-takeover run. |

### Sample A defects (all in Genesis, fixed on the branch, regression tests fail before / pass after)

1. **Named business ignored.** Project was named "Website". Now parsed from "for <Name>, a <kind> business".
2. **Requested pages dropped.** "Framing" and "Windows and doors" were omitted (site had 4 generic pages) yet Genesis reported `ready`. The owner's page list now wins and keeps its order.
3. **Invented claims.** Template copy said "insured", "we stand behind our work", "reply within one working day", and described kitchens/renovations for a framing company. The brief forbids invented credentials. Copy now derives from the stated services; missing facts are visible `[Add ... before you publish.]` placeholders.
4. **No local SEO.** Added LocalBusiness JSON-LD from facts in the prompt only (no address, phone or rating invented), Open Graph tags, city in titles/descriptions, absolute canonical/sitemap/robots when `site.json` `url` is set (the build warns when it is not).

Limits that remain: the template is deterministic, so copy is plain; relative
canonical/sitemap URLs until a domain is set (invalid for search engines until
then); no Search Console / AI-discovery measurement; visual quality was judged by
eye, not benchmarked. This does not demonstrate live-model quality.

## Blockers (launch)

1. **Security: approval/credential boundary is open on main (P0).** The 27 adversarial tests from PR #235, run against main, give **26 failures**: approvals do not expire at the deadline, can cross principal/agent, adapters bypass credential resolution, outputs/evidence can carry credentials, and a lost acknowledgement can replay a consequential action after restart. PR #235 fixes all of them, is conflict-free, and all 14 CI checks are green (including Windows and real-coder Genesis). It is a protected path: **owner review required; I did not and will not bypass it.** Merge it first; PR #233 (credential broker) conflicts with main in 5 files and needs rebasing afterward.
2. **Inference governor: partly verified (P0).** *Correction to an earlier draft of this report, which said the ledger was not in main.* It is: `InferenceGovernorObject` (`apps/web/worker/inference-governor.mjs`) is exported by the Worker and bound as `INFERENCE_GOVERNOR` with migration `v1-inference-governor` in `apps/web/vite.config.ts`, and hosted chat reserves through it (`governChain`). Not verified: whether production is actually bound (the client silently sends ungoverned when unbound; check the setup readiness / "Verify hosted Atlas" run), and whether runner-side CLI inference shares that ledger (PR #332 coordinates CLI ledgers with each other; I did not confirm a link to the Worker DO). Capacity cannot be created: Workers AI's free allowance is 10,000 Neurons/day for the whole account, so a free hosted tier needs the per-user cap below.
3. **No live-model validation.** No Groq/OpenAI/Workers AI key or local model was available. Live chat/coder quality, cost, token use and rate-limit frequency are **unverified** by this run. Last hosted chat gate on record: PROGRESS 2026-10-17 (run 39006489138).
4. **Hosted durability stack unmerged:** #270 -> #274 -> #276 -> #278 -> #282 -> #291 (persist-before-dispatch, dedupe, claims, result ownership, mission recovery). #276, #278, #291 conflict with main (1 each); #270, #274, #282 merge cleanly. Reconcile in that order.

## Open PR triage (dependency order)

| Action | PRs |
|---|---|
| Owner review then merge now (clean, green) | #235 (security, protected) |
| Rebase (small conflicts) then merge | #329 (1), #276 (1), #278 (1), #291 (1), #284 (3), #236 (1) |
| Merge cleanly, in order | #270 -> #274 -> #282; #342, #344, #347 (small, 1 behind) |
| Protected workflow, owner review | #320 (native build CI; 1 conflict) |
| Likely superseded by squash-merged work (the ledger and chat governor are in main); confirm then close | #129-#133, #158, #160; review #178, #181, #191, #200, #202, #207 individually |
| Stale or superseded, confirm then close | #308 (smoke doc only), #105/#101/#98/#97/#77/#69 (Copilot drafts, ~260 ahead / 50 behind), #223, #230, #233, #237, #240, #243, #252, #253, #266 |

Conflict counts are from `git merge-tree` against `857577a`; I did not inspect every
diff line-by-line, and "stale" labels are a recommendation, not a verified
supersession.

## Not covered

Parts 9-14 (multi-agent evaluation, local-model qualification, replay evals,
business launch, Windows signing, enterprise items) were not audited beyond what
the existing suites show.

## Next (acceptance criteria)

1. Owner merges #235; re-run `approval-boundary` + `credential-boundary` on main: 27/27.
2. Confirm the governor is bound in production; connect runner-side CLI inference to the same ledger if it is not; acceptance: concurrent chat + coder jobs on one quota never exceed it, cooldown survives Worker restart.
3. Provide one funded provider key (or Ollama + a qualified model) in an isolated env; run samples B, C, F and a live Genesis run; record time, tokens, cost.
4. Reconcile the hosted durability stack in order; add crash tests (before/after tool, before/after receipt) at the hosted boundary.
5. Smallest safe launch scope: hosted chat + Genesis static-site/local builds with owner approvals, after 1-2 are closed.

## Update: free-tier daily chat cap (branch `claude/free-tier-chat-cap`)

Hosted chat now has a per-account daily message cap, before any subscription is required: free 20, pro 400, team 1500 per UTC day (`TIER_LIMITS.dailyChatMessages`; **starting values, not measured**: tune from real Neuron use). Owners and operator tokens are exempt. A denied message returns HTTP 429 with `retry-after`, `code: CHAT_CAP_REACHED`, the reset time and `/pricing`; the existing chat client already shows the message. Counting is one atomic upsert in `task_usage` under a `chat:YYYY-MM-DD` key (no migration, and account deletion already clears the rows). If usage cannot be read the message is allowed and a metadata-only warning is logged. Tests: 30-way concurrency stays at exactly 20, per-user isolation, UTC-day reset, paid-tier limit; full web suite 501 pass / 3 skipped. Not tested: the chat route itself (no route-level harness exists), and failed model calls still consume a message. Not done: a cap-reached screen with local-model / bring-your-own-key options.
