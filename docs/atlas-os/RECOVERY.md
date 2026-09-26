# Atlas — recovery log

No blocking regression reproduced on `main` @ `1cabfe6` (2026-09-25): every
suite passes, CI and deploy are green, hosted verification last passed
2026-09-23. The entries below are the failures that *did* reproduce or were
found during the audit.

## 1. Vague coder objective ends as "Turn limit reached"

| | |
|---|---|
| **Symptom** | Atlas Coder run 36088414372 failed with `Atlas coder run stopped with status 'blocked': Turn limit reached.` The user saw a failed task and no explanation. |
| **Root cause** | The objective was conversational ("hi can u debug yourself? formy atlas repo can u make direct changes"). Nothing converts an under-specified request into a concrete, evidence-backed change before a coder run is dispatched, so the model explored until its turn budget ran out. The runner behaved correctly (bounded, no change made). |
| **Fix** | Two layers. (1) Chat no longer dispatches on keywords: `apps/web/app/chat/intent.mjs` answers questions and only *offers* a task the person confirms — this exact message is now answered in chat. (2) `POST /api/tasks` refuses a coding objective with nothing concrete to change (`assessCoderObjective` in `dispatch.mjs`): 422 with `needsClarification` and an example of a good objective. Read-only modes stay open-ended. |
| **Verification** | `tests/chat-intent.test.mjs` (the message classifies as chat); `tests/dispatch.test.mjs` (the objective is refused for coder mode; concrete objectives, including the hosted smoke check's, still pass); headless-Chromium run of the chat box against a local worker. |
| **Remaining risk** | The objective check is a heuristic: a concrete-sounding but still vague objective can pass, and the runner's turn limit remains the backstop. |

## 1b. Task creation returns HTTP 502 in production (OPEN — owner action)

| | |
|---|---|
| **Symptom** | `verify-hosted.yml` (inspect mode) run 36203794563 on 2026-09-26: setup reported "ready (8/8)", then `POST /api/tasks` answered **HTTP 502**. No runner started. Chat (run 36201960356) still works. |
| **Evidence** | The deploy log shows the GitHub App secrets are not configured, so dispatch uses `ATLAS_GITHUB_TOKEN`. The route returns 502 only when GitHub refuses the dispatch (non-2xx) or cannot be reached. The request shape and workflow inputs match `main` (`task_id`, `repository`, `branch`, `mode`, `objective`, `merge_policy` for coder, `correlation_id`), and the last successful web dispatches were on 2026-09-25 before 03:25 UTC. |
| **Most likely cause** | The `ATLAS_GITHUB_TOKEN` credential has expired, been revoked, or lost Actions write access — an **external configuration** problem, not a code defect. It cannot be confirmed from this session: the secret is not readable here and the deployed code returned only a generic message. |
| **Fix in code** | Task creation now says which of the four causes it is (401 expired/revoked, 403 permission, 404 not visible, 422 input mismatch) with the minimum fix; `/api/setup/status` performs a live, read-only check of the credential against the workflow instead of reporting "ready" when a secret merely exists; the smoke check prints that diagnosis. |
| **Owner action** | Rotate `ATLAS_GITHUB_TOKEN` (fine-grained token with *Actions: read and write* and *Contents: read* on the allowed repositories), or configure the GitHub App (`ATLAS_GITHUB_APP_ID`, `ATLAS_GITHUB_INSTALLATION_ID`, `ATLAS_GITHUB_APP_PRIVATE_KEY`, `ATLAS_GITHUB_APP_SLUG`); redeploy; run *Verify hosted Atlas* in `inspect` mode. |

## 2. Hosted approval could authorize two actions (SEC-5)

| | |
|---|---|
| **Symptom** | Two concurrent companion requests for one approved action could both receive `consumed`. |
| **Root cause** | `companion/approval/[id]/route.ts` read the approval, then issued an unconditional-on-result update and returned success without checking that a row changed. |
| **Fix** | The update is now conditional on `status='approved' AND consumed_at IS NULL AND expires_at > now` and uses `.returning()`; zero rows → `409 already-consumed`. The decision route also refuses to approve an expired approval. |
| **Verification** | `apps/web` lint + 131 tests + build pass. No D1 concurrency harness exists in the repo, so the race itself is closed by construction (single conditional statement), not by a test. |
| **Remaining risk** | A concurrency test against Miniflare/D1 would make this regression-proof. |

## 3. Operator token timing side-channel (SEC-6)

| | |
|---|---|
| **Fix** | `operator-auth.mjs` compares SHA-256 digests with `timingSafeEqual`. |
| **Verification** | `tests/operator-auth.test.mjs` 10/10. |
| **Remaining risk** | Web routes still have no rate limiting. |

## 4. Workflows without least-privilege tokens (SEC-14)

| | |
|---|---|
| **Fix** | `deploy-cloudflare.yml` and `provision-d1.yml` declare `permissions: contents: read`; `check-workflows.py` now fails any workflow without a top-level `permissions:` block. |
| **Verification** | `python3 .github/atlas/check-workflows.py` → all 9 workflows ok; the new check returns a failure for a document without the block. |
| **Remaining risk** | None known; neither workflow uses the job token for writes. |

## 5. Outbox without a dispatcher

`PlatformTaskStore` wrote every event to a transactional outbox, but nothing
in `src/` called `claimOutbox`, so events were durable but never delivered.
**Fixed:** `platform/outbox-dispatcher.mjs` runs in the daemon, delivers
at-least-once with retry and a visible dead-letter state, and feeds the live
dashboard stream (`tests/platform-outbox.test.mjs`).
