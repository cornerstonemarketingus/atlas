# Atlas deployment status

Updated 2026-10-16. This branch is not deployed. No infrastructure provisioned,
production database migrated, credentials transferred or live business actions
performed. The existing Cloudflare web app and GitHub Actions execution adapter
remain the integration targets. Cloudflare Workers coordinate tasks; full Linux
coding/container workloads require an execution host.

For this transport slice: pass focused and full local tests, required branch CI,
then follow normal review/merge policy. Verify a configured OpenAI-compatible
server using actual text/tool/usage responses and an interrupted stream. Existing
hosted chat release checks remain necessary for changes to hosted transport.

For independent cloud workers: first integrate the durable dispatch/claim/result
stack and existing mission persistence. Then deploy a Linux service with scoped
identity, outbound control-plane connection, private artifact storage and isolated
containers. Register capabilities in the existing worker registry. Acceptance
requires a task initiated remotely while the owner's PC is offline, worker kill
and replacement, preserved checkpoints, bounded spending and one verified artifact.

Request recovery checkpoint (2026-10-17): current main is propagated through
existing #270/#274/#276. #276's final Worker build, full web suite (537 pass,
four optional skips) and separately executed desktop/mobile browser fixture
pass. Prior migrations 0017/0018 still precede deployment; this UI fix adds no
migration or secret. Fresh integrated PR CI/review and configured live reads
remain required. No production migration or deployment was performed here.

Claims integration checkpoint: #278 contains the validated recovery parent and
passes build/typecheck, 545 web tests (four optional skips), 83 runner/local
tests and all ten workflow checks. Protected workflow/identity review and fresh
CI remain required. Apply migration 0019 only after authorized 0017/0018 rollout,
deploy the reviewed claim endpoint before enabling its reviewed workflow gate,
and quiesce old cached runs. No such rollout or live identity journey occurred.

Unresolved external dependencies: owner-selected execution host, authorized
provider configuration, TLS/identity and artifact storage configuration, approved
deployment and physical mobile acceptance. Never expose a Docker socket or host
credentials to an untrusted repository. Protected changes require CODEOWNERS review.

## Cost status

This change adds no dependency or hosted service and incurred no provisioned
infrastructure cost. Ongoing cloud estimates have not been priced against a
selected current vendor/region, so no unverified monthly figure is asserted.
Track CPU-hours, storage, egress and model input/output tokens against configured
caps before rollout. User-owned local inference has hardware/electricity costs;
hosted free allocations are finite; GPU serving adds rental and storage costs.
Vendor pricing comparison remains a deployment-planning task once candidates are
selected. Do not rent compute or increase API budgets automatically.

## 2026-10-19 — Genesis receipt integration checkpoint (#281 / #284)

Integrated current main afdee04, preserving hosted website creation, scoped
preview reads, project-stage UI, bounded bridge deadlines, and existing approvals.
Node dispatch reserves its original operation id before calling the node. Hosted
creation reserves its actual gen_ operation id before returning an existing row
or writing a site. Missing/foreign/archived history prevents creation. Reopening
history restores only bounded operation ids; status checks never create projects.
Retained main's preview UI while restoring bounded polling, cancellation, explicit
read-only retry and truthful not-found diagnostics. Added a real SQLite hosted
fallback recovery/refusal regression. Twenty focused project cases pass. All
11 workflow checks pass. Build/full web tests, typecheck, lint and fresh CI are
pending; no live node, external repository creation, publish or deployment claimed.

Separate #289 CI at 6ac1336 failed Windows: 828 pass, two failures, 20 skips.
Main already repairs the Genesis acceptance fixture. Updated daemon/Genesis
reproduction passes all 11 cases in a serial Windows run; full parallel Windows
CI remains a gate. Earlier all-green source heads do not replace this evidence.
No production migration, credential transfer, data change or paid provisioning.
Next: complete current-head CI and protected persistence review before rollout;
configure a trusted Genesis node only with the required owner authorization.

## 2026-10-19 — Genesis receipt verification follow-through

Integrated build and typecheck pass. Full web acceptance: 624 total, 619 passed,
five optional browser skips, zero failures. Separate Edge desktop/mobile chat
acceptance passes: reopen/reload restores the receipt, offline status retry is
read-only, no project creation POST occurs, and scroll position is preserved.
Twenty-six focused chat/project cases pass. Full ESLint passes after removing
an unused default callback argument. CI b02ca55 failed at that lint error; it did
not reach the incomplete chat test host. The host now imports the real receipt
helper. Final history-refusal diagnostics and no-write assertions pass 16 focused
cases; final head CI remains required. No assertion or authorization was removed.

#289's current-main integration exposed an unsupported Worker redirect mode in
three verification calls; the separate outcome branch now uses manual redirects
and rejects non-success responses. Its source scanner is corrected to inspect
real files on Windows. Both fixes retain original ownership and approval gates.
No live node, physical phone, production write, migration or deployment claimed.
Next: finish exact-head CI/protected review for #284 and #289, then a configured,
explicitly authorized Genesis-node acceptance run without publishing by default.
