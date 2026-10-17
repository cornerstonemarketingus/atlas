# Customer privacy and release readiness audit

Checkpoint: 2026-10-17; base main 1c3be5b; issue #309. This is the first evidence-backed pass, not a completed website/security audit or store submission approval.

## Implemented in this branch

The existing server SSE encoder now projects public activity through an explicit field allowlist. It drops thinking events, tool previews and labels, agent reports/titles, raw backend error messages and completion diagnostic metadata. Unknown event types are dropped. Safe progress, recovery identity, customer answer, approval status and validated customer GitHub project links remain available. Native details/summary controls default to collapsed and show plus/minus; keyboard focus stays visible. No approval is granted or consumed by expanding activity.

Ten focused parser/privacy checks pass, including sentinel diagnostic content, arbitrary SSE chunking, completion metadata, approvals and redirect rejection. Real Chromium desktop/mobile acceptance passed, including keyboard Enter toggles, computed plus/minus indicators and absent internal sentinel content. Typecheck passed. Production build, typecheck and changed-file lint passed; integrated full web suite passed with 492 tests and two optional skips before the prompt follow-up. Fresh CI is required for the prompt revision; no deployment has occurred.

A failed-before regression also exposed unconditional Atlas architecture and credential-deployment instructions in customer model context. The prompt now excludes those details and raw capability diagnostics unless the existing server-verified deployment-owner flag is true. The customer prompt explicitly requests safe summaries instead of hidden reasoning and backend failures. This reduces context exposure; it does not replace retrieval/tool authorization or guarantee arbitrary model output.

## Blocking exposure paths still to close

| Priority | Boundary and observed evidence | Required acceptance |
| --- | --- | --- |
| P0 | Non-streaming chat returns outcome.error, resolved.reason, steps/finalization/servedBy directly in app/api/chat/route.ts. That file is actively owned by #240. GET chat also returns endpoint.reason. | Coordinate the existing owner and apply the same public DTO to JSON and configuration responses. Only a server-verified admin diagnostic endpoint may expose bounded diagnostics; a client-supplied admin flag must never work. |
| P0 | The serialized answer/delta itself is preserved. Existing agent-loop task/synthesis failure notes can become answer text; model output is not a guaranteed confidentiality boundary. | Audit task-start descriptions, synthesis fallbacks and the system prompt with adversarial customer/admin tests. Protect Atlas implementation context at retrieval/tool authorization, not only with output regexes. |
| P0 | ProjectActivity polls /api/genesis/operations and displays result.message directly. The SSE projection does not sanitize this second response path. | Project API and history must use a customer-safe result contract; preserve exact approval target/details through the authorized approval flow. |
| P0 | Task intake catches plan errors and returns error.message; task/activity/history routes remain outside this patch. AccountPrivacy also displays backend billing/deletion messages. | Inject backend/path/token failures into every customer response and verify generic actionable copy plus a non-sensitive support ID. Preserve full diagnostics only within authenticated admin access and server logs with redaction. |
| P1 | ChatSection retains legacy reasoning-rendering code and its HTTP fixture can still inject thinking directly. Current server drops it, but this is not defense in depth. ChatSection is owned by active provider/history PRs. | Coordinate removal of raw thinking rendering and safe-client fallback handling; repeat actual-chat desktop/mobile acceptance. |
| P1 | Existing approval execution boundaries have active #233/#235 ownership. This branch only preserves approval state. | Test exact action/target, expiry, deny/cancel, stale approval, repeated consumption and biometric requirements. Never add a visual approval button that bypasses those boundaries. |

## Read-only public host probe

A bounded unauthenticated GET probe of https://atlas-web.cornerstonemarketingus.workers.dev returned 200 for /, /account, /legal/privacy, /legal/terms and /delete-account. Both /.well-known/apple-app-site-association and /.well-known/assetlinks.json returned 404 with HTML, not association JSON. /chat returned 404; the chat experience lives on existing application routes, so this alone is not a confirmed broken navigation link. Public HTTP status is not authenticated flow acceptance.

The last verified hosted release remains the performance rescue dee7942; successful deployment and authenticated chat smoke evidence are recorded in PROGRESS. Branch/main CI does not establish that newer features are deployed.

## Mobile and store release blockers

- Native iOS/Android projects exist, contradicting the older final section of MOBILE-RELEASE.md. However mobile/www/index.html is only an initializing placeholder and capacitor.config.json has no hosted server URL. This checked-in release asset does not boot the product. A verified packaging/bootstrap path is required before a store build is usable.
- Physical-device acceptance, signed production builds, APNs/FCM delivery to a closed app and real biometric approval remain unverified. Generated native projects and unit-tested injected transports are not those outcomes.
- The inspected iOS plist has no app-bound domains list, the Android activity has only a launcher intent, and no tracked iOS entitlement/privacy-manifest file was found. Review the complete generated signing/privacy/link configuration rather than assuming source helpers activate native features.
- GitHub-only login, mobile billing, signing/store accounts, accurate privacy/data-safety declarations, review credentials and store assets remain existing open release gates. Do not claim a universal Sign in with Apple exemption or payment-policy compliance without reviewing the actual distribution model.
- Account deletion UI and public instructions exist; the page promises eligible deletion within 30 days. Verify processor completion, retained records, audit visibility and token/session revocation using a disposable account before declaring that promise operational.

Official requirements checked for this pass: [Apple account deletion](https://developer.apple.com/support/offering-account-deletion-in-your-app/), [Google Play account deletion](https://support.google.com/googleplay/android-developer/answer/13327111), and [Apple review preparation](https://developer.apple.com/app-store/review/). These require actual flows and accurate disclosures; a checklist alone is insufficient.

## Cloud follow-through

Mission #291 remains recovery while signed in, not an unattended scheduler. Tenant persistence review, shared migration integration and authenticated mission acceptance are open. Task dispatch/request/result ownership PRs must integrate without duplicate dispatch or stale-attempt completion. CRM tools merged but have no selected/configured live account acceptance. Cloud networking checks next need authenticated reconnect/offline/timeout/tenant tests and the pending isolation/approval reviews; no production policy or credential change is included here.

Next: complete this branch's CI, then coordinate the non-streaming and client/history privacy boundaries with active owners; fix packaging and association delivery using actual production identifiers before requesting store review.

## Account and billing follow-through — issue #323

The account-customer-errors branch closes the inspected billing checkout/portal exception and deletion status/request response paths. Unexpected failures return fixed customer copy, a UUID reference and no-store headers; server correlation logs contain only the fixed operation and reference. Raw provider/database/auth exception content is neither returned nor logged by this boundary. This does not add an admin diagnostic console or remove exposure paths elsewhere in Atlas.

Deletion responses expose only validated lifecycle status and request time, excluding operator notes and internal account fields. Existing authentication, account-scoped predicates, owner restriction, DELETE confirmation and billing success behavior remain. Null/array/scalar confirmation bodies receive 400 instead of throwing. The actual account component ignores arbitrary backend failure messages, handles invalid JSON/network uncertainty, prevents concurrent deletion submissions and claims success only after a valid pending receipt.

All three actual-handler regression cases failed against unchanged origin/main before passing on this branch, covering sentinel provider/database/auth errors, malformed bodies and a private operator note. Actual phone-width React acceptance verifies safe billing copy, double-submit fencing, invalid-JSON recovery and a successful deletion receipt with no page errors. These use injected service/browser fixtures; no real customer deletion or payment was performed, and deployed authenticated acceptance remains pending. The separate JSON/history/project/model-output exposure rows above remain open.

## Deletion status recovery — issue #325

An uncertain deletion response now blocks another submission until an explicit status read succeeds. A missing, failed, malformed or stalled initial status response also blocks mutation and offers a safe refresh action. Reads and writes have bounded deadlines; an expired POST is treated as uncertain, never automatically retried. A subsequent pending receipt recovers the existing request without another POST. This is client recovery, not a new server-wide exactly-once guarantee across devices.

Appearance changes now update theme only, avoiding unnecessary account/status requests that could overwrite the deletion view. Status reads use cancellation and generation fencing; pending receipts are validated and projected before display. The actual phone-width component regression fails against unchanged main (it previously enabled retry after failure) and passes with the repair, including lost acknowledgement recovery, initial failure, bounded stalled reads and theme isolation. Server authentication, scoping, confirmation and deletion processing are unchanged. No real customer deletion was executed.
