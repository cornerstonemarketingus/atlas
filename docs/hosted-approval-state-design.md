# Hosted mutation approval state design

This document defines the approval boundary required before Atlas enables
hosted repository mutations. It applies to file edits, commands with write or
external effects, Git staging/commit/push, and pull-request creation. Read-only
runner tasks do not create an approval.

## Security invariant

An approval authorizes exactly one immutable proposed action for one actor,
repository, source revision, runner policy, and bounded lifetime. It is not a
general permission to continue a task or to make a later, regenerated plan.

The executor must reject a mutation unless it atomically consumes an unexpired
approval whose binding matches the action it is about to perform. A UI message,
task identifier, branch name, or client-provided digest alone is never an
approval.

## Approval binding

The control plane creates a canonical UTF-8 JSON manifest and computes:

```
approval_digest = SHA-256("atlas.change-set.v1\\0" + canonical_manifest_bytes)
```

Canonical JSON means recursively sorted object keys, no insignificant
whitespace, and a defined representation for every value. The manifest must
contain these immutable fields:

- `task_id`, `session_id`, authenticated `actor_id`, and tenant/organization ID;
- normalized `owner/repository`, target branch, and the exact base commit SHA;
- allowed operation class (`edit`, `command`, `commit`, `push`, or `pull_request`)
  plus an explicit capability list;
- a digest for the ordered file-change list, each patch/content blob, and the
  full diff preview; an edit may only write those exact paths and bytes;
- command argv arrays, working directory, environment allowlist, network policy,
  limits, and command-image/runner-policy revision, when commands are proposed;
- validation plan and validation-evidence digest, if validation has already run;
- artifact manifest digest, runner workflow revision, and model/prompt/context
  provenance digests; and
- schema version, issuance time, and expiration time.

Git actions need additional exact bindings: index/tree digest after the approved
edit, expected `HEAD` SHA, approved file/hunk scope, commit message digest, and
remote/branch for push. A changed `HEAD`, regenerated diff, validation result,
policy revision, or runner image invalidates the approval and requires a new
preview and approval.

## State and one-time use

Persist only a hash of a 256-bit random approval capability, never the raw
capability. The record includes `approval_id`, `approval_digest`, the complete
immutable binding (or references to immutable blobs), `pending | approved |
rejected | cancelled | expired | consumed`, timestamps, authenticated decision
actor, and the runner execution ID once consumed.

- Default TTL: 10 minutes; cap TTL at 30 minutes. Expiry is enforced by the
  execution service's clock, not the browser's clock.
- Decision and consumption must use conditional/transactional writes. Consuming
  changes `approved` to `consumed` exactly once; all later uses return `replayed`.
- Rejections, cancellations, expiry, and binding mismatch are terminal. Retain
  their metadata for audit according to retention policy, but never reactivate
  them.
- Approval endpoint authentication must require the same authorized user/role
  that the record names (or an explicitly authorized approver role). The server
  obtains the actor identity from session authentication, never from request JSON.
- Executor performs a final binding check immediately before every externally
  visible mutation. A long action needs separately approved sub-actions or an
  immutable transaction plan; it must not reuse a consumed approval.

## Artifact provenance

All proposal and validation artifacts are written before approval to immutable,
content-addressed storage. `artifact_manifest.json` is schema-versioned and
includes artifact SHA-256, byte length, media type, producing task/run ID,
repository commit SHA, tool/runner version, and creation time. The manifest is
itself hashed and bound into the approval.

The UI fetches previews by manifest digest and displays the repository, base
SHA, operation scope, expiry, and artifact hashes. It must label output as
untrusted repository/model content. The executor retrieves artifacts by digest,
verifies each hash and size before use, and writes a final execution receipt
containing the approval digest, consumed approval ID, resulting commit/tree SHA,
and output artifact manifest digest.

Never store raw credentials in an artifact, proposal, audit event, or model
context. Redaction happens before artifact creation; the receipt records the
redactor/policy revision, not redacted secret values.

## Required API boundaries

1. `POST /tasks/{taskId}/proposal` is runner-authenticated and creates immutable
   proposal/artifact records only after validating repository and base SHA.
2. `GET /approvals/{approvalId}` returns safe metadata and signed/authorized
   preview links; raw capability values are never returned after issuance.
3. `POST /approvals/{approvalId}/decision` verifies authenticated actor and
   changes pending state once. It issues a short-lived executor capability only
   for `approved`.
4. `POST /executions` accepts the executor capability and an approval digest;
   it atomically marks the record consumed, re-verifies every binding, then runs
   the bounded operation. It records a receipt even when execution fails.

Responses deliberately distinguish `expired`, `binding-mismatch`, and
`replayed` for operators while avoiding token-or-record enumeration for
unauthorized callers.

## Delivery tests

Before enabling any hosted write mode, add integration tests for digest changes
from one-byte patch, base SHA, argv, policy, and artifact changes; expiry;
double-click/double-executor races; actor/tenant/repository mismatch; stale HEAD;
artifact tampering; retry after executor crash; and audit receipt completeness.
