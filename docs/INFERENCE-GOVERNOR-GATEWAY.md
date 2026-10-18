# Shared capacity for runner and daemon model calls

Hosted chat reserves provider capacity through the Worker's `InferenceGovernorObject`
(one per provider quota scope). Coder runs on a GitHub Actions runner, and any
other process outside the Worker, could not: they raced chat for the same
allowance. This adds an authenticated path so they reserve on the same ledger.

## Pieces

- `apps/web/app/api/inference/governor/route.ts` + `governor-gateway.mjs`: `POST` with
  `{ method, scope, argument }`, methods `reserve | release | observe | withdraw | snapshot`.
  Auth is `Authorization: Bearer $ATLAS_GOVERNOR_TOKEN`, a narrow secret that is **not** the
  operator token. No token configured = 404. Scope must be `https://host[:port][#16 hex]`.
  Body capped at 16 KiB. Governor unavailable = 503.
- `packages/atlas-cli`: `GovernedModelProvider` reserves before every physical attempt,
  waits at most 30 s (or the retry cap if smaller), then raises a retryable rate-limit
  error carrying the wait; the existing retry/fallback layer takes over. A request larger
  than the model's whole allowance is refused as unavailable so a fallback route takes it.
  A provider 429 is released with its `retryAfterMs`, so every other caller on that quota
  stops sending until it passes. Cancellation withdraws the reservation.
- The scope is computed as the Worker computes it (origin + first 8 bytes of SHA-256 of the
  key), so the same key shares one ledger; the key itself is never sent.
- Off by default: nothing changes unless `ATLAS_GOVERNOR_URL` **and** `ATLAS_GOVERNOR_TOKEN`
  are both set. If the governor is unreachable the call proceeds (it must never be the reason
  work fails) and one metadata-only warning is printed.

## To turn it on (owner)

1. Create a random token; add Actions secret `ATLAS_GOVERNOR_TOKEN` and variable
   `ATLAS_GOVERNOR_URL` = `https://<your worker>/api/inference/governor`.
2. Run "Deploy Atlas web to Cloudflare Workers" (uploads the Worker secret).
3. Verify: a coder run's log has no "governor is unreachable" warning; `snapshot` for the
   provider scope shows reservations while a run is active.

## Limits

- Release carries the outcome kind and, for 429, the retry-after, but not provider
  rate-limit headers (the CLI provider contract does not expose them), so the ledger learns
  limits from reservations and 429s rather than `x-ratelimit-*` on runner calls.
- Providers reached by a custom endpoint share a scope by that endpoint's origin. Workers AI
  via `api.cloudflare.com` here may not match the scope chat uses for the Worker's binding.
- Not deployed or run against production; verified in-process and over a real HTTP socket
  against the real ledger (`governed-shared-ledger.test.ts`).
