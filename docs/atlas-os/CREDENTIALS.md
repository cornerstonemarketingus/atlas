# Credentials, identity, authorization and remote approval

How Atlas holds and uses credentials, what exists today, and the order the
rest lands in. Code + tests + live verification outrank this page.

## Principles

1. **Agents ask for capabilities, not secrets.** `cloudflare.ai.run`, not
   "the Cloudflare token". The model never receives a credential: not in a
   prompt, tool result, error, trace or audit record.
2. **Values live in one vault; everything else is a reference.** Records say
   which provider, account, environment and capabilities a credential is
   for, so "the variable exists but points at the wrong account" is visible.
3. **Approvals are bound to one action** (a digest of agent, capability,
   connection and resource), single use, so they cannot be replayed.
4. **Autonomy is a mode over risk levels, never root.** Production, money and
   secrets always ask; level 5 is never catalogued.
5. **Diagnose, don't guess.** A refusal is classified (missing, invalid,
   expired, disabled, wrong account or permission, auth scheme, rate limit,
   billing) by asking the provider, not inferred from a status code.

## What exists (reused, not duplicated)

| Piece | Where |
|---|---|
| Vault: OS keychain / DPAPI / libsecret, encrypted-file fallback; `list()` returns names | `apps/local-control/src/agent/credential-vault.mjs` (protected) |
| Tools reference credentials by name, resolved inside `execute()` | `apps/local-control/src/agent/tool-registry.mjs` |
| Secret redaction (vendor patterns + known values) | `platform/terminal/redaction.mjs`, `platform/memory/redaction.mjs`, atlas-cli redactors (protected) |
| Digest-bound, single-use approvals; Approvals UI; phone pairing | `store.mjs` `local_approvals`, `server.mjs`, `remote/access.mjs` |
| Risk levels 0–5 per action, strong confirmation at 4 | `agent/kernel/autonomy.mjs` (B8) |
| Durable missions (pause, resume, interrupted, cooldown) and goals that sleep and wake | `agent/mission-*.mjs`, `agent/goals.mjs` |
| Hosted Worker secrets uploaded from GitHub secrets on deploy | `.github/workflows/deploy-cloudflare.yml` (protected) |

## Built now

- **Credential Broker** (`apps/local-control/src/agent/credentials/`):
  typed connection records (`API_TOKEN`, `API_KEY`, `OAUTH_ACCESS_TOKEN`,
  `OAUTH_REFRESH_TOKEN`, `SESSION`, `PASSWORD`, `SSH_KEY`, `SERVICE_ACCOUNT`,
  `PASSKEY_REFERENCE`, `EPHEMERAL_TOKEN`) pointing at vault names; a
  capability catalog with risk levels; `request()` → policy (approval mode ×
  level) → digest-bound approval when needed → five-minute single-use lease;
  `use()` hands the value only to the adapter and redacts what comes back;
  classified refusals; provider validators (GitHub, Cloudflare) that detect a
  credential for another account; an append-only audit trail (agent,
  capability, credential reference, resource, decision, approval, result).
- **Approval modes** SAFE / BALANCED / AUTONOMOUS (`PUT /v1/accounts/mode`).
- **Accounts** in Settings → Connections (`/v1/accounts`): status, account,
  environment, capabilities, expiry, last use, last check, Check, Revoke.
- **Redaction at the tool boundary**: the daemon's tool registry now redacts
  every output and error (host secret values, values the broker has used,
  vendor token shapes); before, it passed them through.
- **Hosted provider diagnosis** (`apps/web/app/api/chat/provider-health.mjs`,
  owner-only `GET /api/setup/providers`, printed by "Verify hosted Atlas").

## Next, in order

1. **Route existing adapters through the broker**: infrastructure, genesis
   publishing and deploy tools ask for capabilities instead of reading the
   vault (`agent/tools/infrastructure-tools.mjs`, `platform/genesis/publish.mjs`).
2. **Mission state `WAITING_FOR_AUTH`**: a step whose capability request
   returns `approval-required` waits like `awaiting_approval` does today,
   and resumes the same step when the approval lands (team step executor
   already waits on approvals; extend to broker approvals).
3. **Remote approval broker**: push the approval (action, service, account,
   resource, risk level, capability, expiry) to the paired phone; Approve /
   Deny there resumes the mission. The approval store and pairing exist.
4. **Connect flows**: OAuth for GitHub and Google; for Cloudflare, create a
   least-privilege token once with the owner's consent and capture it straight
   into the vault. Expiry and refresh for OAuth tokens.
5. **Identity vault** (structured profile fields disclosed per field, e.g.
   `identity.email`) and signup/onboarding workflows with human checkpoints
   (CAPTCHA, MFA, passkeys, payment, legal consent) as `WAITING_FOR_USER`.
6. **Hosted parity**: the Worker gets the same broker model over D1 with
   encrypted values (today it uses Worker secrets per variable).

## Workers AI transport and release verification

The native Worker AI binding stays within the deployed account and uses no
bearer token. Its adapter enforces caller cancellation and a 60-second wait
limit; cancellation stops Atlas waiting, but native inference may continue if
Cloudflare cannot cancel the underlying computation. Health checks have a
five-second limit and require actual text or a valid tool call, rather than
accepting HTTP 200 alone.

Native server-sent events are normalized incrementally with downstream
cancellation and bounded frame sizes. The default Llama model advertises its
documented 24,000-token context; custom overrides need measured capabilities.
Model documentation: https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/

A permanent model refusal after tool work records only HTTP status, provider
kind, registry-shaped model name, error category and round. Chat JSON and SSE
carry that metadata into the hosted verification artifact. Provider error text,
credentials and request content are excluded. A passing basic chat test does
not establish multi-round tool compatibility: the release gate must complete
its tool step and final answer in both streaming and non-streaming modes.
