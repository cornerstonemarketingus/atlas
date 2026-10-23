# Atlas release qualification — 2026-10-23

Release baseline: `d9f662175f20e910bc292b638bea5fa56cd10837`.
[Cloudflare deployment 39900284379](https://github.com/cornerstonemarketingus/atlas/actions/runs/39900284379)
succeeded and contains merged mission intake, live audit, textual tool recovery
and result-reporting changes. Deployment success alone does not qualify models.

## Database rollout

[Dry run 39966751152](https://github.com/cornerstonemarketingus/atlas/actions/runs/39966751152)
selected only `0021_cloud_missions.sql` and inspected table names and schema,
without user records. The mission tables were absent. The reviewed additive
migration then succeeded in
[39967073156](https://github.com/cornerstonemarketingus/atlas/actions/runs/39967073156).
No other migrations were replayed. Authenticated mission lifecycle acceptance
still needs its own scoped account journey.

## Observed qualification

- [Website flow 39966438934](https://github.com/cornerstonemarketingus/atlas/actions/runs/39966438934)
  passed: four served pages and a saved preview read back. Local isolated Edge
  checks at 1365 and 390 pixels returned HTTP 200, no horizontal overflow or
  page errors, and confirmed browser cleanup. Evidence and screenshots are in
  the primary checkout's `.review/qualification-browser-20261023/`.
  The initial heading selector was incorrect; the retained first-attempt report
  records that test failure. The rendered software-business preview includes
  construction defaults (renovations/repairs), so semantic business-content
  qualification is **not passed**. No website publication or enquiry delivery
  was attempted.
- [Chat flow 39966305821](https://github.com/cornerstonemarketingus/atlas/actions/runs/39966305821)
  failed both modes. A page was read, but capacity refusals prevented a model
  answer. The fallback route was Groq, Workers AI, OpenAI. Workers AI answered
  429; OpenAI reported unavailable credits. A generic 4006 alone does not prove
  daily exhaustion rather than temporary capacity.
- [Simple chat 39966816365](https://github.com/cornerstonemarketingus/atlas/actions/runs/39966816365)
  produced and persisted a real non-streaming response from Groq
  `openai/gpt-oss-20b`. Streaming failed. This qualifies neither the full chat
  journey nor general coding.
- [Groq 20B evaluation 39966432808](https://github.com/cornerstonemarketingus/atlas/actions/runs/39966432808)
  ran the unmet `correlation-id-helpers` task against independent tests.
  The task timed out at its existing 120-second limit, changed no files and
  failed verification because the required module remained absent. The
  workflow's green status means a report was generated, not that the task passed.
  No coding qualification is claimed.
- [Groq 120B evaluation 39967305877](https://github.com/cornerstonemarketingus/atlas/actions/runs/39967305877)
  repeated the same independent task with the catalog's other Groq model.
  It also reached the existing 120-second deadline with no changed files.
  The task's tests failed; it is not qualified by this attempt.

Raw evidence is retained locally under `.review/qualification-*20261023*`.
These are bounded observations, not a benchmark score or a production-readiness
claim. No credits, paid capacity or permissions were provisioned.

## Retry scheduling correction

The binding adapter previously converted every capacity/daily refusal into a
generic 429 with no reset. Chat interpreted that as a two-second wait. A daily
binding refusal could therefore exhaust bounded retries before an earlier free
provider's stated reset. The adapter now recognizes explicit daily allocation,
quota or limit wording, emits a fixed error code and supplies the next UTC
midnight as `Retry-After`, consistent with
[Cloudflare's daily allocation reset](https://developers.cloudflare.com/workers-ai/platform/pricing/).
Ambiguous capacity errors remain generic. Provider text is never returned.

The three-route regression simulates Groq returning a 14-second reset, an
explicit daily binding refusal and an unfunded fallback. Both chat modes wait
once for Groq and receive a model answer without increasing budgets or retry
counts. The test and reset/privacy regression fail against the original adapter.
This validates the defect class; the production 4006 body was not captured and
is not enough to establish it as the sole cause of the live failure.

Local validation: 39 focused chat/binding/recovery tests pass. Three relevant
regressions fail with the original binding adapter restored. Lint, TypeScript
and web build pass. Full Windows web suite: 725 tests, 718 pass, six skip and
one unchanged sandbox executable-mode assertion failure (`100644` versus
`100755`, also reproduced on the prior baseline). No guard, resource budget,
retry count or training-provider permission was relaxed.
