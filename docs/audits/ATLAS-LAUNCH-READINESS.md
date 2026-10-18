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
2. **Inference control plane not shared (P0).** The Durable Object quota ledger (#129-#133, #158, #160) is **not in main**: `apps/web` has no ledger or DO binding, CLI ledgers are in-memory per process, so chat and runner-side coder inference do not share capacity and cooldowns do not survive restart. PRs #129-#207 are ~330 commits behind main (squash-merged lineage); they need re-creation on current main, not a merge. PR #332 (merged) coordinates output-budget admission across CLI ledgers only.
3. **No live-model validation.** No Groq/OpenAI/Workers AI key or local model was available. Live chat/coder quality, cost, token use and rate-limit frequency are **unverified** by this run. Last hosted chat gate on record: PROGRESS 2026-10-17 (run 39006489138).
4. **Hosted durability stack unmerged:** #270 -> #274 -> #276 -> #278 -> #282 -> #291 (persist-before-dispatch, dedupe, claims, result ownership, mission recovery). #276, #278, #291 conflict with main (1 each); #270, #274, #282 merge cleanly. Reconcile in that order.

## Open PR triage (dependency order)

| Action | PRs |
|---|---|
| Owner review then merge now (clean, green) | #235 (security, protected) |
| Rebase (small conflicts) then merge | #329 (1), #276 (1), #278 (1), #291 (1), #284 (3), #236 (1) |
| Merge cleanly, in order | #270 -> #274 -> #282; #342, #344, #347 (small, 1 behind) |
| Protected workflow, owner review | #320 (native build CI; 1 conflict) |
| Rebuild on current main, then close old | #129-#133, #158, #160, #130 ledger stack; #178, #181, #191, #200, #202, #207 |
| Stale or superseded, confirm then close | #308 (smoke doc only), #105/#101/#98/#97/#77/#69 (Copilot drafts, ~260 ahead / 50 behind), #223, #230, #233, #237, #240, #243, #252, #253, #266 |

Conflict counts are from `git merge-tree` against `857577a`; I did not inspect every
diff line-by-line, and "stale" labels are a recommendation, not a verified
supersession.

## Not covered

Parts 9-14 (multi-agent evaluation, local-model qualification, replay evals,
business launch, Windows signing, enterprise items) were not audited beyond what
the existing suites show. The quantum-research item: no implementation, branch or
document was found by filename search; treat it as nonexistent until shown.

## Next (acceptance criteria)

1. Owner merges #235; re-run `approval-boundary` + `credential-boundary` on main: 27/27.
2. Re-create the quota ledger on main (one PR: DO + binding in `deploy-cloudflare.yml`, chat reservations, CLI governor client); acceptance: concurrent chat + coder jobs on one quota never exceed it, cooldown survives Worker restart.
3. Provide one funded provider key (or Ollama + a qualified model) in an isolated env; run samples B, C, F and a live Genesis run; record time, tokens, cost.
4. Reconcile the hosted durability stack in order; add crash tests (before/after tool, before/after receipt) at the hosted boundary.
5. Smallest safe launch scope: hosted chat + Genesis static-site/local builds with owner approvals, after 1-2 are closed.
