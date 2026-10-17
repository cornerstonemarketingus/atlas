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
