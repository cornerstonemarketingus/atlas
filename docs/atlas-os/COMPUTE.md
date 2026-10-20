# Compute plane: rented GPUs that cannot outlive their budget

Issue #353; engineering plan 2026 §3.2. Code: `apps/local-control/src/platform/compute/`.
Tests: `apps/local-control/tests/compute-manager.test.mjs`, `tests/compute-runpod.test.mjs`
(against a loopback fake of the RunPod API, `tests/helpers/fake-runpod-server.mjs`)
and `tests/budget-release.test.mjs`.

**Status:** the interface, the fake provider, every safety stop, the monthly
cap and a RunPod Serverless adapter (decision D4) are built and tested. The
tests run against a fake per-second-billing provider and a local HTTP fake of
the RunPod API with a fake clock. **No test makes a network call or spends
money.** The daemon (`main.mjs`) constructs the compute service, but it is
**off by default**. With no endpoint it builds nothing and sends no request.
With an endpoint and key but a cap of 0 (the default), it refuses every
provision. **Not live:** nothing has run against a real RunPod account. That
needs the owner's account, endpoint and a cap above 0 (see "RunPod setup"
below). Render jobs do not route to RunPod yet (see "Follow-ups").

## Provider interface (`provider.mjs`)

`estimate(job) → { gpuType, estHourlyUsd, estMinutes } | null`,
`provision({ gpuType, maxLifetimeSec, tags }) → instance`, `status(id)`,
`terminate(id)` (idempotent), `listTagged(tag)` (only instances still billing).
An instance reports its integer `billedMicroUsd`. A provider must enforce
`maxLifetimeSec` itself. `FakeGpuProvider` bills every started second and
stops instances at their max lifetime on its own.

## The four stops (`manager.mjs`)

1. **Budget reservation before provisioning.** The worst case (per-second
   rate × max lifetime) is reserved on the job's task through the existing
   `TaskBudget`, so ancestors and siblings see it immediately. The manager
   refuses with no approved `costMicroUsd` limit (`NO_APPROVED_BUDGET`) or
   when the estimate exceeds what is left (`ESTIMATE_EXCEEDS_BUDGET`). Max
   lifetime is trimmed to what the budget covers, never below the estimate.
2. **Provider-side max lifetime**, set at creation, so a crashed Atlas still
   stops billing. The reservation already covers that lifetime. The manager
   also enforces the same deadline itself, in case a provider ignores it.
3. **Idle timeout.** Each `heartbeat()` extends the lease by
   `idleTimeoutSec` (default 300). An expired lease cannot be revived; the
   reconciler terminates its instance and aborts the job's `signal`.
4. **Reconciler.** `reconcile()` ends every lease that is no longer live,
   lists Atlas-tagged instances and terminates any without a live lease, and
   finishes settlements a crash interrupted. `startReconciler()` runs it once
   with `takeover` (leases held by a previous process are ended) and then on
   an interval; `stopReconciler()` stops it.

Jobs run via `runJob({ tenantId, taskId, job, execute, saveOutputs })`.
Outputs are saved while the instance still exists, and the instance is
terminated on success or failure. Requirement detection
(`requirements.mjs`) sets a VRAM floor by kind (render, inference, training,
transcode). It runs locally instead of renting when the machine's own GPU
(from `agent/models/hardware.mjs`) is big enough.

## Monthly cap (`ATLAS_GPU_MONTHLY_CAP_USD`)

The cap sits above the four stops. `ComputeManager({ monthlyCapMicroUsd })`
defaults to **0, which means GPU spending is off**. Every provision is then
refused with `GPU_SPENDING_OFF` before anything is reserved or sent. With a
cap set, a provision is refused with `MONTHLY_CAP_EXCEEDED` when this would
pass the cap: the tenant's spend this UTC month plus the new reservation.
Spend is settled bills plus reservations still held. A bill that could not be
proven counts as its full reservation. Max lifetime is also trimmed to the
cap that is left. Spend comes from the lease rows themselves
(`ComputeLeaseStore.spend`), so it is durable and tenant-scoped. The check is
repeated atomically with the lease insert (`insertWithinCap`, one IMMEDIATE
transaction). If that second check refuses, the task-budget reservation is
released again. A refusal is audited as `cap.refused`. The current month's
spend is available from `manager.monthlySpend(tenantId)`.

## RunPod Serverless (`runpod.mjs`, `service.mjs`)

`RunpodProvider` maps the provider interface onto jobs on one RunPod
Serverless endpoint. RunPod starts a worker per job and scales back to zero.

| Interface | RunPod call |
|---|---|
| `estimate` | Local pricing table. A job may land on any GPU pool the endpoint lists, so the job must fit the smallest pool and is priced at the dearest. The estimate adds the billing overhead. |
| `provision` | `POST /v2/{endpoint}/run` with `{ input, policy: { executionTimeout, ttl } }`. `input` is `job.input`. |
| `status` | `GET /v2/{endpoint}/status/{job_id}` |
| `terminate` | `POST /v2/{endpoint}/cancel/{job_id}`, then a status read for the final `executionTime`. Idempotent. |
| `listTagged` | The local journal (see below), refreshed with `/status` |
| `waitForCompletion` | Polls `/status` and heartbeats the lease. Returns the worker's `output`. |

**Provider-side max lifetime.** Each job's policy carries
`executionTimeout = (maxLifetimeSec − billing overhead) × 1000` and
`ttl = executionTimeout + queue allowance` (both in ms). The billing overhead
is the endpoint's worker idle timeout plus a cold-start allowance. RunPod
itself stops the job, so a crashed Atlas still stops billing.

**Tags.** RunPod jobs have no tags or metadata, and there is no list-jobs
API. The adapter therefore keeps a journal (`runpod_jobs`) in the lease
database. It writes a row *before* calling `/run` and adds the job id when
`/run` answers. In some cases a job may exist that Atlas cannot see:

- Atlas crashed while `/run` was in flight.
- `/run` timed out.
- `/run` returned 5xx or invalid JSON.

The row is then reported as an `unconfirmed:` instance with an unknown bill,
so the lease keeps its full reservation instead of assuming the job cost
nothing. RunPod's `executionTimeout` and `ttl` bound such a job. A 4xx answer
is a definite refusal, and its reservation is released.

**Billing.** RunPod bills workers per second, from start until the worker
stops, idle time included. It reports no per-job cost. The adapter computes a
job's bill in three ways:

- With a known execution time: `(ceil(executionTime s) + idle timeout + cold-start allowance) × rate`.
- Without one: `min(maxLifetimeSec, elapsed since submission + idle timeout) × rate`.
- `null` when RunPod no longer has the job. That happens past its ttl, or 30
  minutes after it finished, when the result is gone. A null bill settles as
  the full reservation.

**Secrets.** The API key is resolved through the credential vault first and
`ATLAS_RUNPOD_API_KEY` second, only when a request needs it. It is held in a
private field and sent only as `Authorization: Bearer` to an https base URL
(plain http is allowed only for a loopback test server). Redirects are
refused. It never appears in errors, the journal, the audit or the logs.
Errors carry `RUNPOD_HTTP_<status>`, `RUNPOD_UNREACHABLE`,
`RUNPOD_BAD_RESPONSE` or `RUNPOD_NO_API_KEY` and never a response body.

**API sources** (read 2026-10-19; cited in `runpod.mjs`):
- [Send requests (policy fields)](https://docs.runpod.io/serverless/endpoints/send-requests)
- [Operation reference](https://docs.runpod.io/serverless/endpoints/operation-reference)
- [Job states](https://docs.runpod.io/serverless/references/job-states)
- [Endpoint settings](https://docs.runpod.io/serverless/endpoints/endpoint-configurations)
- [Pricing](https://docs.runpod.io/serverless/pricing)

### Costs (default pricing table)

Flex (scale-to-zero) prices per GPU pool, from
<https://docs.runpod.io/serverless/pricing> and
<https://www.runpod.io/product/serverless>, retrieved 2026-10-19. Where
sources disagreed, the higher price is used, so reservations err high.
Override the table with `ATLAS_RUNPOD_PRICING`, for example
`{"ADA_24": 1.2}` or `[{"gpuType":"NEW_POOL","vramGb":96,"hourlyUsd":5}]`.

| Pool | VRAM | USD/hour | Examples |
|---|---|---|---|
| AMPERE_16 | 16 GB | 0.58 | A4000, A4500, RTX 4000 |
| AMPERE_24 | 24 GB | 0.68 | L4, A5000, RTX 3090 |
| ADA_24 | 24 GB | 1.12 | RTX 4090 |
| AMPERE_48 | 48 GB | 1.22 | A6000, A40 |
| ADA_48_PRO | 48 GB | 1.91 | L40, L40S, RTX 6000 Ada |
| AMPERE_80 | 80 GB | 2.74 | A100 80GB |
| ADA_80_PRO | 80 GB | 4.79 | H100 80GB |

Example: a 10-minute render on AMPERE_24 with the default 60 s cold-start
allowance and 5 s idle timeout reserves `ceil(11 min × 1.5)` = 990 s, about
**$0.19**. If the job finishes in 10 minutes it settles near
`(600 + 65) s × $0.68/h` ≈ **$0.13**. An idle endpoint scaled to zero costs
nothing. Check prices on the live pricing page before setting a cap.

### RunPod setup (needs the owner's account; nothing here is live yet)

1. Create a RunPod account and add credit. Set a spend limit in the RunPod
   console as a second guard.
2. Build a **worker image** whose handler (RunPod's `runpod` Python SDK,
   `runpod.serverless.start({"handler": ...})`) reads `job["input"]` and
   returns JSON. For Blender Cycles, run `blender -b scene.blend -E CYCLES -f N
   -- --cycles-device OPTIX|CUDA` and return the frames base64-encoded, or
   upload them to a bucket and return URLs.
3. Create a **Serverless endpoint** from that image:
   - Pick the GPU pool(s), for example `AMPERE_24`.
   - Set max workers small (1–2) and active (min) workers to **0** so it
     scales to zero.
   - Keep the idle timeout at 5 s.
   - Leave the execution timeout at its default. Atlas sends a stricter one
     with every job.
4. Store the secrets and settings for the daemon:
   - `ATLAS_RUNPOD_API_KEY`: a RunPod API key. Put it in the credential vault
     (preferred) or the environment. It is never logged.
   - `ATLAS_RUNPOD_ENDPOINT_ID`: the endpoint id.
   - `ATLAS_GPU_MONTHLY_CAP_USD`: the monthly cap, for example `20`.
     **Default 0 means GPU spending is off.**
   - `ATLAS_RUNPOD_GPU_TYPES`: the endpoint's pools, comma-separated.
     Default `AMPERE_24`.
   - Optional: `ATLAS_RUNPOD_IDLE_TIMEOUT_SEC` (must match the endpoint,
     default 5), `ATLAS_RUNPOD_COLD_START_SEC` (default 60),
     `ATLAS_RUNPOD_QUEUE_TTL_SEC` (default 900) and `ATLAS_RUNPOD_PRICING`.
5. Restart the daemon. It logs `Compute: ...` with the cap and starts the
   reconciler (once at startup with takeover, then every minute).

**Live vs pending.** The adapter, cap, reconciler and daemon wiring are in
the code and tested against the fake. Pending the owner:

- an account, a worker image, an endpoint and a cap above 0;
- a first real job, to confirm the response shapes against the fake;
- comparing the derived bill with RunPod's billing page.

## Leases, settlement and audit

`ComputeLeaseStore` is a tenant-scoped `node:sqlite` table. Each lease records
its job, task, provider, instance id, reservation, lease expiry and deadline.
The lease is written before `provision()`. Every instance carries tags `atlas`,
`atlas-tenant:<id>` and `atlas-lease:<id>`, so an instance created just before
a crash is still found and charged. After termination, the provider's final
bill is settled against the reservation. The unused part goes back through the
new `TaskBudget.release()`, which is idempotent by the lease ref and
understood by `reconcileTaskBudgets`. An overrun is charged truthfully. A bill
that cannot be proven keeps the full reservation charged. Every reserve,
provision, terminate and settle is written to `compute_audit` with an
allowlist of fields; provider error messages are reduced to their codes.

## Known limits

- Cost safety assumes the provider bills at its estimated rate. RunPod's rate
  comes from the documented pricing table, not from the API. If RunPod
  changes its prices, update `ATLAS_RUNPOD_PRICING`.
- RunPod bills workers, not jobs. The derived bill relies on a cold-start
  allowance, which `executionTimeout` does not bound. A slow image boot
  beyond the allowance is billed and not seen. Keep images small or enable
  FlashBoot, and raise `ATLAS_RUNPOD_COLD_START_SEC` if boots are slow.
- Several Atlas jobs running at once on one endpoint may share a warm worker.
  Each job is still charged its own idle and cold-start overhead, so the
  derived bill errs high.
- A RunPod job's output is kept in memory only until it is saved. If the
  daemon restarts before `saveOutputs`, the result is lost and the job is
  settled.
- The monthly cap is per tenant. The local daemon has one tenant (the owner),
  so in practice it caps the owner's RunPod account.
- With `takeover`, a startup reconcile assumes one daemon per lease database.
- Releasing a reservation after a failed `provision()` trusts the provider's
  tag listing to be current.
- A small window between reserving and writing the lease can leave a
  reservation held after a crash. This is conservative: the budget is held
  and no spend happens.

## Follow-ups

- **GPU render routing.** A Blender Cycles render should go through
  `ComputeManager.runJob` with `RunpodProvider.waitForCompletion` as
  `execute`. Its frames would be saved through `saveOutputs` into the
  artifact store. `compute-runpod.test.mjs` already does exactly this with a
  PNG frame. It is not wired into `platform/render/` yet because three things
  are missing:
  - **Inputs.** Render inputs are local files staged into a networkless
    container. A remote worker needs them uploaded (object storage or a
    RunPod network volume), and that upload path does not exist yet.
  - **Request size.** The job `input` is JSON, so large `.blend` files cannot
    be inlined.
  - **Contract.** The render runner's container-only contract (protected
    review) has to gain a "remote GPU" mode deliberately.
- **Routes.** No HTTP route exposes the compute service yet. A
  `GET /api/compute/spend` for the dashboard would be a small addition.
