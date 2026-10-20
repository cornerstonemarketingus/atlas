# Compute plane: rented GPUs that cannot outlive their budget

Issue #353; engineering plan 2026 §3.2. Code: `apps/local-control/src/platform/compute/`.
Tests: `apps/local-control/tests/compute-manager.test.mjs` and `tests/budget-release.test.mjs`.

**Status:** interface, fake provider and every safety stop are built and tested
against a fake per-second-billing provider with a fake clock. **Real (paid)
provider adapter pending owner choice of provider and monthly cap.** The
daemon (`main.mjs`) runs a `ComputeManager` whose only provider today is the
owner's own [Atlas Nodes](#atlas-node-bring-your-own-machine), at $0, with
the reconciler started at boot. Nothing here spends money.

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

- Cost safety assumes the provider bills at its estimated rate. A real adapter
  must quote the rate it will bill, and its tests must check that.
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
configured, nodes are the default (`defaultComputeProviders`); with one, a
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
- Transport is the owner's HTTPS (VPN/proxy); there is no node-specific
  certificate pinning or mutual TLS yet: the node token is the node's identity.
- Apple Silicon GPUs are not usable from Linux containers, so Mac nodes are
  CPU nodes.
