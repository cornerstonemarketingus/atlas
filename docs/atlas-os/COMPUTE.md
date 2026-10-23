# Compute plane: rented GPUs that cannot outlive their budget

Issue #353; engineering plan 2026 §3.2. Code: `apps/local-control/src/platform/compute/`.
Tests: `apps/local-control/tests/compute-manager.test.mjs`, `tests/compute-runpod.test.mjs`
(against a loopback fake of the RunPod API, `tests/helpers/fake-runpod-server.mjs`)
and `tests/budget-release.test.mjs`.

**Status:** the interface, the fake provider, every safety stop, the monthly
cap, a RunPod Serverless adapter (decision D4) and [Atlas Nodes](#atlas-node-bring-your-own-machine)
are built and tested. The tests run against a fake per-second-billing
provider and a local HTTP fake of the RunPod API with a fake clock. **No test
makes a network call or spends money.** The daemon (`main.mjs`) always runs a
`ComputeManager` with the owner's own Atlas Nodes as the first provider, at
$0, and starts the reconciler at boot. RunPod is added after the nodes only
when an endpoint and key are configured, and even then every RunPod
provision is refused while the cap is 0 (the default). **Not live:** nothing
has run against a real RunPod account. That needs the owner's account,
endpoint and a cap above 0 (see "RunPod setup" below). Render jobs do not
route to RunPod yet (see "Follow-ups").

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

## Atlas Node (bring your own machine)

PROGRAM.md Phase 4 / §4.9 (remote nodes). Code: `apps/local-control/src/node/`
(the node program) and `apps/local-control/src/platform/nodes/` (the daemon
side). Tests: `apps/local-control/tests/atlas-node.test.mjs`.

An Atlas Node is a small program you run on a machine you own: a laptop, a
desktop, or a friend's GPU box. It dials **out** to your Atlas daemon,
declares what it can do, pulls render jobs, runs them in **its own container
sandbox**, and uploads the outputs. It is "your own RunPod" at $0. A GPU is a
bonus: CPU rendering (ffmpeg, Blender Cycles on CPU) is the normal case.

### What runs where

| Where | What |
|---|---|
| Your Atlas daemon | Mints and revokes node tokens, keeps nodes in the worker registry (`platform/workers/registry.mjs`), queues jobs, hands each job to one node, verifies uploads, stores outputs in the artifact store. `NodeProvider` puts the nodes behind the `ComputeManager` provider interface. |
| The node machine | `node src/node/main.mjs`: hardware detection (`agent/models/hardware.mjs`), `RenderRunner` (ffmpeg / Blender, container only), outbound HTTPS to the daemon. It never listens on a port. |

Scheduling reuses the compute plane: `ComputeManager` asks every provider
for an estimate and takes the cheapest. `NodeProvider` offers $0 when an
approved, live node of the job's tenant has the needed capabilities
(container sandbox, the render tool, a GPU with enough memory only if the
job asks for one, optional CPU cores / memory). With no paid provider
configured, nodes are the only provider (`createComputeService({ freeProviders })`); with one, a
node still wins whenever one can run the job and the paid provider takes the
rest. A $0 lease reserves nothing, but keeps the max lifetime, idle timeout,
reconciler and audit trail of a rented GPU. A job is submitted with
`nodeRenderJob({ id, render, workspace, gpu?, cpu? })` and run with
`runNodeRender({ manager, provider, tenantId, taskId, job })`.

### Setup

1. **On the daemon (owner):** mint a node token. It is shown once.

   ```sh
   curl -s -X POST http://127.0.0.1:4317/v1/nodes \
     -H "authorization: Bearer $ATLAS_LOCAL_TOKEN" -H "content-type: application/json" \
     -d '{"name":"Living-room PC"}'
   # -> { "node": { "id": "node_…", "status": "waiting_for_node" }, "nodeToken": "…" }
   ```

2. **Make the daemon reachable over HTTPS from the node.** The daemon listens
   on loopback; use the same customer-managed remote access as for phones (a
   VPN such as Tailscale/WireGuard, or an HTTPS reverse proxy/tunnel). The
   node refuses plain `http://` except to `127.0.0.1`/`localhost` on the same
   machine.

3. **On the node machine:** install Node.js 22.13 or newer and a container
   runtime, check out this repository, and build the render image
   (`docker build -t atlas/render:local docker/render`, see
   `docker/render/README.md`; it has ffmpeg and headless Blender). Then start
   the node with the token in an environment variable (never on the command
   line):

   - **Linux** (Docker or Podman):
     ```sh
     export ATLAS_NODE_TOKEN='…'
     export ATLAS_TERMINAL_CONTAINER_RUNTIME=/usr/bin/docker   # or /usr/bin/podman
     export ATLAS_RENDER_FFMPEG_IMAGE=atlas/render:local
     export ATLAS_RENDER_BLENDER_IMAGE=atlas/render:local   # Cycles on CPU works without a GPU
     cd apps/local-control && node src/node/main.mjs --daemon https://atlas.your-tailnet.ts.net --token-env ATLAS_NODE_TOKEN
     ```
   - **macOS** (Docker Desktop, or Podman machine): the same, with
     `ATLAS_TERMINAL_CONTAINER_RUNTIME=/usr/local/bin/docker` (or the path
     `which docker` prints). Apple GPUs are not passed into Linux containers,
     so a Mac node renders on CPU.
   - **Windows** (Docker Desktop, PowerShell):
     ```powershell
     $env:ATLAS_NODE_TOKEN = '…'
     $env:ATLAS_TERMINAL_CONTAINER_RUNTIME = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
     $env:ATLAS_RENDER_FFMPEG_IMAGE = 'atlas/render:local'
     cd apps\local-control; node src\node\main.mjs --daemon https://atlas.your-tailnet.ts.net --token-env ATLAS_NODE_TOKEN
     ```

   `--work-dir <dir>` chooses where job inputs and the sandbox staging copy
   live (default: the OS temp directory). Without a working container
   runtime the node declares no render capability and is never sent work.

4. **Approve it (owner).** The node registers as `untrusted` with what it
   detected (cores, memory, GPU, render tools). Check `GET /v1/nodes`, then
   `POST /v1/nodes/<id>/approve`. Until then it receives nothing.

Revoke with `POST /v1/nodes/<id>/revoke {"reason":"…"}`: the token stops
working at once, and any job it held goes back to the queue for another node.

### Job lifecycle

`provision` queues a node job (inputs are copied out of the workspace at
submit time, regular files inside it only). A node long-polls
`POST /v1/node/claim`; one guarded update hands the job to exactly one node
with a claim id and an expiry (60 s by default). Heartbeats and status
reports extend the claim. The node downloads each input and checks its
sha256, renders in its container sandbox (network off, staging copy only),
uploads each declared output with its sha256 (`PUT …/outputs`), then
`POST …/complete` names every output's digest. The job succeeds only if all
of them were uploaded under that claim with those digests.

- A claim that is not extended (the node died, lost its network, or stopped
  heartbeating) expires: the job is re-queued for a **different** node, at
  most once (two attempts by default), then fails.
- A job whose outputs were confirmed is never re-queued or claimed again; a
  node whose claim was lost gets `409 CLAIM_LOST` on every later call, so two
  nodes can never both complete the same job.
- A node handed a job it cannot run declines it and the job goes to another
  node; the daemon does not offer it such jobs in the first place.
- The compute lease is kept alive by the daemon while it waits; if the daemon
  stops, the lease goes idle, the reconciler cancels the node job, and the
  node's next call is refused.

### Security model

- **Outbound only.** Nodes never listen; they call the daemon over HTTPS
  (loopback http only on the same machine). The daemon itself stays on
  loopback behind your own VPN or proxy. Nothing is publicly exposed.
- **Identity and revocation.** A node token is 32 random bytes; the daemon
  stores only its sha256 (the paired-device mechanism). It authenticates only
  the `/v1/node/*` routes: it cannot read tasks, approvals, artifacts or
  anything else. Failed node tokens are rate limited per client. Revoking a
  node kills its token and its registry worker together.
- **Owner approval before any work.** Trust is the worker registry's:
  untrusted → enrolled only by the owner, and an untrusted, revoked or stale
  node is never given a job. A heartbeat can shrink but never grow declared
  capabilities.
- **Container or nothing.** Every job runs through `RenderRunner`, which
  starts only the container runtime (network none, read-only root, all
  capabilities dropped, one mount: a staging copy of the declared inputs).
  There is no host fallback on the node either.
- **Verified outputs.** Uploads are size-limited (job `maxOutputBytes`, and
  2 GiB per file), hashed while streaming, refused on any digest mismatch,
  restricted to declared output paths, and stored through the artifact store,
  which checks that the bytes really are the media type (mp4, webm, png,
  jpeg, webp).
- **Tenant isolation.** A node belongs to the tenant whose owner minted it and
  only sees that tenant's jobs.
- **What a node owner can see.** The job's inputs and outputs, as with any
  machine you render on. Only add machines whose owners you trust with that
  content.

### Known limits

- Jobs are render jobs (ffmpeg, Blender). Inference on nodes (PROGRAM 4.9
  PROOF 4) will reuse the same enrollment, claim and lease path.
- A revoked or expired node's in-flight container is not killed remotely; its
  result is refused and discarded, and the container stops at the job's own
  timeout.
- Stopping the node cancels its outbound requests, response reads, input
  transfers and retry waits, and removes its partial job workspace. No new
  render or completion request starts after shutdown. An already running
  render still returns under its configured timeout before local shutdown
  completes. Stopping the client does not acknowledge a server-side job
  cancellation: inspect the saved job, since an earlier request may already
  have reached the daemon; unfinished claims recover through lease expiry.
- Transport is the owner's HTTPS (VPN/proxy); there is no node-specific
  certificate pinning or mutual TLS yet: the node token is the node's identity.
- Apple Silicon GPUs are not usable from Linux containers, so Mac nodes are
  CPU nodes.

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
- **Routes.** Done for reading: see "Status route and console card" below.
  There is no write route (the cap is configuration, not a console setting).

## Status route and console card

`GET /v1/compute` (`platform/compute/routes.mjs`) is owner only; a paired
device gets 403, as with the render routes. It answers even when no compute
service was built, with `enabled: false` and the reason. The body is
`{ compute: { enabled, provisioning, rented, gpuSpending, reason, capMicroUsd,
spend, leases, nodes } }`:

- `rented` is true when a RunPod provider is configured; `gpuSpending` is true
  only when it is and the monthly cap is above 0. `capMicroUsd` is the cap
  that applies to paid GPUs (0 when there is no paid provider, since nothing
  can be spent). `provisioning` is true when anything can run, including $0
  Atlas Nodes.
- `spend` is `manager.monthlySpend(tenant)`: month, settled, reserved, total
  and remaining micro-USD for the current UTC month.
- `leases` are the 20 most recent leases, newest first, from an allowlist of
  fields (no instance ids).
- `nodes` is `{ count, approved, online }` for the owner's Atlas Nodes
  (revoked nodes are not counted; online means approved with a fresh
  heartbeat), or null when the node service is not running.

The response never contains the API key or anything from the provider
object. The console's Models page shows it as a **Compute & spend** card:
"GPU spending off (cap $0.00)" or "$X of $Y this month", the reason, the
node counts and the recent leases. Tests: `tests/console-wiring.test.mjs`.
