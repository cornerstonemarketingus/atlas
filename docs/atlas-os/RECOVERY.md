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
| **Fix** | Not a code defect in the runner. The structural fix is upstream intake: the innovation pipeline on this branch makes "what should Atlas change about itself?" an evidence-backed Opportunity Brief → Implementation Proposal → approved build, instead of an open-ended coder prompt. Wiring hosted intake to it is `IMPLEMENTATION-PLAN.md` step 2.3. |
| **Verification** | Pipeline refuses briefs without cited evidence (`tests/platform-innovation.test.mjs` "an Opportunity Brief without evidence … is refused"). |
| **Remaining risk** | The hosted composer still dispatches free-text objectives directly. Until intake routes vague requests through clarification, this failure mode remains reachable. |

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

## 5. Outbox without a dispatcher (found, not yet fixed)

`PlatformTaskStore` writes every event to a transactional outbox, but nothing
in `src/` calls `claimOutbox`. Events are durable and visible in the
dashboard; they are simply never delivered anywhere. Tracked as
`IMPLEMENTATION-PLAN.md` step 1.2.
