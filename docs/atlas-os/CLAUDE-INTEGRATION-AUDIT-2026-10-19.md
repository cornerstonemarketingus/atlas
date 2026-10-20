# Claude integration and configuration audit

Repository: `cornerstonemarketingus/atlas`. Audit baseline: `8269f2a` (main
after #364). This report distinguishes repository secrets, deployed Worker
settings, local-daemon settings, unmerged implementations and unavailable
provider capacity. Credential values were not read from GitHub or written
into this report. GitHub secret presence does not establish credential validity.

## Changes made during this audit

- Reviewed and merged #390 (`2f99b6e`): evals can use the workflow's short-lived
  GitHub Models token with `models: read`, without purchasing a provider key.
  Dispatched a single-task GitHub Models run, [39355131361](https://github.com/cornerstonemarketingus/atlas/actions/runs/39355131361).
  The workflow completed, but the task failed with zero tool calls/tokens:
  the endpoint returned HTTP 200 with a four-byte, non-JSON text response.
  This is a failed sample, not a successful model baseline. The audit also fixes
  structured agent failures being mislabeled as `tests_failed`, while retaining
  independent verification as the authority on whether an artifact is correct.
- Production lacked `genesis_projects`. A read-only schema inspection confirmed
  tenant, task-request and execution-claim tables but no Genesis project table.
  Applied only additive migration `0016_project_genesis.sql`, including its
  indexes, through [39355375599](https://github.com/cornerstonemarketingus/atlas/actions/runs/39355375599).
  The migration completed successfully. No earlier migrations were replayed.
- Fixed deploy wiring for existing repository variables
  `ATLAS_PRICE_DISPLAY_PRO`, `ATLAS_PRICE_DISPLAY_TEAM` and `ATLAS_PUBLIC_URL`.
  Previously the Worker could not read them despite their repository presence.
  Price labels do not create Stripe products or enable checkout.
- Added missing deploy mappings for the existing independent execution adapter's
  `ATLAS_AGENT_DISPATCH_URL` and `ATLAS_AGENT_DISPATCH_TOKEN`. They remain optional
  and unset; an actual authenticated execution service must exist first.
- Set the canonical public URL repository variable to the existing workers.dev
  origin. No provider destination or credential was changed.
- Tightened the chat release gate: persisted text alone no longer proves model
  success. Both streaming and JSON responses must carry provider/model authorship
  metadata. Regression fixtures reject unconfirmed text in either mode.
- Corrected the hosted-site stylesheet regression on #391 for Windows CRLF
  checkouts. All 14 focused hosted-site and bridge tests pass after the fix.

## Configuration inventory

| Capability | Configuration | Evidence and remaining work |
| --- | --- | --- |
| Web deployment and storage | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ATLAS_D1_DATABASE_ID`, `ATLAS_D1_DATABASE_NAME` | Repository secrets exist. Deployment 39249464778 succeeded. Additive Genesis migration is now applied. |
| Sign-in | `ATLAS_SESSION_SECRET`, `ATLAS_GITHUB_OAUTH_CLIENT_ID`, `ATLAS_GITHUB_OAUTH_CLIENT_SECRET`, `ATLAS_OWNER_GITHUB_LOGINS` | Secrets exist and were uploaded by the successful deploy. Hosted setup reported 8/8 ready; that is not a fresh interactive OAuth journey. |
| Dispatch and owner operations | `ATLAS_GITHUB_TOKEN`, `ATLAS_OPERATOR_TOKEN` | Present and uploaded. Hosted verification authenticated successfully. Do not replace these with random values. |
| Shared inference governor | Secret `ATLAS_GOVERNOR_TOKEN`; variable `ATLAS_GOVERNOR_URL` | Created/configured in the preceding task, and deployed with #364. Gateway returns 401 without authentication. Runner outage behavior is fail-closed. |
| Hosted chat | `GROQ_API_KEY`, `OPENAI_API_KEY`, `ATLAS_CHAT_BASE_URL`, `ATLAS_CHAT_MODEL`; optional `ATLAS_MODEL_API_KEY` | Existing keys and endpoint settings were uploaded. The deploy derives the model key from Groq only for its exact trusted origin. The last live gate failed on provider capacity, not missing key names. |
| Keyless Workers AI | Worker binding `AI` | Implemented and deployed by #366. No API key is needed for the binding. Account allowance still applies: live checks returned HTTP 429. |
| Workers AI from Actions/local clients | `ATLAS_WORKERS_AI_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Present. The external REST client cannot use the Worker's in-process binding. The live token/account validation passed; inference returned a rate limit. |
| Stripe billing | `ATLAS_STRIPE_SECRET_KEY`, `ATLAS_STRIPE_WEBHOOK_SECRET`, `ATLAS_STRIPE_PRICE_PRO`, `ATLAS_STRIPE_PRICE_TEAM` | All four absent. Checkout, portal, signature verification and webhook idempotency are implemented. Create the account's recurring prices, register `/api/billing/webhook`, supply the matching credentials/price IDs, deploy and verify a test subscription lifecycle. Do not fabricate keys or treat display prices as price IDs. |
| Web search | `ATLAS_TAVILY_API_KEY` (runtime alias `TAVILY_API_KEY`) | No repository secret. Search is unavailable without it; fetching a known public URL is a separate capability. |
| Full Genesis node | Worker secrets `ATLAS_GENESIS_URL`, `ATLAS_GENESIS_TOKEN` | Both absent. Requires a reachable trusted HTTPS node, its authentication and publishing credentials on that node. A generated token alone would not create a node. |
| Local Genesis models | `ATLAS_GENESIS_BASE_URL`, `ATLAS_GENESIS_MODEL`; optional API-key reference and vision settings | Local Ollama is installed and lists `qwen2.5-coder:7b` and smaller models. Listing models is not an inference, vision or browser acceptance test. No installed vision-capable model was established by this audit. |
| Independent execution host | `ATLAS_AGENT_DISPATCH_URL`, `ATLAS_AGENT_DISPATCH_TOKEN` | Both absent; forwarding was missing and is fixed here. Linux host/container isolation, authenticated dispatch, claim/result delivery and restart acceptance still need real deployment. |
| Per-customer GitHub App | `ATLAS_GITHUB_APP_ID`, `ATLAS_GITHUB_INSTALLATION_ID`, `ATLAS_GITHUB_APP_PRIVATE_KEY`, optional `ATLAS_GITHUB_APP_SLUG` | Absent. The deployment PAT currently handles dispatch. Multi-customer installation onboarding requires a real GitHub App, granted permissions and installation; random IDs/private keys do not substitute. |
| Local rendering | `ATLAS_TERMINAL_CONTAINER_RUNTIME`, `ATLAS_RENDER_FFMPEG_IMAGE`, `ATLAS_RENDER_BLENDER_IMAGE` | Rendering and pinned image source are merged (#376/#389/#399). No settings in this shell. Docker CLI exists, but its Linux engine is unreachable. Build `docker/render`, pin the resulting image, configure the daemon and verify an actual artifact before advertising availability. |
| Publish generated projects | Node vault credentials for the selected host (`ATLAS_GITHUB_TOKEN`, `ATLAS_GITLAB_TOKEN`, `ATLAS_FORGEJO_TOKEN`, `ATLAS_VERCEL_TOKEN` as applicable) | Separate from Worker secrets. Host availability, policy/approval and independent publication verification remain required. Do not copy all repository secrets to project containers. |

## Open Claude implementations

| PR | Finding | Release condition |
| --- | --- | --- |
| #391 hosted websites | A substantial implementation exists, not just a missing key. It builds escaped static pages without executing user code. It is distinct from a full app/API node or publication service. Review covered owner/node separation, workspace/principal scoping, preview paths and CSP. | The 0016 schema blocker is repaired. Fresh CI after the Windows stylesheet fix, merge/deploy and a real authenticated create/preview journey are still required. Public preview links are bearer capabilities; forms do not deliver enquiries. |
| #397 free-provider fabric | Unmerged; audit snapshot showed no completed main CI checks on its head. Adds `CEREBRAS_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY` and per-provider model/tier settings. | Rebase/integrate #364 and verify every new coder provider's quota-origin mapping: current main's governor only names Groq, OpenAI, Anthropic and Workers AI. Do not merge a new route that throws when the governor is configured. Verify training-tier restrictions with real conversation/tool histories. No training opt-in or paid-tier declaration was set by this audit. |
| #398 RunPod | Initial Windows CI failed with SQLite file locks. During this audit Claude pushed ownership-aware provider/service cleanup and tracked every fixture handle (`a394ab6`, integrated in `1ad01f1`). The latest 19 focused tests pass on Windows; an incomplete local alternative was not pushed. | Fresh full CI and real account/endpoint/image acceptance remain required, plus `ATLAS_RUNPOD_API_KEY`, `ATLAS_RUNPOD_ENDPOINT_ID`, explicit `ATLAS_GPU_MONTHLY_CAP_USD`. Keep the default cap zero. Remote render input upload and GPU render routing remain follow-ups. |
| #400 Cloudflare sandboxes | Windows CI fails the executable-bit round-trip assertion. Cloud/local snapshot semantics must be reconciled across Windows and POSIX rather than ignoring a digest mismatch. Default `sandbox.config.json` is disabled. | Fix and test migration semantics, review SDK/container boundary, then obtain Workers Paid, create the backup R2 bucket, configure previews and deploy the enabled build. Local `ATLAS_CLOUD_SANDBOX_URL` and vault `ATLAS_CLOUD_SANDBOX_TOKEN` must match the broker's operator authentication. Genesis does not automatically select this environment yet. |

The RunPod, sandbox and free-vendor implementations were not merged merely
because unit tests or a PR description claimed readiness. Their missing accounts,
live acceptance, budgets and integration work are separate release conditions.

## Production verification and limits

- [Deploy 39249464778](https://github.com/cornerstonemarketingus/atlas/actions/runs/39249464778)
  completed and uploaded the existing runtime credentials plus the governor token.
- [Hosted chat 39249667886](https://github.com/cornerstonemarketingus/atlas/actions/runs/39249667886)
  failed on both attempts: non-streaming had no model-written final answer;
  Groq/Workers AI were limited and OpenAI reported unavailable credits/billing.
  The old streaming check accepted stored text without positive authorship
  metadata. This audit strengthens that check; it does not claim quota recovery.
- Focused audit regressions: 8 deployment/smoke tests pass; 14 hosted-site/bridge
  tests and the latest 19 RunPod tests pass on Windows. The earlier #235/#364
  boundary run passed 31 tests. All 11 workflow files and their shell steps
  validate when the checker uses the installed Git Bash; the system WSL shim
  cannot run Bash in this environment.
- Missing external credentials cannot be generated from their names. A new
  provider key must be created in the user's provider account; Stripe endpoint
  secrets and prices must match that account. Optional integrations should remain
  unavailable until those real services exist.
- No new paid compute, account upgrade, training-provider opt-in, native billing
  approval, public model tunnel or unscoped credential transfer was performed.

## Next acceptance checks

1. Land this deployment/verification fix and redeploy so existing price variables
   reach the Worker. Confirm configured prices are displayed without enabling
   checkout while Stripe remains incomplete.
2. Complete #391's updated CI and hosted create/preview journey; report source,
   placeholders, structural checks and delivery/publishing limitations truthfully.
3. Diagnose the GitHub Models non-JSON response before further model samples;
   the completed workflow currently records a failed task, not a valid baseline.
4. Restore one usable model allowance and rerun the strengthened streaming and
   non-streaming chat gate. Do not keep hammering exhausted provider routes.
5. Configure Stripe and optional services from a secure account-owned source;
   verify each actual service before marking it ready.
